import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRadarApiHandler, StatsWorkerClient } from "@resnode-radar/server";
import { validateMonitorPayload } from "./validate.js";
import { reconcilePublishedState } from "./publisher/index.js";
import { publishSnapshot } from "../../../scripts/publish-snapshot.mjs";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

const STATIC_ALLOW_PREFIXES = [
  "index.html",
  "static",
  "styles",
  "src",
  "providers.js",
  "pricing.js",
  "saved.js",
  "favicon.svg",
  "assets",
  "reviews",
  "LICENSE",
  "data/products.json",
  "data/fx.json",
  "data/daemon-status.json",
  "data/v2/latest.json",
  "data/snapshots",
  "sitemap.xml",
  "robots.txt"
];

export function parseDaemonArgs(argv = process.argv.slice(2), env = process.env) {
  const args = {
    intervalMinutes: Number(env.MONITOR_INTERVAL_MINUTES ?? 20),
    serve: env.MONITOR_SERVE === "1",
    host: env.HOST || "127.0.0.1",
    port: Number(env.PORT ?? 4173),
    gitPush: env.MONITOR_GIT_PUSH === "1",
    dataBranch: env.DATA_BRANCH || "data",
    once: false,
    forceInitial: false,
    childTimeoutMs: Number(env.MONITOR_TIMEOUT_MS ?? 12 * 60 * 1000)
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--serve") args.serve = true;
    else if (token === "--git-push") args.gitPush = true;
    else if (token === "--once") args.once = true;
    else if (token === "--force-initial") args.forceInitial = true;
    else if (token === "--interval" && argv[i + 1]) args.intervalMinutes = Number(argv[++i]);
    else if (token === "--port" && argv[i + 1]) args.port = Number(argv[++i]);
    else if (token === "--host" && argv[i + 1]) args.host = argv[++i];
  }

  if (!Number.isFinite(args.intervalMinutes) || args.intervalMinutes < 1) args.intervalMinutes = 20;
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65_535) args.port = 4173;
  if (!Number.isFinite(args.childTimeoutMs) || args.childTimeoutMs <= 0) {
    args.childTimeoutMs = 12 * 60 * 1000;
  }
  return args;
}

export function writeAtomicJson(filePath, data) {
  mkdirSync(resolve(filePath, ".."), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmpPath, filePath);
}

function readSnapshotMeta(cwd) {
  try {
    const raw = JSON.parse(readFileSync(join(cwd, "data/products.json"), "utf8"));
    return {
      generatedAt: raw.generatedAt || null,
      ageMs:
        Number.isFinite(Date.parse(raw.generatedAt)) && Date.parse(raw.generatedAt) <= Date.now()
          ? Date.now() - Date.parse(raw.generatedAt)
          : Infinity,
      summary: raw.summary || null
    };
  } catch {
    return { generatedAt: null, ageMs: Infinity, summary: null };
  }
}

function fxNeedsRefresh(cwd, maxAgeMs = 12 * 60 * 60 * 1000) {
  try {
    const fx = JSON.parse(readFileSync(join(cwd, "data/fx.json"), "utf8"));
    const fetchedMs = Date.parse(fx.fetchedAt || `${fx.date}T00:00:00Z`);
    if (!Number.isFinite(fetchedMs)) return true;
    return fetchedMs > Date.now() || Date.now() - fetchedMs > maxAgeMs;
  } catch {
    return true;
  }
}

function safeWalkNoSymlink(baseRoot, parts) {
  let targetPath = baseRoot;
  for (const part of parts) {
    targetPath = join(targetPath, part);
    if (lstatSync(targetPath).isSymbolicLink()) {
      const err = new Error("Symlink forbidden");
      err.code = "EACCES";
      throw err;
    }
  }
  if (lstatSync(targetPath).isDirectory()) {
    targetPath = join(targetPath, "index.html");
  }
  const stat = lstatSync(targetPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    const err = new Error("Not a regular file");
    err.code = "EACCES";
    throw err;
  }
  return targetPath;
}

