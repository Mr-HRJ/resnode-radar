import { webcrypto } from "node:crypto";
import { parse } from "node-html-parser";
import { catalogUrlAllowed, cleanPublicUrl } from "./catalog-pages.mjs";

// The anonymous storefront publishes both its AES-GCM decoder and encoding key.
// Read that client on each run so rotation cannot silently produce stale prices.
export function panstarPublicKey(script) {
  if (!script.includes("X-Api-Encrypt") || !script.includes("AES-GCM")) return null;
  const keys = [...script.matchAll(/"([A-Za-z0-9+/]{43}=)"\.trim\(\)/g)];
  return keys.length === 1 ? Buffer.from(keys[0][1], "base64") : null;
}

export async function decodePanstarResponse(result, key) {
  let payload = JSON.parse(result.html);
  if (result.headers?.["x-api-encrypt"] === "1") {
    if (!key || (result.headers["x-api-encrypt-alg"] && result.headers["x-api-encrypt-alg"] !== "AES-GCM") || !result.headers["x-api-encrypt-iv"] || typeof payload.ciphertext !== "string") throw new Error("Panstar public response encoding changed");
    const cryptoKey = await webcrypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
    const bytes = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(result.headers["x-api-encrypt-iv"], "base64") }, cryptoKey, Buffer.from(payload.ciphertext, "base64"));
    payload = JSON.parse(Buffer.from(bytes).toString("utf8"));
  }
  if (payload.code !== 0 || !Array.isArray(payload.data)) throw new Error(`Panstar public catalog returned code ${payload.code ?? "missing"} or an invalid list`);
  return payload.data;
}

const publicItem = (item) => item && (item.status == null || item.status === 0) && (!item.visibilityMode || item.visibilityMode === "PUBLIC");
const idOf = (item) => {
  if (!Number.isSafeInteger(item.id) || item.id <= 0) throw new Error("Panstar public catalog ID changed");
  return item.id;
};

export function parsePanstarPlans(source, result, plans, product, region, { baseRecord }) {
  return plans.filter((plan) => publicItem(plan) && !plan.archived).map((plan) => {
    const id = idOf(plan);
    const cycle = plan.cycle ?? 1;
    if (![1, 3, 6, 12].includes(cycle)) throw new Error("Panstar billing cycle changed");
    const cents = cycle === 12 && plan.annualPrice > 0 ? plan.annualPrice : (plan.monthlyPrice ?? plan.price) * cycle;
    if (!plan.name || !Number.isSafeInteger(cents) || cents <= 0 || !Number.isFinite(plan.cpu) || !Number.isFinite(plan.memory) || !Number.isFinite(plan.disk)) throw new Error("Panstar plan price or hardware schema changed");
    const restricted = Boolean(plan.levelStockEnabled || plan.flashPurchaseEnabled || plan.saleMode);
    const status = plan.stockAvailable === false ? "unavailable" : plan.stockAvailable === true && !restricted ? "available" : "unknown";
    const countries = { US: "美国", HK: "香港", DE: "德国", JP: "日本", FR: "法国", GB: "英国", SG: "新加坡", KR: "韩国", TW: "台湾" };
    const orderUrl = new URL(`/servers?regionId=${idOf(region)}&productId=${idOf(product)}&planId=${id}&cycle=${cycle}`, source.url).href;
    return baseRecord(source, result, {
      id: `${source.id}:plan:${idOf(product)}:${id}`, name: plan.name, category: "vps",
      sourceUrl: result.finalUrl, region: countries[region.icon] || region.name,
      route: product.networkLineProfile?.technicalRoute || product.name,
      hardware: `${plan.cpu} vCPU / ${plan.memory} MB RAM / ${plan.disk} GB`,
      bandwidth: [Number.isFinite(plan.bindwidth) && `${plan.bindwidth} Mbps`, Number.isFinite(plan.traffic) && `${plan.traffic} GB 流量`, Number.isFinite(plan.ipNum) && `${plan.ipNum} IPv4`, Number.isFinite(plan.ip6Num) && `${plan.ip6Num} IPv6`, plan.networkMode === "NAT" && "NAT 共享 IP"].filter(Boolean).join(" / "),
      price: `$${(cents / 100).toFixed(2)} / ${cycle === 1 ? "月" : cycle === 3 ? "季" : cycle === 6 ? "半年" : "年"}`,
      priceValue: cents / 100, currency: "USD", status, stockCount: null,
      statusLabel: status === "available" ? "官方标注可用" : status === "unavailable" ? "官方标注售罄" : restricted ? "需确认活动资格" : "库存未公开",
      orderUrl, note: restricted ? "官网标注活动、预售或等级限制；请确认购买资格。" : "官方公开目录；按最低购买周期列价，数量未公开。",
      evidence: `Official anonymous catalog; stockAvailable=${plan.stockAvailable ?? "not stated"}; cycle=${cycle}; networkMode=${plan.networkMode ?? "not stated"}`,
      raw: { planId: id, productId: idOf(product), billingCycleMonths: cycle, stockAvailable: plan.stockAvailable ?? null, restricted }
    });
  });
}

