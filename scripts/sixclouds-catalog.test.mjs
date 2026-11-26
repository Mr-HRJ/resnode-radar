import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSixCloudsCatalog } from "./adapters/sixclouds-catalog.mjs";
import { monitorPublicCatalog } from "./adapters/public-catalog.mjs";
import { priceQuote } from "../pricing.js";
import { productSpecs } from "@resnode-radar/contracts";

const source = { id: "catalog-666clouds", url: "https://www.666clouds.com/shop", adapter: "public_catalog", catalogFormat: "sixclouds", maxPages: 1, discover: false };
const baseRecord = (s, r, values) => ({ sourceId: s.id, ...values });
const sku = (overrides = {}) => ({ subId: 96, name: "1核1G · 1TB", cpu: 1, memMb: 1024, sysDiskGb: 15, bwMbps: 1000, flowGb: 1024, stock: -1, prices: { monthly: "50.00", quarterly: "150.00", semiannually: "270.00", annually: "500.00", biennially: "-1.00", triennially: "-1.00" }, ...overrides });
const product = (overrides = {}) => ({ id: 191, name: "美西原生IP双ISP - NTT（新IP）", monthly: "999.00", stockNote: "现货", nativePlans: true, planOptions: { revision: 2, plans: [sku()] }, ...overrides });
const groups = (products = [product()]) => [{ id: 21, name: "美国US", products }];
function html(data) {
  const flight = '1:I[123,[],"default"]\n13:' + JSON.stringify(["$", "$L1", null, { groups: data }]) + "\n";
  // Flight chunks can end inside an escaped JSON string or in the middle of a record.
  return [flight.slice(0, 73), flight.slice(73)].map((part) => `<script>self.__next_f.push(${JSON.stringify([1, part])})</script>`).join("");
}
const result = (data, url = source.url) => ({ html: html(data), finalUrl: url, statusCode: 200, ok: true });
const read = (data) => parseSixCloudsCatalog(source, result(data), { baseRecord });

test("666Clouds reads each published SKU instead of the family starting price or stock label", () => {
  const plans = [sku(), sku({ subId: 97, name: '2核2G "试用"', cpu: 2, memMb: 2048, stock: 0, prices: { monthly: "80.00" } }), sku({ subId: 98, stock: 7 })];
  const rows = read(groups([product({ planOptions: { revision: 2, plans } })]));
  assert.deepEqual(rows.map((p) => [p.priceValue, p.status, p.stockCount]), [[50, "available", null], [80, "unavailable", 0], [50, "available", 7]]);
  assert.equal(rows[0].id, "catalog-666clouds:sku:191:96");
  assert.equal(rows[0].orderUrl, "https://www.666clouds.com/shop/191?planSubId=96&selectionRevision=2&cycle=monthly");
  assert.equal(rows[0].category, "home");
  assert.equal(rows[0].region, "美国");
  assert.equal(priceQuote(rows[0]).monthly, 50);
  assert.deepEqual(productSpecs(rows[0]), { cpu: "1 vCPU", memory: "1024 MB", disk: "15 GB Disk", bandwidth: "1000 Mbps", traffic: "1024 GB" });
  assert.equal(rows[0].raw.prices.biennially, undefined);
});

test("666Clouds annual-only offers preserve the annual total and stable SKU identity", () => {
  const offer = product({ name: "德国优化线路 - 年付特价", planOptions: { revision: 1, plans: [sku({ prices: { monthly: "-1.00", annually: "249.00" } })] } });
  const [row] = read([{ id: 27, name: "特价专区", products: [offer] }]);
  assert.equal(row.region, "德国");
  assert.equal(row.category, "vps");
  assert.equal(row.price, "CNY 249.00/年");
  assert.equal(priceQuote(row).monthly, 249 / 12);
  assert.match(row.orderUrl, /cycle=annually$/);
  offer.planOptions.revision = 3;
  offer.planOptions.plans[0].prices.annually = "300.00";
  assert.equal(read(groups([offer]))[0].id, row.id);
});

test("666Clouds rejects changed inventory, pricing, identity and incomplete schemas", () => {
  for (const changes of [{ stock: null }, { stock: -2 }, { stock: "7" }, { subId: 0 }, { cpu: null }, { prices: {} }, { prices: { monthly: "NaN" } }, { prices: { monthly: "-2.00" } }, { prices: { monthly: "-1.00" } }]) {
    assert.throws(() => read(groups([product({ planOptions: { revision: 2, plans: [sku(changes)] } })])), /schema changed/);
  }
  for (const data of [[], "$13:props:groups", groups([product({ nativePlans: false })]), groups([product(), product()])]) {
    assert.throws(() => read(data), /schema changed/);
  }
  assert.throws(() => parseSixCloudsCatalog(source, { ...result(groups()), html: "<h1>Login</h1>" }, { baseRecord }), /groups missing/);
  assert.throws(() => parseSixCloudsCatalog(source, result(groups(), "https://foreign.example/shop"), { baseRecord }), /official catalog URL/);
});

test("666Clouds excludes explicitly hidden, retired and disabled offers", () => {
  const records = read(groups([product({ hidden: true }), product({ retired: true }), product({ planOptions: { revision: 2, plans: [sku({ enabled: false }), sku({ subId: 97 })] } })]));
  assert.equal(records.length, 1);
  assert.equal(records[0].raw.planSubId, 97);
});

test("public monitor dispatches the bounded SKU parser and reports schema failures", async () => {
  const helpers = { baseRecord, errorRecord: (s, e) => ({ status: "error", error: e.message }), fetchHtml: async () => result(groups()) };
  const [row] = await monitorPublicCatalog(source, helpers);
  assert.equal(row.raw.planSubId, 96);
  assert.deepEqual(row.collection, { pagesChecked: 1, pageLimitReached: false, failedPages: 0 });
  const [failure] = await monitorPublicCatalog(source, { ...helpers, fetchHtml: async () => result([]) });
  assert.equal(failure.diagnostic, true);
  assert.equal(failure.status, "error");
  assert.equal(failure.collection.failedPages, 1);
});