export function createStaticServer(rootDir = projectRoot, options = {}) {
  const safeRoot = realpathSync(rootDir);
  const statsClient = new StatsWorkerClient({
    dbPath: options.statsDbPath ?? join(safeRoot, "data/visits.sqlite")
  });
  const apiHandler = createRadarApiHandler(statsClient, {
    latestJsonPath: join(safeRoot, "data/v2/latest.json")
  });

  const server = createServer((req, res) => {
    let rawUrlPath = "/";
    try {
      rawUrlPath = new URL(req.url || "/", "http://127.0.0.1").pathname;
    } catch {
      res.writeHead(400);
      res.end("Bad request");
      return;
    }

    if (
      rawUrlPath === "/api/stats" ||
      rawUrlPath === "/api/v1/stats" ||
      rawUrlPath === "/api/v1/pulse"
    ) {
      void apiHandler(req, res);
      return;
    }

    if (!["GET", "HEAD"].includes(req.method || "")) {
      res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
      res.end("Method not allowed");
      return;
    }

    let pathname = "/";
    try {
      pathname = decodeURIComponent(rawUrlPath);
      if (/[\x00-\x1f\\]/.test(pathname)) throw new Error("Invalid path");
    } catch {
      res.writeHead(400);
      res.end("Bad request");
      return;
    }

    if (pathname.endsWith("/")) pathname += "index.html";
    const parts = pathname.split("/").filter(Boolean);
    const rel = parts.join("/");
    if (
      parts.some((part) => part.startsWith(".") || part.includes(".quarantine")) ||
      /\.(?:sqlite|sqlite-wal|sqlite-shm|lock)$/i.test(rel) ||
      !STATIC_ALLOW_PREFIXES.some((path) => rel === path || rel.startsWith(`${path}/`))
    ) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    try {
      // Prefer built `dist/` for browser UI assets when available, while `data/*` always reads from `safeRoot/data/*`
      const distRoot = join(safeRoot, "dist");
      const useDist =
        !rel.startsWith("data/") &&
        existsSync(join(distRoot, "index.html")) &&
        !lstatSync(distRoot).isSymbolicLink();

      let targetPath;
      if (useDist) {
        try {
          targetPath = safeWalkNoSymlink(distRoot, parts);
        } catch (distErr) {
          if (["ENOENT", "ENOTDIR"].includes(distErr.code)) {
            targetPath = safeWalkNoSymlink(safeRoot, parts);
          } else {
            throw distErr;
          }
        }
      } else {
        targetPath = safeWalkNoSymlink(safeRoot, parts);
      }

      const body = req.method === "HEAD" ? null : readFileSync(targetPath);
      const cacheControl = rel.startsWith("data/snapshots/")
        ? "public, max-age=3600, immutable"
        : rel.startsWith("data/")
          ? "no-store"
          : rel.startsWith("static/")
            ? "public, max-age=31536000, immutable"
            : "no-cache";
      res.writeHead(200, {
        "content-type": MIME_TYPES[extname(targetPath).toLowerCase()] || "application/octet-stream",
        "cache-control": cacheControl,
        "x-content-type-options": "nosniff"
      });
      res.end(body);
    } catch (error) {
      const status = ["ENOENT", "ENOTDIR"].includes(error.code)
        ? 404
        : error.code === "EACCES"
          ? 403
          : 500;
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        status === 404 ? "Not found" : status === 403 ? "Forbidden" : "Asset read failed"
      );
    }
  });

  const origClose = server.close.bind(server);
  server.close = (cb) => {
    server.closeIdleConnections?.();
    return origClose(cb);
  };
  server.on("close", () => {
    void statsClient.close();
  });
  return server;
}

function runNodeScript(scriptPath, cwd, timeoutMs, onChild) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    onChild?.(child);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        rejectPromise(
          new Error(`Script ${scriptPath} timed out after ${Math.round(timeoutMs / 1000)}s`)
        );
      } else if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        rejectPromise(
          new Error(
            `Script ${scriptPath} exited with code ${code}: ${(stderr || stdout).trim().slice(0, 240)}`
          )
        );
      }
    });
  });
}

