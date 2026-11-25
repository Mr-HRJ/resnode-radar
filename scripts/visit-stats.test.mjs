import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { VisitStatsStore, beijingDayKey, startVisitStatsServer } from "./visit-stats-server.mjs";

const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SAFARI_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";

test("VisitStatsStore counts PV/UV, debounces rapid bursts, filters bots, rolls over at Beijing midnight, and never stores raw IPs", () => {
  // 2026-11-23T15:59:50Z === 2026-11-23 23:59:50 Beijing time
  const beforeMidnight = Date.parse("2026-11-23T15:59:50.000Z");
  assert.equal(beijingDayKey(beforeMidnight), "2026-11-23");

  const store = new VisitStatsStore(":memory:", { burstWindowMs: 1500 });
  try {
    // 1. Bot / crawler UAs are ignored
    for (const botUa of ["", "curl/8.7.1", "Mozilla/5.0 (compatible; Googlebot/2.1)", "python-requests/2.32", "UptimeRobot/2.0"]) {
      const r = store.recordVisit({ ip: "203.0.113.99", userAgent: botUa, nowMs: beforeMidnight });
      assert.equal(r.counted, false);
      assert.equal(r.todayPv, 0);
      assert.equal(r.todayUv, 0);
    }

    // 2. First human visitor -> PV=1, UV=1
    const first = store.recordVisit({ ip: "::ffff:203.0.113.42", userAgent: CHROME_UA, nowMs: beforeMidnight });
    assert.equal(first.counted, true);
    assert.equal(first.todayPv, 1);
    assert.equal(first.todayUv, 1);

    // 3. Burst within < 1.5s from same IPv4 (normalized) + UA is debounced
    const burst = store.recordVisit({ ip: "203.0.113.42", userAgent: CHROME_UA, nowMs: beforeMidnight + 600 });
    assert.equal(burst.counted, false);
    assert.equal(burst.todayPv, 1);
    assert.equal(burst.todayUv, 1);

    // 4. Genuine page reload after >= 1.5s increments PV (+1) while keeping UV=1
    const reload = store.recordVisit({ ip: "203.0.113.42", userAgent: CHROME_UA, nowMs: beforeMidnight + 2200 });
    assert.equal(reload.counted, true);
    assert.equal(reload.todayPv, 2);
    assert.equal(reload.todayUv, 1);

    // 5. Distinct visitor increments both PV and UV
    const secondVisitor = store.recordVisit({ ip: "198.51.100.7", userAgent: SAFARI_UA, nowMs: beforeMidnight + 3000 });
    assert.equal(secondVisitor.todayPv, 3);
    assert.equal(secondVisitor.todayUv, 2);

    // Verify raw IP never appears in daily_visitors table
    const storedHashes = store.db.prepare("SELECT visitor_hash FROM daily_visitors").all();
    assert.equal(storedHashes.length, 2);
    for (const row of storedHashes) {
      assert.doesNotMatch(row.visitor_hash, /203\.0\.113|198\.51\.100/);
      assert.match(row.visitor_hash, /^[a-f0-9]{64}$/);
    }

    // 6. Rollover across Beijing midnight (16:00:05Z === 2026-11-24 00:00:05 CST)
    const afterMidnight = Date.parse("2026-11-23T16:00:05.000Z");
    assert.equal(beijingDayKey(afterMidnight), "2026-11-24");
    const morningSnap = store.getSnapshot(afterMidnight);
    assert.equal(morningSnap.day, "2026-11-24");
    assert.equal(morningSnap.todayPv, 0);
    assert.equal(morningSnap.todayUv, 0);
    assert.equal(morningSnap.totalPv, 3);
    assert.equal(morningSnap.totalUv, 2);

    const newDayVisit = store.recordVisit({ ip: "203.0.113.42", userAgent: CHROME_UA, nowMs: afterMidnight + 1000 });
    assert.equal(newDayVisit.todayPv, 1);
    assert.equal(newDayVisit.todayUv, 1);
    assert.equal(newDayVisit.totalPv, 4);
    assert.equal(newDayVisit.totalUv, 3);

    // 7. Old salts & visitor hashes older than retention window are pruned automatically
    const fourDaysLater = afterMidnight + 4 * 86400 * 1000;
    store.recordVisit({ ip: "192.0.2.88", userAgent: CHROME_UA, nowMs: fourDaysLater });
    const remainingVisitorDays = store.db.prepare("SELECT DISTINCT day FROM daily_visitors").all().map((r) => r.day);
    assert.ok(!remainingVisitorDays.includes("2026-11-23"));
  } finally {
    store.close();
  }
});

