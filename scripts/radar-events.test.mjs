import assert from "node:assert/strict";
import { test } from "node:test";
import { diffRuns, isRadarEvent, mergeEvents, timestampMs, trackEvents } from "./radar-events.mjs";

const firstAt = "2026-11-01T10:00:00.000Z";
const secondAt = "2026-11-01T10:30:00.000Z";
const thirdAt = "2026-11-01T11:00:00.000Z";
function plan(extra = {}) {
  return {
    id: "source:pid:42", sourceId: "source", providerId: "vendor", provider: "Vendor",
    sourceUrl: "https://vendor.example/plans", name: "Basic VPS", region: "Tokyo",
    price: "$10 / month", priceValue: 10, status: "available", stockCount: null,
    orderUrl: "https://vendor.example/order/42", fetchedAt: firstAt,
    ...extra
  };
}
const later = (extra = {}) => plan({ fetchedAt: secondAt, ...extra });
function snapshot(at, products, previous = null) {
  const current = { schemaVersion: 1, generatedAt: at, products };
  return { ...current, ...trackEvents(previous, current) };
}
function stockEvent(at, id = "source:pid:42") {
  const before = plan({ id, fetchedAt: new Date(Date.parse(at) - 60000).toISOString(), status: "unavailable" });
  return diffRuns([before], [plan({ id, fetchedAt: at })], at)[0];
}

test("only observed stock transitions and comparable price changes become events", () => {
  const events = diffRuns([plan({ status: "unavailable" })], [later({ price: "$9 / month", priceValue: 9, stockCount: 3 })], secondAt);
  assert.deepEqual(events.map((event) => event.type), ["restock", "price"]);
  assert.deepEqual(events[0], {
    id: `${secondAt}|restock|source:pid:42`, type: "restock", at: secondAt,
    productId: "source:pid:42", providerId: "vendor", provider: "Vendor", name: "Basic VPS", region: "Tokyo",
    price: "$9 / month", priceValue: 9, currency: "USD", stockCount: 3, orderUrl: "https://vendor.example/order/42"
  });
  assert.equal(events[1].previousPrice, "$10 / month");
  assert.equal(events[1].previousPriceValue, 10);
  assert.ok(events.every(isRadarEvent));
  assert.deepEqual(diffRuns([plan()], [later({ status: "unavailable", stockCount: 0 })], secondAt).map((event) => event.type), ["soldout"]);
  assert.deepEqual(diffRuns([plan()], [later({ stockCount: 10 })], secondAt), []);
});

test("a baseline and large newly ingested sources have no invented events", () => {
  const products = Array.from({ length: 400 }, (_, index) => later({ id: `new:${index}`, sourceId: `new-source-${index}` }));
  const baseline = snapshot(secondAt, products);
  assert.deepEqual(baseline.events, []);
  assert.deepEqual(baseline.eventTracking, { startedAt: secondAt, retentionDays: 7, limit: 300 });
  assert.deepEqual(diffRuns([plan()], products, secondAt), []);
  const legacy = { schemaVersion: 1, generatedAt: firstAt, products: [plan({ status: "unavailable" })] };
  assert.deepEqual(snapshot(secondAt, [later()], legacy).events, []);
});

test("missing, unknown, blocked, failed, diagnostic and Reader observations cannot create changes", () => {
  assert.deepEqual(diffRuns([plan()], [], secondAt), []);
  assert.deepEqual(diffRuns([], [later()], secondAt), []);
  for (const extra of [
    { status: "unknown" }, { status: "blocked" }, { status: "error" }, { diagnostic: true },
    { error: "partial failure" }, { raw: { strategy: "reader_snapshot" } },
    { evidenceLevel: { value: "snapshot" } }, { httpStatus: 429 }
  ]) {
    assert.deepEqual(diffRuns([plan(extra)], [later({ status: "available", priceValue: 9 })], secondAt), []);
    assert.deepEqual(diffRuns([plan()], [later({ status: "unavailable", priceValue: 9, ...extra })], secondAt), []);
  }
});

test("unique page/name fallback follows an order link disappearing and returning", () => {
  for (const orderUrl of [null, undefined, "https://vendor.example/plans"]) {
    const sold = later({ id: "source:idx:1", status: "unavailable", orderUrl });
    assert.deepEqual(diffRuns([plan()], [sold], secondAt).map((event) => event.type), ["soldout"]);
    assert.deepEqual(diffRuns([sold], [plan({ fetchedAt: thirdAt })], thirdAt).map((event) => event.type), ["restock"]);
  }
  assert.deepEqual(diffRuns([plan({ sourceUrl: "https://vendor.example/plans?b=2&a=1#top" })],
    [later({ id: "source:idx:1", sourceUrl: "https://vendor.example/plans?a=1&b=2", status: "unavailable" })], secondAt).map((event) => event.type), ["soldout"]);
});

