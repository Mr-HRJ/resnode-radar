import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { providers } from "../providers.js";
import { loadSaved, saveSaved, savedKey } from "../saved.js";
import {
  DEFAULT_FILTERS,
  classifyProduct,
  computeFacetCounts,
  diagnoseZeroResults,
  evaluatePlanTags,
  evaluateProviderTags,
  isHotProvider,
  matchesFilters,
  matchesHardwareSpecs,
  normalizeProduct,
  rankProvidersByPopularity,
  sortProducts
} from "../src/domain/catalog.js";
import {
  ROUTE_OPTIONS,
  describePricing,
  formatEventDelta,
  fxFreshness,
  matchesRoute,
  monitorFreshness,
  parseNumericSpecs,
  productSearchText,
  productSpecs,
  providerInitial,
  regionFlag
} from "../src/domain/format.js";
import { parseUrlState, serializeUrlState } from "../src/state/store.js";

const unknown = { cpu: "未标明", memory: "未标明", disk: "未标明", bandwidth: "未标明", traffic: "未标明" };

test("route choices classify declared multi-carrier routes and exclude response evidence", () => {
  assert.deepEqual(ROUTE_OPTIONS.map(({ value }) => value), ["all", "cn2", "9929", "cmin2", "4837", "iij_sb", "hinet", "bgp", "other"]);
  const product = { name: "日本入门", raw: { features: { 电信: "双程 CN2 GIA", 联通: "回程 AS9929", 移动: "CMIN2" } } };
  for (const route of ["all", "cn2", "9929", "cmin2"]) assert.equal(matchesRoute(product, route), true, route);
  assert.equal(matchesRoute(product, "other"), false);
  assert.equal(matchesRoute({ name: "Hong Kong CN2GT" }, "cn2"), true);
  assert.equal(matchesRoute({ carrier: "CUII" }, "9929"), true);
  assert.equal(matchesRoute({ route: "AS58807" }, "cmin2"), true);
  assert.equal(matchesRoute({ route: "AS4837 直连" }, "4837"), true);
  assert.equal(matchesRoute({ route: "SoftBank 住宅网络" }, "iij_sb"), true);
  assert.equal(matchesRoute({ route: "HiNet 动态" }, "hinet"), true);
  assert.equal(matchesRoute({ raw: { features: { 線路: "BGP 國際" } } }, "bgp"), true);
  assert.equal(matchesRoute({ raw: { features: ["CN2 GIA", "AMD EPYC"] } }, "cn2"), true);
  const diagnostic = {
    name: "普通 VPS",
    evidence: "CN2 GIA / 9929",
    note: "CMIN2 / BGP",
    raw: { response: "AS4809 AS58807", html: "CN2 GIA", features: { CPU: "AMD EPYC 9929", 测试IP: "192.168.1.1", evidence: "CN2" } }
  };
  assert.equal(matchesRoute(diagnostic, "other"), true);
  for (const route of ["cn2", "9929", "cmin2", "bgp"]) assert.equal(matchesRoute(diagnostic, route), false);
  assert.equal(matchesRoute({ route: "CMI CN2026 19929" }, "other"), true);
  assert.equal(matchesRoute({}, "bogus"), false);
  assert.equal(matchesRoute(null, "other"), true);
});

test("true residential / dual-ISP classification never conflates plain datacenter native IP", () => {
  const dcNative = normalizeProduct(
    {
      id: "dc-1",
      category: "vps",
      provider: "VendorA",
      name: "Tokyo BGP 原生 IP Lite",
      route: "BGP 原生 IP",
      hardware: "1 vCPU / 1 GB RAM / 20 GB SSD"
    },
    0,
    null,
    new Map()
  );
  assert.equal(dcNative._classify.isResidential, false);
  assert.equal(dcNative._classify.ipTier.value, "datacenter-native");
  const legacy = normalizeProduct({
    name: "Native IP", bandwidth: "International Network / Shared bandwidth",
    riskTags: [{ value: "nat-shared", label: "NAT/共享", severity: "medium" }]
  }, 0);
  assert.equal(legacy._classify.isNat, false);
  assert.equal(legacy.riskTags.some((tag) => tag.value === "nat-shared"), false);

  const trueIsp = normalizeProduct(
    {
      id: "isp-1",
      category: "home",
      provider: "USVPS24",
      name: "美国加州 AT&T 商业宽带 PRO",
      route: "双 ISP 住宅 IP",
      hardware: "2 vCPU / 2 GB RAM / 30 GB SSD"
    },
    1,
    null,
    new Map()
  );
  assert.equal(trueIsp._classify.isResidential, true);
  assert.equal(trueIsp._classify.delivery, "unknown");

  const natHome = classifyProduct({
    category: "home",
    name: "Residential VPS NAT Lite",
    riskTags: [{ value: "nat-shared", label: "NAT/共享", severity: "medium" }]
  });
  assert.equal(natHome.isResidential, true);
  assert.equal(natHome.delivery, "nat");
});

test("route profiles preserve the declared CN2 tier and do not infer China routing from generic optimization", () => {
  for (const [route, headline] of [
    ["AS4809", "电信 CN2"],
    ["CN2 GT / AS4809", "电信 CN2 GT"],
    ["CN2 GIA / AS4809", "电信 CN2 GIA"]
  ]) assert.equal(classifyProduct({ route }).routeProfile.headline, headline);

  const standard = classifyProduct({ route: "AS4809 / 9929 / CMIN2" });
  assert.equal(standard.routeProfile.headline, "三网回程优化");
  assert.equal(classifyProduct({ route: "CN2 GIA / 9929 / CMIN2" }).routeProfile.headline, "三网精品优化");

  for (const route of ["WAN Latency Optimized", "GTT直连优化"]) {
    const c = classifyProduct({ route, category: "vps" });
    assert.equal(c.hasCnOpt, false);
    assert.doesNotMatch(c.routeProfile.headline, /大陆|直连优化|回国/);
    assert.doesNotMatch(c.routeProfile.chips.map((chip) => chip.label).join(" "), /国际无优化|回国/);
  }
  const explicit = normalizeProduct({ route: "CN 优化", category: "vps", status: "available" }, 0);
  assert.equal(explicit._classify.hasCnOpt, true);
  assert.equal(matchesFilters(explicit, { ...DEFAULT_FILTERS, opt: "opt" }), true);
  assert.equal(matchesFilters(explicit, { ...DEFAULT_FILTERS, opt: "intl" }), false);
});

