import assert from "node:assert/strict";
import { test } from "node:test";
import { CollectionState } from "./collection-state.mjs";

const at = "2026-11-23T10:00:00.000Z", later = "2026-11-23T10:20:00.000Z";
const source = { id: "catalog-dmit", provider: "DMIT" };
const row = (id, extra = {}) => ({ id, sourceId: source.id, name: id, status: "available", fetchedAt: at,
  price: "USD 10/月", priceValue: 10, orderUrl: `https://www.dmit.io/cart.php?a=add&pid=${id}`,
  raw: { pid: id, inventoryChecked: true, inventoryAttemptedAt: at }, ...extra });
const blocked = { id: source.id, sourceId: source.id, diagnostic: true, status: "blocked", httpStatus: 403, error: "challenge" };

test("state retains failed-source history as unknown without renewing verification or emitting stock", (t) => {
  const db = new CollectionState(":memory:"); t.after(() => db.close());
  db.saveSource(source, [row("1")], at, at);
  const result = db.saveSource(source, [blocked], later, later);
  const retained = result.find((r) => r.id === "1");
  assert.equal(retained.status, "unknown"); assert.equal(retained.stockCount, null);
  assert.equal(retained.verification.verifiedAt, at); assert.equal(retained.verification.priceKind, "historical");
  assert.equal(retained.fetchedAt, later); assert.equal(retained.raw.historical, true);
  assert.equal(db.sourceState(source.id).status, "blocked");
});

test("DMIT rotation prioritizes unattempted SKUs and retains actual quotes separately from references", (t) => {
  const db = new CollectionState(":memory:"); t.after(() => db.close());
  db.saveSource(source, [row("1"), row("2", { status: "unknown", raw: { pid: "2", referencePrice: true } })], at, at);
  assert.deepEqual(db.priorityPids(source.id), ["2", "1"]);
  const result = db.saveSource(source, [row("1", { status: "unknown", priceValue: 5, price: "USD 5/月", raw: { pid: "1", referencePrice: true } })], later, later);
  assert.equal(result[0].verification.lastVerifiedQuote.priceValue, 10);
  assert.equal(result[0].verification.verifiedAt, at);
});

test("healthy sources remain due each cycle; blocked sources cool down without advancing attempts", (t) => {
  const db = new CollectionState(":memory:"); t.after(() => db.close());
  db.saveSource(source, [row("1")], "2026-11-23T10:05:00.000Z", at);
  assert.equal(db.due(source.id, later), true);
  db.saveSource(source, [blocked], later, later);
  assert.equal(db.due(source.id, "2026-11-23T10:21:00.000Z"), false);
  db.saveSource(source, [blocked], "2026-11-23T10:30:00.000Z", later, { skipped: true });
  assert.equal(db.sourceState(source.id).lastAttemptAt, later);
});

test("a legacy product sharing its ID with a source diagnostic is preserved with unique IDs", (t) => {
  const db = new CollectionState(":memory:"); t.after(() => db.close());
  db.saveSource(source, [row(source.id)], at, at);
  const result = db.saveSource(source, [blocked], later, later);
  assert.equal(result.length, 2); assert.equal(new Set(result.map((r) => r.id)).size, 2);
});

test("announcements are idempotent, edits retain identity, and baseline items stay historical", (t) => {
  const db = new CollectionState(":memory:"); t.after(() => db.close());
  const feed = { id: "feed", name: "Official", trust: "official" }, item = { key: "guid", hash: "a", title: "First", candidates: [] };
  const first = db.ingestAnnouncement(feed, item, at); db.saveFeed(feed.id, { initialized: true });
  const same = db.ingestAnnouncement(feed, item, later);
  const edit = db.ingestAnnouncement(feed, { ...item, hash: "b", title: "Edited" }, later);
  assert.equal(same.changed, false); assert.equal(edit.changed, true); assert.equal(edit.record.id, first.record.id);
  assert.equal(edit.record.baseline, true); assert.equal(db.announcementPayload(later).items.length, 1);
});

test("undated page changes are ordered by discovery without inventing publication times", (t) => {
  const db = new CollectionState(":memory:"); t.after(() => db.close());
  const feed = { id: "feed", name: "Official", trust: "official" };
  db.ingestAnnouncement(feed, { key: "old", hash: "a", publishedAt: at, candidates: [] }, at);
  db.ingestAnnouncement(feed, { key: "new", hash: "b", publishedAt: null, candidates: [] }, later);
  const items = db.announcementPayload(later).items;
  assert.equal(items[0].key, "new"); assert.equal(items[0].publishedAt, null);
});

test("jobs beyond the per-source batch keep their place and run before previously unmatched links", (t) => {
  const db = new CollectionState(":memory:"); t.after(() => db.close());
  for (let id = 1; id <= 31; id++) db.enqueue(`https://www.dmit.io/cart.php?pid=${id}`, source.id, at);
  const batch = new Set(db.pendingJobs(source.id).map((j) => j.url));
  const waiting = db.db.prepare("SELECT url FROM jobs").all().find((j) => !batch.has(j.url)).url;
  db.saveSource(source, [row("999")], later, later);
  assert.equal(db.pendingJobs(source.id)[0].url, waiting);
  assert.equal(db.pendingJobs(source.id)[0].updated_at, at);
  assert.equal(db.pendingJobs(source.id)[0].result, null);
});
