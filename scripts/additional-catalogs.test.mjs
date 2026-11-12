import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAdditionalCatalog } from "./adapters/additional-catalogs.mjs";

const helpers = {
  baseRecord: (source, result, fields) => ({
    sourceId: source.id, providerId: source.providerId, provider: source.provider,
    sourceUrl: source.url, finalUrl: result.finalUrl, ...fields
  })
};
const sourceFor = (format, url) => ({ id: `catalog-${format}`, providerId: format, provider: format, category: "vps", catalogFormat: format, url });
const resultFor = (url, html) => ({ ok: true, statusCode: 200, finalUrl: url, html, headers: {} });
const hk = "https://clients.zgovps.com/index.php?/cart/hongkong-amd-vps/";
const la = "https://clients.zgovps.com/index.php?/cart/los-angeles-amd-optimised-vps/";
const zgoForm = ({ productId = "117", button = '<button class="btn mt-3 btn-success">Continue</button>', stock = "", reverse = false } = {}) => {
  const options = ['<option value="q">$18.00 USD Quarterly</option>', '<option value="a">$66.00 USD Annually</option>'];
  return `<form class="bordered-section p-4" method="post" action=""><div class="d-flex flex-column justify-content-start align-items-start"><strong class="mb-3">Starter</strong><p>1 Core AMD EPYC 7002 Series<br>1 GB DDR4 RAM<br>10G NVMe SSD<br>1 IPV4<br>500G/Month/100Mbps, Based on the Principle of Fair Use</p><input type="hidden" name="id" value="${productId}"><select name="cycle">${(reverse ? options.reverse() : options).join("")}</select>${stock}${button}</div></form>`;
};
const parseZgo = (html, url = hk) => parseAdditionalCatalog(sourceFor("zgovps", url), resultFor(url, html), helpers);

test("Zgo public forms preserve separately billed USD cycles and official product identity", () => {
  const html = `<base href="https://clients.zgovps.com/"><a href="index.php?/cart/hongkong-amd-vps/">HongKong AMD VPS</a>${zgoForm()}`;
  const records = parseZgo(html);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => [record.priceValue, record.currency, record.raw.billingCycle]), [[18, "USD", "Quarterly"], [66, "USD", "Annually"]]);
  assert.equal(records[0].name, "HongKong AMD VPS · Starter");
  assert.equal(records[0].region, "香港");
  assert.equal(records[0].status, "available");
  assert.equal(records[0].stockCount, null);
  assert.equal(records[0].orderUrl, hk, "do not invent a GET purchase URL from a POST form");
  assert.equal(records[0].sourceUrl, hk);
  assert.match(records[0].hardware, /10G NVMe SSD/, "preserve the published storage unit");
  assert.match(records[0].hardware, /1 GB DDR4 RAM/);
  assert.match(records[0].bandwidth, /500G\/Month\/100Mbps/);
  assert.deepEqual(new Set(records.map((r) => r.id)), new Set(parseZgo(zgoForm({ reverse: true })).map((r) => r.id)));
});

test("Zgo sold-out wording overrides a remaining Continue button and keeps all cycles", () => {
  const records = parseZgo(zgoForm({ stock: "<p>Out of stock!</p>" }), la);
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record.status === "unavailable" && record.stockCount === 0));
  assert.equal(records[0].region, "美国");
  assert.notEqual(records[0].id, parseZgo(zgoForm())[0].id, "region variants must not collide");
});

test("Zgo disabled actions and unrelated sign-in forms do not assert availability", () => {
  const login = '<form><strong class="mb-3">Sign in</strong><button>Continue</button></form>';
  const records = parseZgo(login + zgoForm({ button: '<button disabled>Continue</button>' }));
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record.status === "unknown" && record.stockCount === null));
});

test("Zgo explicit stock count is distinct from an enabled order action", () => {
  const [record] = parseZgo(zgoForm({ stock: "<p>Stock: 3</p>", button: "" }));
  assert.equal(record.stockCount, 3);
  assert.equal(record.status, "available");
});

