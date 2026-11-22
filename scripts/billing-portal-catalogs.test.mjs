import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHostbillOnestep, parseShandunCatalog, parseMoonvmCatalog, parseHaloCloudCatalog } from "./adapters/billing-portal-catalogs.mjs";
import { priceQuote } from "../pricing.js";

const baseRecord = (source, result, values) => ({ sourceId: source.id, provider: source.provider, finalUrl: result.finalUrl, ...values });
const page = (html, finalUrl) => ({ ok: true, statusCode: 200, finalUrl, html });

test("HaloCloud public payload maps VPS groups, clamps negative sellouts and ignores unlimited quantity", () => {
  const source = { id: 'catalog-halocloud', provider: 'HaloCloud', url: 'https://my.halocloud.net/index.php?rp=%2Fstore' };
  const plan = { id: 1, name: 'HK Premium', groupId: 8, description: 'CPU 1 Core\nMemory 1024 MB\nDisk 10 GB\nBandwidth Shared 1 Gbps\nTraffic 1000 GB\nIPv4 1', pricing: { monthly: '3.50', annually: '42.00' }, stockcontrol: true, qty: -74 };
  const payload = { result: 'success', data: { types: [{ id: 2, name: 'VPS' }], regions: [{ id: 1, name: 'Hong Kong' }], nodes: [{ id: 1, name: 'HK Premium', region_id: 1, supported_types_array: [2], product_group_id: 8 }] }, packages: [plan, { ...plan, id: 2, qty: 3 }, { ...plan, id: 3, stockcontrol: false, qty: 0 }], checkout: { logged_in: false } };
  const html = (data) => `<script>window.__HcPurchaseAppData = {currencyPrefix: "$"};</script><script>window.__SimplifiedCartPayload = ${JSON.stringify(data)};</script>`;
  const rows = parseHaloCloudCatalog(source, page(html(payload), source.url), { baseRecord });
  assert.deepEqual(rows.map(p=>p.status), ['unavailable', 'available', 'available']);
  assert.deepEqual(rows.map(p=>p.stockCount), [0, 3, null]);
  assert.equal(rows[0].region, '香港');
  assert.equal(rows[0].priceValue, 3.5);
  assert.equal(priceQuote(rows[0]).monthly, 3.5);
  assert.match(rows[0].hardware, /Memory 1024 MB/);
  assert.equal(new URL(rows[0].orderUrl).searchParams.get('pid'), '1');
  assert.equal(rows[0].raw.checkout, undefined);
  assert.throws(() => parseHaloCloudCatalog(source, page(html({ ...payload, packages: [{ ...plan, qty: null }] }), source.url), { baseRecord }), /schema changed/);
  assert.throws(() => parseHaloCloudCatalog(source, page('<h1>Maintenance</h1>', source.url), { baseRecord }), /payload missing/);
});

const moonvm = { id: 'catalog-moonvm', provider: 'MoonVM', url: 'https://store.moonvm.com/cart.php', currency: 'USD' };
function moonvmGroup(group, id, order = '') {
  return `<section class="moonvm-catalog-section"><header class="moonvm-catalog-divider"><h2>${group}</h2></header>
    <ul><li id="${id}"><div class="pricing-title">Residential Basic</div>
    <button class="moonvm-cycle-option" data-cycle="quarterly"><span class="pricing-price">$28.50</span><span class="billing-cycle">Quarterly</span></button>
    <button class="moonvm-cycle-option" data-cycle="monthly"><span class="pricing-price">$10.00</span><span class="billing-cycle">Monthly</span></button>
    <div class="pricing-details"><ul><li><ul><li>1 vCPU</li><li>1 GB RAM</li><li>10 GB SSD</li><li>100Mbps</li></ul></li></ul></div>
    <div class="pricing-link">${order || '<span>Out of Stock</span>'}</div></li></ul></section>`;
}

