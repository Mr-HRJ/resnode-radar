import test from "node:test";
import assert from "node:assert/strict";
import { parseSpaConsole, parseLazyCat, SPA_CONSOLE_FORMATS } from "./adapters/spa-consoles.mjs";

const helpers = { baseRecord: (_source, _result, record) => record };
const source = (format, url) => ({ id: `catalog-${format}`, providerId: format, provider: format, catalogFormat: format, url });
const run = (format, url, payload, extra = {}) => parseSpaConsole(source(format, url), { html: typeof payload === "string" ? payload : JSON.stringify(payload), finalUrl: url, statusCode: 200 }, { ...helpers, ...extra });

test("exports the supported formats", () => {
  assert.deepEqual(SPA_CONSOLE_FORMATS, ["lazycat", "nmcloud", "breacloud", "kfchost", "hhost"]);
  assert.throws(() => run("other", "https://x.example/", {}), /Unsupported/);
});

// ------------------------------------------------------------------ LazyCat
const lazyPlan = { id: 20, name: "Nano", cpu: 10, cpuCores: 1, cpuLimit: 10, memory: 256, disk: 1024, portLimit: 4, trafficLimit: "322122547200", limitsIngress: "50Mbit", price: 1500, billingCycle: 1, setupFee: 0, monthlyPrice: 1500 };
const lazyPkg = (over) => ({ id: 16, name: "Frontier动态家宽", description: "x", network_mode: "nat", instance_type: "container", display_tags: [{ text: "真家宽" }], preorder_mode: false, vip_only: false, sourceType: "official", soldOut: false, isPaid: true, plans: [lazyPlan], ...over });
const LAZY_PKGS = "https://dash.lazycat.wiki/api/packages/public";
const LAZY_REGIONS = "https://dash.lazycat.wiki/api/packages/public/regions";

test("lazycat joins the region index and maps soldOut / vip_only", () => {
  const src = source("lazycat", LAZY_REGIONS);
  const regions = { regions: [{ code: "US", name: "United States", packageIds: [16, 17], hostCount: 2 }] };
  assert.deepEqual(parseLazyCat(src, { html: JSON.stringify(regions), finalUrl: LAZY_REGIONS }, { ...helpers, now: 1000 }), []);
  const payload = { packages: [lazyPkg(), lazyPkg({ id: 17, name: "Tokyo-Lite", display_tags: [], vip_only: true, plans: [{ ...lazyPlan, id: 30 }] }), lazyPkg({ id: 18, soldOut: true, plans: [{ ...lazyPlan, id: 40 }] })], total: 3 };
  const [a, b, c] = parseLazyCat(src, { html: JSON.stringify(payload), finalUrl: LAZY_PKGS }, { ...helpers, now: 2000 });
  assert.equal(a.id, "catalog-lazycat:plan:16-20");
  assert.equal(a.status, "available");
  assert.equal(a.category, "home");
  assert.equal(a.region, "美国");
  assert.equal(a.price, "CNY 15.00/月");
  assert.equal(a.priceValue, 15);
  assert.equal(a.bandwidth, "50Mbps / 300 GB/月 / 4 端口");
  assert.equal(a.orderUrl, "https://dash.lazycat.wiki/instances/create?source=official&package=16&plan=20&region=us");
  assert.equal(b.status, "unknown");
  assert.equal(b.statusLabel, "VIP 专享");
  assert.equal(b.category, "vps");
  assert.equal(c.status, "unavailable");
  assert.equal(c.region, null, "package not in region index");
  assert.equal(c.stockCount, null);
});

test("lazycat region index expires and schema drift throws", () => {
  const src = source("lazycat", LAZY_REGIONS);
  parseLazyCat(src, { html: JSON.stringify({ regions: [{ code: "JP", name: "Japan", packageIds: [16] }] }), finalUrl: LAZY_REGIONS }, { ...helpers, now: 0 });
  const [stale] = parseLazyCat(src, { html: JSON.stringify({ packages: [lazyPkg()] }), finalUrl: LAZY_PKGS }, { ...helpers, now: 60 * 60 * 1000 });
  assert.equal(stale.region, null);
  assert.throws(() => run("lazycat", LAZY_PKGS, { packages: [lazyPkg({ soldOut: "no" })] }), /identity changed/);
  assert.throws(() => run("lazycat", LAZY_PKGS, { packages: [lazyPkg({ plans: [{ ...lazyPlan, price: "15", monthlyPrice: undefined }] })] }), /price schema/);
  assert.throws(() => run("lazycat", LAZY_PKGS, "<html>"), /JSON/);
  assert.throws(() => run("lazycat", LAZY_PKGS, { items: [] }), /schema changed/);
});

