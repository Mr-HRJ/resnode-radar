import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVpsSiteCatalog, VPS_SITE_CATALOG_FORMATS } from "./adapters/vps-site-catalogs.mjs";

const baseRecord = (source, result, values) => ({ sourceId: source.id, provider: source.provider, finalUrl: result.finalUrl, ...values });
const result = (html, finalUrl) => ({ ok: true, statusCode: 200, finalUrl, html });
const read = (source, html, url) => parseVpsSiteCatalog(source, result(html, url), { baseRecord });

// ---- Misaka: trimmed copy of the server-rendered location page markup -------------------------
const misaka = { id: "catalog-misaka", providerId: "misaka", provider: "Misaka", catalogFormat: "misaka", url: "https://www.misaka.io/locations/hongkong" };
const misakaRow = (plan, price, availability, disk = "48 GB") => `<tr data-slot="table-row"><td data-slot="table-cell">${plan}</td><td>Premium</td><td class="text-right">2</td><td>3 GB</td><td>${disk}</td><td>3 TB<span class="ml-2">Higher direction</span></td><td><span class="font-semibold">$${price}</span><span class="ml-1">/ <!-- -->month</span></td><td>${availability}</td></tr>`;
const deploy = (region, slug) => `<a href="https://app.misaka.io/iaas/vm/create/${region}/${slug}" class="x" aria-label="Deploy">Deploy<svg></svg></a>`;
const soldOut = `<button type="button" disabled>Sold out</button>`;
const misakaPage = ({ diskHeader = "NVMe", rows } = {}) => `<html><head><title>Hong Kong VPS &amp; Cloud Servers | Misaka.io</title></head><body>
<section id="cloud-servers"><div><div id="hkg12-inventory" class="py-8">
  <div class="mb-7"><h2><span class="inventory-heading-text">Cloud Servers</span></h2><div><span class="inventory-heading-text">Equinix HK2</span><code data-region-code="hkg12">HKG12</code></div></div>
  <div class="mb-10"><div id="plans-hkg12-premium"></div><h3>Standard NVMe (Gen3, AMD EPYC)</h3>
    <div data-slot="table-container"><table><thead><tr><th>Plan</th><th>Routing Profile</th><th>vCPU</th><th>RAM</th><th>${diskHeader}</th><th>Transfer</th><th>Price</th><th>Availability</th></tr></thead>
    <tbody>${rows ?? misakaRow("S3N-2C3G", "30", deploy("hkg12", "s3n-2c3g")) + misakaRow("S3N-1C1G", "10", soldOut)}</tbody></table></div>
    <div class="md:hidden"><h4>S3N-2C3G</h4></div>
  </div>
  <div class="mt-6"><span>Prices in USD. Stock is confirmed at checkout.</span></div>
</div></div></section></body></html>`;

test("Misaka location tables yield per-region plans with Deploy links and explicit sold-out rows", () => {
  const rows = read(misaka, misakaPage(), misaka.url);
  assert.equal(rows.length, 2);
  const [open, closed] = rows;
  assert.equal(open.id, "catalog-misaka:plan:hkg12:s3n-2c3g");
  assert.equal(open.name, "S3N-2C3G · Hong Kong HKG12");
  assert.equal(open.region, "香港");
  assert.equal(open.route, "Premium · Standard NVMe (Gen3, AMD EPYC)");
  assert.equal(open.hardware, "2 vCPU / 3 GB RAM / 48 GB NVMe");
  assert.equal(open.bandwidth, "3 TB transfer (higher direction)");
  assert.deepEqual([open.price, open.priceValue, open.currency], ["USD 30/月", 30, "USD"]);
  assert.deepEqual([open.status, open.stockCount, open.orderUrl], ["available", null, "https://app.misaka.io/iaas/vm/create/hkg12/s3n-2c3g"]);
  assert.match(open.note, /Equinix HK2/);
  assert.deepEqual([closed.status, closed.stockCount, closed.orderUrl, closed.priceValue], ["unavailable", 0, null, 10]);
});