export async function startMonitorDaemon(
  rawOptions = {},
  {
    cwd = projectRoot,
    logger = console,
    runScript = runNodeScript,
    reconcilePublished = reconcilePublishedState,
    reconcileRetryMs = 30_000
  } = {}
) {
  const options = { ...parseDaemonArgs([]), ...rawOptions };
  const statusPath = join(cwd, "data/daemon-status.json");
  const intervalMs = Math.round(options.intervalMinutes * 60 * 1000);
  const safeReconcileRetryMs =
    Number.isFinite(reconcileRetryMs) && reconcileRetryMs > 0 ? reconcileRetryMs : 30_000;

  let stopped = false;
  let activeChild = null;
  let timer = null;
  let reconcileTimer = null;
  let activeReconcile = null;
  let server = null;
  let activeCycle = null;
  let stopPromise = null;
  let startupReconcileError = null;

  async function reconcileBaselineIfPresent() {
    if (!existsSync(join(cwd, "data/products.json"))) return null;
    return reconcilePublished({
      dataDir: join(cwd, "data"),
      v1OutputPath: join(cwd, "data/products.json"),
      logger
    });
  }

  // Always reconcile incomplete v1_committed -> latest.json transitions before checking
  // snapshot freshness, so a restart after a partial publish heals v2 immediately instead
  // of waiting up to a full 20-minute interval when v1/fx appear fresh.
  try {
    await reconcileBaselineIfPresent();
  } catch (error) {
    startupReconcileError = error instanceof Error ? error.message : String(error);
    logger.error?.(`[daemon] Startup publish reconciliation failed: ${startupReconcileError}`);
  }

  const initialMeta = readSnapshotMeta(cwd);
  const state = {
    active: true,
    pid: process.pid,
    mode: options.serve ? "live-server+daemon" : "headless-daemon",
    state: "idle",
    intervalMinutes: options.intervalMinutes,
    startedAt: new Date().toISOString(),
    lastRunStartedAt: null,
    lastSuccessAt: initialMeta.generatedAt,
    lastDurationMs: null,
    lastError: startupReconcileError,
    nextRunAt: null,
    runCount: 0,
    successCount: 0,
    consecutiveFailures: 0,
    summary: initialMeta.summary
  };

  function persistStatus(patch = {}) {
    Object.assign(state, patch, { updatedAt: new Date().toISOString() });
    writeAtomicJson(statusPath, state);
  }

  function executeCycle() {
    if (stopped) return Promise.resolve();
    if (activeCycle) return activeCycle;
    if (timer) clearTimeout(timer);
    if (reconcileTimer) {
      clearTimeout(reconcileTimer);
      reconcileTimer = null;
    }
    activeCycle = runCycle().finally(() => {
      activeCycle = null;
    });
    return activeCycle;
  }

  async function runCycle() {
    if (stopped || state.state === "running") return;
    const startedMs = Date.now();
    let nextDelayMs = intervalMs;
    persistStatus({
      state: "running",
      lastRunStartedAt: new Date(startedMs).toISOString(),
      runCount: state.runCount + 1
    });
    logger.log(
      `[daemon] Starting collection cycle #${state.runCount} at ${state.lastRunStartedAt}...`
    );

    try {
      await reconcileBaselineIfPresent();
      if (stopped) return;

      if (fxNeedsRefresh(cwd)) {
        logger.log("[daemon] Refreshing ECB reference FX snapshot...");
        await runScript(join(projectRoot, "scripts/fx-rates.mjs"), cwd, 30_000, (c) => {
          activeChild = c;
        });
      }
      if (stopped) return;
      await runScript(
        join(projectRoot, "scripts/monitor.mjs"),
        cwd,
        options.childTimeoutMs,
        (c) => {
          activeChild = c;
        }
      );
      activeChild = null;
      if (stopped) return;

      const payload = JSON.parse(readFileSync(join(cwd, "data/products.json"), "utf8"));
      const validationErrors = validateMonitorPayload(payload);
      if (validationErrors.length > 0) {
        throw new Error(`Validation failed: ${validationErrors[0]}`);
      }

      if (options.gitPush) {
        await publishSnapshot(cwd, { branch: options.dataBranch, logger });
        if (stopped) return;
      }

      const durationMs = Date.now() - startedMs;
      nextDelayMs = Math.max(10_000, startedMs + intervalMs - Date.now());
      const nextMs = Date.now() + nextDelayMs;
      persistStatus({
        state: "idle",
        lastSuccessAt: payload.generatedAt || new Date().toISOString(),
        lastDurationMs: durationMs,
        lastError: null,
        consecutiveFailures: 0,
        successCount: state.successCount + 1,
        summary: payload.summary,
        nextRunAt: options.once ? null : new Date(nextMs).toISOString()
      });
      logger.log(
        `[daemon] Cycle #${state.runCount} succeeded in ${(durationMs / 1000).toFixed(1)}s (${payload.summary?.available ?? 0} available / ${payload.summary?.total ?? 0} total).`
      );
    } catch (error) {
      activeChild = null;
      if (stopped) return;
      const failures = state.consecutiveFailures + 1;
      const retryMs = Math.min(intervalMs, 2 * 60_000 * Math.pow(2, Math.min(failures - 1, 3)));
      persistStatus({
        state: "backoff",
        lastDurationMs: Date.now() - startedMs,
        lastError: error instanceof Error ? error.message : String(error),
        consecutiveFailures: failures,
        nextRunAt: options.once ? null : new Date(Date.now() + retryMs).toISOString()
      });
      logger.error(
        `[daemon] Cycle #${state.runCount} failed: ${state.lastError}. Retrying in ${Math.round(retryMs / 60000)}m.`
      );
      if (!options.once && !stopped) {
        timer = setTimeout(loopStep, retryMs);
        return;
      }
    }

    if (!options.once && !stopped) {
      timer = setTimeout(loopStep, nextDelayMs);
    }
  }

  async function loopStep() {
    if (stopped) return;
    await executeCycle();
  }

  if (options.serve) {
    server = createStaticServer(cwd);
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(options.port, options.host, resolveListen);
    });
    const addr = server.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : options.port;
    logger.log(`[daemon] Live workbench serving at http://${options.host}:${boundPort}/`);
  }

  const shouldRunImmediately =
    options.once ||
    options.forceInitial ||
    initialMeta.ageMs >= intervalMs * 0.8 ||
    fxNeedsRefresh(cwd, 6 * 24 * 60 * 60 * 1000);

  if (options.once) {
    await executeCycle();
    await stop();
    return { state, server, stop, executeCycle };
  }

  if (shouldRunImmediately) {
    persistStatus({ nextRunAt: new Date().toISOString() });
    void loopStep();
  } else {
    const waitMs = Math.max(10_000, intervalMs - initialMeta.ageMs);
    persistStatus({ state: "idle", nextRunAt: new Date(Date.now() + waitMs).toISOString() });
    logger.log(
      `[daemon] Snapshot is fresh (${Math.round(initialMeta.ageMs / 60000)}m old). Next scheduled run in ${Math.round(waitMs / 60000)}m.`
    );
    timer = setTimeout(loopStep, waitMs);

    const scheduleReconcileRetry = () => {
      if (stopped || activeCycle) return;
      reconcileTimer = setTimeout(retryStartupReconcile, Math.min(waitMs, safeReconcileRetryMs));
    };

    const retryStartupReconcile = async () => {
      reconcileTimer = null;
      if (stopped || activeCycle) return;
      const runPromise = (async () => {
        try {
          await reconcileBaselineIfPresent();
          if (!stopped && state.lastError) {
            persistStatus({ lastError: null });
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.error?.(`[daemon] Startup publish reconciliation retry failed: ${msg}`);
          if (!stopped) {
            persistStatus({ lastError: msg });
            scheduleReconcileRetry();
          }
        }
      })();
      activeReconcile = runPromise;
      try {
        await runPromise;
      } finally {
        if (activeReconcile === runPromise) activeReconcile = null;
      }
    };

    if (startupReconcileError) {
      scheduleReconcileRetry();
    }
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (reconcileTimer) {
      clearTimeout(reconcileTimer);
      reconcileTimer = null;
    }
    stopPromise = (async () => {
      const child = activeChild;
      const killTimer = child ? setTimeout(() => child.kill("SIGKILL"), 2000) : null;
      try {
        child?.kill("SIGTERM");
        await Promise.all([activeCycle, activeReconcile]);
      } finally {
        if (killTimer) clearTimeout(killTimer);
        activeChild = null;
        if (server) await new Promise((res) => server.close(() => res()));
        persistStatus({ active: false, state: "stopped", nextRunAt: null });
        logger.log("[daemon] Continuous monitor stopped cleanly.");
      }
    })();
    return stopPromise;
  }

  return { state, server, stop, executeCycle };
}
