import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarketingCatalog } from "./adapters/marketing-catalogs.mjs";

const baseRecord = (source, result, values) => ({ sourceId: source.id, provider: source.provider, ...values });
function read(format, html, url, extra = {}) {
  const source = { id: `catalog-${format}`, provider: format, catalogFormat: format, url, ...extra };
  return parseMarketingCatalog(source, { html, finalUrl: url, statusCode: 200 }, { baseRecord });
}
const evoxtUrl = "https://evoxt.com/pricing/";
const cloudUrl = "https://v.ps/products/cloud-kvm-vps/";
const miniUrl = "https://v.ps/products/mini-kvm-vps/";
const evoxtRow = (price = "2.99", transfer = "500 GB", marker = "") => `<tr><td><span class="plan-name">VM-0.5</span></td><td>1 core (Up to 6.0 GHz)</td><td>512 MB</td><td>5 GB</td><td>${transfer}</td><td>Weekly</td><td class="price-cell"><span class="price-amount">$${price}</span><span class="price-period"> / month</span>${marker}</td><td><a class="row-cta" href="https://console.evoxt.com/deploy.php">Deploy</a></td></tr>`;
const evoxtGroup = (id, title, locations, row) => `<section class="region-block" id="${id}"><div class="region-heading"><h3>${title}</h3><div class="region-note"><p>Regions</p>${locations}</div></div><table class="pricing-table"><thead><tr>${["Plan", "CPU", "RAM", "Storage", "Monthly Transfer", "Backup", "Price", ""].map((label) => `<th>${label}</th>`).join("")}</tr></thead><tbody>${row}</tbody></table></section>`;
const evoxtPage = () => `<section id="pricing-table">${evoxtGroup("global-regions", "Standard", "United States · Japan (Tokyo) · Malaysia", evoxtRow())}${evoxtGroup("hk-osaka-regions", "Premium Network", "Hong Kong · Japan (Osaka)", evoxtRow("2.99", "250 GB"))}${evoxtGroup("my-premium-region", "Premium Plus Network", "Malaysia (Premium)", evoxtRow("3.49", "150 GB"))}<p class="fine-print">All regions are on a 1 Gigabit port.</p></section><section><article><h3>Extra CPU Cores</h3><span>1 vCore</span><strong>$3 / month</strong></article><article><h3>Extra RAM</h3><span>1 GB RAM</span><strong>$2 / month</strong></article></section>`;
// DOM structure copied from the public V.PS family page; a whole anchor is a card.
const vpsCard = (id = "148", name = "NRT Starter", price = "6.95", cycle = "mo", marker = "") => `<a href="https://vps.hosting/?cmd=cart&amp;action=add&amp;id=${id}" title="Order ${name}" class="group"><span class="font-semibold text-ink">${name}</span><ul><li>2 CPU cores</li><li>1 GB memory</li><li>20 GB NVMe</li><li>1 TB transfer</li><li>1 IPv4</li><li>1 IPv6</li><li>1 Gbps port</li></ul><span><span><span class="font-mono text-2xl">€${price}</span><span class="text-sm text-mute">/${cycle}</span></span><span>Order →</span></span>${marker}</a>`;
const vpsPage = (cards) => `<h1>Cloud KVM VPS</h1><h2>Asia Pacific</h2><div><a href="/locations/tokyo/" title="Tokyo VPS"><img src="/flags/jp.svg" alt="Japan">Tokyo<span>NRT</span></a><div class="mt-4 flex flex-wrap gap-3">${cards}</div></div><script type="application/ld+json">{"@type":"AggregateOffer","offerCount":40}</script>`;

test("Evoxt keeps each region group, prices and published transfer without resource add-ons", () => {
  const records = read("evoxt", evoxtPage(), evoxtUrl);
  assert.equal(records.length, 3);
  assert.equal(new Set(records.map((record) => record.id)).size, 3);
  assert.deepEqual(records.map((record) => record.price), ["USD 2.99/month", "USD 2.99/month", "USD 3.49/month"]);
  assert.deepEqual(records.map((record) => record.raw.catalogFamily), ["global-regions", "hk-osaka-regions", "my-premium-region"]);
  assert.equal(records[1].name, "VM-0.5 · Premium Network");
  assert.equal(records[1].region, "多地区（下单选择）");
  assert.equal(records[1].raw.publishedRegions, "Hong Kong · Japan (Osaka)");
  assert.equal(records[2].region, "马来西亚");
  assert.deepEqual(records.map((record) => record.regions), [["美国", "日本", "马来西亚"], ["香港", "日本"], ["马来西亚"]]);
  assert.match(records[0].hardware, /512 MB RAM \/ 5 GB Storage/);
  assert.match(records[0].bandwidth, /500 GB Monthly Transfer \/ 1 Gigabit port/);
  assert.match(records[2].bandwidth, /150 GB/);
  assert.ok(records.every((record) => record.currency === "USD" && record.raw.billingCycle === "month"));
  assert.ok(records.every((record) => !/Extra/.test(record.name)));
});

