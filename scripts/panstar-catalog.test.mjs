import assert from "node:assert/strict";
import { webcrypto, randomBytes } from "node:crypto";
import { test } from "node:test";
import { decodePanstarResponse, monitorPanstarCatalog, panstarPublicKey, parsePanstarPlans } from "./adapters/panstar-catalog.mjs";
import { priceQuote } from "../pricing.js";

const source = { id: "catalog-panstar", provider: "Panstar", url: "https://panstar.example/pricing" };
const region = { id: 9, name: "东京", icon: "JP", status: 0 };
const product = { id: 36, name: "Tokyo Premium", status: 0 };
const plan = { id: 700, name: "Basic", cpu: 1, memory: 1024, disk: 20, bindwidth: 100, traffic: 500, ipNum: 1, ip6Num: 0, price: 399, cycle: 1, stockAvailable: false, status: 0 };
const baseRecord = (s, r, fields) => ({ sourceId: s.id, ...fields });
const response = (url, data) => ({ ok: true, statusCode: 200, finalUrl: url, headers: {}, html: JSON.stringify({ code: 0, data }) });
const api = (path) => `https://panstar.example/api/ecs/catalog/${path}`;

test("Panstar prices use cents and minimum cycles; missing stock and restrictions stay uncertain", () => {
  const result = response(api('plans?productId=36'), []);
  const parse = (overrides) => parsePanstarPlans(source, result, [{ ...plan, ...overrides }], product, region, { baseRecord })[0];
  const first = parse({});
  assert.equal(first.priceValue, 3.99);
  assert.equal(priceQuote(first).monthly, 3.99);
  assert.equal(first.status, 'unavailable');
  assert.equal(first.stockCount, null);
  assert.equal(first.region, '日本');
  assert.match(first.hardware, /1024 MB RAM/);
  assert.equal(parse({ cycle: 3 }).priceValue, 11.97);
  assert.equal(parse({ cycle: 12, annualPrice: 2999 }).priceValue, 29.99);
  assert.equal(parse({ stockAvailable: true }).status, 'available');
  assert.equal(parse({ stockAvailable: undefined }).status, 'unknown');
  assert.equal(parse({ stockAvailable: true, levelStockEnabled: 1 }).status, 'unknown');
  assert.equal(parse({ stockAvailable: true, saleMode: 1 }).status, 'unknown');
  assert.equal(parse({ archived: 1 }), undefined);
  assert.equal(parse({ visibilityMode: 'PRIVATE' }), undefined);
  assert.equal(parse({ price: 499 }).id, first.id);
  assert.throws(() => parse({ price: null }), /schema/);
  assert.throws(() => parse({ cycle: 2 }), /cycle/);
});

test("Panstar decodes the published client format and rejects corrupted or unexpected API responses", async () => {
  const raw = randomBytes(32), iv = randomBytes(12);
  const script = `"X-Api-Encrypt";"AES-GCM";let e="${raw.toString('base64')}".trim()`;
  assert.deepEqual(panstarPublicKey(script), raw);
  assert.equal(panstarPublicKey('unrelated client'), null);
  const key = await webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, Buffer.from(JSON.stringify({ code: 0, data: [region] })));
  const result = { headers: { 'x-api-encrypt': '1', 'x-api-encrypt-iv': iv.toString('base64') }, html: JSON.stringify({ ciphertext: Buffer.from(ciphertext).toString('base64') }) };
  assert.deepEqual(await decodePanstarResponse(result, raw), [region]);
  await assert.rejects(decodePanstarResponse(result, randomBytes(32)));
  await assert.rejects(decodePanstarResponse({ ...result, headers: { ...result.headers, 'x-api-encrypt-alg': 'other' } }, raw), /encoding changed/);
  await assert.rejects(decodePanstarResponse({ headers: {}, html: '{"code":401,"data":[]}' }), /code 401/);
  await assert.rejects(decodePanstarResponse(response(api('regions'), {})), /invalid list/);
});

function helpers(routes, calls) {
  return { baseRecord, fetchHtml: async (_, url) => { calls.push(url); assert.ok(routes[url], url); return routes[url]; }, blockedRecord: (s,r,message) => baseRecord(s,r,{status:'blocked',evidence:message}), errorRecord: (s,error) => baseRecord(s,null,{status:'error',evidence:error.message}) };
}
test("Panstar walks only public regions/products and preserves partial results on a blocked catalog", async () => {
  const calls = [];
  const routes = {
    [api('regions')]: response(api('regions'), [region, { ...region, id: 10, visibilityMode: 'PRIVATE' }]),
    [api('products-by-region?regionId=9')]: response(api('products-by-region?regionId=9'), [product, product, { ...product, id: 37 }]),
    [api('plans?productId=36')]: response(api('plans?productId=36'), [plan]),
    [api('plans?productId=37')]: { ...response(api('plans?productId=37'), []), ok: false, statusCode: 403 }
  };
  const records = await monitorPanstarCatalog(source, helpers(routes, calls));
  assert.equal(records.length, 2);
  assert.equal(calls.length, 4);
  assert.equal(records[0].status, 'unavailable');
  assert.equal(records[1].status, 'blocked');
  assert.equal(records[1].diagnostic, true);
  assert.equal(records[0].collection.failedPages, 1);
});

test("Panstar source deadline stops the catalog walk with a visible diagnostic", async () => {
  const calls = [];
  const records = await monitorPanstarCatalog(source, { ...helpers({}, calls), deadline: 1, now: () => 2 });
  assert.deepEqual(calls, []);
  assert.equal(records[0].status, 'error');
  assert.equal(records[0].collection.timeBudgetReached, true);
});
