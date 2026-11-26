import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parseVmissCatalog } from "./adapters/vmiss-catalog.mjs";
import { monitorPublicCatalog } from "./adapters/public-catalog.mjs";
import { priceQuote } from "../pricing.js";

const source = JSON.parse(readFileSync(new URL("../apps/collector/config/sources.json", import.meta.url))).find((s) => s.id === "catalog-vmiss");
const helpers = { baseRecord: (s, r, row) => ({ sourceId: s.id, ...row }),
  blockedRecord: (s, r, evidence) => ({ status: "blocked", evidence }), errorRecord: (s, error) => ({ status: "error", error: error.message }) };
const card = ({ pid = "25", qty = "0 Available", disabled = true, amount = "$5.00 CAD", name = "JP.OSA.IIJ.Basic" } = {}) => `<div class="package" id="product${pid}">
  <h3 class="package-title">${name}</h3><div class="price-amount">${amount}</div><div class="price-cycle">Monthly</div>
  <div class="package-content">1 Core\n1024 MB\n10GB SSD\n500Mbps Port\n500GB Bandwidth\n1 IPv4 Included</div>
  <div class="price-amount">${amount}</div><div class="price-cycle">Monthly</div>
  <a id="product${pid}-order-button" class="btn ${disabled ? "disabled" : ""}" href="/store/jp-osaka-iij/basic">Order Now</a>
  ${qty === null ? "" : `<div class="package-qty">${qty}</div>`}</div>`;
const result = (html) => ({ html, finalUrl: source.url, statusCode: 200, ok: true, headers: {} });
const parse = (html) => parseVmissCatalog(source, result(html), helpers);

test("VMISS preserves CAD, CPU and memory, zero stock and the disabled SKU link", () => {
  const [row] = parse(card());
  assert.equal(row.id, "catalog-vmiss:pid:25");
  assert.equal(priceQuote(row).currency, "CAD");
  assert.equal(priceQuote(row).monthly, 5);
  assert.equal(row.hardware, "1 Core / 1024 MB RAM / 10GB SSD");
  assert.equal(row.bandwidth, "500Mbps Port / 500GB Bandwidth / 1 IPv4 Included");
  assert.equal(row.stockCount, 0);
  assert.equal(row.status, "unavailable");
  assert.equal(row.orderUrl, "https://app.vmiss.com/store/jp-osaka-iij/basic");
  assert.equal(row.raw.pid, "25");
});

test("VMISS retains published stock and never invents a quantity from an enabled button", () => {
  const [available] = parse(card({ qty: "7 Available", disabled: false }));
  assert.equal(available.status, "available"); assert.equal(available.stockCount, 7);
  const [unlimited] = parse(card({ qty: null, disabled: false }));
  assert.equal(unlimited.status, "available"); assert.equal(unlimited.stockCount, null);
  const [unknown] = parse(card({ qty: null, disabled: true }));
  assert.equal(unknown.status, "unknown"); assert.equal(unknown.stockCount, null);
  assert.equal(available.id, unlimited.id);
  assert.equal(parse(card({ qty: "2 Available", disabled: true }))[0].status, "unknown");
});

test("VMISS rejects changed currency, hardware, inventory and unsafe order URLs", () => {
  for (const html of [card({ amount: "$5.00" }), card().replace('1024 MB', 'memory configurable'), card({ qty: "many Available" }), card().replace('href="/store/', 'href="https://foreign.example/store/'), card() + card(), card().replace('$5.00 CAD', '$6.00 CAD')]) {
    assert.throws(() => parse(html), /VMISS public catalog schema changed/);
  }
  assert.throws(() => parse('<h1>Unexpected login page</h1>'), /product cards missing/);
});

test("VMISS category exclusions and country labels stay scoped to published VPS plans", () => {
  for (const route of ["dedicated-server", "others"]) assert.deepEqual(parseVmissCatalog(source, { ...result(card()), finalUrl: `https://app.vmiss.com/store/${route}` }, helpers), []);
  for (const [name, region] of [["CN.HK.BGP.Basic", "香港"], ["JP.TKY.IIJ.Basic", "日本"], ["KR.SEL.INTL.Basic", "韩国"], ["US.LA.9929.Basic", "美国"]]) assert.equal(parse(card({ name }))[0].region, region);
});

test("VMISS public catalog dispatch parses all thirteen groups without the old twelve-page cap", async () => {
  const routes = Array.from({ length: 13 }, (_, i) => i ? `https://app.vmiss.com/store/group-${i}` : source.url);
  const nav = routes.map((url) => `<a href="${url}">VPS</a>`).join("");
  const rows = await monitorPublicCatalog(source, { ...helpers, fetchHtml: async (s, url) => ({ ...result(card({ pid: String(25 + routes.indexOf(url)) }) + nav), finalUrl: url }) });
  assert.equal(rows.length, 13);
  assert.equal(rows[0].collection.pagesChecked, 13);
  assert.equal(rows[0].collection.pageLimitReached, false);
  assert.ok(rows.every((r) => r.currency === "CAD"));
});

test("VMISS challenge pages remain blocked diagnostics rather than empty inventory", async () => {
  const rows = await monitorPublicCatalog(source, { ...helpers, fetchHtml: async () => ({ ...result('<title>Just a moment...</title>'), statusCode: 403, ok: false }) });
  assert.equal(rows.length, 1); assert.equal(rows[0].status, "blocked"); assert.equal(rows[0].diagnostic, true);
});
