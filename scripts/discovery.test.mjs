import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { providers } from "../providers.js";
import {
  routeOptions, matchesRoute, productSpecs, regionFlag, providerInitial,
  monitorFreshness, productSearchText
} from "../discovery.js";
import { loadSaved, saveSaved, savedKey } from "../saved.js";

const unknown = { cpu: "未标明", memory: "未标明", disk: "未标明", bandwidth: "未标明", traffic: "未标明" };

test("route choices classify declared multi-carrier routes and exclude response evidence", () => {
  assert.deepEqual(routeOptions.map(({ value }) => value), ["all", "cn2", "9929", "cmin2", "bgp", "other"]);
  const product = { name: "日本入门", raw: { features: { 电信: "双程 CN2 GIA", 联通: "回程 AS9929", 移动: "CMIN2" } } };
  for (const route of ["all", "cn2", "9929", "cmin2"]) assert.equal(matchesRoute(product, route), true, route);
  assert.equal(matchesRoute(product, "other"), false);
  assert.equal(matchesRoute({ name: "Hong Kong CN2GT" }, "cn2"), true);
  assert.equal(matchesRoute({ carrier: "CUII" }, "9929"), true);
  assert.equal(matchesRoute({ route: "AS58807" }, "cmin2"), true);
  assert.equal(matchesRoute({ raw: { features: { 線路: "BGP 國際" } } }, "bgp"), true);
  assert.equal(matchesRoute({ raw: { features: ["CN2 GIA", "AMD EPYC"] } }, "cn2"), true);
  const diagnostic = {
    name: "普通 VPS", evidence: "CN2 GIA / 9929", note: "CMIN2 / BGP",
    raw: { response: "AS4809 AS58807", html: "CN2 GIA", features: { CPU: "AMD EPYC 9929", 测试IP: "192.168.1.1", evidence: "CN2" } }
  };
  assert.equal(matchesRoute(diagnostic, "other"), true);
  for (const route of ["cn2", "9929", "cmin2", "bgp"]) assert.equal(matchesRoute(diagnostic, route), false);
  assert.equal(matchesRoute({ route: "CMI CN2026 19929" }, "other"), true);
  assert.equal(matchesRoute({}, "bogus"), false);
  assert.equal(matchesRoute(null, "other"), true);
});

