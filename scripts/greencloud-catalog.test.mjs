import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCatalogPage } from "./adapters/catalog-pages.mjs";
import { parseGreenCloudCatalog } from "./adapters/greencloud-catalog.mjs";
import { productRegions, productSpecs } from "../discovery.js";

const source = {
  id: "catalog-greencloud", providerId: "greencloud", provider: "GreenCloud(绿云)",
  url: "https://www.greencloudvps.com/billing/store/ssd-kvm-vps/?language=english",
  adapter: "public_catalog", currency: "USD"
};
const baseRecord = (s, r, values) => ({ sourceId: s.id, provider: s.provider, ...values });
const result = (html, url = source.url) => ({ html, finalUrl: url, statusCode: 200, ok: true });
const read = (html, options = {}) => parseGreenCloudCatalog({ ...source, ...options }, result(html, options.url || source.url), { baseRecord });
const feature = (label, value) => `<li><span class="feature-value">${value}</span> ${label}</li>`;
// Same header, feature-value labels, price, quantity and order markup as both official groups.
function card({ id = 1, name = "KVMUT-1", location = "Ogden, UT", ipv6 = "/64", stock = null, amount = "6.00", cycle = "Monthly", href = `/billing/store/ssd-kvm-vps/plan-${id}`, extraFeatures = "" } = {}) {
  return `<div class="product clearfix" id="product${id}">
    <header><span id="product${id}-name">${name}</span> ${stock === null ? "" : `<span class="qty">${stock} Available</span>`}</header>
    <div class="product-desc"><ul>${[
      ["RAM", "1024MB"], ["Hard drive", "15GB SSD RAID-10"], ["CPU", "1 core"],
      ["IPv4", "1"], ["IPv6", ipv6], ["Bandwidth", "1.5TB"], ["Port", "10Gbps"],
      ["OS", "Linux"], ["Location", location], ["Control Panel", "Virtfusion"]
    ].map(([label, value]) => feature(label, value)).join("")}${extraFeatures}</ul></div>
    <footer><div class="product-pricing"><span class="price">$${amount} USD</span><br>${cycle}<br></div>
    <a class="btn btn-order-now" href="${href}">Order Now</a></footer>
  </div>`;
}

function core(record) {
  return Object.fromEntries(["id", "name", "sourceUrl", "priceValue", "status", "statusLabel", "stockCount", "orderUrl", "hardware", "route", "category", "evidence"].map((key) => [key, record[key]]));
}

test("GreenCloud enriches full network specs while retaining generic identities, prices and stock semantics", () => {
  const html = card() + card({ id: 2, name: "KVMCA-1", location: "Toronto, ON (Canada)", stock: 0 });
  const before = parseCatalogPage(source, result(html), { baseRecord });
  const rows = read(html);
  assert.deepEqual(rows.map(core), before.map(core));
  assert.deepEqual(rows.map((row) => row.raw.billingCycle), before.map((row) => row.raw.billingCycle));
  assert.deepEqual(rows.map((row) => [row.status, row.stockCount]), [["available", null], ["unavailable", 0]]);
  const row = rows[0];
  assert.equal(row.price, "$6.00 USD Monthly");
  assert.equal(row.currency, "USD");
  assert.equal(row.raw.priceText, "$6.00 USD");
  assert.equal(row.raw.publishedLocation, "Ogden, UT");
  assert.deepEqual(row.raw.features, {
    CPU: "1 core", 内存: "1024MB", 硬盘: "15GB SSD RAID-10", 流量: "1.5TB", 带宽: "10Gbps", IPv4: "1", IPv6: "/64"
  });
  assert.equal(row.bandwidth, "1.5TB Traffic / 10Gbps Port / 1 IPv4 / /64 IPv6");
  assert.deepEqual(productSpecs(row), { cpu: "1 core", memory: "1024MB", disk: "15GB SSD RAID-10", bandwidth: "10 Gbps", traffic: "1.5TB" });
  assert.deepEqual(productRegions(row), ["美国"]);
});

test("GreenCloud annual billing and IPv6 /112 stay separate from port speed and transfer", () => {
  const url = "https://www.greencloudvps.com/billing/store/budget-kvm-sale/?language=english";
  const html = card({ name: "BudgetKVMMO-2", location: "Kansas City, MO", ipv6: "/112", stock: 8, amount: "25.00", cycle: "Annually", href: "/billing/store/budget-kvm-sale/budgetkvmmo-2", extraFeatures: feature("Note", "No refund/Money back on this plan.") });
  const [row] = read(html, { url });
  assert.deepEqual(core(row), core(parseCatalogPage({ ...source, url }, result(html, url), { baseRecord })[0]));
  assert.equal(row.price, "$25.00 USD Annually");
  assert.equal(row.raw.billingCycle, "Annually");
  assert.equal(row.raw.features.IPv6, "/112");
  assert.equal(productSpecs(row).bandwidth, "10 Gbps");
  assert.equal(productSpecs(row).traffic, "1.5TB");
  assert.equal(row.stockCount, 8);
});