// ------------------------------------------------------------------ NMCloud
const NM = "https://new.nmcloud.cc/api/v1/catalog/products";
const nmProduct = (over) => ({
  id: "c1", code: "hinet-mini", name: "HINET-L-MINI", kind: "lxc", networkProfile: "nat_ipv4", status: "on_sale",
  group: { name: "[HINET家宽|2区] 苗栗-NAT" },
  spec: { cpuCores: 1, memoryMib: 512, diskGib: 5, diskType: "ssd", bandwidthMbps: 100, trafficGb: 500, ipv4Count: 0, portCount: 10 },
  prices: [{ period: "month", amountCents: 1200, currency: "CNY" }, { period: "year", amountCents: 12000, currency: "CNY" }],
  stockLimit: 15, stockUsed: 10, stockAvailable: 5, ...over
});

test("nmcloud follows the public stockAvailable sold-out rule", () => {
  const [open, soldOut, unlimited] = run("nmcloud", NM, [nmProduct(), nmProduct({ code: "b", stockAvailable: 0 }), nmProduct({ code: "c", stockAvailable: null })]);
  assert.equal(open.status, "available");
  assert.equal(open.stockCount, 5);
  assert.equal(open.region, "台湾");
  assert.equal(open.category, "home");
  assert.equal(open.price, "CNY 12.00/月");
  assert.equal(open.orderUrl, "https://new.nmcloud.cc/console/order/new?product=hinet-mini");
  assert.match(open.note, /CNY 120.00\/年/);
  assert.equal(soldOut.status, "unavailable");
  assert.equal(soldOut.stockCount, 0);
  assert.equal(unlimited.status, "available");
  assert.equal(unlimited.stockCount, null);
  assert.equal(run("nmcloud", NM, [nmProduct({ status: "off_shelf" })])[0].status, "unavailable");
  assert.throws(() => run("nmcloud", NM, [nmProduct({ prices: [{ period: "week", amountCents: 1, currency: "CNY" }] })]), /price schema/);
  assert.throws(() => run("nmcloud", NM, { data: [] }), /schema changed/);
});

// ------------------------------------------------------------------ BreaCloud
const BREA = "https://brea.cloud/api/v1/products?currency=HKD";
const breaProduct = (over) => ({
  id: 83, gid: 3, group_name: "特惠主机", name: "Standard-V1", slug: "standard-v1", description: "", status: "active", product_type: "vps",
  billing_mode: "periodic", cpu_cores: 1, memory_mb: 1024, disk_gb: 20, bandwidth_mbps: 100, traffic_quota_gb: 1000, traffic_unlimited: false, free_ipv4_count: 1,
  stock_limited: false, stock_count: 0, hourly_price: null,
  pricing: [{ cycle: "monthly", price: 16500000, setup_fee: 0 }, { cycle: "annually", price: 198000000, setup_fee: 0 }],
  pve_pools: [{ pool_id: 1, name: "洛杉矶 Pro", location: "洛杉矶", enabled: true, online: true, available: true, description: "优化线路" }, { pool_id: 2, name: "法兰克福", location: "法兰克福", enabled: true, online: true, available: false }],
  ...over
});

test("breacloud emits one record per product x pool and honours region-full flags", () => {
  const records = run("breacloud", BREA, { code: "OK", data: { products: [breaProduct(), breaProduct({ id: 89, slug: "intel-1c1g", billing_mode: "usage", hourly_price: 19444, pricing: [{ cycle: "monthly", price: 14000000, setup_fee: 0 }], pve_pools: [{ pool_id: 16, name: "LA", location: "洛杉矶", enabled: true, online: true, available: true }] }), breaProduct({ id: 90, status: "inactive" })] } });
  assert.equal(records.length, 3);
  const [la, fra, usage] = records;
  assert.equal(la.id, "catalog-breacloud:plan:83-1");
  assert.equal(la.status, "available");
  assert.equal(la.price, "HKD 16.50/月");
  assert.equal(la.priceValue, 16.5);
  assert.equal(la.orderUrl, "https://brea.cloud/checkout?product=standard-v1&currency=HKD&region=1");
  assert.equal(fra.status, "unavailable");
  assert.equal(fra.statusLabel, "地区已满");
  assert.equal(usage.orderUrl, "https://brea.cloud/products?region=16&product=intel-1c1g");
  assert.match(usage.note, /HKD 0.019444\/小时/);
  const [left] = run("breacloud", BREA, { code: "OK", data: { products: [breaProduct({ stock_left: 0, pve_pools: [breaProduct().pve_pools[0]] })] } });
  assert.equal(left.status, "unavailable");
  assert.equal(left.stockCount, 0);
  assert.throws(() => run("breacloud", BREA, { code: "OK", data: { products: [breaProduct({ pricing: [{ cycle: "monthly", price: "16.5" }] })] } }), /price schema/);
  assert.throws(() => run("breacloud", BREA, { code: "ERR" }), /schema changed/);
});