test("compact specs parse the three published hardware formats without guessing price", () => {
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

test("explicit multilingual fields take priority and retain declared ranges", () => {
  const product = {
    hardware: "8 vCPU / 16 GB RAM / 200 GB SSD",
    bandwidth: "1 Gbps / 2 TB",
    raw: { features: { CPU: "2*AMD EPYC", 內存: "1GB DDR4", 硬盤: "10-100GB 可选", 帶寬: "100Mbps", 月流量: "500GB（雙向）" } }
  };
  const snapshot = structuredClone(product);
  assert.deepEqual(productSpecs(product), {
    cpu: "2*AMD EPYC", memory: "1GB DDR4", disk: "10-100GB 可选", bandwidth: "100 Mbps", traffic: "500GB(雙向)"
  });
  assert.deepEqual(product, snapshot);
  assert.deepEqual(productSpecs({ raw: { features: { CPU: 2, RAM: "512 MiB", Storage: "20 GB SSD", Bandwidth: "100M", Traffic: "Unlimited" } } }), {
    cpu: "2", memory: "512 MiB", disk: "20 GB SSD", bandwidth: "100 Mbps", traffic: "不限流量"
  });
  assert.equal(productSpecs({ hardware: "内存：2-4GB / 系统盘：30-100GB 可选" }).memory, "2-4GB");
  assert.equal(productSpecs({ hardware: "内存：2-4GB / 系统盘：30-100GB 可选" }).disk, "30-100GB 可选");
});

test("network summaries distinguish bandwidth rates from traffic quotas", () => {
  const examples = [
    ["4TB Transfer @1000Mbps (In & Out)", "1000 Mbps", "4TB"],
    ["Network | 750 GB (In+Out) @ 1Gbps", "1 Gbps", "750 GB"],
    ["1 Gbit Line / Unlimited Traffic / 1 IPv4", "1 Gbps", "不限流量"],
    ["带宽：1000m（共享） / 流量：1000G（in+out）", "1000 Mbps", "1000G(in+out)"],
    ["500 Mbps / 1000 GB / 1 IPv4", "500 Mbps", "1000 GB"],
    ["1.5 TB/mo @ 2.5 Gbps / 1 x IPv4 + /64 IPv6", "2.5 Gbps", "1.5 TB"],
    ["1 GB/s", "1 GB/s", "未标明"],
    ["1 GBps", "1 GBps", "未标明"],
    ["80Mbps / 500G-1T 双向", "80 Mbps", "500G-1T"],
    ["1 Gbps", "1 Gbps", "未标明"],
    ["流量：不限量", "未标明", "不限流量"]
  ];
  for (const [bandwidth, expectedSpeed, expectedTraffic] of examples) {
    const result = productSpecs({ bandwidth });
    assert.equal(result.bandwidth, expectedSpeed, bandwidth);
    assert.equal(result.traffic, expectedTraffic, bandwidth);
    assert.equal(result.memory, "未标明", bandwidth);
    assert.equal(result.disk, "未标明", bandwidth);
  }
});

test("unlimited traffic declarations never become shorthand bandwidth quotas", () => {
  for (const [bandwidth, expectedTraffic] of [
    ["带宽：100m起（独享） / 流量：不限", "不限流量"],
    ["帶寬：600M（共享） / 月流量：不限（公平使用）", "不限流量"],
    ["600M共享 / 不限制流量 / 独享1个 台湾原生", "不限流量"],
    ["带宽：100m起（独享）", "未标明"],
    ["带宽：100M / 流量：未标明", "未标明"],
    ["600M共享", "未标明"],
    ["100M / 1G共享", "未标明"],
    ["100M共享 / 2 TB", "2 TB"],
    ["带宽：100M / 500G 双向", "500G"]
  ]) assert.equal(productSpecs({ bandwidth }).traffic, expectedTraffic, bandwidth);
  const specs = productSpecs({ bandwidth: "带宽：100m起（独享） / 流量：不限" });
  assert.equal(specs.bandwidth, "100 Mbps");
  assert.equal(productSpecs({ raw: { features: { 帶寬: "600M", 流量: "不限" } } }).traffic, "不限流量");
});

test("ambiguous, missing, and unrelated details stay unknown", () => {
  for (const product of [
    undefined, null, {},
    { name: "2 vCPU / 8 GB RAM", price: "$10 / 1 TB", note: "20 GB SSD", evidence: "100Mbps", raw: { response: "CPU: 4 / RAM: 8GB" } },
    { hardware: "AMD EPYC 9354 / 2 GB / 20 GB", raw: { features: { RAM: 4, Storage: "未提供", Bandwidth: "1 TB" } } },
    { hardware: {}, bandwidth: [], raw: { features: { CPU: {}, RAM: ["4 GB"], Disk: null } } }
  ]) assert.deepEqual(productSpecs(product), unknown);
  assert.deepEqual(productSpecs({ hardware: "25GB SSD / CPU" }), { ...unknown, disk: "25GB SSD" });
  assert.deepEqual(productSpecs({ hardware: "1 TB SSD" }), { ...unknown, disk: "1 TB SSD" });
});

test("search includes declared specs and provider aliases as plain text", () => {
  const providerSnapshot = JSON.stringify(providers);
  const product = {
    providerId: "vircs", provider: "NodeMach", name: '<b>Starter</b><script>secretPayload()</script>',
    region: "日本", route: "CN2 GIA", hardware: "2 vCPU / 2 GB RAM / 30 GB SSD",
    bandwidth: "1 Gbps / 1 TB", raw: { features: { CPU: "AMD EPYC", RAM: "2 GB", 线路: "AS9929" }, response: "do-not-index-response" },
    evidence: "do-not-index-evidence"
  };
  const snapshot = structuredClone(product);
  const search = productSearchText(product);
  for (const term of ["nodemach", "vircs", "威尔克斯", "starter", "日本", "cn2 gia", "2 vcpu", "amd epyc", "1 gbps", "as9929"]) assert.ok(search.includes(term), term);
  assert.doesNotMatch(search, /<|>|script|secretpayload|do-not-index/);
  assert.equal(productSearchText({ provider: "VIRCS" }).includes("nodemach"), true);
  assert.equal(productSearchText(null), "");
  assert.deepEqual(product, snapshot);
  assert.equal(JSON.stringify(providers), providerSnapshot);
});

test("flags identify single countries and stay neutral for mixed or unknown regions", () => {
  for (const [region, flag] of [
    ["日本", "🇯🇵"], ["Japan, Tokyo (Residential)", "🇯🇵"], ["JP", "🇯🇵"],
    ["美国 / 洛杉矶", "🇺🇸"], ["USA, CA (Residential)", "🇺🇸"], ["CA", "🇨🇦"],
    ["中国香港", "🇭🇰"], ["CNHK", "🇭🇰"], ["台灣", "🇹🇼"], ["德国", "🇩🇪"],
    ["英国", "🇬🇧"], ["马来西亚", "🇲🇾"], ["越南", "🇻🇳"],
    ["香港 / 日本 / 美国", "◎"], ["sg-sgp / kr-icn", "◎"], ["多地区（下单选择）", "◎"],
    ["全球", "◎"], ["US / CA", "◎"], ["unknown", "◎"], [null, "◎"]
  ]) assert.equal(regionFlag(region), flag, String(region));
});

test("provider initials handle brand case, words, Chinese, and empty names", () => {
  assert.equal(providerInitial("ZoroCloud"), "ZC");
  assert.equal(providerInitial("Flawless Node"), "FN");
  assert.equal(providerInitial("DMIT"), "DM");
  assert.equal(providerInitial("搬瓦工"), "搬瓦");
  assert.equal(providerInitial("<b>LisaHost</b>"), "LH");
  assert.equal(providerInitial(null), "?");
  for (const provider of providers) assert.ok([...providerInitial(provider.name)].length <= 2);
});

test("freshness honors the 90-minute boundary and unknown timestamps", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  assert.deepEqual(monitorFreshness(now, now), { stale: false, label: "刚刚更新" });
  assert.deepEqual(monitorFreshness(now - 60000, now), { stale: false, label: "1 分钟前更新" });
  assert.equal(monitorFreshness(now - 90 * 60000, now).stale, false);
  assert.equal(monitorFreshness(now - 90 * 60000 - 1, now).stale, true);
  assert.deepEqual(monitorFreshness("2026-11-10T12:00:00Z", now), { stale: true, label: "1 天前更新" });
  assert.deepEqual(monitorFreshness(new Date(now + 1000), now), { stale: false, label: "刚刚更新" });
  for (const value of [null, undefined, "", " ", "not a date", NaN, false, {}]) {
    assert.deepEqual(monitorFreshness(value, now), { stale: true, label: "更新时间未知" });
  }
  assert.equal(monitorFreshness(now, NaN).stale, true);
});

function memoryStorage() {
  const items = new Map();
  return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, value) };
}

