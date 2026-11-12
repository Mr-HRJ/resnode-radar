import test from "node:test";
import assert from "node:assert/strict";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { parseDynamicCatalog, buildSkylinePublicCatalogRequest, buildNeburstPublicCatalogRequest, NEBURST_PUBLIC_CATALOG_URL } from "./adapters/dynamic-catalogs.mjs";

const helpers = { baseRecord: (_source, _result, record) => record };
const source = (format) => ({ id: `catalog-${format}`, providerId: format, provider: format, catalogFormat: format, url: `https://${format}.example/` });
const parse = (format, payload) => parseDynamicCatalog(source(format), { html: JSON.stringify(payload), finalUrl: `https://${format}.example/api` }, helpers);

function neburst() {
  const spec = { display_name: "Example-1C1G", group: "Example", cpu: { default: 1, unit: "vCPU" }, memory: { default: 1, unit: "GB" }, disk: { default: 10, unit: "GB" }, bandwidth: { default: 500, unit: "GB" }, network_speed: { default: 1, unit: "Gbps" } };
  return {
    code: 0, cache_ttl: 300,
    data: {
      product_type: "cloud_instance", last_updated: "2026-01-01T00:00:00Z",
      regions: [{ code: "asia-hk", display: "Hong Kong", available: true }, { code: "asia-jp", display: "Tokyo", available: true }],
      shapes: { hk: { ...spec, id: "hk" }, jp: { ...spec, id: "jp" } },
      prices: {
        hk: [{ pay_cycle: "monthly", price_cents: 1000, price: 9999, price_monthly_cents: 999999, currency: "USD" }, { pay_cycle: "annually", price_cents: 12000, currency: "USD" }],
        jp: [{ pay_cycle: "monthly", price_cents: 1500, currency: "USD" }, { pay_cycle: "annually", price_cents: 18000, currency: "USD" }]
      },
      availability: { "asia-hk:hk": true, "asia-hk:jp": false, "asia-jp:hk": false, "asia-jp:jp": true },
      auto_apply_promotions: []
    }
  };
}

function skyline() {
  const shop = { groupId: "0", cpu: 1, memory: 1, storage: 10, trafficLimit: 500, bandwidthLimit: 1000, ipv4Count: 1, enable: 1, stocks: 100, stocksSold: 99 };
  return { code: 200, data: [
    { groupId: "0", packageId: "example", packageName: "日本测试 VPS", packageDescription: "Example base resources", hypervisorId: "example-location", allowAddon: 1,
      cpuShop: { groupId: "3", shopid: "addon", price: 1 },
      shopList: [{ ...shop, shopid: "example-month", name: "月付", period: 720, price: 2.5, originalPrice: 0, discount: 0 }, { ...shop, shopid: "example-year", name: "年付", period: 8760, price: 20, originalPrice: 30, discount: 33.3 }] },
    { groupId: "3", packageId: "addon", packageName: "CPU add-on", shopList: [{ ...shop, groupId: "3", shopid: "addon-only", price: 1, period: 720 }] }
  ] };
}

test("Neburst retains distinct regional shape identities and billing cycles without multiplying false matrix cells", () => {
  const records = parse("neburst", neburst());
  assert.equal(records.length, 4);
  assert.equal(new Set(records.map((r) => r.id)).size, 4);
  assert.deepEqual(new Set(records.map((r) => r.region)), new Set(["香港", "日本"]));
  assert.equal(records.filter((r) => r.name === "Example-1C1G").length, 4);
  const hkMonth = records.find((r) => r.raw.shapeId === "hk" && r.raw.billingCycle === "monthly");
  assert.equal(hkMonth.priceValue, 10);
  assert.equal(hkMonth.price, "USD 10/月");
  assert.equal(hkMonth.raw.city, "Hong Kong");
  assert.match(hkMonth.hardware, /1 vCPU/);
  assert.match(hkMonth.bandwidth, /1 Gbps/);
  assert.deepEqual(hkMonth.raw.features, { CPU: "1 vCPU", RAM: "1 GB", Storage: "10 GB", "Network speed": "1 Gbps", Traffic: "500 GB" });
  assert.equal(hkMonth.raw.configurable, false);
  assert.ok(records.every((r) => r.status === "available" && r.stockCount === null));
});

test("Neburst exposed resource ranges mark the quote as a configurable starting price", () => {
  const fixture = neburst();
  fixture.data.shapes.hk.memory = { default: 1, min: 1, max: 8, unit: "GB" };
  const record = parse("neburst", fixture).find((r) => r.raw.shapeId === "hk" && r.raw.billingCycle === "monthly");
  assert.equal(record.price, "USD 10/月起（默认配置）");
  assert.equal(record.priceValue, 10);
  assert.equal(record.raw.basePrice, true);
  assert.equal(record.raw.features.RAM, "1 GB");
});

