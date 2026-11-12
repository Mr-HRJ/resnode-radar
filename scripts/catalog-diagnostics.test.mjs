import assert from "node:assert/strict";
import { test } from "node:test";
import { monitorPublicCatalog } from "./adapters/public-catalog.mjs";

const source = { id: "catalog-example", provider: "Example", providerId: "example", adapter: "public_catalog", url: "https://example.com/store", maxPages: 3 };
const baseRecord = (s, result, fields) => ({ sourceId: s.id, sourceUrl: s.url, finalUrl: result?.finalUrl ?? s.url, httpStatus: result?.statusCode ?? null, ...fields });
async function collect(result) {
  const calls = [];
  const rows = await monitorPublicCatalog(source, {
    baseRecord,
    fetchHtml: async (_, url) => { calls.push(url); return { ok: true, statusCode: 200, finalUrl: source.url, headers: {}, ...result }; },
    blockedRecord: (s, r, evidence) => baseRecord(s, r, { status: "blocked", evidence, stockCount: null }),
    errorRecord: (s, error) => baseRecord(s, null, { status: "error", evidence: error.message }),
  });
  return { rows, calls };
}

test("empty catalogs retain response provenance without claiming an order entry", async () => {
  const { rows } = await collect({ finalUrl: "https://example.com/pricing", html: "<title>Pricing</title><main>Contact us for a quote</main>" });
  const [diagnostic] = rows;
  assert.equal(diagnostic.diagnostic, true);
  assert.equal(diagnostic.status, "unknown");
  assert.equal(diagnostic.orderUrl, null);
  assert.equal(diagnostic.stockCount, null);
  assert.equal(diagnostic.httpStatus, 200);
  assert.equal(diagnostic.finalUrl, "https://example.com/pricing");
  assert.equal(diagnostic.raw.attempts[0].title, "Pricing");
  assert.equal(diagnostic.raw.attempts[0].status, "no-products");
});

test("login redirects are diagnosed without walking catalog links from the login page", async () => {
  for (const suffix of ["/login", "/index.php?rp=/login", "/index.php?/clientarea/"]) {
    const { rows, calls } = await collect({ finalUrl: `https://example.com${suffix}`, html: '<title>Client Login</title><a href="/store/vps">VPS</a>' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "blocked");
    assert.equal(rows[0].statusLabel, "需登录访问");
    assert.equal(rows[0].raw.attempts[0].reason, "login-required");
    assert.equal(rows[0].httpStatus, 200);
    assert.deepEqual(calls, [source.url]);
  }
});

test("blocked diagnostics distinguish challenges, HTTP refusal and rate limits", async () => {
  for (const [statusCode, title, reason] of [[403, "Attention Required! | Cloudflare", "challenge"], [403, "Forbidden", "http-403"], [429, "Too Many Requests", "rate-limited"], [200, "Access Denied", "access-denied"]]) {
    const { rows, calls } = await collect({ ok: statusCode < 400, statusCode, html: `<title>${title}</title>` });
    assert.equal(rows[0].diagnostic, true);
    assert.equal(rows[0].status, "blocked");
    assert.equal(rows[0].raw.attempts[0].reason, reason);
    assert.equal(rows[0].raw.attempts[0].httpStatus, statusCode);
    assert.equal(rows[0].raw.attempts[0].title, title);
    assert.equal(calls.length, 1);
  }
});
