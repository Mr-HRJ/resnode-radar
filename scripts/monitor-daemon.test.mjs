import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseDaemonArgs, createStaticServer, startMonitorDaemon, writeAtomicJson } from "./monitor-daemon.mjs";
import { buildLaunchAgentPlist } from "./macos-service.mjs";
import { parseStaticArgs, startStaticPreview } from "./serve-static.mjs";
import { publishBatch, validateV2PublishedData } from "../apps/collector/src/index.js";

test("daemon CLI argument and environment parser enforces safe bounds", () => {
  const defaults = parseDaemonArgs([], {});
  assert.equal(defaults.intervalMinutes, 20);
  assert.equal(defaults.serve, false);
  assert.equal(defaults.port, 4173);
  assert.equal(defaults.gitPush, false);

  const custom = parseDaemonArgs(["--serve", "--interval", "15", "--port", "8090", "--git-push"], {});
  assert.equal(custom.serve, true);
  assert.equal(custom.intervalMinutes, 15);
  assert.equal(custom.port, 8090);
  assert.equal(custom.gitPush, true);

  const invalid = parseDaemonArgs(["--interval", "-5", "--port", "99999"], {});
  assert.equal(invalid.intervalMinutes, 20);
  assert.equal(invalid.port, 4173);
});

test("built-in static live server serves assets with no-store on data/ and blocks sensitive paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "resnode-daemon-test-"));
  const server = createStaticServer(root);
  try {
    writeFileSync(join(root, "index.html"), "<!doctype html><title>Radar</title>");
    mkdirSync(join(root, "data"), { recursive: true });
    writeAtomicJson(join(root, "data/daemon-status.json"), { active: true, state: "idle", intervalMinutes: 20 });
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git/config"), "secret");
    writeFileSync(join(root, ".env"), "test-only-placeholder");
    mkdirSync(join(root, "assets"));
    symlinkSync(join(root, ".env"), join(root, "assets/leak.txt"));

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const htmlRes = await fetch(`${base}/`);
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.headers.get("content-type"), /text\/html/);
    assert.match(await htmlRes.text(), /Radar/);

    const dataRes = await fetch(`${base}/data/daemon-status.json`);
    assert.equal(dataRes.status, 200);
    assert.equal(dataRes.headers.get("cache-control"), "no-store");
    assert.equal((await dataRes.json()).active, true);

    const gitRes = await fetch(`${base}/.git/config`);
    assert.equal(gitRes.status, 403);
    for (const path of ["/.env", "/assets/leak.txt", "/monitor/sources.json"]) {
      assert.equal((await fetch(`${base}${path}`)).status, 403, path);
    }
    assert.equal((await fetch(`${base}/assets/%00.png`)).status, 400);

    const postRes = await fetch(`${base}/data/daemon-status.json`, { method: "POST" });
    assert.equal(postRes.status, 405);

    // Built-in /api/stats works locally on :4173 while keeping data/visits.sqlite private
    const visitPost = await fetch(`${base}/api/stats`, {
      method: "POST",
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"
      }
    });
    assert.equal(visitPost.status, 200);
    const visitJson = await visitPost.json();
    assert.equal(visitJson.todayPv, 1);
    assert.equal(visitJson.todayUv, 1);
    assert.equal((await fetch(`${base}/data/visits.sqlite`)).status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("stopping during FX refresh waits for the child and prevents collection from starting", async () => {
  const root = mkdtempSync(join(tmpdir(), "resnode-daemon-stop-"));
  const calls = [];
  const logger = { log() {}, error() {} };
  let handle;
  try {
    handle = await startMonitorDaemon({ forceInitial: true, serve: false, gitPush: false }, {
      cwd: root, logger,
      runScript: (script, _cwd, _timeout, onChild) => {
        calls.push(script);
        return new Promise((resolve) => onChild({ kill: () => { resolve({ stdout: "", stderr: "" }); } }));
      }
    });
    await handle.stop();
    assert.equal(calls.length, 1);
    assert.match(calls[0], /fx-rates/);
    const status = JSON.parse(readFileSync(join(root, "data/daemon-status.json")));
    assert.equal(status.state, "stopped");
    assert.equal(status.nextRunAt, null);
  } finally {
    await handle?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("one-shot daemon closes its server even when collection fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "resnode-daemon-once-"));
  let handle;
  try {
    handle = await startMonitorDaemon({ once: true, serve: true, host: "127.0.0.1", port: 0, gitPush: false }, {
      cwd: root, logger: { log() {}, error() {} },
      runScript: async () => { throw new Error("fixture failure"); }
    });
    assert.equal(handle.server.listening, false);
    assert.equal(handle.state.active, false);
    assert.equal(handle.state.lastError, "fixture failure");
    assert.equal(handle.state.nextRunAt, null);
  } finally {
    await handle?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS LaunchAgent generator embeds KeepAlive, RunAtLoad, and target interval", () => {
  const plist = buildLaunchAgentPlist({
    nodePath: "/usr/local/bin/node",
    workDir: "/tmp/resnode-radar",
    port: 4173,
    intervalMinutes: 15
  });
  assert.match(plist, /com\.resnode\.radar\.monitor/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<string>15<\/string>/);
  assert.ok(readFileSync(new URL("../wrangler.json", import.meta.url), "utf8").includes('"crons"'));
});

test("daemon startup reconciles interrupted v1_committed publish immediately even when v1 and FX are fresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "resnode-daemon-reconcile-"));
  const dataDir = join(root, "data");
  const v1Path = join(dataDir, "products.json");
  const silent = { log() {}, warn() {}, error() {} };
  let handle;

  const makePayload = (generatedAt, name, stockCount) => ({
    schemaVersion: 1,
    generatedAt,
    publishedAt: generatedAt,
    sourceCount: 1,
    summary: { total: 1, available: 1, unavailable: 0, unknown: 0, blocked: 0, error: 0 },
    eventTracking: { startedAt: generatedAt, retentionDays: 7, limit: 300 },
    events: [],
    exchangeRates: {
      base: "CNY",
      date: generatedAt.slice(0, 10),
      source: "ECB",
      sourceUrl: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
      rates: { CNY: 1, USD: 7.2, EUR: 7.6 }
    },
    products: [
      {
        id: "daemon-rec-1",
        sourceId: "src-1",
        provider: "DMIT",
        providerId: "dmit",
        category: "vps",
        adapter: "public_catalog",
        sourceUrl: "https://www.dmit.io/",
        fetchedAt: generatedAt,
        status: "available",
        statusLabel: "有货",
        stockCount,
        price: "$36.90 / Year",
        priceValue: 36.9,
        currency: "USD",
        name,
        region: "Los Angeles",
        orderUrl: "https://www.dmit.io/cart.php?a=add&pid=1",
        evidence: "official",
        evidenceLevel: { value: "stock-count", label: `精确库存 ${stockCount}`, className: "is-count", rank: 1 },
        riskTags: [{ value: "no-extra-risk", label: "未见额外风险", severity: "low" }]
      }
    ]
  });

  try {
    const oldTs = new Date(Date.now() - 25 * 60_000).toISOString();
    const freshTs = new Date(Date.now() - 60_000).toISOString();
    const batchA = makePayload(oldTs, "OLD-BATCH-A", 2);
    const batchB = makePayload(freshTs, "FRESH-CRASHED-BATCH-B", 7);

    const resA = await publishBatch({
      fullPayload: batchA,
      dataDir,
      v1OutputPath: v1Path,
      expectedSourceIds: ["src-1"],
      logger: silent
    });

    // Write fresh FX so fxNeedsRefresh() is false (daemon waits ~19m before next crawl)
    writeFileSync(
      join(dataDir, "fx.json"),
      JSON.stringify({
        base: "CNY",
        date: freshTs.slice(0, 10),
        fetchedAt: freshTs,
        source: "ECB",
        rates: { CNY: 1, USD: 7.2 }
      })
    );

    // Interrupt Batch B right after Phase C (`v1_committed`), leaving v2/latest.json stale on Batch A!
    await assert.rejects(
      () =>
        publishBatch({
          fullPayload: batchB,
          dataDir,
          v1OutputPath: v1Path,
          expectedSourceIds: ["src-1"],
          logger: silent,
          hooks: {
            afterV1Committed() {
              throw new Error("simulated crash before latest.json commit");
            }
          }
        }),
      /simulated crash before latest\.json commit/
    );

    const staleLatest = JSON.parse(readFileSync(join(dataDir, "v2/latest.json"), "utf8"));
    const staleJournal = JSON.parse(readFileSync(join(dataDir, "v2/journal.json"), "utf8"));
    assert.equal(staleLatest.snapshotId, resA.snapshotId);
    assert.equal(staleJournal.state, "v1_committed");

    let crawlCalls = 0;
    handle = await startMonitorDaemon(
      {},
      {
        cwd: root,
        logger: silent,
        runScript: async () => {
          crawlCalls += 1;
          return { stdout: "", stderr: "" };
        }
      }
    );

    // Must NOT wait ~19m or trigger a crawl just to repair latest.json!
    assert.equal(crawlCalls, 0);
    assert.equal(handle.state.state, "idle");
    assert.ok(
      Date.parse(handle.state.nextRunAt) > Date.now() + 15 * 60_000,
      `Normal 20m cadence must be preserved cleanly (nextRunAt=${handle.state.nextRunAt})`
    );

    const healedV1Bytes = readFileSync(v1Path);
    const healedLatest = JSON.parse(readFileSync(join(dataDir, "v2/latest.json"), "utf8"));
    const healedJournal = JSON.parse(readFileSync(join(dataDir, "v2/journal.json"), "utf8"));
    assert.notEqual(healedLatest.snapshotId, resA.snapshotId);
    assert.equal(healedLatest.v1Sha256, createHash("sha256").update(healedV1Bytes).digest("hex"));
    assert.equal(healedJournal.state, "completed");
    assert.deepEqual(
      validateV2PublishedData({ dataDir, fullPayload: batchB, v1Bytes: healedV1Bytes }),
      []
    );
  } finally {
    await handle?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon retries transient startup reconciliation failure promptly during fresh-snapshot wait", async () => {
  const root = mkdtempSync(join(tmpdir(), "resnode-daemon-reconcile-retry-"));
  const dataDir = join(root, "data");
  const silent = { log() {}, warn() {}, error() {} };
  let handle;
  try {
    mkdirSync(dataDir, { recursive: true });
    const freshTs = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(
      join(dataDir, "products.json"),
      JSON.stringify({ generatedAt: freshTs, summary: { total: 1, available: 1 } })
    );
    writeFileSync(
      join(dataDir, "fx.json"),
      JSON.stringify({ base: "CNY", date: freshTs.slice(0, 10), fetchedAt: freshTs, rates: { CNY: 1 } })
    );

    let reconcileAttempts = 0;
    let crawlCalls = 0;
    handle = await startMonitorDaemon(
      {},
      {
        cwd: root,
        logger: silent,
        reconcileRetryMs: 25,
        runScript: async () => {
          crawlCalls += 1;
          return { stdout: "", stderr: "" };
        },
        reconcilePublished: async () => {
          reconcileAttempts += 1;
          if (reconcileAttempts === 1) throw new Error("transient publish lock contention");
          return { action: "repaired" };
        }
      }
    );

    assert.equal(reconcileAttempts, 1);
    assert.equal(handle.state.lastError, "transient publish lock contention");
    assert.equal(crawlCalls, 0);

    const deadline = Date.now() + 2000;
    while (handle.state.lastError !== null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.equal(reconcileAttempts, 2);
    assert.equal(handle.state.lastError, null);
    assert.equal(crawlCalls, 0);
  } finally {
    await handle?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("serve:static builds and serves Vue workbench, compiled modules, and existing inventory without starting collection", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts["serve:static"], /scripts\/serve-static\.mjs/);
  assert.doesNotMatch(pkg.scripts["serve:static"], /http\.server/);

  const parsed = parseStaticArgs(["--port", "4199", "--host", "127.0.0.1"], {});
  assert.equal(parsed.port, 4199);
  assert.equal(parsed.host, "127.0.0.1");

  const root = mkdtempSync(join(tmpdir(), "resnode-serve-static-"));
  const dataDir = join(root, "data");
  const sampleInventory = JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-11-25T10:00:00.000Z",
    products: [{ id: "static-preview-1", name: "Preview Plan", status: "available" }]
  });
  let preview;
  let cliProc;
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "products.json"), sampleInventory);
    writeFileSync(join(root, ".env"), "SECRET=do-not-expose");

    preview = await startStaticPreview(
      { host: "127.0.0.1", port: 0, rootDir: root },
      { logger: { log() {} } }
    );

    const htmlRes = await fetch(preview.url);
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.headers.get("content-type"), /text\/html/);
    const html = await htmlRes.text();
    assert.match(html, /<div id="app"[\s>]/);
    assert.doesNotMatch(html, /Directory listing for/);

    const jsMatch = html.match(/src="(\.?\/?static\/[^"]+\.js)"/);
    const cssMatch = html.match(/href="(\.?\/?static\/[^"]+\.css)"/);
    assert.ok(jsMatch, "Built workbench HTML must reference compiled JS module");
    assert.ok(cssMatch, "Built workbench HTML must reference compiled CSS bundle");

    const jsRes = await fetch(new URL(jsMatch[1], preview.url));
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get("content-type"), /text\/javascript/);
    assert.ok((await jsRes.text()).length > 100);

    const cssRes = await fetch(new URL(cssMatch[1], preview.url));
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.headers.get("content-type"), /text\/css/);

    const dataRes = await fetch(`${preview.url}data/products.json`);
    assert.equal(dataRes.status, 200);
    assert.equal(await dataRes.text(), sampleInventory);

    const reviewRes = await fetch(`${preview.url}reviews/aaitr.html`);
    assert.equal(reviewRes.status, 200);
    assert.match(await reviewRes.text(), /noindex/i);

    assert.equal((await fetch(`${preview.url}.env`)).status, 403);
    assert.equal(existsSync(join(dataDir, "daemon-status.json")), false, "serve:static must never start collection daemon");

    await preview.close();
    preview = null;

    // Also verify CLI entrypoint directly (`node scripts/serve-static.mjs --port 0 --root <root>`)
    const serveStaticScript = fileURLToPath(new URL("./serve-static.mjs", import.meta.url));
    cliProc = spawn(process.execPath, [serveStaticScript, "--port", "0", "--root", root], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const cliUrl = await new Promise((resolveUrl, rejectUrl) => {
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => rejectUrl(new Error(`serve-static CLI timeout: ${stderr}`)), 10_000);
      cliProc.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        const m = stdout.match(/http:\/\/127\.0\.0\.1:\d+\//);
        if (m) {
          clearTimeout(timeout);
          resolveUrl(m[0]);
        }
      });
      cliProc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      cliProc.once("exit", (code) => {
        clearTimeout(timeout);
        rejectUrl(new Error(`serve-static CLI exited early (${code}): ${stderr}`));
      });
    });

    const cliRes = await fetch(cliUrl);
    assert.equal(cliRes.status, 200);
    assert.match(await cliRes.text(), /<div id="app"[\s>]/);
    assert.equal(existsSync(join(dataDir, "daemon-status.json")), false);

    const exitCode = await new Promise((resolveExit) => {
      cliProc.once("exit", (code) => resolveExit(code));
      cliProc.kill("SIGTERM");
    });
    assert.equal(exitCode, 0);
    cliProc = null;
  } finally {
    await preview?.close();
    if (cliProc) cliProc.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