export async function monitorPanstarCatalog(source, helpers) {
  const { fetchHtml, baseRecord, blockedRecord, errorRecord, deadline = Infinity, now = Date.now } = helpers;
  const records = new Map(), attempts = [], seenProducts = new Set();
  let key, lastResult, pageLimitReached = false, timeBudgetReached = false, failure;
  const maxRequests = 80;
  async function read(url) {
    if (now() >= deadline || source.signal?.aborted) { timeBudgetReached = true; throw new Error("Panstar source time budget exceeded; coverage incomplete"); }
    if (attempts.length >= maxRequests) { pageLimitReached = true; throw new Error("Panstar request budget exceeded; coverage incomplete"); }
    if (!cleanPublicUrl(url) || !catalogUrlAllowed(url, source)) throw new Error("Panstar catalog URL outside official hosts");
    const attempt = { url }; attempts.push(attempt);
    const result = await fetchHtml(source, url); lastResult = result;
    attempt.httpStatus = result.statusCode;
    if (!catalogUrlAllowed(result.finalUrl, source)) throw new Error("Panstar catalog redirected outside official hosts");
    if (!result.ok || result.headers?.["cf-mitigated"] === "challenge") throw new Error(`Panstar public catalog HTTP ${result.statusCode}`);
    return result;
  }
  const apiUrl = (path) => new URL(`/api/ecs/catalog/${path}`, source.url).href;
  async function list(path) {
    const result = await read(apiUrl(path));
    return { result, data: await decodePanstarResponse(result, key) };
  }
  try {
    const regionResult = await read(apiUrl("regions"));
    if (regionResult.headers?.["x-api-encrypt"] === "1") {
      const page = await read(source.url);
      const scripts = parse(page.html).querySelectorAll("script[src]").map((node) => cleanPublicUrl(node.getAttribute("src"), page.finalUrl)).filter((url) => url && new URL(url).origin === new URL(source.url).origin && new URL(url).pathname.startsWith("/_next/static/chunks/"));
      for (const url of [...new Set(scripts)].reverse()) {
        const client = await read(url);
        key = panstarPublicKey(client.html);
        if (key) break;
      }
      if (!key) throw new Error("Panstar published public decoder was not found");
    }
    const regions = await decodePanstarResponse(regionResult, key);
    for (const region of regions.filter(publicItem)) {
      const { data: products } = await list(`products-by-region?regionId=${idOf(region)}`);
      for (const product of products.filter(publicItem)) {
        const productId = idOf(product);
        if (seenProducts.has(productId)) continue;
        seenProducts.add(productId);
        if (product.productLine && product.productLine !== "CLASSIC_CLOUD_SERVER") continue;
        const { result, data: plans } = await list(`plans?productId=${productId}`);
        for (const record of parsePanstarPlans(source, result, plans, product, region, helpers)) records.set(record.id, record);
      }
    }
  } catch (error) {
    timeBudgetReached ||= now() >= deadline || Boolean(source.signal?.aborted);
    const refused = [401, 403, 429].includes(lastResult?.statusCode) || lastResult?.headers?.["cf-mitigated"] === "challenge";
    failure = refused ? blockedRecord(source, lastResult, error.message) : errorRecord(source, error);
  }
  if (failure || !records.size) records.set(`${source.id}:diagnostic`, {
    ...(failure || baseRecord(source, lastResult, { name: `${source.provider} 采集状态`, status: "unknown", statusLabel: "未解析到套餐", evidence: "官方公开目录未返回套餐；不能据此判断售罄。" })),
    id: `${source.id}:diagnostic`, diagnostic: true, raw: { attempts }
  });
  return [...records.values()].map((record) => ({ ...record, collection: { pagesChecked: attempts.length, pageLimitReached, ...(timeBudgetReached ? { timeBudgetReached } : {}), failedPages: failure ? 1 : 0 } }));
}
