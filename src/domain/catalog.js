import { providers } from "../../providers.js";
import { comparePrices } from "../../pricing.js";
import { savedKey } from "../../saved.js";
import { hasSharedIpEvidence } from "./network.js";
import {
  BUDGET_OPTIONS,
  CYCLE_OPTIONS,
  MACRO_REGIONS,
  ROUTE_OPTIONS,
  describePricing,
  detectedRoutes,
  macroRegionsFor,
  matchesRoute,
  normalizeSearch,
  plain,
  productRegions,
  productSearchText,
  productSpecs,
  regionFlag
} from "./format.js";

export const REVIEW_DOSSIERS = {
  aaitr: { path: "reviews/aaitr.html", title: "AaITR 家宽实测档案（草稿）" },
  lisahost: { path: "reviews/lisahost.html", title: "LisaHost 实测档案（草稿）" }
};

export const RISK_EXPLANATIONS = {
  "order-only": "官方页存在下单按钮，但未公布确切可售数量，结算时仍可能缺货。",
  "stock-unstated": "商家未展示实时库存数值，建议前往官方订购页确认。",
  "incomplete-fields": "部分硬件、地区或带宽字段未在官方公开页完整列出。",
  "nat-shared": "NAT 共享 IPv4 或动态共享端口方案，非独享独立 IPv4。",
  "no-extra-risk": "抓取阶段未检测到额外受阻、快照降级或共享限制风险。",
  "manual-confirm": "交付或库存需工单/客服人工确认。",
  "third-party-snapshot": "因官方站点开启反爬验证，当前数据来自第三方 Reader 公开快照，时效与字段弱于一手直连。",
  "direct-blocked": "监控直连触发 Cloudflare/WAF 挑战页，未能直接读取官方实时库存。",
  "price-missing": "公开页面未提取到明确数值报价，请以官方下单页结算金额为准。",
  unavailable: "当前监控记录显示为售罄或不可订购。",
  "unknown-status": "页面可达但未能解析出明确的库存可用信号。"
};

export const DEFAULT_FILTERS = Object.freeze({
  track: "all",
  status: "available",
  exactOnly: false,
  noNat: false,
  noSnapshot: false,
  fixedPriceOnly: false,
  savedOnly: false,
  region: "all",
  route: "all",
  budget: "all",
  cycle: "all",
  provider: "all",
  q: "",
  sort: "recommended"
});

export const SORT_OPTIONS = [
  { value: "recommended", label: "综合推荐（证据优先）" },
  { value: "cny-asc", label: "月均参考价：低 → 高" },
  { value: "cny-desc", label: "月均参考价：高 → 低" },
  { value: "stock-desc", label: "精确库存：多 → 少" },
  { value: "event-recent", label: "近期异动优先" },
  { value: "orig-asc", label: "原币种报价：低 → 高" }
];

const residentialTextRe = /家宽|家寬|住宅|民宅|residential|dual\s*isp|双\s*isp|雙\s*isp|comcast|verizon|at&t|frontier|hinet|softbank|att\b/i;
const nativeIpRe = /原生\s*ip|native\s*ip/i;

const providerLookup = new Map();
for (const p of providers) {
  providerLookup.set(p.id.toLowerCase(), p);
  for (const name of [p.name, ...(p.aliases || []), ...(p.inventoryNames || [])]) {
    if (name) providerLookup.set(normalizeSearch(name), p);
  }
}

export function resolveProvider(product) {
  if (!product) return null;
  if (product.providerId) {
    const byId = providerLookup.get(String(product.providerId).toLowerCase());
    if (byId) return byId;
  }
  const byName = providerLookup.get(normalizeSearch(plain(product.provider)));
  return byName || null;
}

/**
 * Strict ontological classification:
 * Never conflates a datacenter VPS claiming "Native IP" with true residential/ISP broadband (`category === "home"`).
 */
