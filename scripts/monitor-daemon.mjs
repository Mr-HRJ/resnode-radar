import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateMonitorPayload } from "./validate-monitor-data.mjs";
import { BROWSER_ASSET_ALLOWLIST } from "./build-cloudflare.mjs";
import { publishSnapshot } from "./publish-snapshot.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

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

export function parseDaemonArgs(argv = process.argv.slice(2), env = process.env) {
  const args = {
    intervalMinutes: Number(env.MONITOR_INTERVAL_MINUTES ?? 10),
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

  if (!Number.isFinite(args.intervalMinutes) || args.intervalMinutes < 1) args.intervalMinutes = 10;
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) args.port = 4173;
  if (!Number.isFinite(args.childTimeoutMs) || args.childTimeoutMs <= 0) args.childTimeoutMs = 12 * 60 * 1000;
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
      ageMs: Number.isFinite(Date.parse(raw.generatedAt)) && Date.parse(raw.generatedAt) <= Date.now()
        ? Date.now() - Date.parse(raw.generatedAt) : Infinity,
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

export function createStaticServer(rootDir = projectRoot) {
  const safeRoot = realpathSync(rootDir);
  const allowed = [...BROWSER_ASSET_ALLOWLIST, "data/products.json", "data/fx.json", "data/daemon-status.json", "sitemap.xml", "robots.txt"];
  return createServer((req, res) => {
    if (!["GET", "HEAD"].includes(req.method || "")) {
      res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
      res.end("Method not allowed");
      return;
    }

    let pathname = "/";
    try {
      pathname = decodeURIComponent(new URL(req.url || "/", "http://127.0.0.1").pathname);
      if (/[\x00-\x1f\\]/.test(pathname)) throw new Error("Invalid path");
    } catch {
      res.writeHead(400);
      res.end("Bad request");
      return;
    }

    if (pathname.endsWith("/")) pathname += "index.html";
    const parts = pathname.split("/").filter(Boolean);
    const rel = parts.join("/");
    if (parts.some((part) => part.startsWith(".")) ||
        !allowed.some((path) => rel === path || rel.startsWith(`${path}/`))) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    try {
      let targetPath = safeRoot;
      // Reject symlinks even inside an allowed directory; they can alias private files.
      for (const part of parts) {
        targetPath = join(targetPath, part);
        if (lstatSync(targetPath).isSymbolicLink()) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }
      }
      if (lstatSync(targetPath).isDirectory()) targetPath = join(targetPath, "index.html");
      const stat = lstatSync(targetPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      const body = req.method === "HEAD" ? null : readFileSync(targetPath);
      res.writeHead(200, {
        "content-type": MIME_TYPES[extname(targetPath).toLowerCase()] || "application/octet-stream",
        "cache-control": rel.startsWith("data/") ? "no-store" : "no-cache",
        "x-content-type-options": "nosniff"
      });
      res.end(body);
    } catch (error) {
      const status = ["ENOENT", "ENOTDIR"].includes(error.code) ? 404 : error.code === "EACCES" ? 403 : 500;
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(status === 404 ? "Not found" : status === 403 ? "Forbidden" : "Asset read failed");
    }
  });
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
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

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
      if (timedOut) rejectPromise(new Error(`Script ${scriptPath} timed out after ${Math.round(timeoutMs / 1000)}s`));
      else if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(`Script ${scriptPath} exited with code ${code}: ${(stderr || stdout).trim().slice(0, 240)}`));
    });
  });
}

export async function startMonitorDaemon(rawOptions = {}, { cwd = projectRoot, logger = console, runScript = runNodeScript } = {}) {
  const options = { ...parseDaemonArgs([]), ...rawOptions };
  const statusPath = join(cwd, "data/daemon-status.json");
  const intervalMs = Math.round(options.intervalMinutes * 60 * 1000);

  let stopped = false;
  let activeChild = null;
  let timer = null;
  let server = null;
  let activeCycle = null;
  let stopPromise = null;

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
    lastError: null,
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
    activeCycle = runCycle().finally(() => { activeCycle = null; });
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
    logger.log(`[daemon] Starting collection cycle #${state.runCount} at ${state.lastRunStartedAt}...`);

    try {
      if (fxNeedsRefresh(cwd)) {
        logger.log("[daemon] Refreshing ECB reference FX snapshot...");
        await runScript(join(projectRoot, "scripts/fx-rates.mjs"), cwd, 30_000, (c) => { activeChild = c; });
      }
      if (stopped) return;
      await runScript(join(projectRoot, "scripts/monitor.mjs"), cwd, options.childTimeoutMs, (c) => { activeChild = c; });
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
      // Keep a fixed cadence measured from each cycle's start, not from its completion.
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
      logger.log(`[daemon] Cycle #${state.runCount} succeeded in ${(durationMs / 1000).toFixed(1)}s (${payload.summary?.available ?? 0} available / ${payload.summary?.total ?? 0} total).`);
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
      logger.error(`[daemon] Cycle #${state.runCount} failed: ${state.lastError}. Retrying in ${Math.round(retryMs / 60000)}m.`);
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
    logger.log(`[daemon] Snapshot is fresh (${Math.round(initialMeta.ageMs / 60000)}m old). Next scheduled run in ${Math.round(waitMs / 60000)}m.`);
    timer = setTimeout(loopStep, waitMs);
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    if (timer) clearTimeout(timer);
    stopPromise = (async () => {
      const child = activeChild;
      const killTimer = child ? setTimeout(() => child.kill("SIGKILL"), 2000) : null;
      try {
        child?.kill("SIGTERM");
        await activeCycle;
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

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const opts = parseDaemonArgs();
  const handle = await startMonitorDaemon(opts);
  if (opts.once && handle.state.lastError) process.exitCode = 1;
  const shutdown = async () => {
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
