import assert from "node:assert/strict";
import { test } from "node:test";
import { CollectionState } from "./collection-state.mjs";
import { candidatesFromLinks, normalizeAnnouncement, parseFeedXml, refreshAnnouncements } from "./announcements.mjs";
import { renderAnnouncements } from "../src/components/announcements.js";

const at = "2026-11-23T10:00:00.000Z";
const source = { id: "news", name: "Official", trust: "official", kind: "rss", url: "https://news.example/feed", linkHosts: ["news.example"] };
const vendors = [{ id: "vendor", provider: "Vendor", url: "https://vendor.example/cart.php" }];
const xml = `<rss version="2.0"><channel><item><guid>one</guid><title>New plan</title><link>https://news.example/one</link><pubDate>Mon, 23 Nov 2026 09:00:00 GMT</pubDate><description><![CDATA[<a href="https://vendor.example/cart.php?a=add&amp;pid=42&amp;utm_source=news">Buy</a>]]></description></item></channel></rss>`;

test("RSS and Atom are parsed without entities and unsafe product links are rejected", async () => {
  const rows = await parseFeedXml(xml);
  const item = normalizeAnnouncement(rows[0], source, vendors, at);
  assert.equal(item.candidates[0].url, "https://vendor.example/cart.php?a=add&pid=42");
  assert.equal(item.publishedAt, "2026-11-23T09:00:00.000Z");
  assert.deepEqual(candidatesFromLinks(["http://vendor.example/cart.php?pid=42", "https://vendor.example/cart.php?a=checkout&pid=42", "https://vendor.example@127.0.0.1/cart.php?pid=42", "https://vendor.example/cart.php?pid=42&callback=http://127.0.0.1"], vendors), []);
  await assert.rejects(parseFeedXml('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>'));
  await assert.rejects(parseFeedXml('<html>challenge</html>'));
  const atom = await parseFeedXml('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>x</id><title>Title</title><link href="https://news.example/x"/><updated>2026-11-22T00:00:00Z</updated><content>test</content></entry></feed>');
  assert.equal(atom[0].link, "https://news.example/x");
});

test("native feed deduplication, 304 refresh, failed refresh, and SKU verification share durable state", async (t) => {
  const db = new CollectionState(":memory:"); t.after(() => db.close());
  let status = 200;
  t.mock.method(globalThis, "fetch", async () => new Response(status === 304 ? null : status === 200 ? xml : "upstream down", { status, headers: { etag: '"first"' } }));
  await refreshAnnouncements(db, [source], vendors, at);
  assert.equal(db.pendingJobs("vendor").length, 1);
  db.saveSource(vendors[0], [{ id: "sku42", sourceId: "vendor", status: "available", statusLabel: "可下单", fetchedAt: at, orderUrl: "https://vendor.example/cart.php?pid=42&a=add", raw: {} }], at, at);
  let result = await refreshAnnouncements(db, [source], vendors, at);
  assert.equal(result.items.length, 1); assert.equal(result.items[0].baseline, true);
  assert.equal(result.items[0].candidates[0].verification.state, "verified");
  db.saveSource(vendors[0], [{ id: "sku42", sourceId: "vendor", status: "unavailable", statusLabel: "售罄", fetchedAt: at, orderUrl: "https://vendor.example/cart.php?pid=42&a=add", raw: {} }], at, at);
  assert.equal(db.announcementPayload(at).items[0].candidates[0].verification.status, "unavailable");
  status = 304; result = await refreshAnnouncements(db, [source], vendors, at);
  assert.equal(result.sources[0].status, "ok");
  status = 503; result = await refreshAnnouncements(db, [source], vendors, at);
  assert.equal(result.items.length, 1); assert.equal(result.sources[0].status, "error");
  assert.equal(Object.hasOwn(result.sources[0], "etag"), false);
  assert.match(renderAnnouncements(result), /售罄/);
  assert.match(renderAnnouncements(result), /首次导入/);
});

test("old baseline announcements do not enqueue obsolete offers; edited/new announcements do", async (t) => {
  const db = new CollectionState(":memory:"); t.after(() => db.close());
  let body = xml.replace("23 Nov 2026", "01 Jan 2020");
  t.mock.method(globalThis, "fetch", async () => new Response(body));
  await refreshAnnouncements(db, [source], vendors, at);
  assert.equal(db.pendingJobs("vendor").length, 0);
  body = body.replace("<guid>one</guid>", "<guid>two</guid>");
  await refreshAnnouncements(db, [source], vendors, at);
  assert.equal(db.pendingJobs("vendor").length, 1);
});

test("announcement rendering escapes hostile titles and removes unsafe source links", () => {
  const html = renderAnnouncements({ sources: [{ name: "test", status: "ok", checkedAt: at }], items: [{ title: '<img src=x onerror="alert(1)">', url: "javascript:alert(1)", source: "test", firstSeenAt: at, candidates: [] }] });
  assert.ok(!html.includes('<img')); assert.ok(!html.includes('href="javascript:'));
});

test("a valid empty RSS is healthy and does not erase previous announcements", async (t) => {
  const db = new CollectionState(":memory:"); t.after(() => db.close());
  let body = xml;
  t.mock.method(globalThis, "fetch", async () => new Response(body));
  await refreshAnnouncements(db, [source], vendors, at);
  body = '<rss version="2.0"><channel><title>Currently no offers</title></channel></rss>';
  const result = await refreshAnnouncements(db, [source], vendors, at);
  assert.equal(result.sources[0].status, "ok"); assert.equal(result.sources[0].items, 0);
  assert.equal(result.items.length, 1);
});