export function classifyProduct(product) {
  const category = product?.category === "home" ? "home" : product?.category === "vps" ? "vps" : "unclassified";
  const textBlob = [product?.name, product?.route, product?.region, product?.note].map(plain).join(" ");
  const hasNatTag = Array.isArray(product?.riskTags) && product.riskTags.some((t) => t?.value === "nat-shared");
  const isNat = hasNatTag || hasSharedIpEvidence(product);

  const isResidential = category === "home";
  const isDualIsp = /双\s*isp|雙\s*isp|dual\s*isp/i.test(textBlob);
  const isNativeIp = nativeIpRe.test(textBlob);

  let ipTier;
  if (isResidential) {
    ipTier = isDualIsp
      ? { value: "residential-dual-isp", label: "家宽 / 双 ISP", tone: "home" }
      : { value: "residential", label: "住宅家宽 / ISP", tone: "home" };
  } else if (isNativeIp) {
    ipTier = { value: "datacenter-native", label: "机房原生 IP", tone: "vps" };
  } else {
    ipTier = { value: "datacenter", label: "机房 VPS", tone: "vps" };
  }

  const routes = detectedRoutes(product);
  const hasCnOpt = routes.some((r) => ["CN2", "9929", "CMIN2", "4837"].includes(r));
  const delivery = isNat ? "nat" : "unknown";

  return {
    category,
    isResidential,
    isDualIsp,
    isNat,
    delivery,
    ipTier,
    routes,
    hasCnOpt,
    mentionsResidentialInVps: !isResidential && residentialTextRe.test(textBlob)
  };
}

export function buildEventIndex(events = []) {
  const byProduct = new Map();
  const byProvider = new Map();
  for (const ev of events) {
    if (!ev || !ev.at) continue;
    const pid = ev.productId;
    if (pid) {
      if (!byProduct.has(pid)) byProduct.set(pid, []);
      byProduct.get(pid).push(ev);
    }
    const prov = resolveProvider(ev);
    const provId = prov?.id || ev.providerId || normalizeSearch(plain(ev.provider));
    if (provId) {
      if (!byProvider.has(provId)) byProvider.set(provId, []);
      byProvider.get(provId).push(ev);
    }
  }
  return { byProduct, byProvider };
}

export function normalizeProduct(raw, index, exchangeRates, eventIndex = new Map(), now = Date.now()) {
  // Older collectors matched "native", "international" and shared bandwidth as NAT.
  // Recheck this derived tag against the retained plan fields without changing observations.
  if (Array.isArray(raw?.riskTags) && !hasSharedIpEvidence(raw)) {
    raw = { ...raw, riskTags: raw.riskTags.filter((tag) => tag?.value !== "nat-shared") };
  }
  const providerObj = resolveProvider(raw);
  const key = savedKey(raw) || `row:${index}`;
  const classify = classifyProduct(raw);
  const pricing = describePricing(raw, exchangeRates, now);
  const specs = productSpecs(raw);
  const regions = productRegions(raw);
  const macroRegions = macroRegionsFor(raw);
  const flag = regionFlag(regions[0] || raw?.region || "");
  const search = productSearchText(raw, specs);
  const eventsForSku = eventIndex instanceof Map ? eventIndex.get(raw?.id) || [] : eventIndex?.byProduct?.get(raw?.id) || [];
  const latestEvent = eventsForSku[0] || null;
  const latestEventMs = latestEvent ? Date.parse(latestEvent.at) || 0 : 0;
  const evidenceVal = raw?.evidenceLevel?.value || "unverified";
  const isSnapshot = evidenceVal === "snapshot" || raw?.raw?.strategy === "reader_snapshot";
  const isExactStock = evidenceVal === "stock-count" && Number.isInteger(raw?.stockCount) && raw.stockCount > 0;
  const riskTags = Array.isArray(raw?.riskTags) ? raw.riskTags.filter(Boolean) : [];
  const highRiskCount = riskTags.filter((r) => r.severity === "high").length;

  return {
    ...raw,
    diagnostic: Boolean(raw?.diagnostic) || ["blocked", "error"].includes(raw?.status),
    _idx: index,
    _key: key,
    _providerId: providerObj?.id || raw?.providerId || normalizeSearch(plain(raw?.provider)) || "unknown",
    _providerName: providerObj?.name || plain(raw?.provider) || "未知商家",
    _dossier: REVIEW_DOSSIERS[providerObj?.id] || null,
    _classify: classify,
    _pricing: pricing,
    _specs: specs,
    _regions: regions,
    _macroRegions: macroRegions,
    _flag: flag,
    _search: search,
    _events: eventsForSku,
    _latestEvent: latestEvent,
    _latestEventMs: latestEventMs,
    _isExactStock: isExactStock,
    _isSnapshot: isSnapshot,
    _evidenceRank: Number.isFinite(raw?.evidenceLevel?.rank) ? raw.evidenceLevel.rank : 6,
    _highRiskCount: highRiskCount
  };
}

export function matchesCycle(product, cycle) {
  if (!cycle || cycle === "all") return true;
  const months = product?._pricing?.quote?.months;
  if (cycle === "monthly") return months === 1;
  if (cycle === "quarterly") return months === 3;
  if (cycle === "semiannual") return months === 6;
  if (cycle === "annual") return Number.isFinite(months) && months >= 12;
  return true;
}