test("MoonVM uses official IDs and containing group regions across repeated full-catalog routes", () => {
  const html = moonvmGroup('Taiwan Hinet VPS', 'productg1-p1-b0') + moonvmGroup('Hong Kong HGC VPS', 'productg5-p25-b0', '<a href="/index.php?rp=/store/hgc/basic">Order</a>');
  const rows = parseMoonvmCatalog(moonvm, page(html, moonvm.url), { baseRecord });
  const repeated = parseMoonvmCatalog(moonvm, page(html, 'https://store.moonvm.com/index.php?rp=/store/hgc'), { baseRecord });
  assert.deepEqual(rows.map(p=>p.id), repeated.map(p=>p.id));
  assert.deepEqual(rows.map(p=>p.region), ['台湾', '香港']);
  assert.deepEqual(rows.map(p=>p.status), ['unavailable', 'available']);
  assert.equal(rows[0].stockCount, 0);
  assert.equal(rows[0].priceValue, 10);
  assert.equal(rows[0].raw.billingCycle, 'monthly');
  assert.equal(rows[0].hardware, '1 vCPU / 1 GB RAM / 10 GB SSD');
  assert.equal(rows[0].bandwidth, '100Mbps');
});

test("MoonVM rejects schema drift and external order links; sold-out badges override links", () => {
  assert.throws(()=>parseMoonvmCatalog(moonvm, page('<h1>Maintenance</h1>', moonvm.url), { baseRecord }), /sections missing/);
  assert.throws(()=>parseMoonvmCatalog(moonvm, page(moonvmGroup('Taiwan Hinet', 'productg1-p1-b0', '<a href="https://foreign.example/store/hk/basic">Order</a>'), moonvm.url), { baseRecord }), /outside official/);
  const html = moonvmGroup('Taiwan Hinet', 'productg1-p1-b0', '<span>Out of Stock</span><a href="/index.php?rp=/store/hk/basic">Order</a>');
  assert.equal(parseMoonvmCatalog(moonvm, page(html, moonvm.url), { baseRecord })[0].status, 'unavailable');
});

// Trimmed from the live HostBill "onestep_cloud_2019" order page (WebHorizon, Singapore EPYC).
const spec = (label, value) => `<div class="row mx-3">
<div class="col-6 p-1 text-right font-weight-light text-muted">${label}</div>
<div class="col-6 p-1 text-left font-weight-bold">${value}</div>
</div>`;
function hostbillCard({ pid, name, prices, outOfStock = false, variant = "", specs = "" }) {
  const cycles = Object.keys(prices);
  const labels = { m: "Monthly", q: "Quarterly", a: "Annually", w: "Hàng tuần" };
  return `<div class="col-lg-3 col-md-6 col-12"${variant ? ` data-code="${variant}"` : ""}>
<div style="overflow: unset !important; padding-top: 10px" class="card cart-product  ${outOfStock ? " outofstock " : ""}" data-value="${pid}">
<span class="vtip_description vtip_features" title="Windows &amp; Custom ISO Supported"></span>
${outOfStock ? `<div class="product-out-of-stock"><div class="cart-product-outofstock-badge">Out</br>of stock</div></div>` : ""}
<div class="text-center cart-product-section py-4">
<h4 class="">${name}</h4>${variant ? `<p class="d-none">${variant}</p>` : ""}
<div class="card-subtitle mt-3 font-weight-bold" style="display:none;">
<span class="h1 text-primary"> ${cycles.map((c) => `<span class="product-price cycle-${c}">${prices[c]}</span>`).join("")}</span>
<span class="h6 text-primary"> / ${cycles.map((c) => `<span class="product-cycle cycle-${c}">${labels[c] ?? c}</span>`).join("")}</span>
</div></div>
<div class="text-small cart-product-section"><div class="my-3">${specs}</div></div>
</div></div>`;
}
const webhorizon = { id: "catalog-webhorizon", providerId: "webhorizon", provider: "WebHorizon", url: "https://clients.webhorizon.net/?/cart/singapore-epyc/", catalogFormat: "hostbill-onestep" };
const whHtml = `<html><head><title>Place new Order - WEB HORIZON TECHNOLOGIES LLC</title></head><body>
<a onclick="return false;" class="mb-4 p-3 rounded media cart-category  selected "><div class="h3 mb-0 text-primary">Singapore</div></a>
<h1 class="my-5">KVM Virtual Servers</h1><div id="orderpage" class="orderpage"><div class="cart-products mb-5"><div class="row">
${hostbillCard({ pid: 201, name: "EPYC-KVM-3GB (Singapore)", prices: { m: "$6.00 USD", q: "$17.00 USD", a: "$61.00 USD" },
  specs: spec("CPU Core", "1 AMD EPYC™ 7003") + spec("Memory", "3GB DDR4 ECC") + spec("Storage", "45GB NVME RAID10") + spec("Transfer", "1TB @ 5Gbps") + spec("Connectivity", "IPv4 + /48 IPv6") + spec("DDoS Protection", "100Gbps") })}
${hostbillCard({ pid: 215, name: "EPYC-KVM-15GB (Singapore)", prices: { m: "$30.00 USD", q: "$85.50 USD" }, outOfStock: true, specs: spec("Memory", "15GB DDR4 ECC") })}
</div></div></div></body></html>`;