test("Misaka accepts SSD disk columns and rejects drifted tables or off-site deploy links", () => {
  const [row] = read(misaka, misakaPage({ diskHeader: "SSD", rows: misakaRow("S2-1C1G", "5", deploy("hkg12", "s2-1c1g"), "25 GB") }), misaka.url);
  assert.equal(row.hardware, "2 vCPU / 3 GB RAM / 25 GB SSD");
  assert.throws(() => read(misaka, misakaPage({ diskHeader: "Disk" }), misaka.url), /schema changed/);
  assert.throws(() => read(misaka, misakaPage({ rows: misakaRow("S3N-2C3G", "30", `<a href="https://evil.example/x">Deploy</a>`) }), misaka.url), /deploy link host/);
  assert.throws(() => read(misaka, misakaPage({ rows: misakaRow("S3N-2C3G", "30 / year", soldOut) }), misaka.url), /schema changed/);
  assert.throws(() => read(misaka, misakaPage(), "https://www.misaka.io/services/cloud"), /requires an official/);
  assert.deepEqual(read(misaka, "<html><title>Lagos VPS</title><body><p>Coming soon</p></body></html>", "https://www.misaka.io/locations/lagos"), []);
});

// ---- HostHatch: excerpt of the official js/app.js plan modules --------------------------------
const hosthatch = { id: "catalog-hosthatch", providerId: "hosthatch", provider: "HostHatch", catalogFormat: "hosthatch", url: "https://hosthatch.com/js/app.js" };
const hhBundle = `741:(e,t,n)=>{"use strict";var r=n(8216),o=n(1129),i=n(7534);const s={label:"NVMe 2 GB",price:{value:4,currency:"USD",cycle:"month"},locations:{AMS:o.VO,LAX:r.U,HKG:i.Kv},hardware:{cpu:{value:1,label:"1 AMD EPYC core",note:"( fair share )"},ram:{value:2,unit:"GB",label:"2 GB DDR4",note:""},storage:{value:10,unit:"GB",label:"10 GB NVMe",note:""},bandwidth:{value:1,unit:"TB",label:"1 TB",tooltip:"500GB in Hong Kong, Tokyo, Sydney & Singapore"}}},a={label:"Storage 1TB",price:{value:5,currency:"USD",cycle:"month"},locations:{AMS:o.VO,STO:o.dJ},hardware:{cpu:{value:1,label:"1 vCPU core",note:""},ram:{value:1024,unit:"MB",label:"1024 MB",note:""},storage:{value:1e3,unit:"GB",label:"1000 GB",note:""},bandwidth:{value:2500,unit:"GB",label:"2500 GB",note:""}}}}`;

test("HostHatch bundle plans become price-only records with official locations and no invented stock", () => {
  const rows = read(hosthatch, hhBundle, hosthatch.url);
  assert.equal(rows.length, 2);
  const [nvme, storage] = rows;
  assert.equal(nvme.id, "catalog-hosthatch:plan:compute:nvme-2-gb");
  assert.equal(nvme.name, "NVMe 2 GB · Compute VM");
  assert.equal(nvme.hardware, "1 AMD EPYC core ( fair share ) / 2 GB DDR4 RAM / 10 GB NVMe");
  assert.deepEqual(nvme.regions, ["荷兰", "美国", "香港"]);
  assert.equal(nvme.region, "多地区（下单选择）");
  assert.deepEqual([nvme.price, nvme.priceValue, nvme.currency], ["USD 4/月", 4, "USD"]);
  assert.deepEqual([nvme.status, nvme.stockCount, nvme.orderUrl], ["unknown", null, null]);
  assert.match(nvme.note, /500GB in Hong Kong/);
  assert.equal(storage.id, "catalog-hosthatch:plan:storage:storage-1tb");
  assert.equal(storage.bandwidth, "2500 GB transfer");
});

test("HostHatch parser fails loudly on drift", () => {
  assert.throws(() => read(hosthatch, "console.log('no plans')", hosthatch.url), /no published plan objects/);
  assert.throws(() => read(hosthatch, hhBundle.replace("AMS:o.VO,LAX", "XYZ:o.VO,LAX"), hosthatch.url), /unknown location code XYZ/);
  assert.throws(() => read(hosthatch, hhBundle.replace(/ram:\{[^}]*\},/, ""), hosthatch.url), /plan NVMe 2 GB/);
  assert.throws(() => read(hosthatch, hhBundle, "https://hosthatch.com/"), /requires the official/);
});