test("fallback never joins distinct linked SKUs with identical names and specifications", () => {
  for (const [oldUrl, newUrl] of [
    ["https://vendor.example/cart.php?a=add&pid=100", "https://vendor.example/cart.php?pid=101&a=add"],
    ["https://vendor.example/order/100", "https://vendor.example/order/101"]
  ]) {
    for (const sourceUrl of ["https://vendor.example/plans", oldUrl]) {
      const before = plan({ id: "source:100", sourceUrl, orderUrl: oldUrl, status: "unavailable", hardware: "1 vCPU" });
      const after = later({ id: "source:101", sourceUrl, orderUrl: newUrl, price: "$9 / month", priceValue: 9, hardware: "1 vCPU" });
      assert.deepEqual(diffRuns([before], [after], secondAt), [], "different linked SKUs cannot create restock or price events");
      assert.deepEqual(diffRuns([{ ...before, status: "available" }], [{ ...after, status: "unavailable" }], secondAt), [], "different linked SKUs cannot create sellout or price events");
    }
  }
});

test("fallback accepts equivalent normalized order identities", () => {
  for (const [oldUrl, newUrl] of [
    ["https://vendor.example/cart.php?a=add&pid=100&currency=1#old", "https://vendor.example/cart.php?currency=2&pid=100&a=add#new"],
    ["https://vendor.example/order/basic?b=2&a=1#old", "https://vendor.example/order/basic?a=1&b=2#new"]
  ]) {
    const before = plan({ id: "old-id", orderUrl: oldUrl, status: "unavailable" });
    const after = later({ id: "new-id", orderUrl: newUrl });
    assert.deepEqual(diffRuns([before], [after], secondAt).map((event) => event.type), ["restock"]);
  }
});

test("fallback identity must be unique on both sides, with no reused ids", () => {
  const before = plan({ status: "unavailable" });
  const after = later({ id: "new-id" });
  for (const [oldRecords, newRecords] of [
    [[before, plan({ id: "duplicate-name" })], [after]],
    [[before], [after, later({ id: "duplicate-name" })]],
    [[before, { ...before }], [after]],
    [[before, plan({ name: "Other plan" })], [after]],
    [[before], [after, later({ status: "unknown" })]],
    [[before, plan({ status: "unknown" })], [later()]],
    [[before], [later(), later({ status: "unknown" })]]
  ]) assert.deepEqual(diffRuns(oldRecords, newRecords, secondAt), []);
});

test("reused positional ids and changed plan variants do not produce changes", () => {
  for (const extra of [
    { name: "Other VPS" }, { sourceId: "other-source" }, { providerId: "other-vendor" },
    { provider: "Other Vendor" }, { sourceUrl: "https://vendor.example/other-plans" },
    { region: "London" }, { hardware: "2 vCPU" }, { bandwidth: "2 TB" },
    { raw: { productId: 2 } }, { raw: { pid: 2 } }
  ]) {
    const before = plan({ status: "unavailable", hardware: "1 vCPU", bandwidth: "1 TB", raw: { pid: 1, productId: 1 } });
    assert.deepEqual(diffRuns([before], [later(extra)], secondAt), []);
  }
  for (const extra of [{ sourceId: null }, { sourceUrl: "invalid" }, { name: null }, { id: null }]) {
    assert.deepEqual(diffRuns([plan({ status: "unavailable", ...extra })], [later(extra)], secondAt), []);
  }
});

test("same ids can distinguish named variants sharing a page, without guessing fallback matches", () => {
  const previous = [plan({ status: "unavailable" }), plan({ id: "source:pid:43" })];
  const current = [later(), later({ id: "source:pid:43" })];
  assert.deepEqual(diffRuns(previous, current, secondAt).map((event) => [event.type, event.productId]), [["restock", "source:pid:42"]]);
});

