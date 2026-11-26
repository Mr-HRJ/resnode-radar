import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MAX_BODY_BYTES,
  VisitStatsStore,
  beijingDayKey,
  isBotUserAgent,
  isLoopbackAddress,
  normalizeClientIp,
  stripInternalStatsFields
} from "./visit-stats-store.js";
import { StatsWorkerClient } from "./stats-client.js";
import { createPulseReader } from "./pulse.js";

export {
  MAX_BODY_BYTES,
  VisitStatsStore,
  StatsWorkerClient,
  beijingDayKey,
  isBotUserAgent,
  isLoopbackAddress,
  normalizeClientIp
};

function sendJson(res, status, payload, method = "GET", extraHeaders = {}) {
  const body = method === "HEAD" ? "" : JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders
  });
  res.end(body);
}

const STATS_PATHS = new Set(["/api/stats", "/api/v1/stats"]);

/**
 * Synchronous store adapter (kept backward-compatible for direct in-memory unit tests
 * that pass an explicit `VisitStatsStore` instance).
 */
export function createVisitStatsHandler(store, options = {}) {
  const clock = options.now || (() => Date.now());
  const isAsyncClient = store instanceof StatsWorkerClient || typeof store?.getCachedStats === "function";

  async function respondWithStats(req, res, runOp) {
    try {
      const result = await runOp();
      const publicPayload = stripInternalStatsFields(result);
      sendJson(res, 200, publicPayload, req.method);
    } catch (error) {
      console.error("Visit stats storage unavailable:", error?.code || "UNKNOWN");
      sendJson(res, 503, { error: "Visit stats temporarily unavailable" }, req.method);
    }
  }

  return (req, res) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    } catch {
      sendJson(res, 400, { error: "Malformed request URL" }, req.method);
      return;
    }

    if (!STATS_PATHS.has(pathname)) {
      sendJson(res, 404, { error: "Not found" }, req.method);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      void respondWithStats(req, res, () => store.getSnapshot(clock()));
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" }, req.method, {
        allow: "GET, HEAD, POST"
      });
      return;
    }

    let bytes = 0;
    let aborted = false;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES && !aborted) {
        aborted = true;
        res.once("finish", () => req.destroy());
        sendJson(res, 413, { error: "Payload too large" }, "POST");
      }
    });
    req.on("error", () => {
      aborted = true;
    });
    req.on("end", () => {
      if (aborted) return;
      const remoteAddr = req.socket?.remoteAddress || "";
      const forwardedRealIp = isLoopbackAddress(remoteAddr) ? req.headers["x-real-ip"] : "";
      const clientIp =
        typeof forwardedRealIp === "string" && forwardedRealIp.trim()
          ? forwardedRealIp
          : remoteAddr;
      const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "";
      void respondWithStats(req, res, () =>
        store.recordVisit({ ip: clientIp, userAgent, nowMs: clock() })
      );
    });
    void isAsyncClient;
  };
}

/**
 * Creates the full v2 HTTP handler serving both:
 * - `GET/HEAD /api/v1/pulse` (pure non-blocking memory stats + async latest.json pointer)
 * - `GET/HEAD/POST /api/v1/stats` & `/api/stats` (worker_threads SQLite isolated)
 */
export function createRadarApiHandler(statsClient, options = {}) {
  const clock = options.now || (() => Date.now());
  const readPulsePointer = createPulseReader({
    latestJsonPath:
      options.latestJsonPath ??
      process.env.PULSE_LATEST_JSON ??
      "data/v2/latest.json",
    ttlMs: options.pulseTtlMs ?? 500
  });
  const statsHandler = createVisitStatsHandler(statsClient, options);

  return async (req, res) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    } catch {
      sendJson(res, 400, { error: "Malformed request URL" }, req.method);
      return;
    }

    if (pathname === "/api/v1/pulse") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "Method not allowed" }, req.method, { allow: "GET, HEAD" });
        return;
      }
      try {
        const pointer = await readPulsePointer();
        if (!pointer) {
          sendJson(res, 404, { error: "v2 latest pointer not published yet" }, req.method);
          return;
        }
        const stats =
          typeof statsClient?.getCachedStats === "function"
            ? statsClient.getCachedStats(clock())
            : null;
        sendJson(res, 200, { ...pointer, stats }, req.method);
      } catch (err) {
        console.error("Pulse pointer read failed:", err?.message || "UNKNOWN");
        sendJson(res, 503, { error: "Pulse pointer temporarily unavailable" }, req.method);
      }
      return;
    }

    if (STATS_PATHS.has(pathname)) {
      statsHandler(req, res);
      return;
    }

    sendJson(res, 404, { error: "Not found" }, req.method);
  };
}

export function startVisitStatsServer(options = {}) {
  const dbPath =
    options.dbPath ?? process.env.STATS_DB ?? "/var/lib/resnode-radar/state/visits.sqlite";
  const host = options.host ?? process.env.STATS_HOST ?? "127.0.0.1";
  const port = Number(options.port ?? process.env.STATS_PORT ?? 18920);
  const latestJsonPath =
    options.latestJsonPath ??
    process.env.PULSE_LATEST_JSON ??
    "/var/lib/resnode-radar/data/v2/latest.json";

  // Dedicated Worker thread isolates synchronous DatabaseSync from the HTTP main event loop,
  // and server.listen() succeeds even if dbPath cannot be opened at startup!
  const statsClient = new StatsWorkerClient({
    dbPath,
    burstWindowMs: options.burstWindowMs,
    busyTimeoutMs: options.busyTimeoutMs ?? 250,
    simulatedBlockMs: options.simulatedBlockMs ?? 0,
    maxUnfinished: options.maxUnfinished ?? 64,
    timeoutMs: options.timeoutMs ?? 1500
  });

  const server = createServer(
    createRadarApiHandler(statsClient, { ...options, latestJsonPath })
  );

  return new Promise((resolveServer, rejectServer) => {
    server.once("error", async (err) => {
      await statsClient.close();
      rejectServer(err);
    });
    server.listen(port, host, () => {
      const addr = server.address();
      resolveServer({
        store: statsClient,
        statsClient,
        server,
        port: typeof addr === "object" && addr ? addr.port : port,
        async close() {
          server.closeIdleConnections?.();
          await new Promise((r) => server.close(() => r()));
          await statsClient.close();
        }
      });
    });
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const runtime = await startVisitStatsServer();
  console.log(`Radar API & visit stats service listening on 127.0.0.1:${runtime.port}`);
  const shutdown = async () => {
    await runtime.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