const beroUrl = "https://bero-host.de/server/prepaid-ryzen-vserver-mieten";
const beroCard = ({ id = 40, name = "Basic", soldOut = false, duration = "30 Tage" } = {}) => `<div class="m-3" wire:click="selectPackage(${id})">${soldOut ? '<h4 class="text-center color-bero-orange">Ausverkauft</h4>' : ''}<div class="text-white bero-orange-border clickable-tag-cursor"><div class="default-package-background default-border-radius"><div><h4>${name}</h4></div><p>CPU: 2 Kerne</p><p>RAM: 6 GB</p><p>NVME: 50 GB</p><p>IPv4: 1 Adresse</p><p>IPv6: 1 /64 Netz</p><p>Backups: 3 Slots</p><p>Traffic: 20TB (fair use)</p><p>Laufzeit: ${duration}</p><div class="my-2"><h5>5,90 € INKL. MWST.</h5></div></div></div></div>`;
const parseBero = (html) => parseAdditionalCatalog(sourceFor("berohost", beroUrl), resultFor(beroUrl, html), helpers);

test("Bero reads German euro prices and external sold-out overlays without guessing monthly billing", () => {
  const records = parseBero(beroCard() + beroCard({ id: 42, name: "Power", soldOut: true }));
  assert.equal(records.length, 2);
  const [basic, power] = records;
  assert.equal(basic.name, "Basic");
  assert.equal(basic.priceValue, 5.9);
  assert.equal(basic.currency, "EUR");
  assert.equal(basic.price, "EUR 5.9 / 30 days (incl. VAT)");
  assert.equal(basic.raw.billingDays, 30);
  assert.equal(basic.raw.billingCycle, "30 Tage");
  assert.equal(basic.raw.vatIncluded, true);
  assert.equal(basic.status, "unknown", "a Livewire selection action alone is not stock evidence");
  assert.equal(basic.stockCount, null);
  assert.equal(basic.region, null, "do not infer a server location from a .de domain");
  assert.equal(basic.hardware, "CPU: 2 Kerne / RAM: 6 GB / NVME: 50 GB");
  assert.match(basic.bandwidth, /Traffic: 20TB \(fair use\)/);
  assert.equal(power.name, "Power", "the overlay heading is not the plan name");
  assert.equal(power.status, "unavailable");
  assert.equal(power.stockCount, 0);
  assert.equal(power.id, "catalog-berohost:plan:42");
});

test("Bero does not create a billing period for incomplete public cards", () => {
  assert.equal(parseBero(beroCard({ duration: "" })).length, 0);
  assert.equal(parseBero(beroCard().replace("5,90 €", "price on request")).length, 0);
});

const sea = "https://billing.spartanhost.net/store/ddos-protected-ssd-premium-kvm-vps-seattle";
const dal = "https://billing.spartanhost.net/store/dallas-premium-vps";
const spartanCard = (group, soldOut = false) => `<div class="product"><h3 class="product-name">4096MB KVM</h3><div class="product-price">$24.00</div><span class="billing-cycle">Monthly</span><ul><li>4096MB DDR5 RAM</li><li>4 CPU vCores</li><li>100GB Raid NVMe SSD Storage</li></ul>${soldOut ? '<p>Out of Stock</p>' : ''}<a href="${group}/4096mb-kvm">Order Now</a></div>`;
const parseSpartan = (url, html) => parseAdditionalCatalog({ ...sourceFor("spartan", url), currency: "USD" }, resultFor(url, html), helpers);

test("Spartan billing groups preserve region variants and sold-out evidence despite order links", () => {
  const [seattle] = parseSpartan(sea, spartanCard(sea, true));
  const [dallas] = parseSpartan(dal, spartanCard(dal));
  assert.equal(seattle.status, "unavailable");
  assert.equal(seattle.stockCount, 0);
  assert.equal(dallas.status, "available");
  assert.equal(dallas.stockCount, null);
  assert.equal(seattle.region, "美国");
  assert.equal(dallas.region, "美国");
  assert.equal(seattle.raw.location, "seattle");
  assert.equal(dallas.raw.location, "dallas");
  const cmin2 = "https://billing.spartanhost.net/store/cmin2-premium-kvm-vps-seattle";
  assert.notEqual(seattle.id, parseSpartan(cmin2, spartanCard(cmin2))[0].id, "same-city SKU names in different network families must remain distinct");
  assert.notEqual(seattle.id, dallas.id, "matching SKU names in different regions remain distinct");
  assert.equal(seattle.currency, "USD");
  assert.equal(seattle.price, "$24.00 Monthly");
  assert.equal(seattle.sourceUrl, sea);
});

test("Spartan marketing links cannot override stock from the official billing catalog", () => {
  assert.throws(() => parseSpartan("https://spartanhost.org/vps", spartanCard(sea)), /official billing catalog/);
});

test("additional catalog dispatcher rejects unsupported formats", () => {
  assert.throws(() => parseAdditionalCatalog({ catalogFormat: "other" }, {}, helpers), /Unsupported/);
});