// ---- GoldCloud: anonymous JSON product list the storefront calls ------------------------------
const goldcloud = { id: "catalog-goldcloud", providerId: "goldcloud", provider: "GoldCloud", catalogFormat: "goldcloud", url: "https://goldcloud.dev/api/v1/products" };
const gcPayload = [{
  key: "42cbcace9a", name: "HK-DC1", flag: "https://goldcloud.dev/static/flag-hk.svg",
  intro: "CPU:E5 2697AV4 峰值50Mbps 保底10Mbps 去程电信CN2 联通4837 移动CMI 回程CN2 10099 CMI 动态优化 测试IP 43.255.159.1",
  trafficNote: "流量用尽后可购买流量包扩容",
  products: [
    { id: 7, urlToken: "AXs1ig", name: "HK-DC1 2H1G", category: "cmi", description: "CPU：2核\n内存：1G\n系统盘：30G\n数据盘：30G\nIP数量：1个ipv4\n流量：1T", priceMonth: 30, stock: 3 },
    { id: 8, urlToken: "p6klVe", name: "HK-DC1 2H2G", category: "cmi", description: "CPU：2核\n内存：2G", priceMonth: 34.5, stock: 0 }
  ]
}, { key: "e4725c11a4", name: "DE-DC1", intro: "CPU:AMD EPYC 去程 GTT 直连优化", products: [{ id: 30, urlToken: "Zz9", name: "DE-DC1 2H2G", description: "CPU：2核", priceMonth: 37.5, stock: 804 }] }];

test("GoldCloud product API maps official stock counts and per-product order pages", () => {
  const rows = read(goldcloud, JSON.stringify(gcPayload), goldcloud.url);
  assert.equal(rows.length, 3);
  const [hk, soldOutRow, de] = rows;
  assert.equal(hk.id, "catalog-goldcloud:plan:7");
  assert.equal(hk.region, "香港");
  assert.equal(hk.route, "CN2 / 4837 / CMI / 10099");
  assert.equal(hk.hardware, "2核 CPU / 1G RAM / 30G 系统盘 / 30G 数据盘");
  assert.equal(hk.bandwidth, "峰值 50Mbps / 保底 10Mbps / 1T 流量 / 1个ipv4");
  assert.deepEqual([hk.price, hk.priceValue, hk.currency], ["CNY 30/月", 30, "CNY"]);
  assert.deepEqual([hk.status, hk.stockCount, hk.orderUrl, hk.statusLabel], ["available", 3, "https://my.goldcloud.dev/products/AXs1ig", "库存 3"]);
  assert.equal(hk.sourceUrl, "https://my.goldcloud.dev/products/category/42cbcace9a");
  assert.deepEqual([soldOutRow.status, soldOutRow.stockCount, soldOutRow.priceValue], ["unavailable", 0, 34.5]);
  assert.deepEqual([de.region, de.route, de.stockCount], ["德国", "GTT", 804]);
});

test("GoldCloud parser rejects non-JSON, drifted fields and other endpoints", () => {
  assert.throws(() => read(goldcloud, "<!doctype html><title>Gold Cloud 控制台</title>", goldcloud.url), /not JSON/);
  assert.throws(() => read(goldcloud, JSON.stringify([{ ...gcPayload[0], products: [{ ...gcPayload[0].products[0], stock: "3" }] }]), goldcloud.url), /schema changed/);
  assert.throws(() => read(goldcloud, JSON.stringify({ products: [] }), goldcloud.url), /category list missing/);
  assert.throws(() => read(goldcloud, JSON.stringify(gcPayload), "https://my.goldcloud.dev/api/v1/products"), /requires the official/);
});

test("dispatcher exposes exactly the formats it handles", () => {
  assert.deepEqual(VPS_SITE_CATALOG_FORMATS, ["misaka", "hosthatch", "goldcloud"]);
  assert.throws(() => parseVpsSiteCatalog({ catalogFormat: "nope" }, result("", "https://x.test/"), { baseRecord }), /Unsupported/);
});
