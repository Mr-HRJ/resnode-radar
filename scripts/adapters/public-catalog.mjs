import { parseCatalogApi, parseNodeMach } from "./catalog-api.mjs";
import { parseMarketingCatalog } from "./marketing-catalogs.mjs";
import { parseAdditionalCatalog } from "./additional-catalogs.mjs";
import { parseDynamicCatalog } from "./dynamic-catalogs.mjs";
import { parse } from "node-html-parser";
import { cleanPublicUrl, catalogUrlAllowed, discoverCatalogLinks, parseCatalogPage } from "./catalog-pages.mjs";

// A bounded walk of published catalog links. Checkout, login and challenge pages
// are never submitted; a blocked read is a monitoring result, not empty stock.
export async function monitorPublicCatalog(source, helpers) {
  const { fetchHtml, baseRecord, blockedRecord, errorRecord } = helpers;
  const queue = [...new Set([source.url, ...(source.catalogUrls ?? [])])].map((url) => ({ url, label: "", depth: 0 }));
  const seen = new Set();
  const products = new Map();
  const attempts = [];
  const diagnostics = [];
  const maxPages = Math.max(1, Math.min(source.maxPages ?? 12, 24));
  let lastResult = null;
  while (queue.length && seen.size < maxPages) {
    const page = queue.shift();
    if (seen.has(page.url)) continue;
    seen.add(page.url);
    let result;
    try {
      if (!cleanPublicUrl(page.url) || !catalogUrlAllowed(page.url, source)) throw new Error("Catalog URL outside configured official hosts");
      result = await fetchHtml(source, page.url);
      lastResult = result;
      if (!catalogUrlAllowed(result.finalUrl, source)) throw new Error("Catalog redirected outside configured official hosts");
      const title = parse(result.html).querySelector("title")?.text.replace(/\s+/g, " ").trim().slice(0, 160) || null;
      const access = result.headers?.["cf-mitigated"] === "challenge" || /Just a moment|Attention Required.*Cloudflare|Security Check|安全验证/i.test(title || "") ? "challenge"
        : /Access Denied/i.test(title || "") ? "access-denied" : result.statusCode === 429 ? "rate-limited" : [401, 403].includes(result.statusCode) ? `http-${result.statusCode}` : null;
      const attempted = { url: page.url, finalUrl: result.finalUrl, httpStatus: result.statusCode, title };
      if (access) {
        attempts.push({ ...attempted, status: "blocked", reason: access });
        diagnostics.push(blockedRecord(source, result, `公开页面访问受限（HTTP ${result.statusCode}${title ? `，${title}` : ""}），库存无法确认`));
        continue;
      }
      if (!result.ok) throw new Error(`公开目录返回 HTTP ${result.statusCode}`);
      const destination = new URL(result.finalUrl);
      if (/\/(?:login|signin|sign-in|clientarea)(?:\/|$|[?#])/i.test(`${destination.pathname}${destination.search}`)) {
        attempts.push({ ...attempted, status: "blocked", reason: "login-required" });
        diagnostics.push({ ...blockedRecord(source, result, "公开产品入口跳转到登录页，当前采集环境无法读取套餐；不能据此判断售罄。"), statusLabel: "需登录访问" });
        continue;
      }
      const records = source.catalogFormat === "usvps24" ? parseUsvps24(source, result, helpers)
        : source.catalogFormat === "nodemach" ? parseNodeMach(source, result, helpers)
          : ["miraigrid", "100tb"].includes(source.catalogFormat) ? parseCatalogApi(source, result, helpers)
            : ["evoxt", "vps"].includes(source.catalogFormat) ? parseMarketingCatalog(source, result, helpers)
              : ["zgovps", "berohost", "spartan"].includes(source.catalogFormat) ? parseAdditionalCatalog(source, result, helpers)
                : ["neburst", "skyline"].includes(source.catalogFormat) ? parseDynamicCatalog(source, result, helpers)
                  : parseCatalogPage({ ...source, pageLabel: page.label }, result, helpers);
      attempts.push({ ...attempted, status: records.length ? "parsed" : "no-products", products: records.length });
      for (const record of records) products.set(record.id, record);
      if (page.depth < 2 && source.discover !== false) {
        queue.push(...discoverCatalogLinks(result.html, result.finalUrl, source).filter((link) => !seen.has(link.url)).map((link) => ({ ...link, depth: page.depth + 1 })));
      }
    } catch (error) {
      attempts.push({ url: page.url, status: "error", message: error.message });
      diagnostics.push(errorRecord(source, error, { sourceUrl: page.url, finalUrl: result?.finalUrl ?? page.url, httpStatus: result?.statusCode ?? null }));
    }
  }
  const coverage = { pagesChecked: seen.size, pageLimitReached: queue.some((page) => !seen.has(page.url)), attempts };
  const records = [...products.values()];
  // Keep partial failures visible alongside the successfully parsed plans.
  if (diagnostics.length) records.push({ ...diagnostics[0], id: `${source.id}:diagnostic`, diagnostic: true, raw: coverage });
  if (!records.length) {
    records.push(baseRecord(source, lastResult, {
      id: `${source.id}:diagnostic`, diagnostic: true, name: `${source.provider} 采集状态`,
      status: "unknown", statusLabel: "未解析到套餐", price: null, priceValue: null,
      hardware: null, bandwidth: null, stockCount: null, orderUrl: null,
      evidence: source.accessNote || "公开页面未返回可解析的 VPS 套餐；可能需要登录或动态加载，不能据此判断库存。", raw: coverage
    }));
  }
  return records.map((record) => ({ ...record, collection: { pagesChecked: coverage.pagesChecked, pageLimitReached: coverage.pageLimitReached, failedPages: diagnostics.length, ...(source.coverageNote ? { scopeNote: source.coverageNote } : {}) } }));
}

export function parseUsvps24(source, result, { baseRecord }) {
  const root = parse(result.html);
  const value = root.querySelector("[data-page]")?.getAttribute("data-page");
  if (!value) throw new Error("USVPS24 public Inertia payload missing");
  const plans = JSON.parse(value).props?.plans;
  if (!Array.isArray(plans)) throw new Error("USVPS24 public plans missing");
  return plans.map((plan) => {
    if (!plan.name || typeof plan.available !== "boolean" || !Number.isFinite(plan.price) || !/^[A-Z]{3}$/.test(plan.currency)) throw new Error("USVPS24 plan schema changed");
    const specs = plan.specs ?? {};
    const count = Number.isInteger(plan.stock) && plan.stock >= 0 ? plan.stock : null;
    const restricted = plan.eligible === false || plan.coming_soon || plan.is_preorder;
    const status = !plan.available || count === 0 ? "unavailable" : restricted ? "unknown" : "available";
    return baseRecord(source, result, {
      id: `${source.id}:plan:${plan.id}`, name: plan.name,
      category: /家宽|家寬|住宅|residential/i.test(`${plan.name} ${specs.ip_type}`) ? "home" : "vps",
      region: "美国", route: specs.line_badge || specs.ip_type || null,
      hardware: [specs.cpu && `${specs.cpu} vCPU`, specs.ram_mb && `${specs.ram_mb} MB RAM`, specs.disk_gb && `${specs.disk_gb} GB SSD`].filter(Boolean).join(" / "),
      bandwidth: [specs.bandwidth_mbps && `${specs.bandwidth_mbps} Mbps`, specs.traffic_gb && `${specs.traffic_gb} GB`, specs.ip_count && `${specs.ip_count} IPv4`].filter(Boolean).join(" / "),
      price: `${plan.currency} ${plan.price}/月`, priceValue: plan.price,
      status, statusLabel: status === "available" ? (count === null ? "官方标注可用" : `库存 ${count}`) : status === "unavailable" ? "不可订购" : "需确认购买资格",
      stockCount: count, orderUrl: source.url,
      note: restricted ? "页面标注邀请制、预售或资格限制；请向官方确认。" : "官方公开套餐数据",
      evidence: `Official page structured plans; available=${plan.available}; eligible=${plan.eligible}; stock=${count ?? "not stated"}`,
      raw: { productId: plan.id, eligible: plan.eligible, unavailableReason: plan.unavailable_reason }
    });
  });
}