test("dual-layer pricing preserves original quotes and refuses to estimate base-only or expired FX", () => {
  const now = Date.parse("2026-11-22T06:00:00Z");
  const validFx = { base: "CNY", date: "2026-11-20", rates: { CNY: 1, USD: 7.0 } };
  const expiredFx = { base: "CNY", date: "2026-11-01", rates: { CNY: 1, USD: 7.0 } };

  const annual = describePricing({ price: "USD 72 / Annually", priceValue: 72, currency: "USD" }, validFx, now);
  assert.equal(annual.originalLabel, "USD 72 / Annually");
  assert.equal(annual.cnyMonthly, 42);
  assert.equal(annual.cnyTone, "ok");

  const baseOnly = describePricing({ price: "USD 9.99/月起", priceValue: 9.99, currency: "USD" }, validFx, now);
  assert.equal(baseOnly.cnyMonthly, null);
  assert.match(baseOnly.cnyLabel, /起步价/);

  const stale = describePricing({ price: "$20/month", priceValue: 20, currency: "USD" }, expiredFx, now);
  assert.equal(stale.cnyMonthly, null);
  assert.match(stale.cnyLabel, /汇率超7天/);

  const delta = formatEventDelta({ type: "price", previousPriceValue: 25, priceValue: 20 });
  assert.equal(delta.direction, "down");
  assert.equal(delta.label, "-20.0%");
});

test("counterfactual zero-result attribution pinpoints conflicting filters accurately", () => {
  const plans = [
    normalizeProduct(
      { id: "1", providerId: "v1", provider: "V1", category: "home", name: "US AT&T Home", region: "美国", status: "available", stockCount: 5, price: "¥80/月", priceValue: 80, currency: "CNY" },
      0,
      null,
      new Map()
    ),
    normalizeProduct(
      { id: "2", providerId: "v2", provider: "V2", category: "vps", name: "UK KVM", region: "英国", status: "available", stockCount: null, price: "¥30/月", priceValue: 30, currency: "CNY" },
      1,
      null,
      new Map()
    )
  ];
  const diagnosis = diagnoseZeroResults(
    plans,
    { ...DEFAULT_FILTERS, track: "home", region: "GB" },
    new Set()
  );
  assert.ok(diagnosis.suggestions.length >= 2);
  assert.ok(diagnosis.suggestions.some((s) => s.keys.includes("region") && s.recoveredCount === 1));
  assert.ok(diagnosis.suggestions.some((s) => s.keys.includes("track") && s.recoveredCount === 1));
});

test("URL state roundtrip preserves filters, layout, compare keys with commas, and inspector target", () => {
  const href = serializeUrlState(
    {
      view: "terminal",
      layout: "grid",
      filters: { ...DEFAULT_FILTERS, track: "home", region: "US", noNat: true, budget: "150", savedOnly: true },
      radar: { type: "restock", window: "24h", region: "all", savedOnly: false, q: "" },
      providersFilter: { q: "", region: "all", feature: "all", health: "all" },
      compareKeys: ['id:["s1","p1"]', 'id:["s2","p2"]'],
      compareOpen: true,
      inspectId: "home-att"
    },
    "https://radar.example/"
  );

  const parsed = parseUrlState(href);
  assert.equal(parsed.view, "terminal");
  assert.equal(parsed.layout, "grid");
  assert.equal(parsed.filters.track, "home");
  assert.equal(parsed.filters.region, "US");
  assert.equal(parsed.filters.noNat, true);
  assert.equal(parsed.filters.budget, "150");
  assert.equal(parsed.filters.savedOnly, true);
  assert.deepEqual(parsed.compareKeys, ['id:["s1","p1"]', 'id:["s2","p2"]']);
  assert.equal(parsed.compareOpen, true);
  assert.equal(parsed.inspectId, "home-att");
});

test("compact specs parse published hardware formats without guessing price", () => {
  const examples = [
    ["1核 / 1GB / 10G SSD", { cpu: "1核", memory: "1GB", disk: "10G SSD" }],
    ["2 vCore / 1 GB RAM / 50 GB RAID-10 SSD", { cpu: "2 vCore", memory: "1 GB", disk: "50 GB RAID-10 SSD" }],
    ["SSD:20 GB RAID-10 / RAM:1 GB / CPU:2x Intel Xeon", { cpu: "2x Intel Xeon", memory: "1 GB", disk: "20 GB RAID-10 SSD" }],
    ['"CPU：1核（2696v4） / 内存：0.5G（DDR4） / 硬盘：5G（SSD）"', { cpu: "1核(2696v4)", memory: "0.5G(DDR4)", disk: "5G(SSD)" }],
    ["CPU | 1 vCore / RAM | 1 GB", { cpu: "1 vCore", memory: "1 GB" }],
    ["• 1 vCore (AMD 7940HS) CPU / • 256 MB DDR5@5600MHz RAM / • 4 GB NVME Disk", { cpu: "1 vCore", memory: "256 MB", disk: "4 GB NVME" }],
    ["1 x vCPU / 1024 MB RAM / 20 GB", { cpu: "1 x vCPU", memory: "1024 MB", disk: "20 GB" }],
    ["1-2 vCPU / 1-2 GB RAM / 500GB-1TB SSD", { cpu: "1-2 vCPU", memory: "1-2 GB", disk: "500GB-1TB SSD" }]
  ];
  for (const [hardware, expected] of examples) {
    assert.deepEqual(productSpecs({ hardware, price: "$99 / month" }), { ...unknown, ...expected }, hardware);
  }
});

test("network summaries distinguish bandwidth rates from traffic quotas", () => {
  const examples = [
    ["4TB Transfer @1000Mbps (In & Out)", "1000 Mbps", "4TB"],
    ["Network | 750 GB (In+Out) @ 1Gbps", "1 Gbps", "750 GB"],
    ["1 Gbit Line / Unlimited Traffic / 1 IPv4", "1 Gbps", "不限流量"],
    ["带宽：1000m（共享） / 流量：1000G（in+out）", "1000 Mbps", "1000G(in+out)"],
    ["1.5 TB/mo @ 2.5 Gbps / 1 x IPv4 + /64 IPv6", "2.5 Gbps", "1.5 TB"],
    ["流量：不限量", "未标明", "不限流量"]
  ];
  for (const [bandwidth, expectedSpeed, expectedTraffic] of examples) {
    const result = productSpecs({ bandwidth });
    assert.equal(result.bandwidth, expectedSpeed, bandwidth);
    assert.equal(result.traffic, expectedTraffic, bandwidth);
  }
});

test("search includes declared specs and provider aliases as plain text without XSS markup", () => {
  const product = {
    providerId: "vircs",
    provider: "NodeMach",
    name: "<b>Starter</b><script>secretPayload()</script>",
    region: "日本",
    route: "CN2 GIA",
    hardware: "2 vCPU / 2 GB RAM / 30 GB SSD",
    bandwidth: "1 Gbps / 1 TB",
    raw: { features: { CPU: "AMD EPYC", RAM: "2 GB", 线路: "AS9929" }, response: "do-not-index-response" },
    evidence: "do-not-index-evidence"
  };
  const search = productSearchText(product);
  for (const term of ["nodemach", "vircs", "威尔克斯", "starter", "日本", "cn2 gia", "2 vcpu", "amd epyc", "1 gbps", "as9929"]) {
    assert.ok(search.includes(term), term);
  }
  assert.doesNotMatch(search, /<|>|script|secretpayload|do-not-index/);
  assert.equal(productSearchText(null), "");
});