test("saved identities survive reorder, refreshed price, status, and titles", () => {
  const original = { sourceId: "source-a", id: "plan-1", name: "Starter", price: "$1", _index: 0 };
  const key = savedKey(original);
  assert.equal(savedKey({ ...original, name: "New title", price: "$9", _index: 32, stockCount: 0, fetchedAt: "2026-11-11" }), key);
  assert.notEqual(savedKey({ ...original, sourceId: "source-b" }), key);
  assert.notEqual(savedKey({ ...original, id: "plan-2" }), key);
  assert.notEqual(savedKey({ sourceId: "a|b", id: "c" }), savedKey({ sourceId: "a", id: "b|c" }));
  assert.ok(savedKey({ id: 0 }));
  assert.equal(savedKey(null), "");
  const withoutId = { sourceId: "source-a", name: "Plan", region: "JP", orderUrl: "https://example.invalid/buy" };
  assert.equal(savedKey(withoutId), savedKey({ ...withoutId, price: "$10", _index: 9 }));
  assert.notEqual(savedKey(withoutId), savedKey({ ...withoutId, name: "Other Plan" }));
});

test("reversed AaITR snapshot blocks keep US saved and compare identities on US", () => {
  const blocks = [
    { name: "US Verizon Dynamic NAT VPS", region: "USA, CA (Residential)", hardware: "1核 / 1GB" },
    { name: "Japan SoftBank Dynamic NAT VPS", region: "Japan, Tokyo (Residential)", hardware: "1核 / 1GB" }
  ];
  const snapshot = (orderedBlocks) => orderedBlocks.map((block, index) => ({
    ...block, sourceId: "aaitr-srv-store", id: `aaitr-srv-store-reader-store-rbn-${index + 1}`,
    adapter: "aaitr_store", provider: "AaITR", orderUrl: "https://www.aaitr.com/store/rbn",
    raw: { strategy: "reader_snapshot" }, price: "¥12", _index: index
  }));
  const before = snapshot(blocks);
  const after = snapshot([...blocks].reverse()).map((product) => ({ ...product, price: "¥18", status: "unavailable" }));
  assert.equal(before[0].id, after[0].id);
  assert.notEqual(before[0].name, after[0].name);
  const storage = memoryStorage();
  assert.equal(saveSaved(new Set([savedKey(before[0])]), storage), true);
  const saved = loadSaved(storage);
  assert.deepEqual(after.filter((product) => saved.has(savedKey(product))).map((product) => product.name), [blocks[0].name]);
  const compareKeys = before.map(savedKey);
  assert.deepEqual(compareKeys.map((key) => after.find((product) => savedKey(product) === key)?.name), blocks.map((block) => block.name));
  assert.equal(new Set(after.map(savedKey)).size, 2);
});

