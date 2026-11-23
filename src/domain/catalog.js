import { providers } from "../../providers.js";
import { comparePrices } from "../../pricing.js";
import { savedKey } from "../../saved.js";
import { hasSharedIpEvidence } from "./network.js";
import {
  BANDWIDTH_OPTIONS,
  BUDGET_OPTIONS,
  CPU_OPTIONS,
  CYCLE_OPTIONS,
  DISK_OPTIONS,
  MACRO_REGIONS,
  MEMORY_OPTIONS,
  OPT_OPTIONS,
  ROUTE_OPTIONS,
  TRAFFIC_OPTIONS,
  declaredRouteText,
  describePricing,
  detectedRoutes,
  macroRegionsFor,
  matchesRoute,
  normalizeSearch,
  parseNumericSpecs,
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

/**
 * Editorial provider order, not measured popularity. Catalog size is not demand.
 * The four owner-selected priority brands remain visible even when collection fails.
 */
export const POPULAR_PROVIDER_WEIGHTS = Object.freeze({
  bwh: 480,
  dmit: 475,
  gomami: 470,
  vmiss: 465,
  vps: 440,
  misaka: 435,
  lisahost: 430,
  greencloud: 425,
  lightlayer: 415,
  spartan: 410,
  rfc: 400,
  zgovps: 395,
  evoxt: 390,
  saltyfish: 385,
  isif: 380,
  zorocloud: 375,
  bestvm: 370,
  neburst: 365,
  berohost: 355,
  akko: 350,
  yunyoo: 345,
  bage: 340,
  racknerd: 335,
  netcup: 330,
  wepc: 325,
  boil: 320,
  "666clouds": 315,
  hostdare: 310,
  vircs: 305,
  ipraft: 300,
  pqs: 295,
  nube: 285,
  cstonecloud: 280,
  polocloud: 275,
  usvps24: 270,
  tothost: 265,
  moonvm: 260,
  cloudsilk: 255,
  buyvm: 250,
  hosthatch: 245,
  aaitr: 240
});

export function providerBaseWeight(providerId) {
  return POPULAR_PROVIDER_WEIGHTS[String(providerId || "").toLowerCase()] || 0;
}

export function isHotProvider(providerId) {
  return ["bwh", "dmit", "gomami", "vmiss"].includes(String(providerId || "").toLowerCase());
}

export const DEFAULT_FILTERS = Object.freeze({
  track: "all",
  opt: "all",
  status: "available",
  exactOnly: false,
  noNat: false,
  noSnapshot: false,
  fixedPriceOnly: false,
  savedOnly: false,
  region: "all",
  route: "all",
  cpu: "all",
  memory: "all",
  disk: "all",
  bandwidth: "all",
  traffic: "all",
  budget: "all",
  minPrice: "",
  maxPrice: "",
  cycle: "all",
  provider: "all",
  q: "",
  sort: "recommended"
});

export const SORT_OPTIONS = [
  { value: "recommended", label: "常用商家 · 现货优先" },
  { value: "cny-asc", label: "💰 月均参考价：低 → 高" },
  { value: "cny-desc", label: "💎 月均参考价：高 → 低" },
  { value: "stock-desc", label: "📦 精确库存：多 → 少" },
  { value: "event-recent", label: "⚡ 近期补货/变价优先" },
  { value: "orig-asc", label: "💵 原币种报价：低 → 高" }
];

const residentialTextRe = /家宽|家寬|住宅|民宅|residential|dual\s*isp|双\s*isp|雙\s*isp|comcast|verizon|at&t|frontier|hinet|softbank|att\b/i;
const nativeIpRe = /原生\s*ip|native\s*ip/i;
const cnDirectTextRe = /三网直连|三網直連|回国优化|回國優化|cn优化|cn優化|大陆优化|大陸優化|精品网|精品網|cmi\b|ctggia/i;

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
  const routeDeclared = declaredRouteText(product);
  const hasNatTag = Array.isArray(product?.riskTags) && product.riskTags.some((t) => t?.value === "nat-shared");
  const isNat = hasNatTag || hasSharedIpEvidence(product);

  const isResidential = category === "home";
  const isDualIsp = /双\s*isp|雙\s*isp|dual\s*isp/i.test(textBlob);
  const isNativeIp = nativeIpRe.test(textBlob);

  const routes = detectedRoutes(product);
  const hasCnOpt =
    routes.some((r) => ["CN2", "9929", "CMIN2", "4837", "软银", "IIJ", "HiNet"].includes(r)) ||
    cnDirectTextRe.test(routeDeclared);
  const isLanding = !isResidential && !hasCnOpt;

  let ipTier;
  if (isResidential) {
    ipTier = isDualIsp
      ? { value: "residential-dual-isp", label: "家宽 · 双ISP", tone: "home" }
      : { value: "residential", label: "真家宽 · ISP", tone: "home" };
  } else if (hasCnOpt) {
    ipTier = { value: "cn-optimized", label: isNativeIp ? "优化 · 原生IP" : "CN优化直连", tone: "opt" };
  } else if (isNativeIp) {
    ipTier = { value: "datacenter-native", label: "机房原生IP", tone: "native" };
  } else {
    ipTier = { value: "datacenter", label: "国际纯落地", tone: "landing" };
  }

  const delivery = isNat ? "nat" : "unknown";

  return {
    category,
    isResidential,
    isDualIsp,
    isNativeIp,
    isNat,
    isLanding,
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
  if (Array.isArray(raw?.riskTags) && !hasSharedIpEvidence(raw)) {
    raw = { ...raw, riskTags: raw.riskTags.filter((tag) => tag?.value !== "nat-shared") };
  }
  const providerObj = resolveProvider(raw);
  const providerId = providerObj?.id || raw?.providerId || normalizeSearch(plain(raw?.provider)) || "unknown";
  const key = savedKey(raw) || `row:${index}`;
  const classify = classifyProduct(raw);
  const pricing = describePricing(raw, exchangeRates, now);
  const specs = productSpecs(raw);
  const numSpecs = parseNumericSpecs(raw, specs);
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
    _providerId: providerId,
    _providerName: providerObj?.name || plain(raw?.provider) || "未知商家",
    _providerWeight: providerBaseWeight(providerId),
    _dossier: REVIEW_DOSSIERS[providerObj?.id] || null,
    _classify: classify,
    _pricing: pricing,
    _specs: specs,
    _numSpecs: numSpecs,
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

export function matchesHardwareSpecs(product, filters) {
  const ns = product._numSpecs || {};
  if (filters.cpu && filters.cpu !== "all") {
    const c = ns.cpuCores;
    if (!Number.isFinite(c)) return false;
    if (filters.cpu === "1" && c !== 1) return false;
    if (filters.cpu === "2" && c !== 2) return false;
    if (filters.cpu === "4" && (c < 3 || c > 4)) return false;
    if (filters.cpu === "8+" && c < 6) return false;
  }
  if (filters.memory && filters.memory !== "all") {
    const m = ns.memoryGb;
    if (!Number.isFinite(m)) return false;
    if (filters.memory === "le1" && m > 1) return false;
    if (filters.memory === "2" && m !== 2) return false;
    if (filters.memory === "4" && m !== 4) return false;
    if (filters.memory === "8" && m !== 8) return false;
    if (filters.memory === "16+" && m < 16) return false;
  }
  if (filters.disk && filters.disk !== "all") {
    const d = ns.diskGb;
    if (!Number.isFinite(d)) return false;
    if (filters.disk === "le20" && d > 20) return false;
    if (filters.disk === "21-50" && (d < 21 || d > 50)) return false;
    if (filters.disk === "51-100" && (d < 51 || d > 100)) return false;
    if (filters.disk === "100+" && d < 100) return false;
  }
  if (filters.bandwidth && filters.bandwidth !== "all") {
    const b = ns.bandwidthMbps;
    if (!Number.isFinite(b)) return false;
    if (filters.bandwidth === "le100" && b > 100) return false;
    if (filters.bandwidth === "200-500" && (b < 200 || b > 500)) return false;
    if (filters.bandwidth === "1g" && b !== 1000) return false;
    if (filters.bandwidth === "2.5g+" && b < 2000) return false;
  }
  if (filters.traffic && filters.traffic !== "all") {
    if (filters.traffic === "unlimited") {
      if (!ns.unlimitedTraffic) return false;
    } else {
      const t = ns.trafficGb;
      if (!Number.isFinite(t)) return false;
      if (filters.traffic === "le500" && t > 500) return false;
      if (filters.traffic === "501-1024" && (t < 501 || t > 1024)) return false;
      if (filters.traffic === "1t-3t" && (t < 1024 || t > 3072)) return false;
      if (filters.traffic === "3t+" && t < 3072) return false;
    }
  }
  return true;
}

export function matchesBudgetRange(product, filters) {
  const hasPreset = filters.budget && filters.budget !== "all";
  const minRaw = String(filters.minPrice ?? "").trim();
  const maxRaw = String(filters.maxPrice ?? "").trim();
  const hasMin = minRaw !== "" && Number.isFinite(Number(minRaw));
  const hasMax = maxRaw !== "" && Number.isFinite(Number(maxRaw));

  if (!hasPreset && !hasMin && !hasMax) return true;
  const cny = product._pricing?.cnyMonthly;
  if (!Number.isFinite(cny)) return false;

  if (hasMin && cny < Number(minRaw)) return false;
  if (hasMax && cny > Number(maxRaw)) return false;

  if (hasPreset && !hasMin && !hasMax) {
    const opt = BUDGET_OPTIONS.find((b) => b.value === filters.budget);
    if (opt) {
      if (opt.min !== null && cny < opt.min) return false;
      if (opt.max !== null && cny > opt.max) return false;
    } else if (/^\d+(?:\.\d+)?$/.test(filters.budget)) {
      // Backward compatibility for legacy ?budget=60 / ?budget=150 links
      if (cny > Number(filters.budget)) return false;
    }
  }
  return true;
}

export function matchesFilters(product, filters = DEFAULT_FILTERS, savedSet = new Set()) {
  if (!product || product.diagnostic) return false;
  const c = product._classify;

  if (filters.track === "home" && !c.isResidential) return false;
  if (filters.track === "vps" && c.isResidential) return false;
  if (filters.track === "cn-opt" && (c.isResidential || !c.hasCnOpt)) return false;
  if (filters.track === "landing" && !c.isLanding) return false;

  if (filters.opt === "opt" && !c.hasCnOpt) return false;
  if (filters.opt === "intl" && c.hasCnOpt) return false;
  if (filters.opt === "native" && !c.isResidential && !c.isDualIsp && !c.isNativeIp) return false;

  if (filters.status && filters.status !== "all") {
    if (product.status !== filters.status) return false;
  }
  if (filters.exactOnly && !product._isExactStock) return false;
  if (filters.noNat && c.isNat) return false;
  if (filters.noSnapshot && product._isSnapshot) return false;
  if (filters.fixedPriceOnly) {
    const q = product._pricing.quote;
    if (q.baseOnly || q.months === null || q.amount === null) return false;
  }
  if (filters.savedOnly && !savedSet.has(product._key)) return false;

  if (!matchesRegion(product, filters.region)) return false;
  if (filters.route && filters.route !== "all" && !matchesRoute(product, filters.route)) return false;
  if (!matchesHardwareSpecs(product, filters)) return false;
  if (!matchesBudgetRange(product, filters)) return false;
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

function isCurrentCatalogPlan(record) {
  return record && !record.diagnostic && !["blocked", "error"].includes(record.status) &&
    !record.raw?.historical && record.verification?.state !== "historical";
}

// Current catalog data takes precedence over editorial priority and active filters.
export function rankProvidersByPopularity(allPlans = [], facetCounts = null) {
  const scaleMap = new Map();
  for (const p of allPlans) {
    if (!p || p.diagnostic) continue;
    const cur = scaleMap.get(p._providerId) || { avail: 0, total: 0, current: 0 };
    cur.total += 1;
    if (isCurrentCatalogPlan(p)) cur.current += 1;
    if (p.status === "available") cur.avail += 1;
    scaleMap.set(p._providerId, cur);
  }

  return [...providers]
    .map((prov) => {
      const sc = scaleMap.get(prov.id) || { avail: 0, total: 0, current: 0 };
      const base = providerBaseWeight(prov.id);
      const count = facetCounts ? facetCounts.get(prov.id) || 0 : sc.avail;
      return {
        provider: prov,
        avail: sc.avail,
        total: sc.total,
        hasCurrentPlans: sc.current > 0,
        count,
        isHot: isHotProvider(prov.id),
        score: base
      };
    })
    .sort((a, b) => Number(b.hasCurrentPlans) - Number(a.hasCurrentPlans) || b.score - a.score || b.count - a.count || a.provider.name.localeCompare(b.provider.name, "zh-CN"));
}

export function sortProducts(list, sortKey = "recommended") {
  const arr = [...list];
  const statusWeight = (p) => (p.status === "available" ? 0 : p.status === "unknown" ? 1 : 2);

  if (sortKey !== "recommended") {
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
      return a._idx - b._idx;
    });
    return arr;
  }

  // Rank each provider's plans by evidence and price before interleaving brands.
  const innerRankCompare = (a, b) => {
    const ca = a._pricing.cnyMonthly ?? Infinity;
    const cb = b._pricing.cnyMonthly ?? Infinity;
    const natA = a._classify.isNat ? 1 : 0;
    const natB = b._classify.isNat ? 1 : 0;
    return (
      statusWeight(a) - statusWeight(b) ||
      a._evidenceRank - b._evidenceRank ||
      natA - natB ||
      a._highRiskCount - b._highRiskCount ||
      ca - cb ||
      comparePrices(a, b) ||
      a._idx - b._idx
    );
  };

  arr.sort(innerRankCompare);

  // One plan per provider per wave keeps large catalogs from filling the first screen.
  const seenPerProvider = new Map();
  const waveOf = new Map();
  for (const p of arr) {
    const k = `${statusWeight(p)}:${p._providerId}`;
    const n = seenPerProvider.get(k) || 0;
    seenPerProvider.set(k, n + 1);
    waveOf.set(p, n);
  }

  arr.sort((a, b) => {
    return (
      statusWeight(a) - statusWeight(b) ||
      waveOf.get(a) - waveOf.get(b) ||
      (b._providerWeight || 0) - (a._providerWeight || 0) ||
      innerRankCompare(a, b)
    );
  });

  return arr;
}

export function computeFacetCounts(plans, filters, savedSet) {
  const tracks = { all: 0, home: 0, "cn-opt": 0, landing: 0, vps: 0 };
  const withoutTrack = { ...filters, track: "all" };
  for (const p of plans) {
    if (!matchesFilters(p, withoutTrack, savedSet)) continue;
    tracks.all += 1;
    if (p._classify.isResidential) tracks.home += 1;
    else {
      tracks.vps += 1;
      if (p._classify.hasCnOpt) tracks["cn-opt"] += 1;
      if (p._classify.isLanding) tracks.landing += 1;
    }
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
  const trackMap = {
    home: "类型: 真家宽/双ISP",
    "cn-opt": "类型: CN回国优化",
    landing: "类型: 国际纯落地",
    vps: "类型: 机房VPS"
  };
  if (filters.track !== "all") {
    badges.push({ key: "track", label: trackMap[filters.track] || `类型: ${filters.track}` });
  }
  if (filters.opt && filters.opt !== "all") {
    const m = OPT_OPTIONS.find((o) => o.value === filters.opt);
    badges.push({ key: "opt", label: m ? m.label : `优化: ${filters.opt}` });
  }
  if (filters.status !== DEFAULT_FILTERS.status) {
    const map = { all: "全部库存状态", unavailable: "仅看售罄", unknown: "仅看库存未公开", available: "仅看可购" };
    badges.push({ key: "status", label: `状态: ${map[filters.status] || filters.status}` });
  }
  if (filters.exactOnly) badges.push({ key: "exactOnly", label: "精确库存" });
  if (filters.noNat) badges.push({ key: "noNat", label: "排除 NAT" });
  if (filters.noSnapshot) badges.push({ key: "noSnapshot", label: "排除快照" });
  if (filters.fixedPriceOnly) badges.push({ key: "fixedPriceOnly", label: "明码固定周期" });
  if (filters.savedOnly) badges.push({ key: "savedOnly", label: "本地收藏" });
  if (filters.region !== "all") {
    const m = MACRO_REGIONS.find((r) => r.value === filters.region);
    badges.push({ key: "region", label: `地区: ${m ? m.label : filters.region}` });
  }
  if (filters.route !== "all") {
    const m = ROUTE_OPTIONS.find((r) => r.value === filters.route);
    badges.push({ key: "route", label: `线路: ${m ? m.label : filters.route}` });
  }
  if (filters.cpu && filters.cpu !== "all") {
    const m = CPU_OPTIONS.find((o) => o.value === filters.cpu);
    badges.push({ key: "cpu", label: `CPU: ${m ? m.label : filters.cpu}` });
  }
  if (filters.memory && filters.memory !== "all") {
    const m = MEMORY_OPTIONS.find((o) => o.value === filters.memory);
    badges.push({ key: "memory", label: `内存: ${m ? m.label : filters.memory}` });
  }
  if (filters.disk && filters.disk !== "all") {
    const m = DISK_OPTIONS.find((o) => o.value === filters.disk);
    badges.push({ key: "disk", label: `硬盘: ${m ? m.label : filters.disk}` });
  }
  if (filters.bandwidth && filters.bandwidth !== "all") {
    const m = BANDWIDTH_OPTIONS.find((o) => o.value === filters.bandwidth);
    badges.push({ key: "bandwidth", label: `带宽: ${m ? m.label : filters.bandwidth}` });
  }
  if (filters.traffic && filters.traffic !== "all") {
    const m = TRAFFIC_OPTIONS.find((o) => o.value === filters.traffic);
    badges.push({ key: "traffic", label: `流量: ${m ? m.label : filters.traffic}` });
  }
  if (filters.minPrice || filters.maxPrice) {
    badges.push({
      key: "priceRange",
      label: `预算: ￥${filters.minPrice || "0"}–${filters.maxPrice || "不限"}/月`
    });
  } else if (filters.budget !== "all") {
    const m = BUDGET_OPTIONS.find((b) => b.value === filters.budget);
    badges.push({ key: "budget", label: `预算: ${m ? m.label : `≤￥${filters.budget}`}` });
  }
  if (filters.cycle !== "all") {
    const m = CYCLE_OPTIONS.find((c) => c.value === filters.cycle);
    badges.push({ key: "cycle", label: `周期: ${m ? m.label : filters.cycle}` });
  }
  if (filters.provider !== "all") {
    const prov = providers.find((p) => p.id === filters.provider);
    badges.push({ key: "provider", label: `店铺: ${prov ? prov.name : filters.provider}` });
  }
  if (filters.q && filters.q.trim()) {
    badges.push({ key: "q", label: `关键词: “${filters.q.trim()}”` });
  }
  return badges;
}

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
  if (filters.provider !== "all") {
    const prov = providers.find((p) => p.id === filters.provider);
    check(["provider"], `放宽店铺限定「${prov ? prov.name : filters.provider}」→ 全部店铺`, { provider: "all" });
  }
  if (filters.track !== "all") check(["track"], "切换为「全部节点类型」", { track: "all" });
  if (filters.opt && filters.opt !== "all") check(["opt"], "放宽「线路优化」限制", { opt: "all" });
  if (filters.region !== "all") {
    const m = MACRO_REGIONS.find((r) => r.value === filters.region);
    check(["region"], `放宽地区「${m ? m.label : filters.region}」→ 全部地区`, { region: "all" });
  }
  if (filters.route !== "all") {
    const m = ROUTE_OPTIONS.find((r) => r.value === filters.route);
    check(["route"], `放宽线路「${m ? m.label : filters.route}」→ 全部线路`, { route: "all" });
  }
  if (filters.cpu && filters.cpu !== "all") check(["cpu"], "放宽 CPU 核数限制", { cpu: "all" });
  if (filters.memory && filters.memory !== "all") check(["memory"], "放宽内存容量限制", { memory: "all" });
  if (filters.disk && filters.disk !== "all") check(["disk"], "放宽硬盘容量限制", { disk: "all" });
  if (filters.bandwidth && filters.bandwidth !== "all") check(["bandwidth"], "放宽端口带宽限制", { bandwidth: "all" });
  if (filters.traffic && filters.traffic !== "all") check(["traffic"], "放宽月流量配额限制", { traffic: "all" });
  if (filters.minPrice || filters.maxPrice || filters.budget !== "all") {
    check(["budget", "minPrice", "maxPrice"], "放宽月均预算范围限制", { budget: "all", minPrice: "", maxPrice: "" });
  }
  if (filters.status === "available") check(["status"], "包含已售罄与库存未公开套餐", { status: "all" });
  else if (filters.status !== "all") check(["status"], "切回全部库存状态", { status: "all" });
  if (filters.exactOnly) check(["exactOnly"], "关闭「仅看精确库存数字」", { exactOnly: false });
  if (filters.noNat) check(["noNat"], "关闭「排除 NAT / 共享 IP」", { noNat: false });
  if (filters.noSnapshot) check(["noSnapshot"], "允许包含第三方快照记录", { noSnapshot: false });
  if (filters.fixedPriceOnly) check(["fixedPriceOnly"], "允许包含起步价/周期未明套餐", { fixedPriceOnly: false });
  if (filters.cycle !== "all") check(["cycle"], "放宽计费周期限制", { cycle: "all" });
  if (filters.savedOnly) check(["savedOnly"], "退出「仅看本地收藏」", { savedOnly: false });

  if (candidates.length === 0) {
    if (filters.track !== "all" && filters.region !== "all") {
      check(["track", "region"], "同时放宽「类型」与「地区」限制", { track: "all", region: "all" });
    }
    if (filters.provider !== "all" && filters.status === "available") {
      check(["provider", "status"], "显示该店铺含售罄在内的全部记录或切回全部店铺", { status: "all" });
    }
  }

  candidates.sort((a, b) => b.recoveredCount - a.recoveredCount);
  return {
    activeCount: listActiveFilterBadges(filters).length,
    suggestions: candidates.slice(0, 5)
  };
}

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
    currentPlanCount: plans.filter(isCurrentCatalogPlan).length,
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
