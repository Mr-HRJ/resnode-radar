import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { URL, fileURLToPath } from "node:url";
import { parse } from "node-html-parser";
import { hasSharedIpEvidence } from "@resnode-radar/contracts/network";
import { parseLagomProductList } from "./adapters/lagom-product-list.js";
import { parseZlidcProductWrap } from "./adapters/zlidc-product-wrap.js";
import { parseRacknerdKvm } from "./adapters/racknerd-kvm.js";
import { monitorPublicCatalog } from "./adapters/public-catalog.js";
import { monitorWhmcsPidWatch } from "./adapters/whmcs-pid-watch.js";
import {
  buildSkylinePublicCatalogRequest,
  buildNeburstPublicCatalogRequest,
  hasSkylinePublicKey,
  discoverSkylineChunkUrls,
  NEBURST_PUBLIC_CATALOG_URL
} from "./adapters/dynamic-catalogs.js";
import {
  cleanPublicUrl,
  catalogUrlAllowed,
  catalogRequestUrl
} from "./adapters/catalog-pages.js";
import { validateSourceRecords, verifySourcesCoverage } from "./adapters/registry.js";
import { createOriginPacer } from "./pacing/origin-pacer.js";
import { fetchHttp2 } from "./transport/http2-client.js";
import { fetchProxy } from "./transport/proxy-client.js";
import { collectWithResidentialFallback } from "./transport/residential-fallback.js";
import { transportErrorDetails } from "./transport/transport-errors.js";
import { trackEvents } from "./events/radar-events.js";
import { readFxSnapshot } from "./fx/fx-rates.js";
import { validateMonitorPayload } from "./validate.js";
import { CollectionState } from "./state/collection-db.js";
import { refreshAnnouncements } from "./feeds/announcements.js";
import {
  publishBatch,
  reconcilePublishedState,
  seedV2FromV1,
  writeV1FallbackPointer
} from "./publisher/index.js";

const execFileAsync = promisify(execFile);
const antiBotPattern =
  /Just a moment|cf_chl|challenge-platform|Enable JavaScript and cookies|cf-turnstile|正在进行安全验证|cf-mitigated/i;
const defaultSourcesPath = fileURLToPath(new URL("../config/sources.json", import.meta.url));
const defaultAnnouncementsPath = fileURLToPath(
  new URL("../config/announcements.json", import.meta.url)
);

function cleanText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function absoluteUrl(base, href) {
  if (!href || href === "#") return null;
  return new URL(href, base).toString();
}

function statusRank(status) {
  if (status === "available") return 1;
  if (status === "unavailable") return 2;
  if (status === "unknown") return 3;
  if (status === "blocked") return 4;
  return 5;
}

function parsePriceValue(priceText) {
  const normalized = cleanText(priceText).replace(/,/g, "");
  const match = normalized.match(/([0-9]+(?:\.[0-9]+)?)/);
  return match ? Number(match[1]) : null;
}

function numericStockCount(product) {
  if (product.stockCount === undefined || product.stockCount === null || product.stockCount === "") {
    return null;
  }
  const value = Number(product.stockCount);
  return Number.isFinite(value) ? value : null;
}

function productEvidenceText(product) {
  return cleanText(
    [
      product.evidence,
      product.status,
      product.statusLabel,
      product.note,
      product.route,
      product.hardware,
      product.bandwidth,
      product.raw?.strategy,
      product.raw?.stockLabel
    ]
      .filter(Boolean)
      .join(" ")
  );
}

export function computeEvidenceLevel(product) {
  if (product.raw?.historical) {
    return { value: "unverified", label: "历史资料·库存待核验", className: "is-unknown", rank: 6 };
  }
  const evidence = productEvidenceText(product);
  const stockCount = numericStockCount(product);
  const hasPreciseStock = stockCount !== null;
  const isSnapshot = /reader_snapshot|third-party|snapshot|第三方|快照/i.test(evidence);

  if (product.status === "error" || /\berror\b|抓取失败|fetch failed|timeout/i.test(evidence)) {
    return { value: "error", label: "抓取失败", className: "is-error", rank: 6 };
  }
  if (product.status === "unavailable" || stockCount === 0) {
    return { value: "unavailable", label: "不可订购", className: "is-unavailable", rank: 5 };
  }
  if (hasPreciseStock) {
    return {
      value: "stock-count",
      label: `精确库存 ${stockCount}`,
      className: "is-count",
      rank: 1
    };
  }
  if (isSnapshot) {
    return { value: "snapshot", label: "第三方快照", className: "is-snapshot", rank: 4 };
  }
  if (
    product.status === "blocked" ||
    /blocked|被阻断|403|429|official direct fetch blocked/i.test(evidence)
  ) {
    return { value: "blocked", label: "直连受阻", className: "is-blocked", rank: 5 };
  }
  if (
    product.orderUrl ||
    /order link found|order=yes|official page|product card parsed from official page|立即订购|product-wrap order link/i.test(
      evidence
    )
  ) {
    return { value: "official-order", label: "官方订购入口", className: "is-official", rank: 2 };
  }
  return { value: "unverified", label: "证据待核验", className: "is-unknown", rank: 6 };
}

function addRiskTag(tags, value, label, severity = "medium") {
  if (!tags.some((tag) => tag.value === value)) tags.push({ value, label, severity });
}

export function computeRiskTags(product) {
  const tags = [];
  const evidence = productEvidenceText(product);
  const stockCount = numericStockCount(product);
  const blockedOfficialAttempt =
    product.raw?.strategy === "reader_snapshot" &&
    product.raw?.attempts?.some(
      (attempt) => attempt.strategy !== "reader_snapshot" && attempt.outcome === "blocked"
    );

  if (product.status === "available" && product.orderUrl && stockCount === null) {
    addRiskTag(tags, "order-only", "仅证明可下单", "medium");
    addRiskTag(tags, "stock-unstated", "库存未明示", "medium");
  }
  if (/reader_snapshot|third-party|snapshot|第三方|快照/i.test(evidence)) {
    addRiskTag(tags, "third-party-snapshot", "第三方快照", "high");
  }
  if (product.status === "blocked" || blockedOfficialAttempt) {
    addRiskTag(tags, "direct-blocked", "官方直连受阻", "high");
  }
  if (product.status === "error") addRiskTag(tags, "fetch-error", "抓取失败", "high");
  if (product.status === "unknown") addRiskTag(tags, "unknown-status", "状态未知", "medium");
  if (product.status === "unavailable") addRiskTag(tags, "unavailable", "当前不可订购", "high");
  if (!Number.isFinite(product.priceValue)) addRiskTag(tags, "price-missing", "价格缺失", "medium");

  const missingFields = ["hardware", "bandwidth", "region"].filter((f) => !cleanText(product[f]));
  if (missingFields.length > 0) addRiskTag(tags, "incomplete-fields", "字段不完整", "medium");
  if (hasSharedIpEvidence(product)) addRiskTag(tags, "nat-shared", "NAT/共享", "medium");
  if (/实名|实名认证|KYC|需要认证/i.test(evidence)) {
    addRiskTag(tags, "identity-required", "需要实名", "high");
  }
  if (/无退款|不退款|no refund|non[-\s]?refundable/i.test(evidence)) {
    addRiskTag(tags, "refund-limited", "退款限制", "medium");
  }
  if (/工单|联系客服|manual|support confirm/i.test(evidence)) {
    addRiskTag(tags, "manual-confirm", "需客服确认", "medium");
  }

  if (tags.length === 0) addRiskTag(tags, "no-extra-risk", "未见额外风险", "low");
  return tags;
}