test("HTTP visit stats server persists across restarts and enforces method, path, and body limits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "resnode-visits-"));
  const dbPath = join(dir, "visits.sqlite");
  let nowMs = Date.parse("2026-11-24T04:00:00.000Z");

  try {
    const srv1 = await startVisitStatsServer({
      dbPath,
      host: "127.0.0.1",
      port: 0,
      now: () => nowMs
    });
    const baseUrl = `http://127.0.0.1:${srv1.port}`;

    // Read-only GET does not increment
    const initRes = await fetch(`${baseUrl}/api/stats`);
    assert.equal(initRes.status, 200);
    assert.equal(initRes.headers.get("cache-control"), "no-store");
    assert.equal(initRes.headers.get("x-content-type-options"), "nosniff");
    const initJson = await initRes.json();
    assert.equal(initJson.todayPv, 0);

    // POST from loopback trusts X-Real-IP and records visit
    const postRes = await fetch(`${baseUrl}/api/stats`, {
      method: "POST",
      headers: {
        "user-agent": CHROME_UA,
        "x-real-ip": "203.0.113.55"
      }
    });
    assert.equal(postRes.status, 200);
    const postJson = await postRes.json();
    assert.equal(postJson.todayPv, 1);
    assert.equal(postJson.todayUv, 1);
    assert.equal("counted" in postJson, false);

    // HEAD returns 200 with empty body
    const headRes = await fetch(`${baseUrl}/api/stats`, { method: "HEAD" });
    assert.equal(headRes.status, 200);
    assert.equal(await headRes.text(), "");

    // Unknown route -> 404, unsupported method -> 405, oversized body -> 413
    assert.equal((await fetch(`${baseUrl}/other`)).status, 404);
    const delRes = await fetch(`${baseUrl}/api/stats`, { method: "DELETE" });
    assert.equal(delRes.status, 405);
    assert.equal(delRes.headers.get("allow"), "GET, HEAD, POST");

    const hugeRes = await fetch(`${baseUrl}/api/stats`, {
      method: "POST",
      headers: { "user-agent": CHROME_UA },
      body: "x".repeat(4096)
    });
    assert.equal(hugeRes.status, 413);

    await srv1.close();

    // Restart against the same SQLite file -> counts survive restart
    nowMs += 5000;
    const srv2 = await startVisitStatsServer({
      dbPath,
      host: "127.0.0.1",
      port: 0,
      now: () => nowMs
    });
    const afterRestart = await (await fetch(`http://127.0.0.1:${srv2.port}/api/stats`)).json();
    assert.equal(afterRestart.todayPv, postJson.todayPv);
    assert.equal(afterRestart.todayUv, postJson.todayUv);
    await srv2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default statistics count exact 1 PV and 1 UV per unique visit without random inflation", () => {
  const store = new VisitStatsStore();
  try {
    const first = store.recordVisit({ ip: "203.0.113.1", userAgent: CHROME_UA, nowMs: 1000 });
    assert.equal(first.todayPv, 1);
    assert.equal(first.todayUv, 1);
    const repeat = store.recordVisit({ ip: "203.0.113.1", userAgent: CHROME_UA, nowMs: 2000 });
    assert.equal(repeat.todayPv, 2);
    assert.equal(repeat.todayUv, 1);
  } finally {
    store.close();
  }
});

test("storage failures return 503 without exposing details or terminating later requests", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const runtime = await startVisitStatsServer({ dbPath: ":memory:", port: 0 });
  t.after(() => runtime.close());
  const url = `http://127.0.0.1:${runtime.port}/api/stats`;
  for (const [method, operation] of [["GET", "getSnapshot"], ["POST", "recordVisit"]]) {
    const original = runtime.store[operation];
    runtime.store[operation] = () => { throw Object.assign(new Error("private database path"), { code: "ERR_SQLITE_ERROR" }); };
    const response = await fetch(url, { method, headers: { "user-agent": CHROME_UA } });
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /private database path/);
    runtime.store[operation] = original;
    assert.equal((await fetch(url, { method, headers: { "user-agent": CHROME_UA } })).status, 200);
  }
  assert.equal(errors.length, 2);
  assert.equal((await (await fetch(url)).json()).todayPv, 1);
});