test("flags, initials, 90-minute snapshot freshness, and 7-day FX freshness honor boundaries", () => {
  assert.equal(regionFlag("日本"), "🇯🇵");
  assert.equal(regionFlag("USA, CA (Residential)"), "🇺🇸");
  assert.equal(regionFlag("香港 / 日本 / 美国"), "◎");
  assert.equal(providerInitial("ZoroCloud"), "ZC");
  assert.equal(providerInitial("搬瓦工"), "搬瓦");
  for (const provider of providers) assert.ok([...providerInitial(provider.name)].length <= 2);

  const now = Date.parse("2026-11-11T12:00:00Z");
  assert.equal(monitorFreshness(now - 30 * 60000, now).stale, false);
  assert.equal(monitorFreshness(now - 30 * 60000 - 1, now).stale, true);

  assert.equal(fxFreshness({ base: "CNY", date: "2026-11-05" }, now).valid, true);
  const expired = fxFreshness({ base: "CNY", date: "2026-11-01" }, now);
  assert.equal(expired.valid, false);
  assert.equal(expired.expired, true);
});

test("numeric hardware/network spec filters, budget range, and flagship popularity ranking work accurately", () => {
  const bwhPlan = normalizeProduct(
    {
      id: "bwh-1",
      providerId: "bwh",
      provider: "搬瓦工(BWH)",
      category: "vps",
      name: "LA CN2 GIA-E 2C2G",
      region: "美国",
      route: "CN2 GIA / 9929 / CMIN2",
      hardware: "2 vCPU AMD R9 7950X3D / 2048MB DDR5 / 40 GB NVMe RAID-10",
      bandwidth: "1000GB @ 2.5 Gbps",
      price: "$49.99 / Quarterly",
      priceValue: 49.99,
      currency: "USD",
      status: "available",
      stockCount: 5,
      evidenceLevel: { value: "stock-count", rank: 1 }
    },
    0,
    { base: "CNY", date: new Date().toISOString().slice(0, 10), rates: { CNY: 1, USD: 7.0 } }
  );
  const cheapNat = normalizeProduct(
    {
      id: "nat-1",
      providerId: "jdidc",
      provider: "JDIDC",
      category: "vps",
      name: "西安 NAT全能云",
      region: "中国内地",
      hardware: "2H / 512M / 50G+20G",
      bandwidth: "10 Mbps / 不限流量",
      price: "CNY 10/月",
      priceValue: 10,
      currency: "CNY",
      status: "available",
      stockCount: 80,
      evidenceLevel: { value: "stock-count", rank: 1 },
      riskTags: [{ value: "nat-shared", label: "NAT/共享", severity: "medium" }]
    },
    1,
    { base: "CNY", date: new Date().toISOString().slice(0, 10), rates: { CNY: 1, USD: 7.0 } }
  );

  assert.equal(bwhPlan._numSpecs.cpuCores, 2);
  assert.equal(bwhPlan._numSpecs.memoryGb, 2);
  assert.equal(bwhPlan._numSpecs.diskGb, 40);
  assert.equal(bwhPlan._numSpecs.bandwidthMbps, 2500);
  assert.equal(bwhPlan._numSpecs.trafficGb, 1000);

  assert.equal(cheapNat._numSpecs.cpuCores, 2);
  assert.equal(cheapNat._numSpecs.memoryGb, 0.5);
  assert.equal(cheapNat._numSpecs.diskGb, 70);
  assert.equal(cheapNat._numSpecs.unlimitedTraffic, true);

  assert.equal(matchesFilters(bwhPlan, { ...DEFAULT_FILTERS, cpu: "2", memory: "2", disk: "21-50", bandwidth: "2.5g+", traffic: "501-1024", minPrice: "100", maxPrice: "130" }), true);
  assert.equal(matchesFilters(bwhPlan, { ...DEFAULT_FILTERS, track: "cn-opt", opt: "opt" }), true);
  assert.equal(matchesFilters(bwhPlan, { ...DEFAULT_FILTERS, track: "landing" }), false);
  assert.equal(matchesFilters(cheapNat, { ...DEFAULT_FILTERS, traffic: "unlimited" }), true);

  // Flagship popular provider ranks ahead of obscure cheap NAT box by default
  const sorted = sortProducts([cheapNat, bwhPlan], "recommended");
  assert.equal(sorted[0].id, "bwh-1");

  const rankedShops = rankProvidersByPopularity([cheapNat, bwhPlan]);
  assert.equal(rankedShops[0].provider.id, "bwh");
});

test("priority brands outrank bulk catalogs without inheriting product popularity", () => {
  const priority = ["bwh", "dmit", "gomami", "vmiss"];
  const makePlan = (providerId, i, status = "available") => normalizeProduct({
    id: `${providerId}-${i}`, providerId, category: "vps", name: "Test VPS",
    price: "CNY 10/月", priceValue: 10, currency: "CNY", status
  }, i);
  const plans = [
    ...Array.from({ length: 220 }, (_, i) => makePlan("misaka", i)),
    ...priority.flatMap((id) => [makePlan(id, 1), makePlan(id, 2)]),
    makePlan("bwh", 3, "unavailable")
  ];
  assert.deepEqual(rankProvidersByPopularity(plans).slice(0, 4).map((p) => p.provider.id), priority);
  assert.deepEqual(rankProvidersByPopularity([]).slice(0, 4).map((p) => p.provider.id), priority);
  const failed = makePlan("bwh", 4, "unknown");
  failed.raw = { historical: true };
  const soldOut = makePlan("vmiss", 5, "unavailable");
  const ranked = rankProvidersByPopularity([failed, soldOut, makePlan("misaka", 6)], new Map([["misaka", 1]]));
  assert.deepEqual(ranked.slice(0, 3).map((p) => p.provider.id), ["vmiss", "misaka", "bwh"]);
  assert.equal(ranked[0].count, 0); // A filtered-out or sold-out shop is still successfully collected.
  assert.equal(ranked[2].hasCurrentPlans, false);
  const sorted = sortProducts(plans);
  assert.deepEqual(sorted.slice(0, 5).map((p) => p._providerId), [...priority, "misaka"]);
  assert.equal(sorted.at(-1).status, "unavailable");
  assert.equal(new Set(sorted).size, plans.length);
  assert.ok(priority.every(isHotProvider));
  assert.equal(isHotProvider("misaka"), false);
  assert.equal(isHotProvider("neburst"), false);
});