test("GreenCloud maps the actual published city/country labels, including all captured locations", () => {
  const groups = {
    加拿大: ["Toronto, ON (Canada)"],
    美国: ["Dallas, TX (USA)", "Dallas, TX", "Los Angeles, CA", "Ogden, UT", "Location: Ogden, UT", "Phoenix, AZ", "San Jose, CA", "Jacksonville, FL", "Kansas City, MO", "Chicago, IL DC1", "Chicago, IL DC2", "Ashburn, VA", "Buffalo, NY", "Staten Island, NY"],
    荷兰: ["Amsterdam, NL"], 德国: ["Frankfurt, DE"], 英国: ["Coventry, UK"],
    新加坡: ["Singapore DC1", "Singapore DC2"], 日本: ["Tokyo, JP IIJ Line", "Tokyo, JP Softbank Line"],
    香港: ["Hong Kong DC1", "Hong Kong DC2"], 罗马尼亚: ["Bucharest, RO"]
  };
  for (const [country, locations] of Object.entries(groups)) {
    for (const location of locations) {
      const [row] = read(card({ location }));
      assert.equal(row.region, country, location);
      assert.equal(row.raw.publishedLocation, location);
    }
  }
});

test("GreenCloud leaves ambiguous locations unknown despite country-looking plan names or page hints", () => {
  for (const location of ["Undisclosed", "CA", "London", "Chicago, IL / Tokyo, JP", "greencloudvps.com"]) {
    const [row] = read(card({ name: "Tokyo US KVM", location }), { regionHint: "日本", pageLabel: "United States VPS" });
    assert.equal(row.region, null, location);
    assert.equal(row.raw.publishedLocation, location);
  }
});

test("GreenCloud matches normalized order URLs, retaining distinct cards with the same name", () => {
  const html = '<base href="https://www.greencloudvps.com/billing/">' +
    card({ id: 2, name: "Shared display name", location: "Bucharest, RO", href: "store/ssd-kvm-vps/second?ref=abc#buy" }) +
    card({ id: 1, name: "Shared display name", location: "Coventry, UK", href: "store/ssd-kvm-vps/first?utm_source=promo" });
  const rows = read(html);
  assert.deepEqual(rows.map(core), parseCatalogPage(source, result(html), { baseRecord }).map(core));
  assert.deepEqual(rows.map((row) => [row.region, row.orderUrl]), [
    ["罗马尼亚", "https://www.greencloudvps.com/billing/store/ssd-kvm-vps/second"],
    ["英国", "https://www.greencloudvps.com/billing/store/ssd-kvm-vps/first"]
  ]);
});

test("GreenCloud rejects changed or ambiguous card schemas instead of assigning unrelated enrichment", () => {
  const malformed = [
    "<h1>Login</h1>",
    card().replace(feature("RAM", "1024MB"), ""),
    card({ extraFeatures: feature("CPU", "8 cores") }),
    card().replace('class="feature-value">1.5TB', 'class="feature-value">10Gbps'),
    card().replace('class="feature-value">10Gbps', 'class="feature-value">/64'),
    card().replace("$6.00 USD", "$6.00 EUR"),
    card({ cycle: "Weekly" }),
    card().replace("btn-order-now", "other-order"),
    card({ href: "/billing/store/ssd-kvm-vps/same?ref=one" }) + card({ id: 2, href: "/billing/store/ssd-kvm-vps/same?ref=two" }),
    card().replace('<footer>', '<span class="price">$99.00 USD</span><footer>'),
    card() + '<div class="package"><h3>Extra KVM</h3><p>1 core CPU / 1 GB RAM</p><span class="price">$2.00</span><span class="cycle">Monthly</span><a href="/billing/store/ssd-kvm-vps/extra">Order</a></div>'
  ];
  for (const html of malformed) assert.throws(() => read(html), /GreenCloud public catalog schema changed/);
  assert.throws(() => read(card(), { currency: "EUR" }), /published USD price or billing cycle mismatch/);
});

test("GreenCloud derives USD only from explicit published text and restricts supported official groups", () => {
  assert.equal(read(card(), { currency: undefined })[0].currency, "USD");
  assert.throws(() => read(card().replace("$6.00 USD", "$6.00"), { currency: undefined }), /published USD price or billing cycle mismatch/);
  for (const url of ["https://foreign.example/billing/store/ssd-kvm-vps/", "https://www.greencloudvps.com/billing/login", "https://www.greencloudvps.com/billing/store/unreviewed/"]) {
    assert.throws(() => read(card(), { url }), /unsupported official catalog group URL/);
  }
});