test("prices require the same known currency, same billing cycle and fixed amounts", () => {
  for (const extra of [
    { price: "€9 / month", currency: "EUR" }, { price: "$108 / year", priceValue: 108 },
    { price: "$9" }, { price: "9 / month" }, { price: "from $9 / month" },
    { raw: { configurable: true } }, { price: "$9 / hour" }, { price: "$9 one-time" },
    { priceValue: null }, { priceValue: NaN }, { priceValue: -9 },
    { price: "EUR 9 / month", currency: "USD" },
    { price: "€9 / month", currency: "USD" },
    { raw: { billingCycle: "annual" } },
    { raw: { billingCycle: "hourly" } }
  ]) {
    assert.deepEqual(diffRuns([plan()], [later({ price: "$9 / month", priceValue: 9, ...extra })], secondAt), []);
  }
  assert.deepEqual(diffRuns([plan({ price: "$10" })], [later({ priceValue: 9 })], secondAt), []);
  assert.deepEqual(diffRuns([plan({ priceValue: 0.1 + 0.2 })], [later({ priceValue: 0.3 })], secondAt), []);
  const yearly = diffRuns([plan({ price: "USD 100 / year", priceValue: 100 })], [later({ price: "USD 90 / year", priceValue: 90 })], secondAt);
  assert.equal(yearly[0].type, "price");
  const canadian = diffRuns([plan({ price: "CA$10 / month", currency: "CAD" })], [later({ price: "CA$9 / month", currency: "CAD", priceValue: 9 })], secondAt);
  assert.equal(canadian[0].currency, "CAD");
});

test("events need fresh, strictly ordered record timestamps", () => {
  for (const fetchedAt of [undefined, "invalid", secondAt, thirdAt]) {
    assert.deepEqual(diffRuns([plan({ fetchedAt, status: "unavailable" })], [later()], secondAt), []);
  }
  for (const fetchedAt of [undefined, "invalid", firstAt, thirdAt]) {
    assert.deepEqual(diffRuns([plan({ status: "unavailable" })], [later({ fetchedAt })], secondAt), []);
  }
  assert.deepEqual(diffRuns([plan()], [later({ status: "unavailable" })], "invalid"), []);
  assert.ok(Number.isNaN(timestampMs("2026-02-30T00:00:00.000Z")));
});

test("persisted runs retain history, skip repeated snapshots, and reject time reversal", () => {
  const baseline = snapshot(firstAt, [plan({ status: "unavailable" })]);
  const second = snapshot(secondAt, [later()], baseline);
  assert.equal(second.events.length, 1);
  assert.equal(second.eventTracking.startedAt, firstAt);
  const repeated = snapshot(secondAt, [later({ status: "unavailable" })], second);
  assert.deepEqual(repeated.events, second.events);
  const third = snapshot(thirdAt, [plan({ fetchedAt: thirdAt })], second);
  assert.deepEqual(third.events, second.events);
  assert.throws(() => snapshot(firstAt, [plan()], second), /cannot precede/);
  const stale = { ...baseline, products: [plan({ fetchedAt: "2026-10-31T23:00:00.000Z", status: "unavailable" })] };
  assert.deepEqual(snapshot(secondAt, [later()], stale).events, []);
  assert.deepEqual(snapshot("2026-11-09T00:00:00.000Z", [], third).events, []);
});

test("retention rejects malformed/future entries, deduplicates, sorts by instant and caps at 300", () => {
  const at = "2026-11-10T00:00:00.000Z";
  const newest = stockEvent(at);
  const boundary = stockEvent("2026-11-03T00:00:00.000Z");
  const expired = stockEvent("2026-11-02T23:59:59.999Z");
  const future = stockEvent("2026-11-10T00:00:00.001Z");
  const offsetAt = "2026-11-09T20:00:00-04:00";
  const sameInstant = { ...newest, at: offsetAt, id: `${offsetAt}|restock|${newest.productId}` };
  const invalid = [null, {}, { ...newest, id: "" }, { ...newest, at: "invalid" }, { ...newest, type: "new" },
    { ...newest, priceValue: "9" }, { ...newest, orderUrl: "javascript:bad" }];
  const merged = mergeEvents([boundary, expired, future, newest, ...invalid], [newest, sameInstant], at);
  assert.deepEqual(merged.map((event) => Date.parse(event.at)), [Date.parse(at), Date.parse(boundary.at)]);
  assert.equal(mergeEvents([boundary, newest], [], at, "2026-11-04T00:00:00.000Z").length, 1);
  assert.deepEqual(mergeEvents([newest], [], "invalid"), []);
  const many = Array.from({ length: 350 }, (_, index) => stockEvent(new Date(Date.parse(at) - index * 60000).toISOString(), `plan:${index}`));
  const limited = mergeEvents([...many].reverse(), [], at);
  assert.equal(limited.length, 300);
  assert.equal(limited[0].productId, "plan:0");
  assert.equal(limited.at(-1).productId, "plan:299");
});
