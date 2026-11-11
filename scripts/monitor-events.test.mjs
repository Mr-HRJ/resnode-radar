import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEcbRates } from "./fx-rates.mjs";
import { validateMonitorPayload } from "./validate-monitor-data.mjs";

const monitorPath = fileURLToPath(new URL("./monitor.mjs", import.meta.url));
const validatePath = fileURLToPath(new URL("./validate-monitor-data.mjs", import.meta.url));
const sourceUrl = "https://vendor.example/product/basic";
const firstAt = "2026-11-10T10:00:00.000Z";
const secondAt = "2026-11-10T10:30:00.000Z";
const fx = parseEcbRates("<Cube time='2026-11-09'><Cube currency='CNY' rate='10'/><Cube currency='USD' rate='1.25'/></Cube>");
const preload = `
import { readFileSync, writeFileSync } from "node:fs";
const RealDate = globalThis.Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [process.env.MONITOR_TEST_TIME])); }
  static now() { return RealDate.parse(process.env.MONITOR_TEST_TIME); }
};
const fixture = JSON.parse(readFileSync("fixture.json", "utf8"));
const calls = [];
globalThis.fetch = async (input) => {
  const url = String(input);
  calls.push(url);
  writeFileSync("calls.json", JSON.stringify(calls));
  if (url !== fixture.url) throw new Error("Unexpected offline request: " + url);
  const response = new Response(fixture.body, { status: fixture.status ?? 200 });
  Object.defineProperty(response, "url", { value: url });
  return response;
};
`;
function workspace(t) {
  const root = process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : tmpdir();
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "resnode-feed-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "monitor"));
  mkdirSync(join(dir, "data"));
  writeFileSync(join(dir, "monitor/sources.json"), JSON.stringify([{
    id: "offline-basic", providerId: "vendor", provider: "Vendor", category: "vps",
    adapter: "vircs_inertia_product", url: sourceUrl
  }]));
  writeFileSync(join(dir, "preload.mjs"), preload);
  return dir;
}
function fixture(available, total) {
  return { url: sourceUrl, body: `<script data-page="app" type="application/json">${JSON.stringify({ props: { data: {
    available, total, data: { id: 42, name: "Basic VPS", payable: true, description: [] }
  } } })}</script>` };
}
function run(dir, at, response) {
  writeFileSync(join(dir, "fixture.json"), JSON.stringify(response));
  writeFileSync(join(dir, "calls.json"), "[]");
  execFileSync(process.execPath, ["--import", join(dir, "preload.mjs"), monitorPath], {
    cwd: dir, stdio: "pipe", timeout: 15000,
    env: { ...process.env, MONITOR_TEST_TIME: at, MONITOR_FETCH_RETRIES: "0", MONITOR_CONCURRENCY: "1" }
  });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "calls.json"), "utf8")), [sourceUrl], "monitor must not fetch FX or any unexpected provider");
  const payload = JSON.parse(readFileSync(join(dir, "data/products.json"), "utf8"));
  assert.deepEqual(validateMonitorPayload(payload), []);
  return payload;
}

test("offline collector runs persist real comparisons, keep the baseline, and embed local FX without fetching it", (t) => {
  const dir = workspace(t);
  writeFileSync(join(dir, "data/fx.json"), JSON.stringify(fx));
  const first = run(dir, firstAt, fixture(0, 10));
  assert.deepEqual(first.events, []);
  assert.equal(first.eventTracking.startedAt, firstAt);
  assert.deepEqual(first.exchangeRates, fx);

  const second = run(dir, secondAt, fixture(3, 8));
  assert.deepEqual(second.events.map((event) => event.type).sort(), ["price", "restock"]);
  assert.equal(second.events.find((event) => event.type === "price").previousPriceValue, 10);
  assert.equal(second.eventTracking.startedAt, firstAt);
  assert.deepEqual(second.exchangeRates, fx);
  assert.deepEqual(run(dir, secondAt, fixture(3, 8)).events, second.events);

  const sold = run(dir, "2026-11-10T11:00:00.000Z", fixture(0, 8));
  assert.equal(sold.events.length, 3);
  assert.equal(sold.events[0].type, "soldout");
  const blocked = run(dir, "2026-11-10T11:30:00.000Z", { url: sourceUrl, body: "Just a moment cf_chl", status: 403 });
  assert.equal(blocked.products[0].status, "blocked");
  assert.deepEqual(blocked.events, sold.events);

  writeFileSync(join(dir, "data/fx.json"), JSON.stringify({ ...fx, rates: { ...fx.rates, USD: 0 } }));
  const recovered = run(dir, "2026-11-10T12:00:00.000Z", fixture(2, 7));
  assert.equal(recovered.products[0].status, "available");
  assert.deepEqual(recovered.events, sold.events, "blocked to available is neither restock nor price history");
  assert.equal(Object.hasOwn(recovered, "exchangeRates"), false);
  assert.match(execFileSync(process.execPath, [validatePath], { cwd: dir, encoding: "utf8" }), /1 monitor records and 3 events/);

  const saved = readFileSync(join(dir, "data/products.json"), "utf8");
  assert.throws(() => run(dir, firstAt, fixture(0, 5)), /cannot precede/);
  assert.equal(readFileSync(join(dir, "data/products.json"), "utf8"), saved);
});

test("corrupt previous data establishes a new empty baseline without extra requests", (t) => {
  const dir = workspace(t);
  writeFileSync(join(dir, "data/products.json"), '{"broken":');
  const payload = run(dir, firstAt, fixture(3, 8));
  assert.deepEqual(payload.events, []);
  assert.equal(payload.eventTracking.startedAt, firstAt);
  assert.equal(Object.hasOwn(payload, "exchangeRates"), false);
});

test("data validator rejects invalid event tracking, event history and FX", (t) => {
  const dir = workspace(t);
  run(dir, firstAt, fixture(0, 10));
  const valid = run(dir, secondAt, fixture(1, 10));
  const event = valid.events[0];
  const oldAt = "2026-11-02T10:00:00.000Z";
  const futureAt = "2026-11-10T11:00:00.000Z";
  for (const broken of [
    { ...valid, events: undefined }, { ...valid, events: {} }, { ...valid, events: [null] },
    { ...valid, eventTracking: undefined }, { ...valid, eventTracking: { ...valid.eventTracking, limit: 301 } },
    { ...valid, eventTracking: { ...valid.eventTracking, retentionDays: 8 } },
    { ...valid, eventTracking: { ...valid.eventTracking, startedAt: futureAt } },
    { ...valid, events: [event, event] }, { ...valid, events: Array(301).fill(event) },
    { ...valid, events: [{ ...event, at: oldAt, id: `${oldAt}|restock|${event.productId}` }] },
    { ...valid, events: [{ ...event, at: futureAt, id: `${futureAt}|restock|${event.productId}` }] },
    { ...valid, events: [{ ...event, priceValue: "10" }] },
    { ...valid, exchangeRates: { ...fx, rates: { CNY: 1 } } }
  ]) assert.ok(validateMonitorPayload(broken).length > 0);
  assert.deepEqual(validateMonitorPayload({ ...valid, exchangeRates: fx }), []);
});