test("hardware filter boundaries match their displayed capacities and units", () => {
  const cases = [
    ["memory", "le1", "memoryGb", 1, 1.1],
    ["memory", "2", "memoryGb", 2, 1.5],
    ["memory", "4", "memoryGb", 4, 3],
    ["memory", "8", "memoryGb", 8, 6],
    ["memory", "16+", "memoryGb", 16, 12],
    ["disk", "le20", "diskGb", 20, 20.5],
    ["disk", "21-50", "diskGb", 50, 50.5],
    ["disk", "51-100", "diskGb", 100, 100.5],
    ["disk", "100+", "diskGb", 100, 99],
    ["bandwidth", "le100", "bandwidthMbps", 100, 120],
    ["bandwidth", "200-500", "bandwidthMbps", 500, 600],
    ["bandwidth", "1g", "bandwidthMbps", 1000, 1500],
    ["bandwidth", "2.5g+", "bandwidthMbps", 2000, 1800],
    ["traffic", "le500", "trafficGb", 500, 505],
    ["traffic", "501-1024", "trafficGb", 1024, 1050],
    ["traffic", "1t-3t", "trafficGb", 3072, 3100],
    ["traffic", "1t-3t", "trafficGb", 1024, 1023],
    ["traffic", "3t+", "trafficGb", 3072, 3071]
  ];
  for (const [filter, value, spec, valid, invalid] of cases) {
    for (const [capacity, expected] of [[valid, true], [invalid, false], [null, false]]) {
      assert.equal(matchesHardwareSpecs({ _numSpecs: { [spec]: capacity } }, { [filter]: value }), expected, `${filter}=${value}, ${capacity}`);
    }
  }
});

test("numeric specs preserve uncertainty and distinguish bandwidth bits from bytes", () => {
  assert.equal(parseNumericSpecs({ hardware: "2 vCPU / 40 GB SSD" }).memoryGb, null);
  assert.equal(parseNumericSpecs({ hardware: "2 x Xeon / 4 GB RAM / 40 GB SSD" }).cpuCores, null);
  assert.equal(parseNumericSpecs({ hardware: "2-4 vCPU / 2-4 GB RAM / 20-40 GB SSD" }).cpuCores, null);
  for (const memory of ["2-4 GB", "2 GB–4 GB"]) {
    assert.equal(parseNumericSpecs({}, { ...unknown, memory }).memoryGb, null);
  }
  assert.equal(parseNumericSpecs({}, { ...unknown, disk: "2 x 500 GB SSD" }).diskGb, null);
  assert.equal(parseNumericSpecs({}, { ...unknown, bandwidth: "100-1000 Mbps" }).bandwidthMbps, null);
  for (const [bandwidth, expected] of [["100 Mbps", 100], ["100 MB/s", 800], ["100 MBps", 800], ["1 GB/s", 8000], ["2.5 Gbps", 2500]]) {
    assert.equal(parseNumericSpecs({ bandwidth }).bandwidthMbps, expected, bandwidth);
  }
  assert.equal(parseNumericSpecs({ bandwidth: "Bandwidth: unlimited / Traffic: 500 GB" }).unlimitedTraffic, false);
});

test("current catalog saved identities remain unique across all records", () => {
  const { products } = JSON.parse(readFileSync(new URL("../data/products.json", import.meta.url), "utf8"));
  const keys = products.map(savedKey);
  assert.ok(keys.every(Boolean));
  assert.equal(new Set(keys).size, products.length);

  const storage = { map: new Map(), getItem(k) { return this.map.get(k) ?? null; }, setItem(k, v) { this.map.set(k, v); } };
  assert.equal(saveSaved(new Set([keys[0]]), storage), true);
  assert.deepEqual(loadSaved(storage), new Set([keys[0]]));
});

test("normalized route text preserves raw route filtering without reparsing source fields", () => {
  for (const raw of [
    { route: "CN2 GIA / 9929 / CMIN2" },
    { raw: { features: { network: "Softbank HiNet BGP" } } },
    { name: "Plain VPS", note: "No CN2 route promised" }
  ]) {
    const plan = normalizeProduct({ id: "routes", status: "available", ...raw }, 0);
    for (const { value } of ROUTE_OPTIONS) assert.equal(matchesRoute(plan, value), matchesRoute(raw, value));
    Object.defineProperty(plan, "route", { get() { throw new Error("source route should not be reparsed"); } });
    for (const { value } of ROUTE_OPTIONS) assert.doesNotThrow(() => matchesRoute(plan, value));
  }
});