export function matchesRegion(product, region) {
  if (!region || region === "all") return true;
  if (product._macroRegions?.includes(region)) return true;
  const target = normalizeSearch(region);
  return (product._regions || []).some((r) => normalizeSearch(r) === target);
}

export function matchesFilters(product, filters = DEFAULT_FILTERS, savedSet = new Set()) {
  if (!product || product.diagnostic) return false;
  if (filters.track === "home" && !product._classify.isResidential) return false;
  if (filters.track === "vps" && product._classify.isResidential) return false;

  if (filters.status && filters.status !== "all") {
    if (product.status !== filters.status) return false;
  }
  if (filters.exactOnly && !product._isExactStock) return false;
  if (filters.noNat && product._classify.isNat) return false;
  if (filters.noSnapshot && product._isSnapshot) return false;
  if (filters.fixedPriceOnly) {
    const q = product._pricing.quote;
    if (q.baseOnly || q.months === null || q.amount === null) return false;
  }
  if (filters.savedOnly && !savedSet.has(product._key)) return false;

  if (!matchesRegion(product, filters.region)) return false;
  if (filters.route && filters.route !== "all" && !matchesRoute(product, filters.route)) return false;

  if (filters.budget && filters.budget !== "all") {
    const max = Number(filters.budget);
    const cny = product._pricing.cnyMonthly;
    if (!Number.isFinite(cny) || cny > max) return false;
  }

  if (!matchesCycle(product, filters.cycle)) return false;

  if (filters.provider && filters.provider !== "all") {
    if (product._providerId !== filters.provider) return false;
  }

  if (filters.q && filters.q.trim()) {
    const tokens = normalizeSearch(filters.q).split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      if (!product._search.includes(token)) return false;
    }
  }

  return true;
}

export function sortProducts(list, sortKey = "recommended") {
  const arr = [...list];
  const statusWeight = (p) => (p.status === "available" ? 0 : p.status === "unknown" ? 1 : 2);
  arr.sort((a, b) => {
    if (sortKey === "cny-asc") {
      const ca = a._pricing.cnyMonthly ?? Infinity;
      const cb = b._pricing.cnyMonthly ?? Infinity;
      return statusWeight(a) - statusWeight(b) || ca - cb || comparePrices(a, b) || a._idx - b._idx;
    }
    if (sortKey === "cny-desc") {
      const ca = a._pricing.cnyMonthly ?? -1;
      const cb = b._pricing.cnyMonthly ?? -1;
      return statusWeight(a) - statusWeight(b) || cb - ca || a._idx - b._idx;
    }
    if (sortKey === "stock-desc") {
      const sa = Number.isInteger(a.stockCount) ? a.stockCount : -1;
      const sb = Number.isInteger(b.stockCount) ? b.stockCount : -1;
      return statusWeight(a) - statusWeight(b) || sb - sa || a._evidenceRank - b._evidenceRank || a._idx - b._idx;
    }
    if (sortKey === "event-recent") {
      return b._latestEventMs - a._latestEventMs || statusWeight(a) - statusWeight(b) || a._evidenceRank - b._evidenceRank || a._idx - b._idx;
    }
    if (sortKey === "orig-asc") {
      return statusWeight(a) - statusWeight(b) || comparePrices(a, b) || a._idx - b._idx;
    }
    // "recommended": available first -> stronger evidence -> no high risk -> lower CNY monthly -> original price
    const ca = a._pricing.cnyMonthly ?? Infinity;
    const cb = b._pricing.cnyMonthly ?? Infinity;
    return (
      statusWeight(a) - statusWeight(b) ||
      a._evidenceRank - b._evidenceRank ||
      a._highRiskCount - b._highRiskCount ||
      ca - cb ||
      comparePrices(a, b) ||
      a._idx - b._idx
    );
  });
  return arr;
}