// ------------------------------------------------------------------ KFCHost
const KFC = "https://kfchost.com/api/front/get-ecs-products?region=jp";
const kfcProduct = (over) => ({
  id: 1325, name: "星火", name_en: "Micro Start", desc: "低价入口款", status: 1, product_group: "ecs",
  price_json: { 1: { price: 99, show_price: 199, is_show: true } },
  option_json: { flow: "2000", ecs_billing_mode: "fixedFlow", system_disk: "10", bandwidth_desc: "200M", ip: "1", memory: "512", cpu: "1", bandwidth: "200", region: "jp" },
  is_sell_out: 0, ...over
});

test("kfchost reads price_json cents and is_sell_out", () => {
  const [open, sold] = run("kfchost", KFC, { code: 0, message: "", data: [kfcProduct(), kfcProduct({ id: 1326, is_sell_out: 1 })] });
  assert.equal(open.id, "catalog-kfchost:plan:1325");
  assert.equal(open.name, "星火 Micro Start");
  assert.equal(open.region, "日本");
  assert.equal(open.price, "USD 0.99/月");
  assert.equal(open.status, "available");
  assert.equal(open.bandwidth, "200M / 2000 GB/月 / 1 IPv4");
  assert.equal(open.orderUrl, "https://kfchost.com/center/product/ecs/create/plan/1325");
  assert.match(open.note, /原价 USD 1.99/);
  assert.equal(sold.status, "unavailable");
  assert.equal(sold.stockCount, 0);
  assert.throws(() => run("kfchost", KFC, { code: 0, data: [kfcProduct({ price_json: null })] }), /identity changed/);
  assert.throws(() => run("kfchost", KFC, { code: 401, data: [] }), /schema changed/);
});

// ------------------------------------------------------------------ HHost
const HH = "https://members.hhost.com/Console/Cloud/getPlans";
const hhPlan = (over) => ({ id: 3, cpu: 2, memory: 4096, hdd_size: 20, price: 500, down_bandwidth: 750, up_bandwidth: 750, traffic: 750, os_limit: 1, nat_port_count: 0, stock: { unlimited: true }, ...over });

test("hhost maps unlimited, counted and sold-out stock", () => {
  const payload = { HK: { 1: { name: "New Territories 1", ip_groups: [{ id: 1, group_name: "HK Global BGP", disabled: 0, plans: [hhPlan(), hhPlan({ id: 4, stock: { unlimited: false, available: 4, sold_out: false, low: true } }), hhPlan({ id: 5, stock: { unlimited: false, available: 0, sold_out: true } })] }] } }, JP: { 8: { name: "Tokyo", ip_groups: [{ id: 2, group_name: "Native IP", disabled: 1, plans: [hhPlan({ id: 31 })] }] } } };
  const [unlimited, counted, sold, disabled] = run("hhost", HH, payload);
  assert.equal(unlimited.status, "available");
  assert.equal(unlimited.stockCount, null);
  assert.equal(unlimited.region, "香港");
  assert.equal(unlimited.price, "USD 5.00/月");
  assert.equal(unlimited.orderUrl, "https://members.hhost.com/index.html#/affCloud?type=1&pid=3&cycle=0");
  assert.equal(counted.stockCount, 4);
  assert.equal(counted.statusLabel, "库存 4");
  assert.equal(sold.status, "unavailable");
  assert.equal(sold.stockCount, 0);
  assert.equal(disabled.status, "unknown");
  assert.equal(disabled.region, "日本");
  assert.throws(() => run("hhost", HH, { HK: { 1: { name: "x", ip_groups: [{ plans: [hhPlan({ price: "5" })] }] } } }), /plan schema/);
  assert.throws(() => run("hhost", HH, {}), /schema changed/);
});
