import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  CollectionState,
  createOriginPacer,
  enrichProductSignals,
  publishBatch,
  reconcilePublishedState,
  seedV2FromV1,
  trackEvents,
  validateV2PublishedData,
  verifySourcesCoverage,
  withPublishLock,
  writeV1FallbackPointer
} from "../src/index.js";

test("all 161 configured sources (7 adapters x 34 catalogFormats) map cleanly in registry", () => {
  const sources = JSON.parse(
    readFileSync(new URL("../config/sources.json", import.meta.url), "utf8")
  );
  const report = verifySourcesCoverage(sources);
  assert.equal(report.sourceCount, 161);
  assert.equal(report.adapters.length, 7);
  assert.equal(report.catalogFormats.length, 34);
});

test("OriginPacer guarantees strict >= intervalMs spacing after delayed wakeup and skips aborted waiters", async () => {
  let clock = 0;
  const launches = [];
  let callIndex = 0;

  const pacer = createOriginPacer({
    now: () => clock,
    sleep: async (ms, signal) => {
      signal?.throwIfAborted();
      callIndex += 1;
      // Simulate heavy OS/event-loop stall on the first sleep: requested 8000ms, actually wakes at 20000ms
      if (callIndex === 1) {
        clock += 20_000;
      } else {
        clock += ms;
      }
    }
  });

  // Sequential / queued requests on same origin with 8000ms minimum spacing
  await pacer("https://www.dmit.io/pages/pricing", 8000);
  launches.push(clock); // 0ms

  await pacer("https://www.dmit.io/cart.php?a=add&pid=1", 8000);
  launches.push(clock); // 20000ms (delayed wakeup)

  // Aborted waiter must NOT advance slot
  const abortCtrl = new AbortController();
  abortCtrl.abort(new Error("cancelled"));
  await assert.rejects(
    () => pacer("https://www.dmit.io/cart.php?a=add&pid=2", 8000, abortCtrl.signal),
    /cancelled/
  );

  await pacer("https://www.dmit.io/cart.php?a=add&pid=3", 8000);
  launches.push(clock); // MUST be 28000ms (20000 + 8000), NEVER 20000ms!

  assert.deepEqual(launches, [0, 20_000, 28_000]);
});

test("OriginPacer preserves strict FIFO order when a middle queued waiter aborts while predecessor wakes late", async () => {
  let clock = 0;
  let activeSleepers = 0;
  let maxConcurrentSleepers = 0;
  let releaseDelayedA = null;
  const order = [];

  const pacer = createOriginPacer({
    now: () => clock,
    sleep: async (ms, signal) => {
      signal?.throwIfAborted();
      activeSleepers += 1;
      maxConcurrentSleepers = Math.max(maxConcurrentSleepers, activeSleepers);
      try {
        if (!releaseDelayedA) {
          await new Promise((resolve) => {
            releaseDelayedA = () => {
              clock += 20_000;
              resolve();
            };
          });
        } else {
          clock += ms;
        }
      } finally {
        activeSleepers -= 1;
      }
    }
  });

  // Initial request at t=0 sets nextAllowedAt = 8000
  await pacer("https://www.dmit.io/pages/pricing", 8000);
  assert.equal(clock, 0);

  // Queue A, B, C behind the 8000ms window; A enters sleep and stalls
  const abortB = new AbortController();
  const runA = pacer("https://www.dmit.io/cart.php?a=add&pid=10", 8000).then(() => {
    order.push(["A", clock]);
  });
  const runB = pacer("https://www.dmit.io/cart.php?a=add&pid=11", 8000, abortB.signal).then(() => {
    order.push(["B", clock]);
  });
  const runC = pacer("https://www.dmit.io/cart.php?a=add&pid=12", 8000).then(() => {
    order.push(["C", clock]);
  });

  // Let microtasks settle so A is inside sleep
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(activeSleepers, 1);

  // Cancel B in the middle of the queue BEFORE A wakes up!
  abortB.abort(new Error("mid-queue abort"));
  await assert.rejects(runB, /mid-queue abort/);

  // C MUST still be waiting behind A (never starting a concurrent sleeper or overtaking A)
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(activeSleepers, 1);
  assert.deepEqual(order, []);

  // Now wake A late at t=20000 -> A releases at 20000, then C sleeps 8000ms and releases at 28000
  releaseDelayedA();
  await Promise.all([runA, runC]);

  assert.equal(maxConcurrentSleepers, 1, "Never more than one active sleeper per origin");
  assert.deepEqual(order, [
    ["A", 20_000],
    ["C", 28_000]
  ]);
});

