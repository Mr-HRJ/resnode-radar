import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ecbDailyUrl, isFxSnapshot, parseEcbRates, readFxSnapshot, updateRates } from "./fx-rates.mjs";

const now = "2026-11-10T12:00:00.000Z";
const xml = (date = "2026-11-09", extra = "") => `<gesmes:Envelope><Cube><Cube time='${date}'>
  <Cube currency='USD' rate='1.25'/><Cube rate="10.0" currency="CNY"/>
  <Cube currency='JPY' rate='160.0'/>${extra}</Cube></Cube></gesmes:Envelope>`;
const cached = () => ({ ...parseEcbRates(xml()), fetchedAt: "2026-11-09T18:00:00.000Z" });
const quiet = { log() {}, warn() {} };
function tempDirectory(t) {
  const root = process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : tmpdir();
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "resnode-fx-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("ECB quotes are rebased as CNY per currency unit, preserving the official day", () => {
  const snapshot = parseEcbRates(xml());
  assert.equal(snapshot.base, "CNY");
  assert.equal(snapshot.date, "2026-11-09");
  assert.deepEqual(snapshot.rates, { EUR: 10, USD: 8, CNY: 1, JPY: 0.0625 });
  assert.equal(snapshot.rates.GBP, undefined);
  assert.match(snapshot.sourceUrl, /^https:\/\/www\.ecb\.europa\.eu\//);
  assert.equal(isFxSnapshot(snapshot), true);
});

test("ECB malformed, missing, nonfinite, duplicate and zero rates are rejected", () => {
  for (const body of [
    "", "<html>Unavailable</html>", xml("2026-02-30"), xml("2026-13-01"), xml("2099-01-01"),
    xml().replace("currency='USD'", "currency='GBP'"), xml().replace('currency="CNY"', 'currency="CAD"'),
    xml().replace("rate='1.25'", "rate='0'"), xml().replace("rate='1.25'", "rate='-1.25'"),
    xml().replace("rate='1.25'", "rate='NaN'"), xml().replace("rate='1.25'", "rate='1.2.3'"),
    xml().replace("rate='1.25'", `rate='${"9".repeat(400)}'`),
    xml().replace("rate='1.25'", "rate='1.25' rate='2'"),
    xml("2026-11-09", "<Cube currency='USD' rate='1.3'/>"),
    xml("2026-11-09", "<Cube currency='GBP'/>"),
    xml("2026-11-09", "<Cube currency='GBP' rate=1.3/>"),
    xml("2026-11-09", "<Cube currency='GBP' rate='Infinity'/>"),
    xml("2026-11-09", "<Cube time='2026-11-10'/>")
  ]) assert.throws(() => parseEcbRates(body), /ECB/);
});

test("FX validation rejects malformed cache data rather than supplying defaults", () => {
  const valid = cached();
  for (const value of [
    null, {}, { ...valid, base: "USD" }, { ...valid, date: "2026-02-30" },
    { ...valid, date: "2026-11-10" }, { ...valid, fetchedAt: "invalid" },
    { ...valid, date: "2099-01-01", fetchedAt: undefined }, { ...valid, fetchedAt: "2099-01-01T12:00:00.000Z" },
    { ...valid, rates: null }, { ...valid, rates: [] }, { ...valid, rates: {} },
    { ...valid, rates: { CNY: 1, USD: 7 } }, { ...valid, rates: { ...valid.rates, CNY: 2 } },
    { ...valid, rates: { ...valid.rates, USD: "8" } }, { ...valid, rates: { ...valid.rates, GBP: Infinity } },
    { ...valid, rates: { ...valid.rates, GBP: 0 } }, { ...valid, rates: { ...valid.rates, BADCODE: 5 } },
    { ...valid, sourceUrl: null }, { ...valid, sourceUrl: "javascript:invalid" }
  ]) assert.equal(isFxSnapshot(value), false);
});

test("successful standalone update fetches ECB exactly once and writes validated observations", async (t) => {
  const filePath = join(tempDirectory(t), "data/fx.json");
  let calls = 0;
  const result = await updateRates({ filePath, now, logger: quiet, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, ecbDailyUrl);
    assert.equal(options.headers.accept, "application/xml");
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(xml("2026-11-10"));
  } });
  assert.equal(calls, 1);
  assert.equal(result.updated, true);
  assert.equal(result.snapshot.date, "2026-11-10");
  assert.equal(result.snapshot.fetchedAt, now);
  assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")), result.snapshot);
  assert.deepEqual(readFxSnapshot(filePath), result.snapshot);
});

test("failed or regressive updates preserve cached bytes and their original timestamps", async (t) => {
  const filePath = join(tempDirectory(t), "fx.json");
  const snapshot = cached();
  const original = JSON.stringify(snapshot);
  for (const fetchResult of [
    () => { throw new Error("offline"); },
    () => new Response("unavailable", { status: 503 }),
    () => new Response("<html>blocked</html>"),
    () => new Response(xml("2026-11-08")),
    () => new Response(xml("2026-11-11"))
  ]) {
    writeFileSync(filePath, original);
    let calls = 0;
    const result = await updateRates({ filePath, now, logger: quiet, fetchImpl: async () => { calls++; return fetchResult(); } });
    assert.equal(calls, 1);
    assert.equal(result.updated, false);
    assert.deepEqual(result.snapshot, snapshot);
    assert.equal(readFileSync(filePath, "utf8"), original);
    assert.equal(result.snapshot.date, "2026-11-09");
    assert.equal(result.snapshot.fetchedAt, "2026-11-09T18:00:00.000Z");
  }
});

test("unavailable FX without a valid cache creates no invented snapshot", async (t) => {
  const filePath = join(tempDirectory(t), "fx.json");
  const options = { filePath, now, logger: quiet, fetchImpl: async () => { throw new Error("offline"); } };
  const missing = await updateRates(options);
  assert.equal(missing.updated, false);
  assert.equal(missing.snapshot, null);
  assert.equal(existsSync(filePath), false);
  writeFileSync(filePath, '{"broken":');
  assert.equal(readFxSnapshot(filePath, quiet), null);
  const invalid = await updateRates(options);
  assert.equal(invalid.snapshot, null);
  assert.equal(readFileSync(filePath, "utf8"), '{"broken":');
});