export function computeFacetCounts(plans, filters, savedSet) {
  // Compute counts for each dimension with that single dimension relaxed
  const tracks = { all: 0, home: 0, vps: 0 };
  const withoutTrack = { ...filters, track: "all" };
  for (const p of plans) {
    if (!matchesFilters(p, withoutTrack, savedSet)) continue;
    tracks.all += 1;
    if (p._classify.isResidential) tracks.home += 1;
    else tracks.vps += 1;
  }

  const regions = new Map();
  const withoutRegion = { ...filters, region: "all" };
  for (const r of MACRO_REGIONS) regions.set(r.value, 0);
  for (const p of plans) {
    if (!matchesFilters(p, withoutRegion, savedSet)) continue;
    regions.set("all", (regions.get("all") || 0) + 1);
    for (const code of p._macroRegions) {
      regions.set(code, (regions.get(code) || 0) + 1);
    }
  }

  const routes = new Map();
  const withoutRoute = { ...filters, route: "all" };
  for (const r of ROUTE_OPTIONS) routes.set(r.value, 0);
  for (const p of plans) {
    if (!matchesFilters(p, withoutRoute, savedSet)) continue;
    routes.set("all", (routes.get("all") || 0) + 1);
    for (const opt of ROUTE_OPTIONS) {
      if (opt.value !== "all" && matchesRoute(p, opt.value)) {
        routes.set(opt.value, (routes.get(opt.value) || 0) + 1);
      }
    }
  }

  const providerCounts = new Map();
  const withoutProvider = { ...filters, provider: "all" };
  for (const p of plans) {
    if (!matchesFilters(p, withoutProvider, savedSet)) continue;
    providerCounts.set(p._providerId, (providerCounts.get(p._providerId) || 0) + 1);
  }

  return { tracks, regions, routes, providerCounts };
}

export function listActiveFilterBadges(filters) {
  const badges = [];
  if (filters.track !== "all") {
    badges.push({ key: "track", label: filters.track === "home" ? "赛道: 真家宽/双ISP" : "赛道: 机房/优化线路" });
  }
  if (filters.status !== DEFAULT_FILTERS.status) {
    const map = { all: "全部库存状态", unavailable: "仅看售罄", unknown: "仅看库存未公开", available: "仅看可购" };
    badges.push({ key: "status", label: `状态: ${map[filters.status] || filters.status}` });
  }
  if (filters.exactOnly) badges.push({ key: "exactOnly", label: "仅看精确库存" });
  if (filters.noNat) badges.push({ key: "noNat", label: "排除 NAT/共享" });
  if (filters.noSnapshot) badges.push({ key: "noSnapshot", label: "排除第三方快照" });
  if (filters.fixedPriceOnly) badges.push({ key: "fixedPriceOnly", label: "仅看明码固定周期" });
  if (filters.savedOnly) badges.push({ key: "savedOnly", label: "仅看本地收藏" });
  if (filters.region !== "all") {
    const m = MACRO_REGIONS.find((r) => r.value === filters.region);
    badges.push({ key: "region", label: `地区: ${m ? m.label : filters.region}` });
  }
  if (filters.route !== "all") {
    const m = ROUTE_OPTIONS.find((r) => r.value === filters.route);
    badges.push({ key: "route", label: `线路: ${m ? m.label : filters.route}` });
  }
  if (filters.budget !== "all") {
    const m = BUDGET_OPTIONS.find((b) => b.value === filters.budget);
    badges.push({ key: "budget", label: `预算: ${m ? m.label : `≤¥${filters.budget}`}` });
  }
  if (filters.cycle !== "all") {
    const m = CYCLE_OPTIONS.find((c) => c.value === filters.cycle);
    badges.push({ key: "cycle", label: `周期: ${m ? m.label : filters.cycle}` });
  }
  if (filters.provider !== "all") {
    const prov = providers.find((p) => p.id === filters.provider);
    badges.push({ key: "provider", label: `商家: ${prov ? prov.name : filters.provider}` });
  }
  if (filters.q && filters.q.trim()) {
    badges.push({ key: "q", label: `关键词: “${filters.q.trim()}”` });
  }
  return badges;
}

/**
 * Counterfactual Zero-Result Conflict Attribution Engine:
 * Simulates relaxing each active constraint individually (and high-impact pairs if needed)
 * to tell the user exactly which condition caused 0 matches and offer 1-click recovery.
 */