test("Neburst retains a false availability signal only with an explicit offered-region mapping", () => {
  const fixture = neburst();
  fixture.data.regions[0].shape_ids = ["hk", "jp"];
  const records = parse("neburst", fixture);
  const unavailable = records.filter((r) => r.region === "香港" && r.raw.shapeId === "jp");
  assert.equal(records.length, 6);
  assert.equal(unavailable.length, 2);
  assert.ok(unavailable.every((r) => r.status === "unavailable" && r.stockCount === null && r.raw.availability === false));
});

test("Neburst all-false shapes retain unknown region and status, without inventing sold-out regional products", () => {
  const fixture = neburst();
  fixture.data.availability["asia-hk:hk"] = false;
  const records = parse("neburst", fixture).filter((r) => r.raw.shapeId === "hk");
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.region === null && r.raw.regionCode === null && r.status === "unknown" && r.stockCount === null));
  assert.deepEqual(records[0].raw.unmappedAvailability, [{ region: "asia-hk", available: false }, { region: "asia-jp", available: false }]);
});

test("Neburst applies only the first shape/cycle-qualified automatic promotion using integer cents", () => {
  const fixture = neburst();
  fixture.data.auto_apply_promotions = [
    { code: "annual-example", discount_type: "percent", discount_value: 20, discount_value_cents: 2000, applicable_shapes: ["hk"], allowed_pay_cycles: ["annually"] },
    { code: "do-not-stack", discount_type: "percent", discount_value: 50, applicable_shapes: ["hk"], allowed_pay_cycles: ["annually"] },
    { code: "fixed-example", discount_type: "fixed", discount_value: 5, discount_value_cents: 500, applicable_shapes: ["jp"], allowed_pay_cycles: ["annually"] }
  ];
  const records = parse("neburst", fixture);
  const hkYear = records.find((r) => r.raw.shapeId === "hk" && r.raw.billingCycle === "annually");
  const jpYear = records.find((r) => r.raw.shapeId === "jp" && r.raw.billingCycle === "annually");
  assert.equal(hkYear.priceValue, 96);
  assert.equal(hkYear.price, "USD 96/年");
  assert.equal(hkYear.raw.originalPrice, 120);
  assert.equal(hkYear.raw.promotion.code, "annual-example");
  assert.equal(jpYear.priceValue, 175);
  assert.ok(records.filter((r) => r.raw.billingCycle === "monthly").every((r) => r.raw.promotion === null));
});

test("Neburst keeps currency and unpriced catalog shapes without inventing a zero quote", () => {
  const fixture = neburst();
  fixture.data.prices.hk = [];
  fixture.data.prices.jp = [{ pay_cycle: "monthly", price: "1500", currency: "JPY" }];
  const records = parse("neburst", fixture);
  const unpriced = records.find((r) => r.raw.shapeId === "hk");
  const priced = records.find((r) => r.raw.shapeId === "jp");
  assert.equal(unpriced.price, null);
  assert.equal(unpriced.priceValue, null);
  assert.equal(unpriced.status, "unknown");
  assert.equal(priced.price, "JPY 1500/月");
  assert.equal(priced.currency, "JPY");
});

test("Dynamic catalogs reject unsuccessful envelopes and changed price/availability schemas", () => {
  assert.throws(() => parse("neburst", { code: 401, data: {} }), /schema changed/);
  const brokenPrice = neburst();
  brokenPrice.data.prices.hk[0].price_cents = -1;
  assert.throws(() => parse("neburst", brokenPrice), /price_cents/);
  const brokenAvailability = neburst();
  brokenAvailability.data.availability["asia-hk:hk"] = "true";
  assert.throws(() => parse("neburst", brokenAvailability), /availability/);
  assert.throws(() => parse("skyline", { code: 401, data: [] }), /schema changed/);
});

test("Skyline excludes add-ons and preserves actual discounted prices and annual billing", () => {
  const records = parse("skyline", skyline());
  assert.equal(records.length, 2);
  const yearly = records.find((r) => r.raw.shopId === "example-year");
  assert.equal(yearly.region, "日本");
  assert.equal(yearly.price, "USD 20/年起（基础配置）");
  assert.equal(yearly.raw.basePrice, true);
  assert.equal(yearly.priceValue, 20);
  assert.equal(yearly.raw.originalPrice, 30);
  assert.equal(yearly.raw.discountPercent, 33.3);
  assert.equal(yearly.raw.billingPeriodHours, 8760);
  assert.ok(records.every((r) => r.status === "unknown" && r.stockCount === null));
  assert.equal(yearly.raw.stocks, 100);
  assert.equal(yearly.raw.stocksSold, 99);
});