test("Evoxt marketing deploy links leave stock unknown and price edits retain plan identities", () => {
  const before = read("evoxt", evoxtPage(), evoxtUrl);
  const after = read("evoxt", evoxtPage().replaceAll("$2.99", "$4.99"), evoxtUrl);
  assert.deepEqual(before.map((record) => record.id), after.map((record) => record.id));
  for (const record of before) {
    assert.equal(record.status, "unknown");
    assert.equal(record.stockCount, null);
    assert.equal(record.statusLabel, "库存未公开");
    assert.equal(record.orderUrl, "https://console.evoxt.com/deploy.php");
  }
});

test("V.PS parses individual anchor cards instead of region headings with official country labels", () => {
  const records = read("vps", vpsPage(vpsCard() + vpsCard("149", "NRT Essential", "7.95")), cloudUrl);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.name), ["NRT Starter", "NRT Essential"]);
  assert.equal(records[0].region, "日本");
  assert.equal(records[0].raw.publishedCountry, "Japan");
  assert.equal(records[0].raw.publishedCity, "Tokyo");
  assert.equal(records[0].raw.locationUrl, "https://v.ps/locations/tokyo/");
  assert.equal(records[0].raw.productId, "148");
  assert.equal(records[0].hardware, "2 CPU cores / 1 GB memory / 20 GB NVMe");
  assert.equal(records[0].price, "EUR 6.95/month");
  assert.equal(records[0].currency, "EUR");
  assert.equal(records[0].orderUrl, "https://vps.hosting/?cmd=cart&action=add&id=148");
});

test("V.PS annual plans retain their billing cycle and marketing offerCount is never inventory", () => {
  const [record] = read("vps", vpsPage(vpsCard("161", "NRT Mini", "39.95", "yr")), miniUrl);
  assert.equal(record.price, "EUR 39.95/year");
  assert.equal(record.priceValue, 39.95);
  assert.equal(record.raw.billingCycle, "year");
  assert.equal(record.status, "unknown");
  assert.equal(record.stockCount, null);
  assert.equal(record.statusLabel, "库存未公开");
});

test("V.PS identity uses source, family and product ID, independent of title or price", () => {
  const [before] = read("vps", vpsPage(vpsCard()), cloudUrl);
  const [after] = read("vps", vpsPage(vpsCard("148", "NRT Renamed", "8.95")), cloudUrl);
  assert.equal(before.id, after.id);
  assert.notEqual(before.id, read("vps", vpsPage(vpsCard()), miniUrl)[0].id);
  assert.notEqual(before.id, read("vps", vpsPage(vpsCard()), cloudUrl, { id: "other-source" })[0].id);
  assert.equal(read("vps", vpsPage(vpsCard() + vpsCard()), cloudUrl).length, 1);
});

test("explicit plan stock markers are respected, and country is not guessed from plan names", () => {
  const [sold] = read("vps", vpsPage(vpsCard("148", "NRT Starter", "6.95", "mo", '<span class="stock">Sold Out</span>')), cloudUrl);
  assert.equal(sold.status, "unavailable"); assert.equal(sold.stockCount, 0);
  const [marked] = read("vps", vpsPage(vpsCard("148", "NRT Starter", "6.95", "mo", '<span class="stock" data-stock="1">In Stock</span>')), cloudUrl);
  assert.equal(marked.status, "available"); assert.equal(marked.stockCount, null);
  const [ambiguous] = read("vps", vpsPage(vpsCard("148", "NRT Starter", "6.95", "mo", '<span data-stock="1">Order</span>')), cloudUrl);
  assert.equal(ambiguous.status, "unknown"); assert.equal(ambiguous.stockCount, null);
  const [noCountry] = read("vps", vpsPage(vpsCard()).replace('alt="Japan"', 'alt=""'), cloudUrl);
  assert.equal(noCountry.region, null);
});

test("V.PS normalizes published Hong Kong locations and the Netherlands country alias", () => {
  const hongKong = vpsPage(vpsCard("286", "HKG Starter"))
    .replace('title="Tokyo VPS"', 'title="Hong Kong VPS"').replace('alt="Japan"', 'alt="China"');
  const [hk] = read("vps", hongKong, cloudUrl);
  assert.equal(hk.region, "香港");
  assert.equal(hk.raw.publishedCountry, "China");
  assert.equal(hk.raw.publishedCity, "Hong Kong");
  const amsterdam = vpsPage(vpsCard("91", "AMS Starter"))
    .replace('title="Tokyo VPS"', 'title="Amsterdam VPS"').replace('alt="Japan"', 'alt="The Netherlands"');
  const [nl] = read("vps", amsterdam, cloudUrl);
  assert.equal(nl.region, "荷兰");
  assert.equal(nl.raw.publishedCountry, "The Netherlands");
});

test("catalog schema or billing changes fail explicitly instead of emitting guessed prices", () => {
  assert.throws(() => read("evoxt", "<h1>Login</h1>", evoxtUrl), /region tables missing/);
  assert.throws(() => read("evoxt", evoxtPage().replace("$2.99", "$TBA"), evoxtUrl), /price or billing period changed/);
  assert.throws(() => read("vps", vpsPage(vpsCard("148", "NRT Starter", "6.95", "week")), cloudUrl), /price or billing period changed/);
  assert.throws(() => read("vps", vpsPage(vpsCard()), "https://v.ps/pricing/"), /family page/);
});