export function diagnoseZeroResults(plans, filters, savedSet = new Set()) {
  const candidates = [];
  const check = (keys, label, patch) => {
    const next = { ...filters, ...patch };
    let count = 0;
    for (const p of plans) {
      if (matchesFilters(p, next, savedSet)) count += 1;
    }
    if (count > 0) {
      candidates.push({ keys, label, patch, recoveredCount: count });
    }
  };

  if (filters.q && filters.q.trim()) check(["q"], `清空搜索关键词「${filters.q.trim()}」`, { q: "" });
  if (filters.track !== "all") check(["track"], "切换为「全部赛道（含家宽与机房）」", { track: "all" });
  if (filters.region !== "all") {
    const m = MACRO_REGIONS.find((r) => r.value === filters.region);
    check(["region"], `放宽地区「${m ? m.label : filters.region}」→ 全部地区`, { region: "all" });
  }
  if (filters.route !== "all") {
    const m = ROUTE_OPTIONS.find((r) => r.value === filters.route);
    check(["route"], `放宽线路「${m ? m.label : filters.route}」→ 全部线路`, { route: "all" });
  }
  if (filters.provider !== "all") {
    const prov = providers.find((p) => p.id === filters.provider);
    check(["provider"], `移除商家限定「${prov ? prov.name : filters.provider}」`, { provider: "all" });
  }
  if (filters.status === "available") check(["status"], "包含已售罄与库存未公开套餐", { status: "all" });
  else if (filters.status !== "all") check(["status"], "切回全部库存状态", { status: "all" });
  if (filters.exactOnly) check(["exactOnly"], "关闭「仅看精确库存数字」", { exactOnly: false });
  if (filters.noNat) check(["noNat"], "关闭「排除 NAT / 共享 IP」", { noNat: false });
  if (filters.noSnapshot) check(["noSnapshot"], "允许包含第三方快照记录", { noSnapshot: false });
  if (filters.fixedPriceOnly) check(["fixedPriceOnly"], "允许包含起步价/周期未明套餐", { fixedPriceOnly: false });
  if (filters.budget !== "all") check(["budget"], `放宽月均预算上限（≤¥${filters.budget}）`, { budget: "all" });
  if (filters.cycle !== "all") check(["cycle"], "放宽计费周期限制", { cycle: "all" });
  if (filters.savedOnly) check(["savedOnly"], "退出「仅看本地收藏」", { savedOnly: false });

  // Pairwise relaxation fallback if single-filter relaxation recovers nothing
  if (candidates.length === 0) {
    if (filters.track !== "all" && filters.region !== "all") {
      check(["track", "region"], "同时放宽「赛道」与「地区」限制", { track: "all", region: "all" });
    }
    if (filters.q && filters.status === "available") {
      check(["q", "status"], "清空关键词并显示含售罄在内的全部套餐", { q: "", status: "all" });
    }
  }

  candidates.sort((a, b) => b.recoveredCount - a.recoveredCount);
  return {
    activeCount: listActiveFilterBadges(filters).length,
    suggestions: candidates.slice(0, 5)
  };
}

/**
 * Provider monitoring health aggregator — preserves full diagnostic/blocked/pageLimit transparency.
 */
export function providerHealth(provider, allRecords = []) {
  const names = new Set(
    [provider?.id, provider?.name, ...(provider?.aliases || []), ...(provider?.inventoryNames || [])]
      .filter(Boolean)
      .map((v) => normalizeSearch(v))
  );
  const matched = [];
  for (const rec of allRecords) {
    if (!rec) continue;
    if (rec._providerId) {
      if (rec._providerId === provider?.id) matched.push(rec);
      continue;
    }
    const byId = provider?.id && rec.providerId && String(rec.providerId).toLowerCase() === String(provider.id).toLowerCase();
    const byName = rec.provider && names.has(normalizeSearch(plain(rec.provider)));
    if (byId || byName) matched.push(rec);
  }

  let available = 0;
  let unavailable = 0;
  let unknown = 0;
  let blocked = 0;
  let error = 0;
  let exactCount = 0;
  let pageLimitReached = false;
  const diagnostics = [];
  const plans = [];

  for (const r of matched) {
    if (r.collection?.pageLimitReached) pageLimitReached = true;
    if (r.diagnostic) {
      diagnostics.push(r);
      if (r.status === "blocked") blocked += 1;
      else if (r.status === "error") error += 1;
      else unknown += 1;
      continue;
    }
    plans.push(r);
    if (r.status === "available") {
      available += 1;
      if (r.evidenceLevel?.value === "stock-count" && Number.isInteger(r.stockCount) && r.stockCount > 0) {
        exactCount += 1;
      }
    } else if (r.status === "unavailable") {
      unavailable += 1;
    } else if (r.status === "blocked") {
      blocked += 1;
    } else if (r.status === "error") {
      error += 1;
    } else {
      unknown += 1;
    }
  }

  const known = available + unavailable;
  const hasFailure = blocked > 0 || error > 0 || diagnostics.some((d) => d.status === "blocked" || d.status === "error");

  let state = "unknown";
  if (matched.length === 0) state = "unmonitored";
  else if (available > 0 && hasFailure) state = "partial";
  else if (available > 0) state = "healthy";
  else if (hasFailure && known === 0) state = "blocked";
  else if (unavailable > 0 && hasFailure) state = "partial";
  else if (unavailable > 0) state = "soldout";
  else state = "unknown";

  return {
    state,
    total: matched.length,
    planCount: plans.length,
    known,
    available,
    unavailable,
    unknown,
    blocked,
    error,
    exactCount,
    pageLimitReached,
    diagnostics,
    plans
  };
}