test("evaluateProviderTags distinguishes hot, value, budget, NAT-only, ordinary, and stale-FX shops honestly", () => {
  const fx = { base: "CNY", date: "2026-11-24", rates: { CNY: 1, USD: 7.0 } };
  const staleFx = { base: "CNY", date: "2026-01-01", rates: { CNY: 1, USD: 7.0 } };
  const now = Date.parse("2026-11-24T12:00:00Z");
  const mk = (overrides, idx = 0, rates = fx) => normalizeProduct({
    id: `p-${idx}`,
    category: "vps",
    status: "available",
    name: "KVM Plan",
    region: "美国",
    hardware: "1 vCPU / 1 GB RAM / 20 GB SSD",
    bandwidth: "1 Gbps / 1 TB",
    price: "CNY 50/月",
    priceValue: 50,
    currency: "CNY",
    ...overrides
  }, idx, rates, new Map(), now);

  // 1. Flagship hot vendor with 1 cheap promo + high median earns hot/veteran/line, primary "热门" (never "budget" or "value")
  const bwhPlans = [
    mk({ providerId: "bwh", price: "USD 39/year", priceValue: 39, currency: "USD", route: "CN2 GIA" }, 1),
    mk({ providerId: "bwh", price: "USD 169/year", priceValue: 169, currency: "USD", route: "CN2 GIA" }, 2),
    mk({ providerId: "bwh", price: "USD 1200/year", priceValue: 1200, currency: "USD", route: "CN2 GIA" }, 3)
  ];
  const bwhTags = evaluateProviderTags("bwh", bwhPlans);
  assert.deepEqual(bwhTags.tags.map((t) => t.key), ["hot", "veteran", "line"]);
  assert.equal(bwhTags.primaryTag?.shortLabel, "热门");

  // 2. High-spec non-NAT shop qualifies for value + budget, displaying "性价比" as primary
  const dpnetPlans = [
    mk({ providerId: "dpnet", hardware: "2 vCPU / 4 GB RAM / 50 GB SSD", price: "USD 2.00/month", priceValue: 2.0, currency: "USD" }, 10),
    mk({ providerId: "dpnet", hardware: "4 vCPU / 8 GB RAM / 90 GB SSD", price: "USD 4.79/month", priceValue: 4.79, currency: "USD" }, 11),
    mk({ providerId: "dpnet", hardware: "4 vCPU / 8 GB RAM / 90 GB SSD", price: "USD 7.99/month", priceValue: 7.99, currency: "USD" }, 12)
  ];
  const dpnetTags = evaluateProviderTags("dpnet", dpnetPlans);
  assert.deepEqual(dpnetTags.tags.map((t) => t.key), ["value", "budget"]);
  assert.equal(dpnetTags.primaryTag?.shortLabel, "性价比");

  // 3. Ultra-low-price independent-IPv4 shop (<= CNY 10.5/mo) displays "低价" as primary
  const dedirockPlans = [
    mk({ providerId: "dedirock", hardware: "1 vCPU / 1 GB RAM / 10 GB SSD", price: "USD 10.88/year", priceValue: 10.88, currency: "USD" }, 20),
    mk({ providerId: "dedirock", hardware: "1 vCPU / 2 GB RAM / 20 GB SSD", price: "USD 17.88/year", priceValue: 17.88, currency: "USD" }, 21)
  ];
  const dedirockTags = evaluateProviderTags("dedirock", dedirockPlans);
  assert.equal(dedirockTags.primaryTag?.key, "budget");
  assert.equal(dedirockTags.primaryTag?.shortLabel, "低价");
  assert.ok(dedirockTags.tags.some((t) => t.key === "value"));

  // 4. CN-optimized specialist shop with >= 25% share (or <=¥65 median) of affordable CN-opt plans earns "优线" + "性价比"
  const akkoPlans = [
    mk({ providerId: "akko", route: "电信 CN2 GIA", price: "CNY 449/year", priceValue: 449, currency: "CNY" }, 30),
    mk({ providerId: "akko", route: "电信 CN2 GIA", price: "CNY 449/year", priceValue: 449, currency: "CNY" }, 31),
    mk({ providerId: "akko", route: "电信 CN2 GIA", price: "CNY 699/year", priceValue: 699, currency: "CNY" }, 32)
  ];
  const akkoTags = evaluateProviderTags("akko", akkoPlans);
  assert.deepEqual(akkoTags.tags.map((t) => t.key), ["line", "value"]);
  assert.equal(akkoTags.primaryTag?.shortLabel, "优线");
  assert.match(akkoTags.tags.find((t) => t.key === "value").reason, /平价 CN 优化/);

  // 4a. Expensive CN-opt catalog with only 3 cheap CN-opt promos out of 35 plans (8.6%, median ¥699.99) earns "line" ONLY, NEVER "value"
  const akkoDilutedOpt = [
    ...Array.from({ length: 3 }, (_, i) => mk({ providerId: "akko", route: "电信 CN2 GIA", price: "CNY 449/year", priceValue: 449, currency: "CNY" }, 330 + i)),
    ...Array.from({ length: 32 }, (_, i) => mk({ providerId: "akko", route: "电信 CN2 GIA", price: "CNY 699.99/月", priceValue: 699.99, currency: "CNY" }, 340 + i))
  ];
  assert.deepEqual(evaluateProviderTags("akko", akkoDilutedOpt).tags.map((t) => t.key), ["line"]);

  // 4a-2. Mainland cities (北京/上海/广州/深圳/杭州) and null/unknown regions NEVER qualify for shop tags
  for (const invalidRegion of ["北京", "上海", "广州", "深圳", "中国", "Beijing", "Shanghai", null, "", "未知待定"]) {
    const nonCrossBorderShop = Array.from({ length: 6 }, (_, i) => mk({
      providerId: "dpnet",
      region: invalidRegion,
      hardware: "4 vCPU AMD EPYC 7763 / 8 GB RAM / 80 GB NVMe",
      bandwidth: "10000 Mbps / 5 TB",
      price: "CNY 15/月",
      priceValue: 15,
      currency: "CNY"
    }, 700 + i));
    assert.deepEqual(evaluateProviderTags("dpnet", nonCrossBorderShop).tags, [], `Expected [] shop tags for region=${invalidRegion}`);
  }

  // 4b. Big-port / Ryzen specialist shop (>=6 plans & >=44% share) earns "高配"; diluted giant catalog (JDIDC pattern) stays untagged
  const hostdzirePlans = Array.from({ length: 6 }, (_, i) => mk({
    providerId: "hostdzire",
    hardware: "4 vCPU AMD EPYC 7763 / 8 GB RAM / 80 GB NVMe",
    bandwidth: "10000 Mbps / 5 TB",
    price: "USD 12/month",
    priceValue: 12,
    currency: "USD"
  }, 100 + i));
  const hdTags = evaluateProviderTags("hostdzire", hostdzirePlans);
  assert.equal(hdTags.primaryTag?.key, "perf");
  assert.equal(hdTags.primaryTag?.shortLabel, "高配");

  const dilutedCatalog = [
    mk({ providerId: "jdidc", hardware: "2 vCPU / 4 GB RAM / 40 GB SSD", price: "CNY 25/月", priceValue: 25, currency: "CNY" }, 200),
    mk({ providerId: "jdidc", hardware: "2 vCPU / 4 GB RAM / 40 GB SSD", price: "CNY 25/月", priceValue: 25, currency: "CNY" }, 201),
    ...Array.from({ length: 20 }, (_, i) => mk({ providerId: "jdidc", price: "CNY 150/月", priceValue: 150, currency: "CNY" }, 210 + i))
  ];
  assert.deepEqual(evaluateProviderTags("jdidc", dilutedCatalog).tags, []);

  // 4c. 4 cheap qualified plans + 200 expensive low-quota plans (<500GB) MUST compute whole-shop median (¥500) and earn NEITHER value NOR budget
  const skewedLowQuotaShop = [
    ...Array.from({ length: 4 }, (_, i) => mk({ providerId: "lamhosting", hardware: "1 vCPU / 1 GB RAM / 20 GB SSD", bandwidth: "1 Gbps / 1 TB", price: "CNY 15/月", priceValue: 15, currency: "CNY" }, 300 + i)),
    ...Array.from({ length: 200 }, (_, i) => mk({ providerId: "lamhosting", hardware: "2 vCPU / 2 GB RAM / 40 GB SSD", bandwidth: "100 Mbps / 100 GB", price: "CNY 500/月", priceValue: 500, currency: "CNY" }, 310 + i))
  ];
  const skewedTags = evaluateProviderTags("lamhosting", skewedLowQuotaShop);
  assert.deepEqual(skewedTags.tags, []);
  assert.equal(skewedTags.metrics.medCny, 500);

  // 4d. Starting-price (baseOnly), unknown-cycle, or expired-FX 10Gbps/residential/CN-opt plans NEVER enter live shop tag counts
  const teaserPerfPlans = Array.from({ length: 6 }, (_, i) => mk({
    providerId: "hostdzire",
    hardware: "4 vCPU AMD EPYC 7763 / 8 GB RAM / 80 GB NVMe",
    bandwidth: "10000 Mbps / 5 TB",
    price: "USD 12/month起",
    priceValue: 12,
    currency: "USD"
  }, 600 + i));
  const stalePerfPlans = Array.from({ length: 6 }, (_, i) => mk({
    providerId: "hostdzire",
    hardware: "4 vCPU AMD EPYC 7763 / 8 GB RAM / 80 GB NVMe",
    bandwidth: "10000 Mbps / 5 TB",
    price: "USD 12/month",
    priceValue: 12,
    currency: "USD"
  }, 610 + i, staleFx));
  const unknownCycleResPlans = Array.from({ length: 6 }, (_, i) => mk({
    providerId: "cstonecloud",
    category: "home",
    name: "CUII-ISP-A 住宅双ISP",
    route: "联通 9929",
    bandwidth: "100 Mbps / 1 TB",
    price: "¥55.00 CNY",
    priceValue: 55,
    currency: "CNY"
  }, 620 + i));
  assert.deepEqual(evaluateProviderTags("hostdzire", teaserPerfPlans).tags, []);
  assert.deepEqual(evaluateProviderTags("hostdzire", stalePerfPlans).tags, []);
  assert.deepEqual(evaluateProviderTags("cstonecloud", unknownCycleResPlans).tags, []);

  // 5. NAT-only ultra-cheap shop NEVER falsely receives independent-VPS "低价" or "性价比"
  const natPlans = [
    mk({ providerId: "lazycat", name: "UK NAT Mini", price: "CNY 3/月", priceValue: 3, riskTags: [{ value: "nat-shared", label: "NAT 共享", severity: "medium" }] }, 40),
    mk({ providerId: "lazycat", name: "UK NAT Basic", price: "CNY 5/月", priceValue: 5, riskTags: [{ value: "nat-shared", label: "NAT 共享", severity: "medium" }] }, 41)
  ];
  const natTags = evaluateProviderTags("lazycat", natPlans);
  assert.deepEqual(natTags.tags, []);
  assert.equal(natTags.primaryTag, null);

  // 6. Ordinary high-priced vendor stays neutrally untagged
  const expensivePlans = [
    mk({ providerId: "neburst", price: "USD 29.9/month", priceValue: 29.9, currency: "USD" }, 50),
    mk({ providerId: "neburst", price: "USD 59.9/month", priceValue: 59.9, currency: "USD" }, 51)
  ];
  assert.deepEqual(evaluateProviderTags("neburst", expensivePlans).tags, []);

  // 7. Expired ECB FX (>7d) stops live CNY-based tagging on foreign-currency plans (including netcup/racknerd: never falls back to value/budget)
  const staleDpnet = [
    mk({ providerId: "dpnet", hardware: "2 vCPU / 4 GB RAM / 50 GB SSD", price: "USD 2.19/month", priceValue: 2.19, currency: "USD" }, 60, staleFx),
    mk({ providerId: "dpnet", hardware: "4 vCPU / 8 GB RAM / 90 GB SSD", price: "USD 4.79/month", priceValue: 4.79, currency: "USD" }, 61, staleFx)
  ];
  const staleNetcup = [
    mk({ providerId: "netcup", hardware: "4 vCPU / 8 GB RAM / 256 GB SSD", price: "USD 5.99/month", priceValue: 5.99, currency: "USD" }, 62, staleFx),
    mk({ providerId: "netcup", hardware: "4 vCPU / 8 GB RAM / 256 GB SSD", price: "USD 7.99/month", priceValue: 7.99, currency: "USD" }, 63, staleFx)
  ];
  const staleRacknerd = [
    mk({ providerId: "racknerd", hardware: "1 vCPU / 1 GB RAM / 20 GB SSD", price: "USD 10.99/year", priceValue: 10.99, currency: "USD" }, 64, staleFx),
    mk({ providerId: "racknerd", hardware: "2 vCPU / 2 GB RAM / 40 GB SSD", price: "USD 17.99/year", priceValue: 17.99, currency: "USD" }, 65, staleFx)
  ];
  assert.deepEqual(evaluateProviderTags("dpnet", staleDpnet).tags, []);
  assert.deepEqual(evaluateProviderTags("netcup", staleNetcup).tags.map((t) => t.key), ["veteran"]);
  assert.deepEqual(evaluateProviderTags("racknerd", staleRacknerd).tags.map((t) => t.key), ["veteran"]);

  // 8. Offline veteran benchmark brand keeps ONLY brand-history "veteran" (never price-class "value" or "budget" without live quotes)
  const netcupOffline = evaluateProviderTags("netcup", []);
  assert.deepEqual(netcupOffline.tags.map((t) => t.key), ["veteran"]);
  assert.equal(netcupOffline.primaryTag?.key, "veteran");
  assert.equal(netcupOffline.primaryTag?.basis, "editorial");
});