test("HostBill onestep cards map to per-pid plans with official out-of-stock flags and cart links", () => {
  const rows = parseHostbillOnestep(webhorizon, page(whHtml, webhorizon.url), { baseRecord });
  assert.equal(rows.length, 2);
  const [open, soldOut] = rows;
  assert.deepEqual(
    { id: open.id, name: open.name, price: open.price, priceValue: open.priceValue, currency: open.currency, status: open.status, stockCount: open.stockCount, orderUrl: open.orderUrl, region: open.region },
    { id: "catalog-webhorizon:plan:201", name: "EPYC-KVM-3GB (Singapore)", price: "$6.00 USD / Monthly", priceValue: 6, currency: "USD", status: "available", stockCount: null, orderUrl: "https://clients.webhorizon.net/?cmd=cart&action=add&id=201", region: "新加坡" }
  );
  assert.equal(open.hardware, "CPU Core: 1 AMD EPYC™ 7003 / Memory: 3GB DDR4 ECC / Storage: 45GB NVME RAID10");
  assert.equal(open.bandwidth, "Transfer: 1TB @ 5Gbps / Connectivity: IPv4 + /48 IPv6");
  assert.deepEqual(open.raw.cyclePrices, { m: "$6.00 USD", q: "$17.00 USD", a: "$61.00 USD" });
  assert.equal(open.category, "vps");
  assert.match(open.evidence, /pid=201; outofstock=false/);
  assert.deepEqual([soldOut.status, soldOut.stockCount, soldOut.priceValue], ["unavailable", 0, 30]);
  assert.equal(priceQuote(open).monthly, 6);
});

test("HostBill onestep handles VND thousands separators, localized cycles and Linux/Windows variants", () => {
  const source = { id: "catalog-dataonline", provider: "DataOnline", url: "https://my.dataonline.vn/cart/vps-nuoc-ngoai/" };
  const html = `<div id="orderpage"><div class="row">
${hostbillCard({ pid: 142, name: "VPS INTEL-01", variant: "Germany-Nuremberg-Linux-INTEL", prices: { m: "₫280,000 VND", q: "₫798,000 VND" }, specs: spec("CPU", "2 vCPU") + spec("RAM", "4 GB") + spec("Network", "10 Gbps") })}
${hostbillCard({ pid: 232, name: "VPS INTEL-01", variant: "Germany-Nuremberg-Windows-INTEL", prices: { m: "₫280,000 VND" } })}
${hostbillCard({ pid: 177, name: "Cloud VPS giá rẻ 1", prices: { w: "₫20,000 VND", m: "₫68,000 VND" } })}
</div></div>`;
  const rows = parseHostbillOnestep(source, page(html, source.url), { baseRecord });
  assert.deepEqual(rows.map((r) => r.id), ["catalog-dataonline:plan:142", "catalog-dataonline:plan:232", "catalog-dataonline:plan:177"]);
  assert.deepEqual(rows.map((r) => r.name), ["VPS INTEL-01 (Germany Nuremberg Linux INTEL)", "VPS INTEL-01 (Germany Nuremberg Windows INTEL)", "Cloud VPS giá rẻ 1"]);
  assert.deepEqual(rows.map((r) => [r.priceValue, r.currency, r.region]), [[280000, "VND", "德国"], [280000, "VND", "德国"], [68000, "VND", null]]);
  assert.equal(rows[2].price, "₫68,000 VND / Monthly", "monthly is preferred over the weekly cycle listed first");
  assert.equal(rows[0].orderUrl, "https://my.dataonline.vn/?cmd=cart&action=add&id=142");
  assert.equal(priceQuote(rows[2]).months, 1);
});

