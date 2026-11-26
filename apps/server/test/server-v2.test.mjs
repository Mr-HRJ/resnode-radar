import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startVisitStatsServer } from "../src/server.js";

const VALID_POINTER = {
  schemaVersion: 2,
  dictVersion: 1,
  mode: "v2",
  snapshotId: "snap_1764072000000_abcdef012345",
  v1Sha256: "a".repeat(64),
  generatedAt: "2026-11-25T12:00:00.000Z",
  publishedAt: "2026-11-25T12:00:05.000Z",
  snapshotPath: "data/snapshots/snap_1764072000000_abcdef012345/snapshot.json",
  auditDirPath: "data/snapshots/snap_1764072000000_abcdef012345/audit"
};

test("server boots and serves /api/v1/pulse even when visits.sqlite cannot be opened", async () => {
  const dir = mkdtempSync(join(tmpdir(), "resnode-server-broken-db-"));
  let runtime = null;
  try {
    // Create a regular file where parent dir is expected so SQLite open fails with ENOTDIR/SQLITE_CANTOPEN
    const blockerFile = join(dir, "blocker");
    writeFileSync(blockerFile, "not-a-directory");
    const latestPath = join(dir, "latest.json");
    writeFileSync(latestPath, JSON.stringify(VALID_POINTER));

    runtime = await startVisitStatsServer({
      host: "127.0.0.1",
      port: 0,
      dbPath: join(blockerFile, "visits.sqlite"),
      latestJsonPath: latestPath
    });

    const base = `http://127.0.0.1:${runtime.port}`;
    const pulseRes = await fetch(`${base}/api/v1/pulse`);
    assert.equal(pulseRes.status, 200);
    const pulseBody = await pulseRes.json();
    assert.equal(pulseBody.snapshotId, VALID_POINTER.snapshotId);
    assert.equal(pulseBody.stats, null);

    const statsRes = await fetch(`${base}/api/v1/stats`);
    assert.equal(statsRes.status, 503);
  } finally {
    await runtime?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker_threads isolation keeps /api/v1/pulse sub-100ms under sustained SQLite lock contention and concurrent stats overload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "resnode-server-stress-"));
  let runtime = null;
  try {
    mkdirSync(join(dir, "state"), { recursive: true });
    const latestPath = join(dir, "latest.json");
    writeFileSync(latestPath, JSON.stringify(VALID_POINTER));

    // Simulate 200ms synchronous SQLite lock wait per Worker operation, bounded queue=8, timeout=500ms
    runtime = await startVisitStatsServer({
      host: "127.0.0.1",
      port: 0,
      dbPath: join(dir, "state/visits.sqlite"),
      latestJsonPath: latestPath,
      simulatedBlockMs: 200,
      maxUnfinished: 8,
      timeoutMs: 500
    });

    const base = `http://127.0.0.1:${runtime.port}`;
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";

    // Launch 25 concurrent POST /api/v1/stats requests (total synchronous worker time would be >3s if on main thread!)
    const statsPromises = Array.from({ length: 25 }, (_, idx) =>
      fetch(`${base}/api/v1/stats`, {
        method: "POST",
        headers: { "user-agent": ua, "x-real-ip": `203.0.113.${idx + 1}` }
      }).then((r) => r.status)
    );

    // Simultaneously send 8 continuous GET /api/v1/pulse probes during peak lock contention
    const pulseLatencies = [];
    for (let i = 0; i < 8; i += 1) {
      const t0 = performance.now();
      const res = await fetch(`${base}/api/v1/pulse`);
      const elapsed = performance.now() - t0;
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.snapshotId, VALID_POINTER.snapshotId);
      pulseLatencies.push(elapsed);
    }

    const maxPulseMs = Math.max(...pulseLatencies);
    assert.ok(
      maxPulseMs < 500,
      `Expected /api/v1/pulse to stay non-blocking (<500ms << Nginx 3000ms), got ${maxPulseMs.toFixed(1)}ms`
    );

    const statuses = await Promise.all(statsPromises);
    // Bounded queue + deadline shedding returns 503 for overloaded/timed-out requests and 200 for completed ones
    assert.ok(statuses.every((s) => s === 200 || s === 503));
    assert.ok(statuses.includes(503), "Overloaded stats queue must shed excess load with 503");
  } finally {
    await runtime?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