test("explicit card index fallbacks use content while real plan IDs stay reliable", () => {
  for (const [adapter, suffix] of [
    ["aaitr_store", (index) => `-idx-${index + 1}`],
    ["lagom_product_list", (index) => `:card:${index + 1}`],
    ["lagom_product_list", (index) => `-plan:${index + 1}`],
    ["whmcs_group", (index) => `-pid-${index + 1}`],
    ["zlidc_product_wrap", (index) => `-pid-${index + 1}`]
  ]) {
    const records = ["1 vCPU / 1 GB", "2 vCPU / 2 GB"].map((hardware, index) => ({
      sourceId: "source", id: `source${suffix(index)}`, adapter,
      name: "Plan", region: "美国", hardware, raw: { sourceCardIndex: index }
    }));
    const reversed = [...records].reverse().map((product, index) => ({ ...product, id: `source${suffix(index)}`, raw: { sourceCardIndex: index } }));
    assert.notEqual(savedKey(records[0]), savedKey(records[1]), adapter);
    assert.equal(savedKey(records[0]), savedKey(reversed[1]), adapter);
    assert.equal(savedKey(records[1]), savedKey(reversed[0]), adapter);
  }
  const realPlan = {
    sourceId: "source", id: "source-pid-42", adapter: "whmcs_group",
    orderUrl: "https://example.invalid/cart.php?a=add&pid=42", name: "Original name",
    raw: { sourceCardIndex: 41, strategy: "reader_snapshot" }
  };
  assert.equal(savedKey(realPlan), savedKey({ ...realPlan, name: "Renamed", price: "$99", raw: { sourceCardIndex: 0 } }));
});

test("current catalog saved identities remain unique", () => {
  const { products } = JSON.parse(readFileSync(new URL("../data/products.json", import.meta.url), "utf8"));
  const keys = products.map(savedKey);
  assert.ok(keys.every(Boolean));
  assert.equal(new Set(keys).size, products.length);
});

test("saved sets persist, deduplicate, and remove entries without mutating callers", () => {
  const storage = memoryStorage();
  assert.deepEqual(loadSaved(storage), new Set());
  const first = savedKey({ sourceId: "vendor", id: "1" });
  const second = savedKey({ sourceId: "vendor", id: "2" });
  const saved = new Set([first, second]);
  assert.equal(saveSaved(saved, storage), true);
  assert.deepEqual(loadSaved(storage), saved);
  const loaded = loadSaved(storage);
  loaded.delete(first);
  assert.equal(saveSaved(loaded, storage), true);
  assert.deepEqual(loadSaved(storage), new Set([second]));
  assert.deepEqual(saved, new Set([first, second]));
  assert.equal(saveSaved(new Set(), storage), true);
  assert.deepEqual(loadSaved(storage), new Set());
});

test("malformed storage and invalid entry types recover safely", () => {
  for (const value of ["{invalid", "{}", "null", "true", "17", '"string"']) {
    assert.deepEqual(loadSaved({ getItem: () => value }), new Set(), value);
  }
  assert.deepEqual(loadSaved({ getItem: () => '["one",null,3,"one",{},"", " ","two"]' }), new Set(["one", "two"]));
  const storage = memoryStorage();
  const saved = new Set(["one", null, 3, {}, ""]);
  assert.equal(saveSaved(saved, storage), true);
  assert.deepEqual(loadSaved(storage), new Set(["one"]));
  assert.equal(saved.size, 5);
  assert.equal(saveSaved([], storage), false);
});

test("denied and unavailable storage never throws, including the global getter", (t) => {
  const denied = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("quota"); } };
  assert.deepEqual(loadSaved(denied), new Set());
  assert.equal(saveSaved(new Set(["one"]), denied), false);
  assert.deepEqual(loadSaved(null), new Set());
  assert.equal(saveSaved(new Set(["one"]), null), false);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => descriptor ? Object.defineProperty(globalThis, "localStorage", descriptor) : delete globalThis.localStorage);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("SecurityError"); } });
  assert.deepEqual(loadSaved(), new Set());
  assert.equal(saveSaved(new Set(["one"])), false);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: undefined });
  assert.deepEqual(loadSaved(), new Set());
  assert.equal(saveSaved(new Set(["one"])), false);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
  assert.equal(saveSaved(new Set(["one"])), true);
  assert.deepEqual(loadSaved(), new Set(["one"]));
});