test("evaluatePlanTags marks genuine blockbusters, generous plans, value lines, and low-entry VPS while excluding NAT, small pipes, sold-out, and stale FX", () => {
  const fx = { base: "CNY", date: "2026-11-24", rates: { CNY: 1, USD: 7.0 } };
  const staleFx = { base: "CNY", date: "2026-01-01", rates: { CNY: 1, USD: 7.0 } };
  const now = Date.parse("2026-11-24T12:00:00Z");
  const mk = (overrides, idx = 0, rates = fx) => normalizeProduct({
    id: `plan-${idx}`,
    category: "vps",
    status: "available",
    name: "Standard KVM",
    region: "美国",
    hardware: "1 vCPU / 1 GB RAM / 20 GB SSD",
    bandwidth: "1 Gbps / 1 TB",
    price: "CNY 50/月",
    priceValue: 50,
    currency: "CNY",
    ...overrides
  }, idx, rates, new Map(), now);

  // 1. BWH limited-edition Amsterdam Plan earns 爆款 + 年付惠 + 性价比; ordinary BWH high-tier plan stays untagged
  const bwhLimited = mk({
    sourceId: "bwh-limited-pids",
    providerId: "bwh",
    name: "The Amsterdam Plan",
    route: "CN2 GIA / 9929 / CMIN2",
    price: "USD 39/year",
    priceValue: 39,
    currency: "USD"
  }, 1);
  const bwhRegular = mk({
    sourceId: "catalog-bwh",
    providerId: "bwh",
    name: "SPECIAL 40G KVM PROMO V5 - CN2 GIA ECOMMERCE VPS",
    route: "CN2 GIA",
    price: "USD 89.99/quarter",
    priceValue: 89.99,
    currency: "USD"
  }, 2);
  assert.equal(bwhLimited._primaryPlanTag?.key, "blockbuster");
  assert.deepEqual(bwhLimited._planTags.map((t) => t.key), ["blockbuster", "annual", "value"]);
  assert.deepEqual(bwhRegular._planTags, []);

  // 2. DPNET 2C/4G 1Gbps unlimited at $2/mo earns 便宜量大 + 性价比 + 低价
  const dpnetGenerous = mk({
    providerId: "dpnet",
    name: "2 CPU / 4 GB RAM",
    hardware: "2 vCPU / 4 GB RAM / 50 GB SSD",
    bandwidth: "1000 Mbps / Unlimited",
    price: "USD 2.00/month",
    priceValue: 2.0,
    currency: "USD"
  }, 3);
  assert.equal(dpnetGenerous._primaryPlanTag?.key, "generous");
  assert.deepEqual(dpnetGenerous._planTags.map((t) => t.key), ["generous", "value", "budget"]);

  // 3. HostDare BGSSD1 1Gbps / 10TB at $39.99/yr earns 便宜量大 + 年付惠 (not 爆款, since BGSSD1 is standard Bulgaria BGP)
  const hostdare10T = mk({
    providerId: "hostdare",
    name: "BGSSD1",
    hardware: "1 vCPU / 1 GB RAM / 25 GB SSD",
    bandwidth: "1000 Mbps / 10000 GB",
    price: "USD 39.99/year",
    priceValue: 39.99,
    currency: "USD"
  }, 4);
  assert.equal(hostdare10T._primaryPlanTag?.key, "generous");
  assert.deepEqual(hostdare10T._planTags.map((t) => t.key), ["generous", "annual"]);
  assert.match(hostdare10T._planTags.find((t) => t.key === "generous").reason, /10TB/);

  // 4. Small pipes (10M BGP & 20M CN2), 1C/1G 10Gbps entry plans, 256MB toy containers, baremetal E5, and $399/mo slices NEVER get sloppy tags
  const tinyPipe = mk({
    providerId: "jdidc",
    name: "新加坡BGP 2核 2GB",
    hardware: "2 vCPU / 2 GB RAM / 60 GB SSD",
    bandwidth: "10 Mbps / Unlimited",
    price: "CNY 20/月",
    priceValue: 20,
    currency: "CNY"
  }, 5);
  const tinyCn2Pipe = mk({
    providerId: "jdidc",
    name: "香港3区CN2 2H1G",
    route: "CN2",
    hardware: "2 vCPU / 1 GB RAM / 30 GB SSD",
    bandwidth: "20 Mbps / 500 GB",
    price: "CNY 16/月",
    priceValue: 16,
    currency: "CNY"
  }, 50);
  const entry1C1G10G = mk({
    providerId: "greencloud",
    name: "KVMTX-1",
    hardware: "1 vCPU / 1 GB RAM / 15 GB SSD",
    bandwidth: "10000 Mbps / 1536 GB",
    price: "USD 6.00/month",
    priceValue: 6.0,
    currency: "USD"
  }, 51);
  const toyCrumb = mk({
    providerId: "breadcloud",
    name: "Crumb",
    hardware: "0.5 vCPU / 256 MB RAM / 3 GB SSD",
    bandwidth: "1000 Mbps / 500 GB",
    price: "USD 1.10/month",
    priceValue: 1.1,
    currency: "USD",
    stockCount: 3,
    evidenceLevel: { value: "stock-count", label: "精确库存", rank: 1 }
  }, 52);
  const baremetalMisclassified = mk({
    providerId: "yunyoo",
    category: "home",
    name: "洛杉矶C.Std-E5-2680v4",
    route: "CMIN2 / 9929",
    hardware: "Dual Xeon E5-2680v4 / 256 GB RAM / 3840 GB SSD",
    bandwidth: "100 Mbps / 10 TB",
    price: "CNY 3699.99/月",
    priceValue: 3699.99,
    currency: "CNY"
  }, 53);
  const expensiveSlice = mk({
    providerId: "rivencloud",
    name: "Max VPS",
    route: "CN2 GIA / CMIN2",
    hardware: "8 vCPU / 16 GB RAM / 160 GB SSD",
    bandwidth: "1000 Mbps / 4096 GB",
    price: "USD 399.95/month",
    priceValue: 399.95,
    currency: "USD",
    stockCount: 1,
    evidenceLevel: { value: "stock-count", label: "精确库存", rank: 1 }
  }, 54);
  assert.deepEqual(tinyPipe._planTags, []);
  assert.deepEqual(tinyCn2Pipe._planTags, []);
  assert.deepEqual(entry1C1G10G._planTags, []);
  assert.deepEqual(toyCrumb._planTags, []);
  assert.deepEqual(baremetalMisclassified._planTags, []);
  assert.deepEqual(expensiveSlice._planTags, []);

  // 5. NAT-only, shared-port residential, and sold-out limited SKU never receive active deal tags
  const natBox = mk({
    providerId: "lazycat",
    name: "UK NAT Mini",
    price: "CNY 3/月",
    priceValue: 3,
    riskTags: [{ value: "nat-shared", label: "NAT 共享", severity: "medium" }]
  }, 6);
  const sharedResBox = mk({
    providerId: "miraigrid",
    category: "home",
    name: "日本 软银 住宅共享 VPS 2T",
    route: "SoftBank 住宅网络",
    bandwidth: "500 Mbps / 2 TB / IPv4 入站： 包含 10 个端口",
    price: "USD 7.99/month",
    priceValue: 7.99,
    currency: "USD"
  }, 7);
  const soldOutLimited = mk({
    sourceId: "bwh-limited-pids",
    providerId: "bwh",
    status: "unavailable",
    name: "The Amsterdam Plan",
    price: "USD 39/year",
    priceValue: 39,
    currency: "USD"
  }, 8);
  assert.deepEqual(natBox._planTags, []);
  assert.deepEqual(sharedResBox._planTags, []);
  assert.deepEqual(soldOutLimited._planTags, []);

  // 6. Expired ECB FX (>7d), baseOnly teaser quotes, or unknown cycles stop ALL product tags (including BWH limited blockbuster)
  const staleGenerous = mk({
    providerId: "dpnet",
    name: "2 CPU / 4 GB RAM",
    hardware: "2 vCPU / 4 GB RAM / 50 GB SSD",
    bandwidth: "1000 Mbps / Unlimited",
    price: "USD 2.00/month",
    priceValue: 2.0,
    currency: "USD"
  }, 9, staleFx);
  const staleBwhLimited = mk({
    sourceId: "bwh-limited-pids",
    providerId: "bwh",
    name: "The Amsterdam Plan",
    route: "CN2 GIA / 9929 / CMIN2",
    price: "USD 39/year",
    priceValue: 39,
    currency: "USD"
  }, 90, staleFx);
  const teaserBwhLimited = mk({
    sourceId: "bwh-limited-pids",
    providerId: "bwh",
    name: "The Amsterdam Plan",
    route: "CN2 GIA / 9929 / CMIN2",
    price: "USD 39/year起",
    priceValue: 39,
    currency: "USD"
  }, 91);
  const unknownCycleBwhLimited = mk({
    sourceId: "bwh-limited-pids",
    providerId: "bwh",
    name: "The Amsterdam Plan",
    route: "CN2 GIA / 9929 / CMIN2",
    price: "USD 39",
    priceValue: 39,
    currency: "USD"
  }, 92);
  assert.deepEqual(staleGenerous._planTags, []);
  assert.deepEqual(evaluatePlanTags(staleGenerous).tags, []);
  assert.deepEqual(staleBwhLimited._planTags, []);
  assert.deepEqual(teaserBwhLimited._planTags, []);
  assert.deepEqual(unknownCycleBwhLimited._planTags, []);

  // 7. New dimensions: 家宽直连 (home-opt), 性能高配 (perf), 紧俏余量 (scarce), 年付特惠 (annual) + strict bw/quota checks on perf
  const homeDirect = mk({
    providerId: "wepc",
    category: "home",
    name: "美国洛杉矶Cogent_9929_家宽直播",
    route: "联通 9929 双ISP住宅",
    bandwidth: "200 Mbps / 1 TB",
    price: "USD 15.9/month",
    priceValue: 15.9,
    currency: "USD"
  }, 10);
  assert.equal(homeDirect._primaryPlanTag?.key, "home-opt");
  assert.deepEqual(homeDirect._planTags.map((t) => t.key), ["home-opt"]);

  const perfEpyc = mk({
    providerId: "hostdzire",
    name: "Singapore VPS #2 AMD EPYC 7763",
    hardware: "2 vCPU AMD EPYC 7763 / 4 GB RAM / 40 GB NVMe",
    bandwidth: "Storage/Network 40 GB NVMe Storage 10Gbit Port ( Shared ) - With 2TB Bandwidth",
    price: "USD 6.99/month",
    priceValue: 6.99,
    currency: "USD"
  }, 11);
  assert.equal(perfEpyc._numSpecs.trafficGb, 2048);
  assert.equal(perfEpyc._primaryPlanTag?.key, "perf");
  assert.match(perfEpyc._primaryPlanTag.reason, /EPYC 7763/);
  assert.match(perfEpyc._primaryPlanTag.reason, /10Gbps/);

  const perfMissingBw = mk({
    providerId: "terabix",
    name: "CVM-4GB-Milan",
    hardware: "2 vCPU AMD EPYC Milan / 4 GB RAM / 50 GB NVMe",
    bandwidth: "",
    price: "USD 6.00/month",
    priceValue: 6.0,
    currency: "USD"
  }, 111);
  const perfMissingTraffic = mk({
    providerId: "terabix",
    name: "CVM-4GB-Milan-PortOnly",
    hardware: "2 vCPU AMD EPYC Milan / 4 GB RAM / 50 GB NVMe",
    bandwidth: "10 Gbps",
    price: "USD 6.00/month",
    priceValue: 6.0,
    currency: "USD"
  }, 112);
  const perfLowQuota = mk({
    providerId: "terabix",
    name: "CVM-4GB-Milan-LowQuota",
    hardware: "2 vCPU AMD EPYC Milan / 4 GB RAM / 50 GB NVMe",
    bandwidth: "10 Gbps / 200 GB",
    price: "USD 6.00/month",
    priceValue: 6.0,
    currency: "USD"
  }, 113);
  assert.deepEqual(perfMissingBw._planTags, []);
  assert.deepEqual(perfMissingTraffic._planTags, []);
  assert.deepEqual(perfLowQuota._planTags, []);

  // 7b. Mainland China cities (北京/上海/广州) and null/empty/unknown regions (including TOT K11) NEVER earn any product tags
  for (const badRegion of ["北京", "上海", "广州", "杭州", "中国", "Beijing", "Shanghai", null, "", "未知机房"]) {
    const domesticOrUnknown = mk({
      providerId: "tothost",
      name: badRegion === null ? "TOT K11" : `Node-${badRegion}`,
      region: badRegion,
      hardware: "2 vCPU AMD Ryzen 9950X / 4 GB RAM / 50 GB NVMe",
      bandwidth: "1000 Mbps / Unlimited",
      price: "CNY 15/月",
      priceValue: 15,
      currency: "CNY"
    }, 800);
    assert.deepEqual(domesticOrUnknown._planTags, [], `Expected [] plan tags for region=${badRegion}`);
  }
  // Whereas "中国香港" is recognized as Hong Kong cross-border and tagged normally
  const hkCrossBorder = mk({
    providerId: "dpnet",
    region: "中国香港",
    hardware: "2 vCPU / 4 GB RAM / 50 GB SSD",
    bandwidth: "1000 Mbps / Unlimited",
    price: "CNY 15/月",
    priceValue: 15,
    currency: "CNY"
  }, 801);
  assert.ok(hkCrossBorder._planTags.some((t) => t.key === "generous"));

  const scarceBoil = mk({
    providerId: "boil",
    name: "HKT 300Mbps VPS",
    bandwidth: "300 Mbps / 5 TB",
    price: "USD 22/month",
    priceValue: 22,
    currency: "USD",
    stockCount: 2,
    evidenceLevel: { value: "stock-count", label: "精确库存", rank: 1 }
  }, 12);
  assert.equal(scarceBoil._primaryPlanTag?.key, "scarce");
  assert.match(scarceBoil._primaryPlanTag.reason, /仅剩 2 台/);

  // 8. Deal filter, facet counts, URL sync, and zero-result relaxation
  const all = [bwhLimited, bwhRegular, dpnetGenerous, hostdare10T, tinyPipe, natBox, homeDirect, perfEpyc, scarceBoil];
  assert.equal(matchesFilters(bwhLimited, { ...DEFAULT_FILTERS, deal: "blockbuster" }), true);
  assert.equal(matchesFilters(bwhRegular, { ...DEFAULT_FILTERS, deal: "blockbuster" }), false);
  assert.equal(matchesFilters(homeDirect, { ...DEFAULT_FILTERS, deal: "home-opt" }), true);
  assert.equal(matchesFilters(perfEpyc, { ...DEFAULT_FILTERS, deal: "perf" }), true);
  assert.equal(matchesFilters(scarceBoil, { ...DEFAULT_FILTERS, deal: "scarce" }), true);
  const facets = computeFacetCounts(all, DEFAULT_FILTERS, new Set());
  assert.equal(facets.deals.get("blockbuster"), 1);
  assert.equal(facets.deals.get("generous"), 2);
  assert.equal(facets.deals.get("annual"), 2);
  assert.equal(facets.deals.get("value"), 2);
  assert.equal(facets.deals.get("home-opt"), 1);
  assert.equal(facets.deals.get("perf"), 1);
  assert.equal(facets.deals.get("scarce"), 1);
  assert.equal(facets.deals.get("budget"), 1);

  const diag = diagnoseZeroResults(all, { ...DEFAULT_FILTERS, provider: "jdidc", deal: "blockbuster" });
  assert.ok(diag.suggestions.some((s) => s.keys.includes("deal")));

  for (const dealKey of ["generous", "annual", "home-opt", "perf", "scarce"]) {
    const url = serializeUrlState({ view: "terminal", layout: "table", filters: { ...DEFAULT_FILTERS, deal: dealKey } });
    assert.match(url, new RegExp(`deal=${dealKey}`));
    assert.equal(parseUrlState(url).filters.deal, dealKey);
  }
});
