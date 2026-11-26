import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";

const execFileAsync = promisify(execFile);
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildVps } from "./build-vps.mjs";
import { validateV2PublishedData } from "../apps/collector/src/validate.js";

const repoRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));

test("VPS assets use the production origin, stage immutable Vite chunks, and leave collection data outside the public build", () => {
  const output = mkdtempSync(join(tmpdir(), "resnode-vps-test-"));
  try {
    const first = buildVps(output);
    assert.match(first.revision, /^[a-f0-9]{16}$/);
    for (const file of ["index.html", "reviews/aaitr.html", "reviews/lisahost.html", "sitemap.xml", "robots.txt"]) {
      const body = readFileSync(join(output, file), "utf8");
      assert.match(body, /https:\/\/vpsld\.com\//, file);
      assert.doesNotMatch(body, /majiayu000\.github\.io|haorenjie1997\.workers\.dev/, file);
    }
    for (const file of [".git", ".env", "data", "scripts", "monitor", "deploy", "node_modules"]) {
      assert.equal(existsSync(join(output, file)), false, file);
      assert.equal(existsSync(join(output, "static", first.revision, file)), false, file);
    }
    for (const page of ["index.html", "reviews/aaitr.html", "reviews/lisahost.html"]) {
      const html = readFileSync(join(output, page), "utf8");
      const references = [...html.matchAll(/(?:src|href)="(\/static\/[^"?#]+)"/g)].map(
        (match) => match[1]
      );
      assert.ok(references.length >= 3, page);
      for (const reference of references) {
        assert.ok(existsSync(join(output, reference)), reference);
      }
    }
    const stagedStatic = join(output, "static", first.revision, "static");
    const jsBundles = readdirSync(stagedStatic).filter((n) => n.endsWith(".js"));
    assert.ok(jsBundles.length >= 2, "Vite JS chunks staged inside immutable revision directory");
    assert.ok(existsSync(join(output, "static", first.revision, "favicon.svg")));

    const second = buildVps(output, "https://radar.example/");
    assert.equal(second.revision, first.revision, "origin changes do not invalidate unchanged assets");
    assert.match(readFileSync(join(output, "index.html"), "utf8"), /https:\/\/radar\.example\//);
    assert.throws(() => buildVps(output, "http://radar.example/"), /HTTPS origin/);

    const nginxHttps = readFileSync(new URL("../deploy/vps/nginx-https.conf", import.meta.url), "utf8");
    assert.match(nginxHttps, /gzip_static on;/);
    assert.match(
      nginxHttps,
      /location = \/data\/products\.json\s*\{[^}]*gzip_static off;[^}]*\}/s,
      "Mutable /data/products.json must disable gzip_static so rollback never serves stale v2 .gz"
    );
    assert.match(nginxHttps, /location = \/api\/v1\/pulse\b/);
    assert.match(nginxHttps, /location = \/api\/v1\/stats\b/);
    assert.match(nginxHttps, /location = \/api\/stats\b/);
    assert.match(nginxHttps, /location = \/data\/v2\/latest\.json\b/);
    assert.match(nginxHttps, /location \^~ \/data\/snapshots\/\s*\{/);
    assert.match(nginxHttps, /proxy_pass http:\/\/127\.0\.0\.1:18920;/);
    const statsService = readFileSync(new URL("../deploy/vps/resnode-radar-stats.service", import.meta.url), "utf8");
    assert.match(statsService, /scripts\/visit-stats-server\.mjs/);
    assert.doesNotMatch(statsService, /STATS_BOOST/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("cutover.sh and rollback.sh replace real checkout data/ directory with shared symlink and honor MONITOR_DATA_DIR from any caller cwd", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "resnode-cutover-rb-"));
  try {
    const sharedData = join(sandbox, "var-lib/data");
    const sharedStatic = join(sandbox, "var-lib/static");
    const currentLink = join(sandbox, "opt/current");
    const v2Release = join(sandbox, "opt/releases/v2-new");
    const v1Release = join(sandbox, "opt/releases/v1-prev");
    const unrelatedCwd = join(sandbox, "caller-cwd");
    const mockBin = join(sandbox, "mock-bin");
    const opsLog = join(sandbox, "ops.log");

    mkdirSync(sharedData, { recursive: true });
    mkdirSync(sharedStatic, { recursive: true });
    mkdirSync(unrelatedCwd, { recursive: true });
    mkdirSync(mockBin, { recursive: true });
    chmodSync(unrelatedCwd, 0o555); // Read-only caller cwd proves scripts never write to caller cwd!

    // Mock systemctl and nginx
    const mockSystemctl = join(mockBin, "systemctl");
    writeFileSync(
      mockSystemctl,
      `#!/usr/bin/env bash\necho "systemctl $*" >> "${opsLog}"\n`,
      { mode: 0o755 }
    );
    const mockNginx = join(mockBin, "nginx");
    writeFileSync(
      mockNginx,
      `#!/usr/bin/env bash\necho "nginx $*" >> "${opsLog}"\n`,
      { mode: 0o755 }
    );
    // Mock sudo -u resnode-radar <cmd...> so default production RUN_AS_USER=resnode-radar branch is verified too!
    const mockSudo = join(mockBin, "sudo");
    writeFileSync(
      mockSudo,
      `#!/usr/bin/env bash\nif [[ "$1" == "-u" ]]; then shift 2; fi\nexec "$@"\n`,
      { mode: 0o755 }
    );

    const makeSamplePayload = (markerName, generatedAt) => ({
      schemaVersion: 1,
      generatedAt,
      publishedAt: generatedAt,
      sourceCount: 1,
      summary: { total: 1, available: 1, unavailable: 0, unknown: 0, blocked: 0, error: 0 },
      eventTracking: { startedAt: generatedAt, retentionDays: 7, limit: 300 },
      events: [],
      exchangeRates: {
        base: "CNY",
        date: "2026-11-25",
        source: "ECB",
        sourceUrl: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
        rates: { CNY: 1, USD: 7.2, EUR: 7.6 }
      },
      products: [
        {
          id: "cutover-test-1",
          sourceId: "src-1",
          provider: "DMIT",
          providerId: "dmit",
          category: "vps",
          adapter: "public_catalog",
          sourceUrl: "https://www.dmit.io/",
          fetchedAt: generatedAt,
          status: "available",
          statusLabel: "有货",
          stockCount: 3,
          price: "$36.90 / Year",
          priceValue: 36.9,
          currency: "USD",
          name: markerName,
          region: "Los Angeles",
          orderUrl: "https://www.dmit.io/cart.php?a=add&pid=1",
          evidence: "official",
          evidenceLevel: { value: "stock-count", label: "精确库存 3", className: "is-count", rank: 1 },
          riskTags: [{ value: "no-extra-risk", label: "未见额外风险", severity: "low" }]
        }
      ]
    });

    // Persistent shared data holds the live production snapshot
    writeFileSync(
      join(sharedData, "products.json"),
      `${JSON.stringify(makeSamplePayload("PERSISTENT-SHARED-LIVE-SKU", "2026-11-25T10:00:00.000Z"))}\n`
    );

    // Populate v2Release like a real git checkout (including a real non-symlink data/ directory!)
    for (const rel of ["package.json", "scripts", "apps", "packages", "deploy"]) {
      cpSync(join(repoRoot, rel), join(v2Release, rel), {
        recursive: true,
        filter: (src) => !src.includes("node_modules") && !src.includes("/dist")
      });
    }
    symlinkSync(join(repoRoot, "node_modules"), join(v2Release, "node_modules"));
    mkdirSync(join(v2Release, "data"), { recursive: true });
    writeFileSync(
      join(v2Release, "data/products.json"),
      `${JSON.stringify(makeSamplePayload("STALE-CHECKOUT-BUNDLE-SKU", "2026-11-20T00:00:00.000Z"))}\n`
    );
    writeFileSync(join(v2Release, "data/fx.json"), `{"base":"CNY","date":"2026-11-20","rates":{"USD":7.1}}\n`);
    buildVps(join(v2Release, "dist"));

    // Populate v1Release with real bc4488d v1 entrypoint (when git history present) or offline v1 entrypoint that ignores --v1-fallback and rewrites products.json if ever executed!
    mkdirSync(join(v1Release, "data"), { recursive: true });
    writeFileSync(join(v1Release, "data/products.json"), "{}\n");
    let populatedFromGit = false;
    try {
      execFileSync(
        "sh",
        [
          "-c",
          `git -C "${repoRoot}" archive bc4488d package.json providers.js pricing.js saved.js scripts | tar -x -C "${v1Release}"`
        ],
        { stdio: "pipe" }
      );
      symlinkSync(join(repoRoot, "node_modules"), join(v1Release, "node_modules"));
      populatedFromGit = existsSync(join(v1Release, "scripts/monitor.mjs"));
    } catch {
      populatedFromGit = false;
    }
    if (!populatedFromGit) {
      mkdirSync(join(v1Release, "scripts"), { recursive: true });
      writeFileSync(
        join(v1Release, "scripts/monitor.mjs"),
        `import { writeFileSync } from "node:fs";\nwriteFileSync("data/products.json", '{"corruptedByV1Crawl":true}\\n");\nprocess.exit(1);\n`
      );
    }
    const offlineSourcesPath = join(sandbox, "offline-sources.json");
    writeFileSync(
      offlineSourcesPath,
      JSON.stringify([
        {
          id: "offline-probe",
          provider: "Offline",
          category: "vps",
          adapter: "whmcs_group",
          url: "http://127.0.0.1:1/cart.php?gid=1"
        }
      ])
    );

    const baseEnv = {
      ...process.env,
      PATH: `${mockBin}:${process.env.PATH || "/usr/bin:/bin"}`,
      NODE_BIN: process.execPath,
      SHARED_DATA: sharedData,
      SHARED_STATIC: sharedStatic,
      CURRENT_LINK: currentLink,
      SYSTEMCTL_BIN: mockSystemctl,
      NGINX_BIN: mockNginx
    };

    // 1) Run cutover.sh from unrelated read-only cwd
    execFileSync("bash", [join(repoRoot, "deploy/vps/cutover.sh"), v2Release], {
      cwd: unrelatedCwd,
      env: baseEnv
    });

    const cutoverOps = readFileSync(opsLog, "utf8").trim().split("\n");
    assert.deepEqual(cutoverOps, [
      "nginx -t",
      "systemctl stop resnode-radar",
      "systemctl show -p ActiveState --value resnode-radar",
      "systemctl restart resnode-radar-stats",
      "systemctl start resnode-radar",
      "nginx -t",
      "systemctl reload nginx"
    ]);

    assert.equal(lstatSync(join(v2Release, "data")).isSymbolicLink(), true, "v2Release/data must be replaced with a symlink");
    assert.equal(realpathSync(join(v2Release, "data")), realpathSync(sharedData));
    assert.equal(existsSync(join(sharedData, "data")), false, "Must NEVER create nested sharedData/data symlink");
    assert.equal(existsSync(join(unrelatedCwd, "data")), false, "Must never write to caller cwd");
    assert.equal(realpathSync(currentLink), realpathSync(v2Release));

    const seededPointer = JSON.parse(readFileSync(join(sharedData, "v2/latest.json"), "utf8"));
    assert.equal(seededPointer.mode, "v2");
    assert.equal(seededPointer.generatedAt, "2026-11-25T10:00:00.000Z", "Must seed from persistent sharedData, not stale bundle");
    const seededSnap = JSON.parse(readFileSync(join(sharedData, seededPointer.snapshotPath.replace(/^data\//, "")), "utf8"));
    assert.equal(seededSnap.products[0].name, "PERSISTENT-SHARED-LIVE-SKU");

    // 2) Preflight failure in rollback.sh (missing shared data) MUST fail BEFORE stopping resnode-radar
    writeFileSync(opsLog, "");
    assert.throws(() => {
      execFileSync("bash", [join(repoRoot, "deploy/vps/rollback.sh"), v1Release], {
        cwd: unrelatedCwd,
        env: { ...baseEnv, SHARED_DATA: join(sandbox, "nonexistent-shared-data") },
        stdio: "pipe"
      });
    });
    assert.equal(readFileSync(opsLog, "utf8"), "", "Failed preflight must not stop resnode-radar");

    // 3) Simulate rollback failing AFTER switching `current` to v1Release (e.g. reload nginx fails once),
    //    then retry v2Release/deploy/vps/rollback.sh -> MUST NOT invoke v1Release/scripts/monitor.mjs or touch products.json!
    const productsBeforeRollback = readFileSync(join(sharedData, "products.json"), "utf8");
    const reloadFailOnceSystemctl = join(mockBin, "systemctl-fail-reload-once");
    const reloadFailMarker = join(sandbox, "reload-failed-once");
    writeFileSync(
      reloadFailOnceSystemctl,
      `#!/usr/bin/env bash\necho "systemctl $*" >> "${opsLog}"\nif [[ "$1" == "reload" && "$2" == "nginx" && ! -f "${reloadFailMarker}" ]]; then\n  touch "${reloadFailMarker}"\n  exit 1\nfi\n`,
      { mode: 0o755 }
    );

    assert.throws(() => {
      execFileSync("bash", [join(v2Release, "deploy/vps/rollback.sh"), v1Release], {
        cwd: unrelatedCwd,
        env: {
          ...baseEnv,
          SYSTEMCTL_BIN: reloadFailOnceSystemctl,
          MONITOR_SOURCES: offlineSourcesPath
        },
        stdio: "pipe"
      });
    });
    // First attempt already switched `current` to v1Release before reload failed!
    assert.equal(realpathSync(currentLink), realpathSync(v1Release));
    assert.equal(readFileSync(join(sharedData, "products.json"), "utf8"), productsBeforeRollback);

    // Retry from v2Release/deploy/vps/rollback.sh while `current` ALREADY points to v1Release (with real v1 scripts/monitor.mjs!)
    writeFileSync(opsLog, "");
    execFileSync("bash", [join(v2Release, "deploy/vps/rollback.sh"), v1Release], {
      cwd: unrelatedCwd,
      env: {
        ...baseEnv,
        SYSTEMCTL_BIN: reloadFailOnceSystemctl,
        MONITOR_SOURCES: offlineSourcesPath
      }
    });
    assert.equal(
      readFileSync(join(sharedData, "products.json"), "utf8"),
      productsBeforeRollback,
      "Retried rollback must NEVER invoke v1 monitor.mjs or rewrite products.json"
    );

    const rbPointer = JSON.parse(readFileSync(join(sharedData, "v2/latest.json"), "utf8"));
    assert.equal(rbPointer.mode, "v1-fallback");
    assert.equal(realpathSync(currentLink), realpathSync(v1Release));
    assert.equal(lstatSync(join(v1Release, "data")).isSymbolicLink(), true);
    assert.equal(realpathSync(join(v1Release, "data")), realpathSync(sharedData));

    const ops = readFileSync(opsLog, "utf8").trim().split("\n");
    assert.deepEqual(ops, [
      "nginx -t",
      "systemctl stop resnode-radar",
      "systemctl restart resnode-radar-stats",
      "systemctl start resnode-radar",
      "nginx -t",
      "systemctl reload nginx"
    ]);

    // 4) Failing `nginx -t` in BOTH cutover.sh and rollback.sh MUST exit non-zero BEFORE touching current/services and NEVER echo completion!
    const failingNginx = join(mockBin, "nginx-fail");
    writeFileSync(
      failingNginx,
      `#!/usr/bin/env bash\necho "nginx: configuration file test failed" >&2\nexit 1\n`,
      { mode: 0o755 }
    );
    writeFileSync(opsLog, "");

    let cutoverErr = null;
    try {
      execFileSync("bash", [join(repoRoot, "deploy/vps/cutover.sh"), v2Release], {
        cwd: unrelatedCwd,
        env: { ...baseEnv, NGINX_BIN: failingNginx },
        stdio: "pipe"
      });
    } catch (err) {
      cutoverErr = err;
    }
    assert.ok(cutoverErr && cutoverErr.status !== 0, "cutover.sh must fail non-zero when nginx -t fails");
    assert.doesNotMatch(String(cutoverErr.stdout || ""), /Cutover complete/);
    assert.equal(realpathSync(currentLink), realpathSync(v1Release), "Failed nginx -t in cutover must not switch current");
    assert.equal(readFileSync(opsLog, "utf8"), "", "Failed nginx -t preflight must not restart services");

    let rollbackErr = null;
    try {
      execFileSync("bash", [join(repoRoot, "deploy/vps/rollback.sh"), v2Release], {
        cwd: unrelatedCwd,
        env: { ...baseEnv, NGINX_BIN: failingNginx },
        stdio: "pipe"
      });
    } catch (err) {
      rollbackErr = err;
    }
    assert.ok(rollbackErr && rollbackErr.status !== 0, "rollback.sh must fail non-zero when nginx -t fails");
    assert.doesNotMatch(String(rollbackErr.stdout || ""), /Rollback complete/);
    assert.equal(realpathSync(currentLink), realpathSync(v1Release), "Failed nginx -t in rollback must not switch current");
    assert.equal(readFileSync(opsLog, "utf8"), "", "Failed nginx -t preflight must not stop resnode-radar");
  } finally {
    try {
      chmodSync(join(sandbox, "caller-cwd"), 0o755);
    } catch {
      // ignore
    }
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("cutover.sh stops active legacy collector and child processes before v2 seed, preserves v1/v2 parity, and recovers service on failure", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "resnode-cutover-race-"));
  let legacyPid = null;
  try {
    const sharedData = join(sandbox, "var-lib/data");
    const sharedStatic = join(sandbox, "var-lib/static");
    const currentLink = join(sandbox, "opt/current");
    const v1Release = join(sandbox, "opt/releases/v1-prev");
    const v2Release = join(sandbox, "opt/releases/v2-new");
    const mockBin = join(sandbox, "mock-bin");
    const opsLog = join(sandbox, "ops.log");
    const readyFile = join(sandbox, "legacy.ready");
    const pidFile = join(sandbox, "legacy.pids");

    mkdirSync(sharedData, { recursive: true });
    mkdirSync(sharedStatic, { recursive: true });
    mkdirSync(join(sandbox, "opt"), { recursive: true });
    mkdirSync(v1Release, { recursive: true });
    mkdirSync(mockBin, { recursive: true });

    for (const rel of ["package.json", "scripts", "apps", "packages", "deploy"]) {
      cpSync(join(repoRoot, rel), join(v2Release, rel), {
        recursive: true,
        filter: (src) => !src.includes("node_modules") && !src.includes("/dist")
      });
    }
    symlinkSync(join(repoRoot, "node_modules"), join(v2Release, "node_modules"));
    buildVps(join(v2Release, "dist"));
    symlinkSync(v1Release, currentLink);

    const makePayload = (names, generatedAt) => ({
      schemaVersion: 1,
      generatedAt,
      publishedAt: generatedAt,
      sourceCount: 1,
      summary: { total: names.length, available: names.length, unavailable: 0, unknown: 0, blocked: 0, error: 0 },
      eventTracking: { startedAt: generatedAt, retentionDays: 7, limit: 300 },
      events: [],
      exchangeRates: {
        base: "CNY",
        date: "2026-11-25",
        source: "ECB",
        sourceUrl: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
        rates: { CNY: 1, USD: 7.2, EUR: 7.6 }
      },
      products: names.map((name, idx) => ({
        id: `race-sku-${idx + 1}`,
        sourceId: "src-1",
        provider: "DMIT",
        providerId: "dmit",
        category: "vps",
        adapter: "public_catalog",
        sourceUrl: "https://www.dmit.io/",
        fetchedAt: generatedAt,
        status: "available",
        statusLabel: "有货",
        stockCount: 3,
        price: "$36.90 / Year",
        priceValue: 36.9,
        currency: "USD",
        name,
        region: "Los Angeles",
        orderUrl: `https://www.dmit.io/cart.php?a=add&pid=${idx + 1}`,
        evidence: "official",
        evidenceLevel: { value: "stock-count", label: "精确库存 3", className: "is-count", rank: 1 },
        riskTags: [{ value: "no-extra-risk", label: "未见额外风险", severity: "low" }]
      }))
    });

    const initialPayload = makePayload(["INITIAL-LEGACY-SKU"], "2026-11-25T10:00:00.000Z");
    const midflightFinalPayload = makePayload(
      ["INITIAL-LEGACY-SKU", "LEGACY-MIDFLIGHT-FINAL-COMMIT"],
      "2026-11-25T10:15:00.000Z"
    );
    const rogueOverwritePayload = makePayload(
      ["ROGUE-POST-SEED-OVERWRITE"],
      "2026-11-25T10:16:00.000Z"
    );

    writeFileSync(join(sharedData, "products.json"), `${JSON.stringify(initialPayload)}\n`);

    const legacyScript = join(sandbox, "legacy-collector.mjs");
    writeFileSync(
      legacyScript,
      `
import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sharedData = ${JSON.stringify(sharedData)};
const pidFile = ${JSON.stringify(pidFile)};
const readyFile = ${JSON.stringify(readyFile)};
const finalPayload = ${JSON.stringify(midflightFinalPayload)};
const roguePayload = ${JSON.stringify(rogueOverwritePayload)};

if (process.argv[2] === "--child") {
  // Unlocked child writer simulating an active legacy scraper process inside the unit control-group
  setInterval(() => {
    const tmp = join(sharedData, "products.json.rogue.tmp");
    writeFileSync(tmp, JSON.stringify(roguePayload) + "\\n");
    renameSync(tmp, join(sharedData, "products.json"));
  }, 60);
  process.on("SIGTERM", () => process.exit(0));
} else {
  const child = spawn(process.execPath, [import.meta.filename, "--child"], { stdio: "ignore" });
  const childExited = new Promise((resolveExit) => child.once("exit", resolveExit));
  writeFileSync(pidFile, JSON.stringify({ parentPid: process.pid, childPid: child.pid }));
  writeFileSync(readyFile, "ready");
  // Simulate slow unlocked graceful flush of an in-flight batch on SIGTERM
  let stopping = false;
  process.on("SIGTERM", async () => {
    if (stopping) return;
    stopping = true;
    child.kill("SIGTERM");
    await Promise.all([
      childExited,
      new Promise((r) => setTimeout(r, 120))
    ]);
    const tmp = join(sharedData, "products.json.legacy.tmp");
    writeFileSync(tmp, JSON.stringify(finalPayload) + "\\n");
    renameSync(tmp, join(sharedData, "products.json"));
    process.exit(0);
  });
  setInterval(() => {}, 1000);
}
`
    );

    const legacyProc = spawn(process.execPath, [legacyScript], {
      detached: true,
      stdio: "ignore"
    });
    legacyPid = legacyProc.pid;
    legacyProc.unref();

    const deadline = Date.now() + 5000;
    while (!existsSync(readyFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(existsSync(readyFile), true, "Legacy collector process group must be ready before cutover");
    const pids = JSON.parse(readFileSync(pidFile, "utf8"));

    // Stateful systemctl stub mimicking KillMode=control-group: signals -$pgid and reports deactivating until both parent and child exit
    const mockSystemctl = join(mockBin, "systemctl");
    writeFileSync(
      mockSystemctl,
      `#!/usr/bin/env bash
set -euo pipefail
echo "systemctl $*" >> "${opsLog}"
case "$1" in
  stop)
    if [[ -f "${pidFile}" ]]; then
      kill -TERM -- "-${pids.parentPid}" 2>/dev/null || true
    fi
    ;;
  show)
    if kill -0 "${pids.parentPid}" 2>/dev/null || kill -0 "${pids.childPid}" 2>/dev/null; then
      echo "deactivating"
    else
      echo "inactive"
    fi
    ;;
esac
`,
      { mode: 0o755 }
    );
    const mockNginx = join(mockBin, "nginx");
    writeFileSync(mockNginx, `#!/usr/bin/env bash\necho "nginx $*" >> "${opsLog}"\n`, { mode: 0o755 });
    const mockSudo = join(mockBin, "sudo");
    writeFileSync(mockSudo, `#!/usr/bin/env bash\nif [[ "$1" == "-u" ]]; then shift 2; fi\nexec "$@"\n`, { mode: 0o755 });

    const env = {
      ...process.env,
      PATH: `${mockBin}:${process.env.PATH || "/usr/bin:/bin"}`,
      NODE_BIN: process.execPath,
      SHARED_DATA: sharedData,
      SHARED_STATIC: sharedStatic,
      CURRENT_LINK: currentLink,
      SYSTEMCTL_BIN: mockSystemctl,
      NGINX_BIN: mockNginx
    };

    await execFileAsync("bash", [join(repoRoot, "deploy/vps/cutover.sh"), v2Release], {
      cwd: sandbox,
      env
    });

    // Wait past legacy intervals to prove neither parent nor child survives past stop to corrupt products.json
    await new Promise((r) => setTimeout(r, 200));
    for (const deadPid of [pids.parentPid, pids.childPid]) {
      assert.throws(() => process.kill(deadPid, 0), { code: "ESRCH" });
    }

    const finalV1Bytes = readFileSync(join(sharedData, "products.json"));
    const finalV1 = JSON.parse(finalV1Bytes.toString("utf8"));
    const finalPointer = JSON.parse(readFileSync(join(sharedData, "v2/latest.json"), "utf8"));
    assert.equal(finalV1.products.length, 2);
    assert.equal(finalV1.products[1].name, "LEGACY-MIDFLIGHT-FINAL-COMMIT");
    assert.equal(
      finalPointer.v1Sha256,
      createHash("sha256").update(finalV1Bytes).digest("hex"),
      "Seeded v2 pointer must match the post-stop settled v1 products.json"
    );
    assert.deepEqual(
      validateV2PublishedData({ dataDir: sharedData, fullPayload: finalV1, v1Bytes: finalV1Bytes }),
      []
    );

    const ops = readFileSync(opsLog, "utf8").trim().split("\n");
    const stopIdx = ops.indexOf("systemctl stop resnode-radar");
    const showIdx = ops.indexOf("systemctl show -p ActiveState --value resnode-radar");
    const startIdx = ops.indexOf("systemctl start resnode-radar");
    assert.ok(stopIdx >= 0 && showIdx > stopIdx && startIdx > showIdx, `Unexpected ops sequence: ${ops.join(", ")}`);

    // Failure recovery: if --seed-v2-from-v1 fails after stopping collector, cutover keeps old `current` link and restarts `resnode-radar`
    execFileSync("ln", ["-sfn", v1Release, currentLink]);
    assert.equal(realpathSync(currentLink), realpathSync(v1Release));
    writeFileSync(opsLog, "");
    writeFileSync(join(sharedData, "products.json"), "{corrupt-json\n");

    let failErr = null;
    try {
      await execFileAsync("bash", [join(repoRoot, "deploy/vps/cutover.sh"), v2Release], {
        cwd: sandbox,
        env
      });
    } catch (err) {
      failErr = err;
    }
    assert.ok(failErr && failErr.status !== 0, "Corrupt baseline seed must fail cutover cleanly");
    assert.doesNotMatch(String(failErr.stdout || ""), /Cutover complete/);
    assert.equal(realpathSync(currentLink), realpathSync(v1Release), "Failed seed must NOT switch current symlink");
    const recoveryOps = readFileSync(opsLog, "utf8").trim().split("\n");
    assert.ok(
      recoveryOps.includes("systemctl stop resnode-radar") &&
        recoveryOps.at(-1) === "systemctl start resnode-radar",
      `Expected automatic start recovery after failed seed, got: ${recoveryOps.join(", ")}`
    );
  } finally {
    if (legacyPid) {
      try {
        process.kill(-legacyPid, "SIGKILL");
      } catch {
        // already exited
      }
    }
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("v2 cutover -> rollback -> legacy v1 continuous updates serve fresh batches for both gzip and identity requests", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "resnode-rollback-gz-"));
  let httpServer = null;
  try {
    const sharedData = join(sandbox, "var-lib/data");
    const sharedStatic = join(sandbox, "var-lib/static");
    const currentLink = join(sandbox, "opt/current");
    const v1Release = join(sandbox, "opt/releases/v1-prev");
    const v2Release = join(sandbox, "opt/releases/v2-new");
    const mockBin = join(sandbox, "mock-bin");

    mkdirSync(sharedData, { recursive: true });
    mkdirSync(sharedStatic, { recursive: true });
    mkdirSync(join(sandbox, "opt"), { recursive: true });
    mkdirSync(v1Release, { recursive: true });
    mkdirSync(mockBin, { recursive: true });

    for (const rel of ["package.json", "scripts", "apps", "packages", "deploy"]) {
      cpSync(join(repoRoot, rel), join(v2Release, rel), {
        recursive: true,
        filter: (src) => !src.includes("node_modules") && !src.includes("/dist")
      });
    }
    symlinkSync(join(repoRoot, "node_modules"), join(v2Release, "node_modules"));
    buildVps(join(v2Release, "dist"));
    symlinkSync(v1Release, currentLink);

    const makeBatch = (markerName, generatedAt) => ({
      schemaVersion: 1,
      generatedAt,
      publishedAt: generatedAt,
      sourceCount: 1,
      summary: { total: 1, available: 1, unavailable: 0, unknown: 0, blocked: 0, error: 0 },
      eventTracking: { startedAt: generatedAt, retentionDays: 7, limit: 300 },
      events: [],
      exchangeRates: {
        base: "CNY",
        date: "2026-11-25",
        source: "ECB",
        sourceUrl: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
        rates: { CNY: 1, USD: 7.2, EUR: 7.6 }
      },
      products: [
        {
          id: "rb-gz-sku-1",
          sourceId: "src-1",
          provider: "DMIT",
          providerId: "dmit",
          category: "vps",
          adapter: "public_catalog",
          sourceUrl: "https://www.dmit.io/",
          fetchedAt: generatedAt,
          status: "available",
          statusLabel: "有货",
          stockCount: 5,
          price: "$36.90 / Year",
          priceValue: 36.9,
          currency: "USD",
          name: markerName,
          region: "Los Angeles",
          orderUrl: "https://www.dmit.io/cart.php?a=add&pid=1",
          evidence: "official",
          evidenceLevel: { value: "stock-count", label: "精确库存 5", className: "is-count", rank: 1 },
          riskTags: [{ value: "no-extra-risk", label: "未见额外风险", severity: "low" }]
        }
      ]
    });

    const mockSystemctl = join(mockBin, "systemctl");
    writeFileSync(mockSystemctl, `#!/usr/bin/env bash\nexit 0\n`, { mode: 0o755 });
    const mockNginx = join(mockBin, "nginx");
    writeFileSync(mockNginx, `#!/usr/bin/env bash\nexit 0\n`, { mode: 0o755 });
    const mockSudo = join(mockBin, "sudo");
    writeFileSync(mockSudo, `#!/usr/bin/env bash\nif [[ "$1" == "-u" ]]; then shift 2; fi\nexec "$@"\n`, { mode: 0o755 });

    const env = {
      ...process.env,
      PATH: `${mockBin}:${process.env.PATH || "/usr/bin:/bin"}`,
      NODE_BIN: process.execPath,
      SHARED_DATA: sharedData,
      SHARED_STATIC: sharedStatic,
      CURRENT_LINK: currentLink,
      SYSTEMCTL_BIN: mockSystemctl,
      NGINX_BIN: mockNginx
    };

    // HTTP server faithfully mirroring Nginx `gzip_static on; gzip on;` behavior for /data/products.json
    httpServer = createServer((req, res) => {
      if (req.url !== "/data/products.json") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const jsonPath = join(sharedData, "products.json");
      const gzPath = `${jsonPath}.gz`;
      const acceptsGzip = /\bgzip\b/i.test(String(req.headers["accept-encoding"] || ""));
      if (acceptsGzip) {
        const payload = existsSync(gzPath) ? readFileSync(gzPath) : gzipSync(readFileSync(jsonPath));
        res.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "x-gz-source": existsSync(gzPath) ? "static" : "dynamic"
        });
        res.end(payload);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(readFileSync(jsonPath));
    });
    await new Promise((resolveListen) => httpServer.listen(0, "127.0.0.1", resolveListen));
    const { port } = httpServer.address();

    const fetchProducts = (acceptEncoding) =>
      new Promise((resolveReq, rejectReq) => {
        const req = httpRequest(
          {
            hostname: "127.0.0.1",
            port,
            path: "/data/products.json",
            headers: { "accept-encoding": acceptEncoding }
          },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              const raw = Buffer.concat(chunks);
              const decoded =
                res.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw;
              resolveReq({
                status: res.statusCode,
                gzSource: res.headers["x-gz-source"] || null,
                json: JSON.parse(decoded.toString("utf8"))
              });
            });
          }
        );
        req.on("error", rejectReq);
        req.end();
      });

    // 1) Initial v2 cutover seeds products.json.gz alongside v2 snapshot
    writeFileSync(
      join(sharedData, "products.json"),
      `${JSON.stringify(makeBatch("V2-CUTOVER-BATCH-1", "2026-11-25T10:00:00.000Z"))}\n`
    );
    await execFileAsync("bash", [join(v2Release, "deploy/vps/cutover.sh"), v2Release], {
      cwd: sandbox,
      env
    });
    assert.equal(existsSync(join(sharedData, "products.json.gz")), true);
    const v2Gzip = await fetchProducts("gzip");
    const v2Identity = await fetchProducts("identity");
    assert.equal(v2Gzip.gzSource, "static");
    assert.equal(v2Gzip.json.products[0].name, "V2-CUTOVER-BATCH-1");
    assert.equal(v2Identity.json.products[0].name, "V2-CUTOVER-BATCH-1");

    // 2) Rollback to v1 must invalidate products.json.gz before legacy collector resumes
    await execFileAsync("bash", [join(v2Release, "deploy/vps/rollback.sh"), v1Release], {
      cwd: sandbox,
      env
    });
    assert.equal(existsSync(join(sharedData, "products.json.gz")), false);

    // 3) Legacy v1 collector continuously updates ONLY products.json (never .gz) -> both gzip & identity see every new batch!
    for (const [name, ts] of [
      ["V1-LEGACY-UPDATE-BATCH-2", "2026-11-25T10:20:00.000Z"],
      ["V1-LEGACY-UPDATE-BATCH-3", "2026-11-25T10:40:00.000Z"]
    ]) {
      const tmp = join(sharedData, "products.json.v1.tmp");
      writeFileSync(tmp, `${JSON.stringify(makeBatch(name, ts))}\n`);
      execFileSync("mv", ["-f", tmp, join(sharedData, "products.json")]);

      const gzRes = await fetchProducts("gzip");
      const idRes = await fetchProducts("identity");
      assert.equal(gzRes.gzSource, "dynamic");
      assert.equal(gzRes.json.products[0].name, name, `gzip request must return fresh ${name}`);
      assert.equal(idRes.json.products[0].name, name, `identity request must return fresh ${name}`);
    }
  } finally {
    if (httpServer) await new Promise((r) => httpServer.close(r));
    rmSync(sandbox, { recursive: true, force: true });
  }
});