test("withPublishLock never evicts an initializing or active lock across contending OS child processes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "resnode-lock-mp-"));
  const lockPath = join(dir, ".publish.lock");
  const lockModuleUrl = new URL("../src/lock.js", import.meta.url).href;
  const eventsLog = join(dir, "events.jsonl");

  function spawnContender(script, args = []) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(`Child exited ${code}: ${stderr}`));
        else resolve(stdout.trim());
      });
    });
  }

  try {
    // 1) Pause Process 1 right after creating an empty 0-byte lock file (before writing JSON),
    //    then contend from Process 2 via withPublishLock -> Process 2 MUST wait, NEVER delete Process 1's lock!
    const holderReady = new Promise((resolve, reject) => {
      const holderScript = `
        import { appendFileSync, closeSync, fsyncSync, openSync, unlinkSync, writeSync } from "node:fs";
        const [lockPath, eventsLog] = process.argv.slice(1);
        const createdAt = Date.now();
        const fd = openSync(lockPath, "wx", 0o600);
        process.stdout.write("CREATED\\n");
        await new Promise((r) => setTimeout(r, 220));
        const initDoneAt = Date.now();
        writeSync(fd, JSON.stringify({ pid: process.pid, token: "init-holder", acquiredAt: initDoneAt }));
        fsyncSync(fd);
        closeSync(fd);
        await new Promise((r) => setTimeout(r, 140));
        const exitAt = Date.now();
        appendFileSync(eventsLog, JSON.stringify({ role: "holder", createdAt, initDoneAt, enterAt: initDoneAt, exitAt }) + "\\n");
        unlinkSync(lockPath);
      `;
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", holderScript, lockPath, eventsLog],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      let resolvedCreated = false;
      let errOut = "";
      child.stderr.on("data", (d) => {
        errOut += d.toString();
      });
      child.stdout.on("data", (d) => {
        if (!resolvedCreated && d.toString().includes("CREATED")) {
          resolvedCreated = true;
          // Wrap waitDone inside an object so Promise.resolve does NOT flatten and wait for child exit!
          resolve({
            waitDone: new Promise((done, fail) => {
              child.on("close", (code) =>
                code === 0 ? done() : fail(new Error(`Holder failed ${code}: ${errOut}`))
              );
            })
          });
        }
      });
      child.on("error", reject);
    });

    const { waitDone: waitHolderDone } = await holderReady;
    // Right now lockPath is 0 bytes on disk while holder is still sleeping 220ms before writeSync!
    assert.equal(readFileSync(lockPath).length, 0, "Lock file must still be 0 bytes when contenders launch");

    const contenderScript = `
      import { appendFileSync } from "node:fs";
      import { withPublishLock } from ${JSON.stringify(lockModuleUrl)};
      const [lockPath, eventsLog, label] = process.argv.slice(1);
      const contendStartAt = Date.now();
      await withPublishLock(lockPath, async () => {
        const enterAt = Date.now();
        await new Promise((r) => setTimeout(r, 60));
        const exitAt = Date.now();
        appendFileSync(eventsLog, JSON.stringify({ role: label, contendStartAt, enterAt, exitAt }) + "\\n");
      }, { retryMs: 15, timeoutMs: 5000 });
    `;
    await Promise.all([
      waitHolderDone,
      spawnContender(contenderScript, [lockPath, eventsLog, "contender-A"]),
      spawnContender(contenderScript, [lockPath, eventsLog, "contender-B"])
    ]);

    const records = readFileSync(eventsLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 3);
    assert.equal(records[0].role, "holder", "Initializing holder must enter and finish first");
    // Prove contenders actually contended DURING the 0-byte initialization window (before holder wrote JSON)
    assert.ok(
      records[1].contendStartAt < records[0].initDoneAt &&
        records[2].contendStartAt < records[0].initDoneAt,
      `Contenders must contend during holder initialization window: ${JSON.stringify(records)}`
    );
    for (let i = 1; i < records.length; i += 1) {
      assert.ok(
        records[i].enterAt >= records[i - 1].exitAt,
        `Overlapping critical sections detected: ${JSON.stringify(records)}`
      );
    }
    assert.equal(existsSync(lockPath), false, "Lock file must be cleaned up after release");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("published v1 baseline prevents false soldout across available -> fetch failure -> unavailable", () => {
  const dir = mkdtempSync(join(tmpdir(), "resnode-baseline-"));
  try {
    const db = new CollectionState(join(dir, "collection.sqlite"));
    const source = { id: "demo-src", provider: "Demo", category: "vps", adapter: "whmcs_group", url: "https://example.com/store" };

    const t1 = "2026-11-25T10:00:00.000Z";
    const t2 = "2026-11-25T10:20:00.000Z";
    const t3 = "2026-11-25T10:40:00.000Z";

    const makePlan = (status, at) =>
      enrichProductSignals({
        id: "demo-src-pid-1",
        sourceId: "demo-src",
        provider: "Demo",
        category: "vps",
        adapter: "whmcs_group",
        sourceUrl: source.url,
        fetchedAt: at,
        status,
        statusLabel: status === "available" ? "有货" : "售罄",
        price: "$10/月",
        priceValue: 10,
        currency: "USD",
        name: "KVM-1G",
        orderUrl: "https://example.com/cart.php?a=add&pid=1",
        evidence: "official page",
        raw: { pid: "1" }
      });

    // Cycle 1: available
    const r1 = db.saveSource(source, [makePlan("available", t1)], t1, t1).map(enrichProductSignals);
    const pub1 = {
      schemaVersion: 1,
      generatedAt: t1,
      ...trackEvents(null, { generatedAt: t1, products: r1 }),
      products: r1
    };
    assert.equal(pub1.events.length, 0);

    // Cycle 2: upstream fetch error -> public payload receives diagnostic + synthesized `unknown` historical row
    const errRow = enrichProductSignals({
      id: "demo-src",
      sourceId: "demo-src",
      provider: "Demo",
      category: "vps",
      adapter: "whmcs_group",
      sourceUrl: source.url,
      fetchedAt: t2,
      diagnostic: true,
      status: "error",
      statusLabel: "HTTP 502",
      evidence: "HTTP 502",
      error: "HTTP 502"
    });
    const r2 = db.saveSource(source, [errRow], t2, t2).map(enrichProductSignals);
    const pub2 = {
      schemaVersion: 1,
      generatedAt: t2,
      ...trackEvents(pub1, { generatedAt: t2, products: r2 }),
      products: r2
    };
    assert.equal(pub2.events.length, 0);
    assert.equal(r2.find((p) => p.id === "demo-src-pid-1")?.status, "unknown");

    // Cycle 3: unavailable -> comparing against pub2 (unknown) MUST NOT fabricate a soldout event
    const r3 = db.saveSource(source, [makePlan("unavailable", t3)], t3, t3).map(enrichProductSignals);
    const pub3 = {
      schemaVersion: 1,
      generatedAt: t3,
      ...trackEvents(pub2, { generatedAt: t3, products: r3 }),
      products: r3
    };
    assert.equal(pub3.events.length, 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publishBatch, reconcilePublishedState, non-empty corrupt dir .quarantine recovery, and 24h GC work atomically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "resnode-pub-v2-"));
  const dataDir = join(dir, "data");
  const v1Path = join(dataDir, "products.json");
  const silent = { log() {}, warn() {} };

  const makePayload = (generatedAt, stockCount = 5) => ({
    schemaVersion: 1,
    generatedAt,
    publishedAt: generatedAt,
    sourceCount: 1,
    summary: { total: 1, available: 1, unavailable: 0, unknown: 0, blocked: 0, error: 0 },
    eventTracking: { startedAt: generatedAt, retentionDays: 7, limit: 300 },
    events: [],
    exchangeRates: {
      base: "CNY",
      date: "2026-11-24",
      source: "ECB",
      sourceUrl: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
      rates: { CNY: 1, USD: 7.2, EUR: 7.6 }
    },
    products: [
      enrichProductSignals({
        id: "src1-plan1",
        sourceId: "src1",
        provider: "DMIT",
        providerId: "dmit",
        category: "vps",
        adapter: "public_catalog",
        sourceUrl: "https://www.dmit.io/",
        fetchedAt: generatedAt,
        status: "available",
        statusLabel: `库存 ${stockCount}`,
        stockCount,
        price: "$36.90 / Year",
        priceValue: 36.9,
        currency: "USD",
        name: "LAX.Pro.WEE",
        region: "Los Angeles",
        route: "CN2 GIA",
        hardware: "1 vCPU / 1 GB RAM / 20 GB SSD",
        bandwidth: "500 Mbps / 500 GB",
        orderUrl: "https://www.dmit.io/cart.php?a=add&pid=1",
        evidence: "exact stock",
        raw: { pid: "1", features: { Route: "CN2 GIA" } }
      })
    ]
  });

  try {
    const p1 = makePayload("2026-11-23T00:00:00.000Z", 5);
    const res1 = await publishBatch({
      fullPayload: p1,
      dataDir,
      v1OutputPath: v1Path,
      expectedSourceIds: ["src1"],
      logger: silent
    });

    const v1Bytes = readFileSync(v1Path);
    assert.equal(existsSync(`${v1Path}.gz`), true, "publishBatch must emit products.json.gz");
    assert.equal(
      gunzipSync(readFileSync(`${v1Path}.gz`)).equals(v1Bytes),
      true,
      "products.json.gz must decompress byte-identically to products.json"
    );
    assert.deepEqual(validateV2PublishedData({ dataDir, fullPayload: p1, v1Bytes }), []);

    // Verify validateV2PublishedData catches stale/corrupt or missing products.json.gz, and reconcile restores it
    writeFileSync(`${v1Path}.gz`, Buffer.from("stale-gz"));
    const staleErrors = validateV2PublishedData({ dataDir, fullPayload: p1, v1Bytes });
    assert.ok(staleErrors.length > 0, "Stale/corrupt products.json.gz must fail v2 validation");
    const gzRepaired = await reconcilePublishedState({ dataDir, v1OutputPath: v1Path, logger: silent });
    assert.equal(gzRepaired.action, "repaired");
    assert.equal(gunzipSync(readFileSync(`${v1Path}.gz`)).equals(v1Bytes), true);
    assert.deepEqual(validateV2PublishedData({ dataDir, fullPayload: p1, v1Bytes }), []);

    // Inject non-empty corrupt snapshot directory + corrupt latest.json AND simulate crash right after quarantine!
    const snapDir = join(dataDir, "snapshots", res1.snapshotId);
    writeFileSync(join(snapDir, "snapshot.json"), "{corrupted-json");
    writeFileSync(join(dataDir, "v2/latest.json"), "{corrupted-pointer");

    await assert.rejects(
      () =>
        reconcilePublishedState({
          dataDir,
          v1OutputPath: v1Path,
          logger: silent,
          hooks: {
            onQuarantined() {
              throw new Error("Simulated crash immediately after moving corrupt dir to .quarantine");
            }
          }
        }),
      /Simulated crash/
    );

    // Corrupt dir was moved into .quarantine, and re-running reconcilePublishedState must succeed cleanly without ENOTEMPTY!
    assert.ok(readdirSync(join(dataDir, ".quarantine")).length >= 1);
    const repaired = await reconcilePublishedState({
      dataDir,
      v1OutputPath: v1Path,
      logger: silent
    });
    assert.equal(repaired.action, "repaired");
    assert.equal(repaired.snapshotId, res1.snapshotId);
    assert.deepEqual(
      validateV2PublishedData({ dataDir, fullPayload: p1, v1Bytes: readFileSync(v1Path) }),
      []
    );

    // Verify seed-v2-from-v1 & v1-fallback rollback pointer
    await writeV1FallbackPointer({ dataDir, logger: silent });
    const fb = JSON.parse(readFileSync(join(dataDir, "v2/latest.json"), "utf8"));
    assert.equal(fb.mode, "v1-fallback");
    // Reconcile respects intentional v1-fallback mode
    const kept = await reconcilePublishedState({ dataDir, v1OutputPath: v1Path, logger: silent });
    assert.equal(kept.action, "v1_fallback_preserved");

    // Seed restores v2 mode AND generates missing products.json.gz preserving original generatedAt
    unlinkSync(`${v1Path}.gz`);
    assert.equal(existsSync(`${v1Path}.gz`), false);
    const seeded = await seedV2FromV1({ dataDir, v1OutputPath: v1Path, logger: silent });
    assert.equal(seeded.pointer.generatedAt, p1.generatedAt);
    assert.equal(seeded.pointer.mode, "v2");
    assert.equal(existsSync(`${v1Path}.gz`), true, "seedV2FromV1 must generate missing products.json.gz");
    assert.equal(gunzipSync(readFileSync(`${v1Path}.gz`)).equals(readFileSync(v1Path)), true);
    assert.deepEqual(validateV2PublishedData({ dataDir, fullPayload: p1, v1Bytes: readFileSync(v1Path) }), []);

    // Validate rejects missing products.json.gz in active v2 mode
    unlinkSync(`${v1Path}.gz`);
    const missingGzErrors = validateV2PublishedData({ dataDir, fullPayload: p1, v1Bytes: readFileSync(v1Path) });
    assert.ok(missingGzErrors.some((e) => /products\.json\.gz/.test(e)), missingGzErrors.join("; "));
    const restoredGz = await reconcilePublishedState({ dataDir, v1OutputPath: v1Path, logger: silent });
    assert.equal(restoredGz.action, "repaired");
    assert.equal(gunzipSync(readFileSync(`${v1Path}.gz`)).equals(readFileSync(v1Path)), true);

    // Publish 2 newer snapshots >24h later -> test crash interruptions at afterStage, afterSnapPublished, and afterV1Committed!
    const p2 = makePayload("2026-11-25T10:00:00.000Z", 4);

    // (a) Crash right after Phase A (`afterStage`, before snapshot dir or v1 is committed)
    await assert.rejects(
      () =>
        publishBatch({
          fullPayload: p2,
          dataDir,
          v1OutputPath: v1Path,
          logger: silent,
          hooks: {
            afterStage() {
              throw new Error("Crash after Phase A (staged)");
            }
          }
        }),
      /Crash after Phase A/
    );
    assert.equal(JSON.parse(readFileSync(join(dataDir, "v2/journal.json"), "utf8")).state, "staged");
    const recAfterStage = await reconcilePublishedState({ dataDir, v1OutputPath: v1Path, logger: silent });
    assert.equal(recAfterStage.snapshotId, seeded.snapshotId, "Uncommitted stage must roll forward/stay on p1");
    assert.equal(JSON.parse(readFileSync(join(dataDir, "v2/journal.json"), "utf8")).state, "completed");
    assert.equal(JSON.parse(readFileSync(join(dataDir, "v2/journal.json"), "utf8")).snapId, seeded.snapshotId);

    // (b) Crash right after Phase B (`afterSnapPublished`, before v1 products.json is committed)
    await assert.rejects(
      () =>
        publishBatch({
          fullPayload: p2,
          dataDir,
          v1OutputPath: v1Path,
          logger: silent,
          hooks: {
            afterSnapPublished() {
              throw new Error("Crash after Phase B (snapshot_published)");
            }
          }
        }),
      /Crash after Phase B/
    );
    assert.equal(JSON.parse(readFileSync(join(dataDir, "v2/journal.json"), "utf8")).state, "snapshot_published");
    const recAfterSnap = await reconcilePublishedState({ dataDir, v1OutputPath: v1Path, logger: silent });
    assert.equal(recAfterSnap.snapshotId, seeded.snapshotId, "v1 is still p1 so latest.json stays consistent on p1");
    assert.equal(JSON.parse(readFileSync(join(dataDir, "v2/latest.json"), "utf8")).snapshotId, seeded.snapshotId);
    assert.equal(JSON.parse(readFileSync(join(dataDir, "v2/journal.json"), "utf8")).state, "completed");

    // (c) Crash right after Phase C (`afterV1Committed`, products.json is now p2 while latest.json still points to p1!)
    let expectedP2SnapId = null;
    await assert.rejects(
      () =>
        publishBatch({
          fullPayload: p2,
          dataDir,
          v1OutputPath: v1Path,
          logger: silent,
          hooks: {
            afterV1Committed({ snapId }) {
              expectedP2SnapId = snapId;
              throw new Error("Crash after Phase C (v1_committed)");
            }
          }
        }),
      /Crash after Phase C/
    );
    assert.equal(JSON.parse(readFileSync(join(dataDir, "v2/journal.json"), "utf8")).state, "v1_committed");
    assert.equal(JSON.parse(readFileSync(join(dataDir, "v2/latest.json"), "utf8")).snapshotId, seeded.snapshotId);

    // Reconcile converges latest.json + journal.json forward to p2 while preserving p1 as immediate predecessor!
    const recAfterV1 = await reconcilePublishedState({ dataDir, v1OutputPath: v1Path, logger: silent });
    assert.equal(recAfterV1.action, "repaired");
    assert.equal(recAfterV1.snapshotId, expectedP2SnapId);
    assert.equal(JSON.parse(readFileSync(join(dataDir, "v2/latest.json"), "utf8")).snapshotId, expectedP2SnapId);
    assert.equal(JSON.parse(readFileSync(join(dataDir, "v2/journal.json"), "utf8")).state, "completed");
    assert.equal(JSON.parse(readFileSync(join(dataDir, "v2/journal.json"), "utf8")).snapId, expectedP2SnapId);
    assert.deepEqual(validateV2PublishedData({ dataDir, fullPayload: p2, v1Bytes: readFileSync(v1Path) }), []);
    assert.equal(existsSync(join(dataDir, "snapshots", res1.snapshotId)), true, "Immediate predecessor res1 protected from 24h GC");

    // Publishing p3 after interrupted write right between products.json and products.json.gz -> reconcile repairs BOTH!
    const p3 = makePayload("2026-11-25T10:20:00.000Z", 3);
    await assert.rejects(
      () =>
        publishBatch({
          fullPayload: p3,
          dataDir,
          v1OutputPath: v1Path,
          logger: silent,
          hooks: {
            afterV1PlainCommitted() {
              throw new Error("Crash between products.json and products.json.gz");
            }
          }
        }),
      /Crash between products\.json and products\.json\.gz/
    );
    // products.json now holds p3 while products.json.gz still holds p2 -> reconcile must repair products.json.gz & latest.json!
    assert.equal(gunzipSync(readFileSync(`${v1Path}.gz`)).equals(readFileSync(v1Path)), false);
    const healedMidPhaseC = await reconcilePublishedState({ dataDir, v1OutputPath: v1Path, logger: silent });
    assert.equal(healedMidPhaseC.action, "repaired");
    const p3Bytes = readFileSync(v1Path);
    assert.equal(gunzipSync(readFileSync(`${v1Path}.gz`)).equals(p3Bytes), true);
    assert.deepEqual(validateV2PublishedData({ dataDir, fullPayload: p3, v1Bytes: p3Bytes }), []);

    assert.equal(existsSync(join(dataDir, "snapshots", res1.snapshotId)), false);
    assert.equal(existsSync(join(dataDir, "snapshots", expectedP2SnapId)), true);
    assert.equal(existsSync(join(dataDir, "snapshots", healedMidPhaseC.snapshotId)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