test("Skyline does not interpret zero/sentinel/capacity fields as proven remaining stock", () => {
  const fixture = skyline();
  fixture.data[0].shopList[0].stocks = 0;
  fixture.data[0].shopList[0].stocksSold = 10000;
  const record = parse("skyline", fixture)[0];
  assert.equal(record.status, "unknown");
  assert.equal(record.stockCount, null);
  assert.equal(record.raw.stocks, 0);
  assert.equal(record.raw.stocksSold, 10000);
});

test("Skyline builds a fresh public encrypted request without authentication or captured signatures", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyDer = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const publicScript = `const keys = {[platform.MAC]:"${keyDer}"};`;
  const request = buildSkylinePublicCatalogRequest(publicScript, { now: 1767225600000, nonce: "abcdefgh" });
  assert.equal(request.method, "POST");
  assert.equal(request.url, "https://api.skylineconnect.io/v1/api/payment/payment_product_list");
  assert.deepEqual(request.headers, { "Content-Type": "application/json", platform: "mac", language: "zh" });
  const decode = (request) => {
    const body = JSON.parse(request.body);
    assert.deepEqual(Object.keys(body), ["signature"]);
    // Raw RSA decrypt avoids platform-specific legacy PKCS1 decryption policies;
    // verify the locally generated PKCS1 v1.5 encoding before reading its payload.
    const block = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, Buffer.from(body.signature, "base64"));
    assert.equal(block[0], 0);
    assert.equal(block[1], 2);
    const separator = block.indexOf(0, 2);
    assert.ok(separator >= 10);
    return JSON.parse(block.subarray(separator + 1).toString("utf8"));
  };
  assert.deepEqual(decode(request), { nonce: "abcdefgh", timestamp: "1767225600000", group_id: "0" });
  const freshA = decode(buildSkylinePublicCatalogRequest(publicScript));
  const freshB = decode(buildSkylinePublicCatalogRequest(publicScript));
  assert.equal(freshA.nonce.length, 8);
  assert.notEqual(freshA.nonce, freshB.nonce);
  assert.ok(Math.abs(Date.now() - Number(freshA.timestamp)) < 10000);
  assert.throws(() => buildSkylinePublicCatalogRequest("changed bundle"), /public encryption key missing/);
  assert.throws(() => buildSkylinePublicCatalogRequest(publicScript, { platform: "other" }), /Unsupported/);
});

test("Neburst reproduces public request metadata using the actual UA, fresh time and no auth or trace token", () => {
  const deviceId = "0123456789abcdef0123456789abcdef";
  const request = buildNeburstPublicCatalogRequest({ userAgent: "ResNodeTest/1", now: 1767225600000, deviceId });
  assert.equal(request.url, NEBURST_PUBLIC_CATALOG_URL);
  assert.equal(request.url, "https://neburst.com/api/v1/public/pricing/cloud?include_unpriced=true");
  assert.equal(request.method, "GET");
  assert.equal(request.body, undefined);
  assert.deepEqual(request.headers, {
    "user-agent": "ResNodeTest/1", "content-type": "application/json",
    "neburst-request-language": "en-us", "neburst-request-time": "1767225600000",
    "neburst-request-id": "f18c3a5887f6f4625759aeabc355c398", "neburst-device-fp": deviceId,
    cookie: `nb_dfp=${deviceId}`
  });
  assert.equal(new URL(request.url).searchParams.has("trace_id"), false);
  assert.ok(!Object.keys(request.headers).some((key) => /authorization|refresh|captcha|ecdh/i.test(key)));
  const next = buildNeburstPublicCatalogRequest({ userAgent: "ResNodeTest/1", now: 1767225600001, deviceId });
  assert.notEqual(next.headers["neburst-request-id"], request.headers["neburst-request-id"]);
  const differentUA = buildNeburstPublicCatalogRequest({ userAgent: "ResNodeTest/2", now: 1767225600000, deviceId });
  assert.notEqual(differentUA.headers["neburst-request-id"], request.headers["neburst-request-id"]);
  const freshA = buildNeburstPublicCatalogRequest({ userAgent: "ResNodeTest/1" });
  const freshB = buildNeburstPublicCatalogRequest({ userAgent: "ResNodeTest/1" });
  assert.notEqual(freshA.headers["neburst-device-fp"], freshB.headers["neburst-device-fp"]);
  assert.match(freshA.headers["neburst-device-fp"], /^[0-9a-f]{32}$/);
  assert.equal(freshA.headers.cookie, `nb_dfp=${freshA.headers["neburst-device-fp"]}`);
  assert.ok(Math.abs(Date.now() - Number(freshA.headers["neburst-request-time"])) < 10000);
  assert.throws(() => buildNeburstPublicCatalogRequest(), /actual transport user-agent/);
  assert.throws(() => buildNeburstPublicCatalogRequest({ userAgent: "Example\r\nInjected: header" }), /actual transport user-agent/);
  assert.throws(() => buildNeburstPublicCatalogRequest({ userAgent: "Example", deviceId: "browser-cookie-value" }), /device identifier/);
});
