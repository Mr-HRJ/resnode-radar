import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { providers } from "../providers.js";
import { loadSaved, saveSaved, savedKey } from "../saved.js";
import {
  DEFAULT_FILTERS,
  classifyProduct,
  diagnoseZeroResults,
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