test("HostBill onestep throws on schema drift instead of reporting empty stock", () => {
  assert.throws(() => parseHostbillOnestep(webhorizon, page("<html><h1>Maintenance</h1></html>", webhorizon.url), { baseRecord }), /markup not found/);
  const noPrice = `<div class="card cart-product" data-value="9"><h4>X</h4></div>`;
  assert.throws(() => parseHostbillOnestep(webhorizon, page(noPrice, webhorizon.url), { baseRecord }), /no published price/);
});

// Trimmed from the live public JSON at https://www.shandun.net/console/v1/product?id=12&page=1&limit=12
const shandun = { id: "catalog-shandun", providerId: "shandun", provider: "ShanDun Network", url: "https://www.shandun.net/console/v1/product?id=12&page=1&limit=12", catalogFormat: "shandun" };
const specsHtml = (lines) => `<!DOCTYPE html>\n<html><body><div class="funidc-specs">${lines.map((l) => `<div>${l}</div>`).join("\n")}</div></body></html>`;
const item = (values) => ({ stock_control: 0, qty: 0, pay_type: "recurring_prepayment", cycle: "1個月", module: "mf_cloud", product_group_name_second: "美國", product_group_id_second: 12, product_group_name_first: "雲端伺服器", product_group_id_first: 1, ...values });
const shandunJson = JSON.stringify({ status: 200, msg: "請求成功", data: { count: 4, list: [
  item({ id: 9, name: "US Premium China Route", price: "4.99", stock_control: 1, qty: 0, description: specsHtml(["CN2 + 9929 + CMIN2 精品綫路", "AMD EPYC 高效能處理器", "1 - 10 個 IPv4 地址"]) }),
  item({ id: 7, name: "US 9929 Anti-DDoS", price: "4.99", description: specsHtml(["提供 200G DDoS 防禦", "AS9929，高峰時段穩定順暢", "EPYC 高效能處理器", "NVMe SSD 高速儲存"]) }),
  item({ id: 8, name: "US 4837 ISP", price: "4.99", stock_control: 1, qty: 3, description: specsHtml(["雙 ISP 美國原生 IP", "最高 1000M 優化頻寬"]) }),
  item({ id: 99, name: "Other group", price: "9", product_group_id_first: 2, description: "" })
] } });

test("ShanDun public product API follows the official store's stock_control/qty sold-out rule", () => {
  const rows = parseShandunCatalog(shandun, page(shandunJson, shandun.url), { baseRecord });
  assert.deepEqual(rows.map((r) => r.id), ["catalog-shandun:plan:9", "catalog-shandun:plan:7", "catalog-shandun:plan:8"]);
  assert.deepEqual(rows.map((r) => [r.status, r.stockCount]), [["unavailable", 0], ["available", null], ["available", 3]]);
  assert.deepEqual(rows.map((r) => r.orderUrl), [9, 7, 8].map((id) => `https://www.shandun.net/store/cloud-servers.html?id=${id}`));
  assert.deepEqual(rows.map((r) => r.region), ["美国", "美国", "美国"]);
  assert.equal(rows[0].route, "CN2 / 9929 / CMIN2");
  assert.equal(rows[1].price, "US$4.99 起/1個月");
  assert.equal(rows[2].category, "home");
  assert.equal(rows[1].hardware, "EPYC 高效能處理器 / NVMe SSD 高速儲存");
  const quote = priceQuote(rows[1]);
  assert.equal(quote.baseOnly, true, "configurable starting prices are never folded into a fixed monthly estimate");
  assert.equal(quote.currency, "USD");
});

test("ShanDun parser throws when the API is not the expected public JSON", () => {
  assert.throws(() => parseShandunCatalog(shandun, page("<html>login</html>", shandun.url), { baseRecord }), /did not return JSON/);
  assert.throws(() => parseShandunCatalog(shandun, page(JSON.stringify({ status: 401, msg: "unauthorized" }), shandun.url), { baseRecord }), /schema changed/);
  assert.throws(() => parseShandunCatalog(shandun, page(JSON.stringify({ status: 200, data: { list: [{ id: 1, name: "x", product_group_id_first: 1 }] } }), shandun.url), { baseRecord }), /stock fields/);
});