export function enrichProductSignals(product) {
  return {
    ...product,
    evidenceLevel: computeEvidenceLevel(product),
    riskTags: computeRiskTags(product)
  };
}

function aaitrUrl(targetUrl, baseUrl) {
  const url = new URL(targetUrl, baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["aaitr.com", "www.aaitr.com"].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error("AaITR URL must use HTTP(S), an allowed hostname and no credentials");
  }
  return url.toString();
}

function isAntiBotResult(fetchResult) {
  if (!fetchResult) return false;
  const cfMitigated = fetchResult.headers?.["cf-mitigated"];
  const html = fetchResult.html ?? "";
  return (
    cfMitigated === "challenge" ||
    antiBotPattern.test(html) ||
    ((fetchResult.statusCode ?? 200) < 500 && /Cloudflare Ray ID/i.test(html))
  );
}

function resolveConfigFile(cwd, relPath, fallbackPath) {
  const local = join(cwd, relPath);
  return existsSync(local) ? local : fallbackPath;
}

export async function runCollection({
  cwd = process.cwd(),
  env = process.env,
  argv = [],
  logger = console
} = {}) {
  if (argv.includes("--check-v1-fallback-support")) {
    return { supported: true };
  }
  if (argv.includes("--seed-v2-from-v1")) {
    const dataDir = resolve(cwd, env.MONITOR_DATA_DIR || "data");
    const v1OutputPath = env.MONITOR_OUTPUT
      ? resolve(cwd, env.MONITOR_OUTPUT)
      : join(dataDir, "products.json");
    return seedV2FromV1({ dataDir, v1OutputPath, logger });
  }
  if (argv.includes("--v1-fallback")) {
    const dataDir = resolve(cwd, env.MONITOR_DATA_DIR || "data");
    const v1OutputPath = env.MONITOR_OUTPUT
      ? resolve(cwd, env.MONITOR_OUTPUT)
      : join(dataDir, "products.json");
    return writeV1FallbackPointer({ dataDir, v1OutputPath, logger });
  }

  const configuredDataDir = resolve(cwd, env.MONITOR_DATA_DIR || "data");
  const defaultProdOutput = join(configuredDataDir, "products.json");
  const outputPath = env.MONITOR_OUTPUT ? resolve(cwd, env.MONITOR_OUTPUT) : defaultProdOutput;
  const isDefaultProdOutput = outputPath === defaultProdOutput;
  const dataDir = isDefaultProdOutput ? configuredDataDir : dirname(outputPath);

  const onlySourceIds = new Set(
    String(env.MONITOR_ONLY ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  );
  if (onlySourceIds.size > 0) {
    if (!env.MONITOR_OUTPUT || isDefaultProdOutput) {
      throw new Error("MONITOR_ONLY requires a non-production MONITOR_OUTPUT to protect the full snapshot");
    }
    if (env.MONITOR_STATE_DB && env.MONITOR_ALLOW_SUBSET_STATE !== "1") {
      throw new Error(
        "Subset collection requires a separate state database and MONITOR_ALLOW_SUBSET_STATE=1"
      );
    }
  }

  // Step 0: On full production runs, reconcile any interrupted prior publish BEFORE freezing baseline
  if (!onlySourceIds.size && isDefaultProdOutput) {
    await reconcilePublishedState({ dataDir, v1OutputPath: outputPath, logger });
  }

  // Freeze last successfully published v1 baseline BEFORE touching SQLite working state
  let previousPayload = null;
  try {
    previousPayload = JSON.parse(readFileSync(outputPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn(`Previous monitor snapshot unavailable: ${error.message}`);
    }
  }

  const exchangeRates = readFxSnapshot(join(cwd, "data/fx.json"), logger);
  const sourcesPath = resolveConfigFile(cwd, "monitor/sources.json", defaultSourcesPath);
  const allSources = JSON.parse(readFileSync(sourcesPath, "utf8"));
  verifySourcesCoverage(allSources);

  const sources = onlySourceIds.size
    ? allSources.filter((source) => onlySourceIds.has(source.id))
    : allSources;
  if (!sources.length) {
    throw new Error("No matching monitor sources selected");
  }

  const generatedAt = new Date().toISOString();
  const collectionState = env.MONITOR_STATE_DB ? new CollectionState(env.MONITOR_STATE_DB) : null;
  const userAgent = "Mozilla/5.0 ResNodeRadar/2.0 (+https://github.com/Mr-HRJ/resnode-radar)";
  const monitorConcurrency = Math.max(1, Number(env.MONITOR_CONCURRENCY ?? 12));
  const fetchRetries = Number(env.MONITOR_FETCH_RETRIES ?? 2);
  const fetchTimeoutMs = Number(env.MONITOR_FETCH_TIMEOUT_MS ?? 20_000);
  const sourceTimeBudgetMs = Number(env.MONITOR_SOURCE_BUDGET_MS ?? 150_000);
  const waitForRequestSlot = createOriginPacer();

  function baseRecord(source, fetchResult, extra = {}) {
    return {
      id: extra.id ?? source.id,
      sourceId: source.id,
      providerId: source.providerId,
      provider: source.provider,
      category: source.category,
      adapter: source.adapter,
      sourceUrl: source.url,
      finalUrl: fetchResult?.finalUrl ?? source.url,
      fetchedAt: generatedAt,
      observedAt: new Date().toISOString(),
      httpStatus: fetchResult?.statusCode ?? null,
      region: source.regionHint ?? null,
      route: source.routeHint ?? null,
      ...extra
    };
  }

  function blockedRecord(source, fetchResult, reason, extra = {}) {
    return baseRecord(source, fetchResult, {
      diagnostic: true,
      name: `${source.provider} 监控源`,
      status: "blocked",
      statusLabel: "被阻断",
      price: null,
      priceValue: null,
      hardware: null,
      bandwidth: null,
      stockCount: null,
      orderUrl: source.url,
      evidence: reason,
      error: reason,
      ...extra
    });
  }

  function errorRecord(source, error, extra = {}) {
    const { message, code, hostname } = transportErrorDetails(
      error,
      extra.sourceUrl ?? source.url
    );
    return baseRecord(source, null, {
      diagnostic: true,
      name: `${source.provider} 监控源`,
      status: "error",
      statusLabel: ["ENOTFOUND", "EAI_AGAIN"].includes(code) ? "DNS 解析失败" : "抓取失败",
      price: null,
      priceValue: null,
      hardware: null,
      bandwidth: null,
      stockCount: null,
      orderUrl: source.url,
      evidence: message,
      error: message,
      ...(code ? { transportError: { code, hostname } } : {}),
      ...extra
    });
  }

  async function fetchHtml(source, targetUrl = source.url, restrictAaitr = false) {
    source.signal?.throwIfAborted();
    const restrictCatalog = source.adapter === "public_catalog";
    const validateUrl = (value, base) => {
      if (restrictAaitr) return aaitrUrl(value, base);
      if (restrictCatalog) {
        const url = cleanPublicUrl(value, base);
        if (!url || !catalogUrlAllowed(url, source)) {
          throw new Error("Catalog redirect outside configured official hosts");
        }
        return catalogRequestUrl(url, source);
      }
      return value;
    };
    const initialUrl = validateUrl(targetUrl);
    if (source.catalogFormat === "neburst" && initialUrl !== NEBURST_PUBLIC_CATALOG_URL) {
      throw new Error("Neburst collection requires its public pricing URL");
    }
    let publicClientScript = null;
    if (source.catalogFormat === "skyline") {
      if (initialUrl !== "https://api.skylineconnect.io/v1/api/payment/payment_product_list") {
        throw new Error("Skyline collection requires its public product-list URL");
      }
      const probeSource = {
        ...source,
        catalogFormat: null,
        requestIntervalMs: Math.min(source.requestIntervalMs ?? 2000, 300)
      };
      if (source.publicClientScript) {
        const client = await fetchHtml(probeSource, source.publicClientScript);
        if (client.ok && hasSkylinePublicKey(client.html)) {
          publicClientScript = client.html;
        }
      }
      if (!publicClientScript) {
        const entryUrl = source.website || "https://www.skylineconnect.io/products";
        const page = await fetchHtml(probeSource, entryUrl);
        if (!page.ok) {
          throw new Error(`Skyline public storefront returned HTTP ${page.statusCode}`);
        }
        const chunkUrls = discoverSkylineChunkUrls(page.html, page.finalUrl || entryUrl).slice(
          0,
          30
        );
        for (const chunkUrl of chunkUrls) {
          const chunk = await fetchHtml(probeSource, chunkUrl);
          if (chunk.ok && hasSkylinePublicKey(chunk.html)) {
            publicClientScript = chunk.html;
            break;
          }
        }
        if (!publicClientScript) {
          throw new Error("Skyline published public encryption key not found in official client bundles");
        }
      }
    }

    let lastError;
    for (let attempt = 0; attempt <= fetchRetries; attempt += 1) {
      await waitForRequestSlot(initialUrl, source.requestIntervalMs, source.signal);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
      try {
        let currentUrl = initialUrl;
        let response;
        const publicRequest = publicClientScript
          ? buildSkylinePublicCatalogRequest(publicClientScript)
          : source.catalogFormat === "neburst"
            ? buildNeburstPublicCatalogRequest({ userAgent })
            : null;
        for (let redirects = 0; ; redirects += 1) {
          if (source.transport === "http2" && publicRequest) {
            throw new Error("HTTP/2 catalog transport supports public GET pages only");
          }
          response = await (source.transport === "http2"
            ? fetchHttp2
            : source.proxyUrl
              ? fetchProxy
              : fetch)(currentUrl, {
            ...(source.proxyUrl ? { proxyUrl: source.proxyUrl } : {}),
            ...(publicRequest ? { method: publicRequest.method, body: publicRequest.body } : {}),
            headers: {
              "user-agent": userAgent,
              accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              ...publicRequest?.headers
            },
            redirect: restrictAaitr || restrictCatalog ? "manual" : "follow",
            signal: source.signal
              ? AbortSignal.any([controller.signal, source.signal])
              : controller.signal
          });
          const location = response.headers.get("location");
          if (
            !(restrictAaitr || restrictCatalog) ||
            ![301, 302, 303, 307, 308].includes(response.status) ||
            !location
          ) {
            break;
          }
          await response.body?.cancel();
          if (publicRequest) {
            throw new Error(`${source.provider} public catalog redirected unexpectedly`);
          }
          if (redirects === 20) throw new Error("AaITR HTTP redirect limit exceeded");
          currentUrl = validateUrl(location, currentUrl);
          await waitForRequestSlot(currentUrl, source.requestIntervalMs, source.signal);
        }
        const html = await response.text();
        const result = {
          ok: response.ok,
          statusCode: response.status,
          finalUrl: response.url,
          headers: Object.fromEntries(response.headers.entries()),
          html
        };
        if (
          !publicRequest &&
          attempt < fetchRetries &&
          [502, 503, 504, 520, 521, 522, 523, 524].includes(result.statusCode) &&
          !isAntiBotResult(result)
        ) {
          throw new Error(`Temporary upstream HTTP ${result.statusCode}`);
        }
        return result;
      } catch (error) {
        source.signal?.throwIfAborted();
        lastError = error;
        if (
          attempt === fetchRetries ||
          transportErrorDetails(error, initialUrl).code === "ENOTFOUND"
        ) {
          break;
        }
        await delay(800 * (attempt + 1), undefined, { signal: source.signal });
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }

  function extractInertiaPage(html) {
    const root = parse(html);
    const script = root.querySelector('script[data-page="app"][type="application/json"]');
    if (!script) throw new Error("VIRCS Inertia JSON script not found");
    return JSON.parse(script.text);
  }

  function parseVircs(source, fetchResult) {
    if (isAntiBotResult(fetchResult)) {
      return [blockedRecord(source, fetchResult, "Provider returned Cloudflare challenge")];
    }
    const page = extractInertiaPage(fetchResult.html);
    const data = page?.props?.data;
    const product = data?.data;
    if (!product) throw new Error("VIRCS product payload missing props.data.data");
    const name = cleanText(product.name);
    if (typeof product.name !== "string" || !name) {
      throw new Error("VIRCS product name missing or empty");
    }
    const available = Number(data.available);
    if (
      !["number", "string"].includes(typeof data.available) ||
      !cleanText(data.available) ||
      !Number.isInteger(available) ||
      available < 0
    ) {
      throw new Error("VIRCS props.data.available missing or invalid");
    }
    const description = Array.isArray(product.description) ? product.description : [];
    const byKey = Object.fromEntries(
      description.map((item) => [cleanText(item.key), cleanText(item.value)])
    );
    const summary = data.summary ?? {};
    const bandwidth = cleanText(
      [summary?.["带宽"]?.name, summary?.["流量"]?.name].filter(Boolean).join(" / ")
    );
    const hardware = cleanText([byKey.CPU, byKey["内存"], byKey["硬盘"]].filter(Boolean).join(" / "));
    const network = cleanText(summary?.["网络"]?.name ?? source.routeHint ?? "");
    const price = data.total ? `$${data.total}/月` : null;

    return [
      baseRecord(source, fetchResult, {
        name,
        region: cleanText(product.location ?? source.regionHint),
        route: network,
        note: cleanText(product.subtitle ?? ""),
        hardware,
        bandwidth,
        price,
        priceValue: parsePriceValue(price),
        status: available > 0 && product.payable ? "available" : "unavailable",
        statusLabel: available > 0 && product.payable ? `可订购 · ${available}` : "不可订购",
        stockCount: available,
        orderUrl: source.url,
        evidence: `VIRCS props.data.available=${available}; total=${data.total ?? "unknown"}`,
        raw: {
          productId: product.id,
          status: product.status,
          payable: product.payable
        }
      })
    ];
  }

  function featureMap(card) {
    const out = {};
    for (const li of card.querySelectorAll("li")) {
      const value = cleanText(li.querySelector("b")?.text ?? "");
      const label = cleanText(li.text.replace(value, ""));
      if (label && value) out[label] = value;
    }
    return out;
  }

  function parseWhmcsGroup(source, fetchResult) {
    if (isAntiBotResult(fetchResult)) {
      return [blockedRecord(source, fetchResult, "Provider returned anti-bot challenge")];
    }
    const root = parse(fetchResult.html);
    const cards = root.querySelectorAll("#products .card");
    if (cards.length === 0) throw new Error("WHMCS product cards not found");

    return cards.map((card, index) => {
      const name = cleanText(card.querySelector("h4")?.text);
      const priceCore = cleanText(card.querySelector(".price-cls")?.text);
      const period = cleanText(card.querySelector(".text-small.text-muted")?.text);
      const order = card.querySelector('a[href*="cart.php?a=add"]');
      const linkedUrl = absoluteUrl(fetchResult.finalUrl || source.url, order?.getAttribute("href"));
      const orderUrl =
        order &&
        !order.hasAttribute("disabled") &&
        order.getAttribute("aria-disabled") !== "true" &&
        !order.classList.contains("disabled")
          ? linkedUrl
          : null;
      const pid = linkedUrl ? new URL(linkedUrl).searchParams.get("pid") : String(index + 1);
      const features = featureMap(card);
      const hardware = cleanText(
        [features.CPU, features["内存"], features["硬盘"]].filter(Boolean).join(" / ")
      );
      const bandwidth = cleanText(
        [features["带宽"], features["流量"], features.IP].filter(Boolean).join(" / ")
      );
      const description = cleanText(card.querySelector("p")?.text);
      const orderText = cleanText(order?.text);
      const price = priceCore ? `${priceCore}${period ? `/${period}` : ""}` : null;
      const visibleText = cleanText(card.structuredText);
      const soldOut = /Sold Out|Out of Stock|售罄|缺货|無庫存|无库存/i.test(visibleText);
      const stock = visibleText.match(
        /(?:库存|庫存)\s*[:：]?\s*(\d+)|(\d+)\s*(?:可用|Available\b|in stock\b)/i
      );
      const count = soldOut ? 0 : stock ? Number(stock[1] ?? stock[2]) : null;
      const status = count === 0 ? "unavailable" : orderUrl ? "available" : "unknown";

      return baseRecord(source, fetchResult, {
        id: `${source.id}-pid-${pid}`,
        name,
        region: source.regionHint ?? null,
        route: source.routeHint ?? null,
        note: description,
        hardware,
        bandwidth,
        price,
        priceValue: parsePriceValue(priceCore),
        status,
        statusLabel:
          status === "unavailable"
            ? "已售罄"
            : status === "available"
              ? count === null
                ? "可订购入口"
                : `库存 ${count}`
              : "未知",
        stockCount: count,
        orderUrl,
        evidence: `WHMCS product card; pid=${pid}; stock=${count ?? "not stated"}; order=${Boolean(orderUrl)}; button=${orderText}`,
        raw: {
          pid,
          features,
          sourceCardIndex: index
        }
      });
    });
  }

  function orderedUniqueUrls(urls) {
    const seen = new Set();
    const out = [];
    for (const url of urls) {
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
    return out;
  }

  function summarizeAttempt(strategy, targetUrl, fetchResult, outcome, note) {
    let title = null;
    if (fetchResult?.html) {
      try {
        title = cleanText(parse(fetchResult.html).querySelector("title")?.text).slice(0, 120);
      } catch {
        title = null;
      }
    }
    return {
      strategy,
      url: targetUrl,
      finalUrl: fetchResult?.finalUrl ?? targetUrl,
      httpStatus: fetchResult?.statusCode ?? null,
      ok: Boolean(fetchResult?.ok),
      via: fetchResult?.via ?? "http",
      bytes: fetchResult?.html?.length ?? 0,
      outcome,
      note,
      title: title || undefined
    };
  }

  function summarizeErrorAttempt(strategy, targetUrl, error) {
    return {
      strategy,
      url: targetUrl,
      finalUrl: targetUrl,
      httpStatus: null,
      ok: false,
      via: strategy === "headless_chrome" ? "headless_chrome" : "http",
      bytes: 0,
      outcome: "error",
      note: error.message,
      error: error.message
    };
  }

  function extractUrlsFromText(baseUrl, text) {
    const matches = String(text ?? "").matchAll(
      /(?:(?:[a-z][a-z0-9+.-]*:)?\/\/[^\s"'<>)]*|\/(?:store\/[a-z0-9_-]+|cart\.php\?gid=\d+))/gi
    );
    const urls = [];
    for (const match of matches) {
      const rawUrl = match[0].replace(/[.,;]+$/, "");
      try {
        urls.push(aaitrUrl(rawUrl, baseUrl));
      } catch {
        continue;
      }
    }
    return orderedUniqueUrls(urls);
  }

  function nodeLines(node) {
    const structured = node?.structuredText ?? node?.text ?? "";
    return structured
      .split(/\n|[-]{4,}/)
      .map(cleanText)
      .filter(Boolean);
  }

  function textFeatureMap(text) {
    const out = {};
    for (const line of String(text ?? "").split(/\n|[-]{4,}/)) {
      const cleaned = cleanText(line);
      const match = cleaned.match(/^([^:：]{1,16})[:：]\s*(.+)$/);
      if (match) out[cleanText(match[1])] = cleanText(match[2]);
    }
    return out;
  }

  function firstProductText(node, selectors) {
    for (const selector of selectors) {
      const value = cleanText(node.querySelector(selector)?.text);
      if (value) return value;
    }
    return "";
  }

  function stockLabelFromText(text) {
    const match = String(text ?? "").match(
      /Sold Out|Limited Stock|Plenty in Stock|Out of Stock|In Stock|库存充足|库存不足|已售罄|售罄|缺货|有货|无货/i
    );
    return match ? cleanText(match[0]) : "";
  }

  function stripStockWords(text) {
    return cleanText(
      String(text ?? "")
        .replace(
          /Sold Out|Limited Stock|Plenty in Stock|Out of Stock|In Stock|库存充足|库存不足|已售罄|售罄|缺货|有货|无货/gi,
          ""
        )
        .replace(/Order Now|立即购买|加入购物车|Add to Cart/gi, "")
    );
  }

  function extractAaitrName(node, index) {
    for (const candidate of node.querySelectorAll("span, h3, h4, strong")) {
      const id = candidate.getAttribute("id") ?? "";
      if (/-name$/i.test(id)) return stripStockWords(candidate.text);
    }
    const direct = stripStockWords(
      firstProductText(node, ["h4", "h3", ".product-title", ".product-name", "header"])
    );
    if (direct) return direct;
    const line = nodeLines(node).find((item) => {
      if (/^(Starting from|从开始|Monthly|月缴|Order Now|立即购买|FREE|免费)/i.test(item)) {
        return false;
      }
      if (/点我查看|查看购物车|Choose Another Category|查看其他分类/i.test(item)) return false;
      return item.length <= 80;
    });
    return stripStockWords(line) || `AaITR 产品 ${index + 1}`;
  }

  function extractAaitrPrice(text) {
    const match = String(text ?? "").match(
      /(?:¥|￥)\s*[0-9][0-9,.]*(?:\.[0-9]+)?\s*CNY|[0-9][0-9,.]*(?:\.[0-9]+)?\s*元/i
    );
    return match ? cleanText(match[0]) : null;
  }

  function aaitrProductNodes(root) {
    const selectors = [
      "#products .product",
      "#products .card",
      ".products .product",
      ".products .card",
      ".product-list .product"
    ];
    const seen = new Set();
    const nodes = [];
    for (const selector of selectors) {
      for (const node of root.querySelectorAll(selector)) {
        if (seen.has(node)) continue;
        seen.add(node);
        nodes.push(node);
      }
    }
    return nodes;
  }

  function parseAaitrStorePage(source, fetchResult, strategy, attempt) {
    if (isAntiBotResult(fetchResult)) return [];
    const root = parse(fetchResult.html);
    const cards = aaitrProductNodes(root);
    if (cards.length === 0) throw new Error("AaITR WHMCS product blocks not found");

    const records = [];
    cards.forEach((card, index) => {
      const fullText = card.structuredText || card.text || "";
      const name = extractAaitrName(card, index);
      const price = extractAaitrPrice(fullText);
      const order = card.querySelector('a[href*="cart.php?a=add"], a[href*="/cart.php?a=add"]');
      const orderUrl = absoluteUrl(fetchResult.finalUrl ?? source.url, order?.getAttribute("href"));
      const pid = orderUrl ? new URL(orderUrl).searchParams.get("pid") : null;
      const stockLabel = stockLabelFromText(fullText);
      const soldOut = /Sold Out|Out of Stock|已售罄|售罄|缺货|无货/i.test(fullText);
      const availableSignal =
        /Limited Stock|Plenty in Stock|In Stock|库存充足|库存不足|有货|Order Now|立即购买/i.test(
          fullText
        );
      const features = textFeatureMap(fullText);
      const hardware = cleanText(
        [features.CPU, features["内存"] ?? features.RAM, features["硬盘"] ?? features.Disk]
          .filter(Boolean)
          .join(" / ")
      );
      const bandwidth = cleanText(
        [
          features["带宽"] ?? features.Bandwidth,
          features["流量"] ?? features.Traffic,
          features["转发"] ?? features["Port Forwarding"]
        ]
          .filter(Boolean)
          .join(" / ")
      );
      const hasProductSignal =
        name && (price || stockLabel || orderUrl || /静态家宽|动态NAT|住宅家宽/i.test(fullText));
      if (!hasProductSignal) return;

      const status = soldOut
        ? "unavailable"
        : orderUrl || availableSignal
          ? "available"
          : "unknown";
      const statusLabel =
        status === "available"
          ? stockLabel || "可订购"
          : status === "unavailable"
            ? stockLabel || "售罄"
            : "未知";
      records.push(
        baseRecord(source, fetchResult, {
          id: `${source.id}-${pid ? `pid-${pid}` : `idx-${index + 1}`}`,
          name,
          region: features["位置"] ?? features.Location ?? source.regionHint ?? null,
          route: features.IP ?? source.routeHint ?? null,
          note: nodeLines(card)
            .filter((line) => /^点我查看|需要实名认证|静态IP|保证|IP[:：]/.test(line))
            .join(" / "),
          hardware,
          bandwidth,
          price,
          priceValue: parsePriceValue(price),
          status,
          statusLabel,
          stockCount: null,
          orderUrl: orderUrl ?? source.url,
          evidence: `AaITR ${strategy} parsed WHMCS product; stock=${stockLabel || "not stated"}; order=${orderUrl ? "yes" : "no"}`,
          raw: {
            pid,
            stockLabel,
            features,
            strategy,
            attempt
          }
        })
      );
    });

    if (records.length === 0) throw new Error("AaITR product blocks found but no product signals");
    return records;
  }

  function stripMarkdown(value) {
    return cleanText(
      String(value ?? "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/\*\*/g, "")
        .replace(/`/g, "")
        .replace(/^\s*[-*]\s+/, "")
    );
  }

  function readerTargetUrl(source, sourcePageUrl) {
    const baseUrl = source.readerSnapshot?.baseUrl ?? "https://r.jina.ai/";
    return `${baseUrl.replace(/\/?$/, "/")}${sourcePageUrl}`;
  }

  function readerPathSlug(sourcePageUrl, index) {
    const url = new URL(sourcePageUrl);
    const path = url.pathname
      .replace(/^\/+|\/+$/g, "")
      .replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase();
    return `${path || "page"}-${index + 1}`;
  }

  function statusFromSnapshotStock(stockLabel, text) {
    if (/Sold Out|Out of Stock|已售罄|售罄|缺货|无货/i.test(`${stockLabel} ${text}`)) {
      return "unavailable";
    }
    if (
      /Limited Stock|Plenty in Stock|In Stock|库存充足|库存不足|有货/i.test(
        `${stockLabel} ${text}`
      )
    ) {
      return "available";
    }
    return "unknown";
  }

  function parseAaitrReaderSnapshot(source, fetchResult, sourcePageUrl, attempt) {
    const content =
      String(fetchResult.html ?? "")
        .split(/Markdown Content:\s*/i)
        .at(1) ?? fetchResult.html;
    const lines = String(content)
      .split(/\r?\n/)
      .map(stripMarkdown)
      .filter(Boolean)
      .filter((line) => !/^Title:|^URL Source:|^Markdown Content:/i.test(line))
      .filter((line) => !/^[-\s]+$/.test(line));

    const blocks = [];
    let current = null;
    for (const line of lines) {
      const header = line.match(
        /^(.+?)\s+(Sold Out|Limited Stock|Plenty in Stock|Out of Stock|In Stock|库存充足|库存不足|已售罄|售罄|缺货|有货|无货)\s*$/i
      );
      if (header && !/^点我查看|^需要实名认证|^静态IP/i.test(line)) {
        if (current) blocks.push(current);
        current = {
          name: stripStockWords(header[1]),
          stockLabel: cleanText(header[2]),
          lines: []
        };
        continue;
      }
      if (current) current.lines.push(line);
    }
    if (current) blocks.push(current);

    const records = blocks.map((block, index) => {
      const bodyText = block.lines.join("\n");
      const features = textFeatureMap(bodyText);
      const hardware = cleanText(
        [features.CPU, features["内存"] ?? features.RAM, features["硬盘"] ?? features.Disk]
          .filter(Boolean)
          .join(" / ")
      );
      const bandwidth = cleanText(
        [
          features["带宽"] ?? features.Bandwidth,
          features["流量"] ?? features.Traffic,
          features["转发"] ?? features["Port Forwarding"]
        ]
          .filter(Boolean)
          .join(" / ")
      );
      const route = features.IP ?? features.T ?? source.routeHint ?? null;
      const snapshotStatus = statusFromSnapshotStock(block.stockLabel, bodyText);
      const status = "unknown";
      const statusLabel = `快照: ${block.stockLabel}（实时库存未确认）`;
      const price = extractAaitrPrice(bodyText);

      return baseRecord(source, fetchResult, {
        id: `${source.id}-reader-${readerPathSlug(sourcePageUrl, index)}`,
        name: block.name,
        region: features["位置"] ?? features.Location ?? source.regionHint ?? null,
        route,
        note: "第三方 Reader 快照；本轮未取得可解析的官方数据，详见尝试记录",
        hardware,
        bandwidth,
        price,
        priceValue: parsePriceValue(price),
        status,
        statusLabel,
        stockCount: null,
        orderUrl: sourcePageUrl,
        evidence: `AaITR reader_snapshot parsed ${sourcePageUrl}; stock=${block.stockLabel}; no parseable official product data obtained; see attempts`,
        raw: {
          snapshotStatus,
          stockLabel: block.stockLabel,
          features,
          strategy: "reader_snapshot",
          sourcePageUrl,
          attempt
        }
      });
    });

    if (records.length === 0) throw new Error("AaITR Reader snapshot product blocks not found");
    return records;
  }

  function findChromeExecutable() {
    const candidates = [
      env.AAITR_CHROME_BIN,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser"
    ].filter(Boolean);
    return candidates.find((path) => existsSync(path)) ?? null;
  }

  async function renderWithChrome(source, targetUrl, chromeBin) {
    const timeoutMs = Number(source.browserProbe?.timeoutMs ?? 25_000);
    const virtualTimeBudgetMs = Number(source.browserProbe?.virtualTimeBudgetMs ?? 12_000);
    const { stdout } = await execFileAsync(
      chromeBin,
      [
        "--headless=new",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-sandbox",
        `--virtual-time-budget=${virtualTimeBudgetMs}`,
        "--dump-dom",
        targetUrl
      ],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, signal: source.signal }
    );
    return {
      ok: true,
      statusCode: null,
      finalUrl: targetUrl,
      headers: {},
      html: stdout,
      via: "headless_chrome"
    };
  }

  async function tryAaitrHttp(source, targetUrl, strategy, attempts) {
    const fetchResult = await fetchHtml(source, targetUrl, true);
    if (isAntiBotResult(fetchResult)) {
      const attempt = summarizeAttempt(
        strategy,
        targetUrl,
        fetchResult,
        "blocked",
        "anti-bot challenge"
      );
      attempts.push(attempt);
      return { records: null, fetchResult };
    }
    if (!fetchResult.ok) {
      attempts.push(
        summarizeAttempt(
          strategy,
          targetUrl,
          fetchResult,
          "http_error",
          `HTTP ${fetchResult.statusCode}`
        )
      );
      return { records: null, fetchResult };
    }
    try {
      const attempt = summarizeAttempt(
        strategy,
        targetUrl,
        fetchResult,
        "parsed",
        "product parser accepted page"
      );
      const records = parseAaitrStorePage(source, fetchResult, strategy, attempt);
      attempts.push(attempt);
      return { records, fetchResult };
    } catch (error) {
      attempts.push(
        summarizeAttempt(strategy, targetUrl, fetchResult, "parse_error", error.message)
      );
      return { records: null, fetchResult };
    }
  }

  async function discoverAaitrUrls(source, attempts) {
    const discovered = [];
    for (const targetUrl of source.discoveryUrls ?? []) {
      try {
        const fetchResult = await fetchHtml(source, targetUrl, true);
        if (isAntiBotResult(fetchResult)) {
          attempts.push(
            summarizeAttempt("discovery", targetUrl, fetchResult, "blocked", "anti-bot challenge")
          );
          continue;
        }
        if (!fetchResult.ok) {
          attempts.push(
            summarizeAttempt(
              "discovery",
              targetUrl,
              fetchResult,
              "http_error",
              `HTTP ${fetchResult.statusCode}`
            )
          );
          continue;
        }
        const urls = extractUrlsFromText(fetchResult.finalUrl ?? targetUrl, fetchResult.html);
        discovered.push(...urls.filter((url) => /\/store\/|cart\.php\?gid=/.test(url)));
        attempts.push(
          summarizeAttempt(
            "discovery",
            targetUrl,
            fetchResult,
            "discovered",
            `${urls.length} AaITR URL(s) found`
          )
        );
      } catch (error) {
        attempts.push(summarizeErrorAttempt("discovery", targetUrl, error));
      }
    }
    return orderedUniqueUrls(discovered);
  }

  async function tryAaitrReaderSnapshot(source, sourcePageUrl, attempts) {
    const targetUrl = readerTargetUrl(source, sourcePageUrl);
    const fetchResult = await fetchHtml(source, targetUrl);
    if (!fetchResult.ok) {
      attempts.push(
        summarizeAttempt(
          "reader_snapshot",
          targetUrl,
          fetchResult,
          "http_error",
          `HTTP ${fetchResult.statusCode}`
        )
      );
      return { records: null, fetchResult };
    }
    if (isAntiBotResult(fetchResult)) {
      attempts.push(
        summarizeAttempt(
          "reader_snapshot",
          targetUrl,
          fetchResult,
          "blocked",
          "reader returned anti-bot content"
        )
      );
      return { records: null, fetchResult };
    }
    try {
      const attempt = summarizeAttempt(
        "reader_snapshot",
        targetUrl,
        fetchResult,
        "parsed",
        `third-party reader parsed ${sourcePageUrl}`
      );
      const records = parseAaitrReaderSnapshot(source, fetchResult, sourcePageUrl, attempt);
      attempts.push(attempt);
      return { records, fetchResult };
    } catch (error) {
      attempts.push(
        summarizeAttempt("reader_snapshot", targetUrl, fetchResult, "parse_error", error.message)
      );
      return { records: null, fetchResult };
    }
  }

  async function monitorAaitrStore(source) {
    const attempts = [];
    let lastFetchResult = null;
    const initialCandidates = orderedUniqueUrls([source.url, ...(source.fallbackUrls ?? [])]);

    for (const targetUrl of initialCandidates) {
      try {
        const result = await tryAaitrHttp(source, targetUrl, "direct_http", attempts);
        lastFetchResult = result.fetchResult ?? lastFetchResult;
        if (result.records?.length) {
          return result.records.map((record) => ({ ...record, raw: { ...record.raw, attempts } }));
        }
      } catch (error) {
        attempts.push(summarizeErrorAttempt("direct_http", targetUrl, error));
      }
    }

    const discoveredCandidates = (await discoverAaitrUrls(source, attempts)).filter(
      (url) => !initialCandidates.includes(url)
    );
    for (const targetUrl of discoveredCandidates) {
      try {
        const result = await tryAaitrHttp(source, targetUrl, "discovered_http", attempts);
        lastFetchResult = result.fetchResult ?? lastFetchResult;
        if (result.records?.length) {
          return result.records.map((record) => ({ ...record, raw: { ...record.raw, attempts } }));
        }
      } catch (error) {
        attempts.push(summarizeErrorAttempt("discovered_http", targetUrl, error));
      }
    }

    if (source.browserProbe?.enabled !== false) {
      const chromeBin = findChromeExecutable();
      const browserCandidates = orderedUniqueUrls([
        ...initialCandidates,
        ...discoveredCandidates
      ]).slice(0, Number(source.browserProbe?.maxUrls ?? 1));
      if (!chromeBin) {
        attempts.push({
          strategy: "headless_chrome",
          url: null,
          finalUrl: null,
          httpStatus: null,
          ok: false,
          via: "headless_chrome",
          bytes: 0,
          outcome: "skipped",
          note: "Chrome executable not found"
        });
      } else {
        for (const targetUrl of browserCandidates) {
          try {
            const fetchResult = await renderWithChrome(source, targetUrl, chromeBin);
            lastFetchResult = fetchResult;
            if (isAntiBotResult(fetchResult)) {
              attempts.push(
                summarizeAttempt(
                  "headless_chrome",
                  targetUrl,
                  fetchResult,
                  "blocked",
                  "rendered anti-bot challenge"
                )
              );
              continue;
            }
            const attempt = summarizeAttempt(
              "headless_chrome",
              targetUrl,
              fetchResult,
              "parsed",
              "rendered DOM parser accepted page"
            );
            const records = parseAaitrStorePage(source, fetchResult, "headless_chrome", attempt);
            attempts.push(attempt);
            if (records.length) {
              return records.map((record) => ({ ...record, raw: { ...record.raw, attempts } }));
            }
          } catch (error) {
            attempts.push(summarizeErrorAttempt("headless_chrome", targetUrl, error));
          }
        }
      }
    }

    if (source.readerSnapshot?.enabled !== false) {
      const readerCandidates = orderedUniqueUrls(
        source.readerSnapshot?.urls?.length
          ? source.readerSnapshot.urls
          : [...initialCandidates, ...discoveredCandidates]
      );
      const readerRecords = [];
      for (const targetUrl of readerCandidates) {
        try {
          const result = await tryAaitrReaderSnapshot(source, targetUrl, attempts);
          lastFetchResult = result.fetchResult ?? lastFetchResult;
          if (result.records?.length) readerRecords.push(...result.records);
        } catch (error) {
          attempts.push(summarizeErrorAttempt("reader_snapshot", targetUrl, error));
        }
      }
      if (readerRecords.length) {
        return readerRecords.map((record) => ({ ...record, raw: { ...record.raw, attempts } }));
      }
    }

    const blocked = attempts.some((attempt) => attempt.outcome === "blocked");
    const reason = blocked
      ? `AaITR product data is protected by anti-bot challenge after ${attempts.length} attempt(s)`
      : `AaITR product parser could not find live product data after ${attempts.length} attempt(s)`;
    if (blocked) {
      return [blockedRecord(source, lastFetchResult, reason, { raw: { attempts } })];
    }
    return [errorRecord(source, new Error(reason), { raw: { attempts } })];
  }

  async function monitorSource(source) {
    try {
      if (source.adapter === "aaitr_store") return await monitorAaitrStore(source);
      if (source.adapter === "public_catalog") {
        return await monitorPublicCatalog(source, {
          fetchHtml,
          isAntiBotResult,
          baseRecord,
          blockedRecord,
          errorRecord,
          deadline: source.deadline
        });
      }
      if (source.adapter === "whmcs_pid_watch") {
        return await monitorWhmcsPidWatch(source, {
          waitForRequestSlot,
          userAgent,
          isAntiBotResult,
          baseRecord,
          blockedRecord,
          errorRecord
        });
      }

      const fetchResult = await fetchHtml(source);
      if (
        source.adapter === "vircs_inertia_product" &&
        new URL(fetchResult.finalUrl).host !== new URL(source.url).host
      ) {
        return [
          errorRecord(
            source,
            new Error(`VIRCS redirected outside source host: ${source.url} -> ${fetchResult.finalUrl}`),
            {
              finalUrl: fetchResult.finalUrl,
              httpStatus: fetchResult.statusCode
            }
          )
        ];
      }

      if (!fetchResult.ok && isAntiBotResult(fetchResult)) {
        return [
          blockedRecord(
            source,
            fetchResult,
            `Provider returned anti-bot response with HTTP ${fetchResult.statusCode}`
          )
        ];
      }

      if (!fetchResult.ok) {
        return [
          baseRecord(source, fetchResult, {
            diagnostic: true,
            name: `${source.provider} 监控源`,
            status: "error",
            statusLabel: `HTTP ${fetchResult.statusCode}`,
            price: null,
            priceValue: null,
            hardware: null,
            bandwidth: null,
            stockCount: null,
            orderUrl: source.url,
            evidence: `HTTP request failed with ${fetchResult.statusCode}`,
            error: `HTTP ${fetchResult.statusCode}`
          })
        ];
      }

      if (source.adapter === "vircs_inertia_product") return parseVircs(source, fetchResult);
      if (source.adapter === "whmcs_group") return parseWhmcsGroup(source, fetchResult);
      if (source.adapter === "racknerd_kvm") {
        return parseRacknerdKvm(source, fetchResult, { cleanText, parsePriceValue, baseRecord });
      }
      if (source.adapter === "zlidc_product_wrap") {
        return parseZlidcProductWrap(source, fetchResult, generatedAt, {
          absoluteUrl,
          cleanText,
          parsePriceValue
        });
      }
      if (source.adapter === "lagom_product_list") {
        return parseLagomProductList(source, fetchResult, generatedAt, {
          absoluteUrl,
          cleanText,
          nodeLines,
          parsePriceValue
        });
      }
      throw new Error(`Unsupported adapter: ${source.adapter}`);
    } catch (error) {
      return [errorRecord(source, error)];
    }
  }

  async function mapWithConcurrency(items, limit, mapper) {
    const out = [];
    let cursor = 0;
    async function worker() {
      while (cursor < items.length) {
        const index = cursor++;
        out[index] = await mapper(items[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  function sourceLaneKey(source) {
    try {
      return new URL(source.url).hostname.replace(/^www\./, "");
    } catch {
      return source.id;
    }
  }

  function buildSourceLanes(items) {
    const lanes = new Map();
    items.forEach((source, index) => {
      const key = sourceLaneKey(source);
      if (!lanes.has(key)) lanes.set(key, []);
      lanes.get(key).push({ source, index });
    });
    return [...lanes.values()].sort((a, b) => b.length - a.length);
  }

  async function timedMonitorSource(source) {
    const startedMs = Date.now();
    const budget = Number(source.timeBudgetMs ?? sourceTimeBudgetMs);
    if (!Number.isFinite(budget) || budget <= 0) {
      throw new Error(`Invalid time budget for ${source.id}`);
    }
    if (collectionState && !collectionState.due(source.id, new Date().toISOString())) {
      const health = collectionState.sourceState(source.id);
      const records = [
        {
          ...errorRecord(source, new Error(`上次核验受限，冷却至 ${health.nextAttemptAt} 后重试`)),
          id: `${source.id}:diagnostic`,
          diagnostic: true,
          status: "blocked",
          statusLabel: "冷却中",
          raw: { cooldownUntil: health.nextAttemptAt }
        }
      ];
      return {
        records: collectionState.saveSource(source, records, new Date().toISOString(), generatedAt, {
          skipped: true
        }),
        durationMs: 0
      };
    }
    if (collectionState) {
      source = {
        ...source,
        skuPriority: collectionState.priorityPids(source.id),
        catalogUrls: [
          ...new Set([
            ...(source.catalogUrls ?? []),
            ...collectionState.pendingJobs(source.id).map((j) => j.url)
          ])
        ].slice(0, 32)
      };
    }
    const records = await collectWithResidentialFallback(
      source,
      async (attemptSource) => {
        const remaining = budget - (Date.now() - startedMs);
        if (remaining <= 0) {
          return [
            {
              ...errorRecord(
                source,
                new Error("Source time budget exceeded; collection is incomplete")
              ),
              diagnostic: true
            }
          ];
        }
        const controller = new AbortController();
        const timer = setTimeout(
          () =>
            controller.abort(new Error("Source time budget exceeded; collection is incomplete")),
          remaining
        );
        try {
          return await monitorSource({
            ...attemptSource,
            signal: controller.signal,
            deadline: Date.now() + remaining
          });
        } finally {
          clearTimeout(timer);
        }
      },
      env.MONITOR_FALLBACK_PROXY,
      { dmitEnabled: Boolean(env.MONITOR_DMIT_CURL_LIB) }
    );
    return {
      records: collectionState
        ? collectionState.saveSource(source, records, new Date().toISOString(), generatedAt)
        : records,
      durationMs: Date.now() - startedMs
    };
  }

  try {
    collectionState?.seed(previousPayload);
    const runStartedMs = Date.now();

    if (env.MONITOR_ANNOUNCEMENTS === "1") {
      if (!collectionState) {
        throw new Error("Announcement collection requires MONITOR_STATE_DB");
      }
      const annConfigPath = resolveConfigFile(
        cwd,
        "monitor/announcements.json",
        defaultAnnouncementsPath
      );
      await refreshAnnouncements(
        collectionState,
        JSON.parse(readFileSync(annConfigPath, "utf8")),
        sources
      );
    }

    const timings = [];
    const resultsBySource = [];
    await mapWithConcurrency(buildSourceLanes(sources), monitorConcurrency, async (lane) => {
      for (const { source, index } of lane) {
        const { records, durationMs } = await timedMonitorSource(source);
        resultsBySource[index] = validateSourceRecords(
          source,
          records,
          enrichProductSignals,
          errorRecord
        );
        timings.push({ id: source.id, durationMs });
      }
    });

    const products = resultsBySource.flat();
    products.sort(
      (a, b) =>
        statusRank(a.status) - statusRank(b.status) ||
        (a.priceValue ?? 999_999) - (b.priceValue ?? 999_999)
    );

    const summary = products.reduce(
      (acc, product) => {
        acc.total += 1;
        acc[product.status] = (acc[product.status] ?? 0) + 1;
        return acc;
      },
      { total: 0, available: 0, unavailable: 0, unknown: 0, blocked: 0, error: 0 }
    );

    const generatedAtMs = Date.parse(generatedAt);
    const maxProductTimestampMs = products.reduce((maxMs, p) => {
      for (const candidate of [
        p?.observedAt,
        p?.verification?.observedAt,
        p?.verification?.attemptedAt,
        p?.verification?.verifiedAt
      ]) {
        const ms = candidate ? Date.parse(candidate) : NaN;
        if (Number.isFinite(ms) && ms > maxMs) maxMs = ms;
      }
      return maxMs;
    }, generatedAtMs);
    const publishedAt = new Date(Math.max(Date.now(), maxProductTimestampMs)).toISOString();

    const payload = {
      schemaVersion: 1,
      generatedAt,
      publishedAt,
      ...(collectionState ? { sourceHealth: collectionState.sourceHealth() } : {}),
      ...(collectionState && env.MONITOR_ANNOUNCEMENTS === "1"
        ? { announcements: collectionState.announcementPayload(publishedAt) }
        : {}),
      sourceCount: sources.length,
      summary,
      ...trackEvents(previousPayload, { generatedAt, products }),
      ...(exchangeRates ? { exchangeRates } : {}),
      products
    };

    const expectedSourceIds = sources.map((source) => source.id);
    const validationErrors = validateMonitorPayload(payload, { expectedSourceIds });
    if (validationErrors.length) {
      throw new Error(
        `Monitor data validation failed: ${validationErrors.slice(0, 5).join("; ")}`
      );
    }

    if (!onlySourceIds.size && isDefaultProdOutput) {
      const observationsByProduct = collectionState
        ? collectionState.recentObservationsByProduct(10)
        : new Map();
      await publishBatch({
        fullPayload: payload,
        dataDir,
        v1OutputPath: outputPath,
        expectedSourceIds,
        observationsByProduct,
        logger
      });
    } else {
      mkdirSync(dirname(outputPath), { recursive: true });
      const tempProductsPath = `${outputPath}.${process.pid}.tmp`;
      writeFileSync(tempProductsPath, `${JSON.stringify(payload, null, 2)}\n`);
      renameSync(tempProductsPath, outputPath);
    }

    collectionState?.finishRun(generatedAt, summary);
    logger.log(
      `Wrote ${outputPath} with ${products.length} records from ${sources.length} sources in ${((Date.now() - runStartedMs) / 1000).toFixed(1)}s (concurrency ${monitorConcurrency})`
    );
    logger.log(JSON.stringify(summary));
    logger.log(
      `Slowest sources: ${timings
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 10)
        .map((t) => `${t.id}=${(t.durationMs / 1000).toFixed(1)}s`)
        .join(", ")}`
    );
    return payload;
  } finally {
    collectionState?.close();
  }
}
