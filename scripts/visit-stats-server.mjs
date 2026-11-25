import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;
const BURST_WINDOW_MS = 500;
const RETENTION_DAYS = 2;
const MAX_BODY_BYTES = 1024;

const BOT_UA_PATTERN =
  /(?:[a-z0-9_-]*(?:bot|spider|crawler)\b|\b(?:slurp|archiver|curl|wget|python-requests|python-urllib|aiohttp|httpx|go-http-client|java\/|okhttp|axios|node-fetch|undici|headlesschrome|phantomjs|playwright|puppeteer|selenium|lighthouse|pagespeed|uptimerobot|pingdom|statuscake|datadog|newrelic|globalping|censys|shodan|zgrab|masscan|nmap|facebookexternalhit|bingpreview)\b)/i;

export function beijingDayKey(nowMs = Date.now()) {
  return new Date(nowMs + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

export function isBotUserAgent(userAgent) {
  const ua = typeof userAgent === "string" ? userAgent.trim() : "";
  if (ua.length < 8) return true;
  return BOT_UA_PATTERN.test(ua);
}

export function normalizeClientIp(rawIp) {
  const ip = typeof rawIp === "string" ? rawIp.trim() : "";
  if (!ip) return "0.0.0.0";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function isLoopbackAddress(addr) {
  const normalized = normalizeClientIp(addr);
  return normalized === "127.0.0.1" || normalized === "::1";
}

export class VisitStatsStore {
  constructor(dbPath = ":memory:", options = {}) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.burstWindowMs = Number.isFinite(options.burstWindowMs) ? options.burstWindowMs : BURST_WINDOW_MS;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS daily_stats (
        day TEXT PRIMARY KEY,
        pv INTEGER NOT NULL DEFAULT 0,
        uv INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS daily_salts (
        day TEXT PRIMARY KEY,
        salt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS daily_visitors (
        day TEXT NOT NULL,
        visitor_hash TEXT NOT NULL,
        last_hit_ms INTEGER NOT NULL,
        PRIMARY KEY (day, visitor_hash)
      );
    `);

    this.stmtGetSalt = this.db.prepare("SELECT salt FROM daily_salts WHERE day = ?");
    this.stmtInsertSalt = this.db.prepare("INSERT OR IGNORE INTO daily_salts (day, salt) VALUES (?, ?)");
    this.stmtPruneVisitors = this.db.prepare("DELETE FROM daily_visitors WHERE day < ?");
    this.stmtPruneSalts = this.db.prepare("DELETE FROM daily_salts WHERE day < ?");
    this.stmtGetVisitor = this.db.prepare("SELECT last_hit_ms FROM daily_visitors WHERE day = ? AND visitor_hash = ?");
    this.stmtInsertVisitor = this.db.prepare("INSERT INTO daily_visitors (day, visitor_hash, last_hit_ms) VALUES (?, ?, ?)");
    this.stmtTouchVisitor = this.db.prepare("UPDATE daily_visitors SET last_hit_ms = ? WHERE day = ? AND visitor_hash = ?");
    this.stmtEnsureDay = this.db.prepare("INSERT OR IGNORE INTO daily_stats (day, pv, uv, updated_at) VALUES (?, 0, 0, ?)");
    this.stmtIncPvAndUv = this.db.prepare("UPDATE daily_stats SET pv = pv + 1, uv = uv + 1, updated_at = ? WHERE day = ?");
    this.stmtIncPvOnly = this.db.prepare("UPDATE daily_stats SET pv = pv + 1, updated_at = ? WHERE day = ?");
    this.stmtGetDay = this.db.prepare("SELECT pv, uv, updated_at FROM daily_stats WHERE day = ?");
    this.stmtGetTotals = this.db.prepare(
      "SELECT COALESCE(SUM(pv), 0) AS totalPv, COALESCE(SUM(uv), 0) AS totalUv, MAX(updated_at) AS latestAt FROM daily_stats"
    );
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getSnapshot(nowMs = Date.now()) {
    const day = beijingDayKey(nowMs);
    const today = this.stmtGetDay.get(day);
    const totals = this.stmtGetTotals.get();
    return {
      schemaVersion: 1,
      day,
      timezone: "Asia/Shanghai",
      todayPv: Number(today?.pv ?? 0),
      todayUv: Number(today?.uv ?? 0),
      totalPv: Number(totals?.totalPv ?? 0),
      totalUv: Number(totals?.totalUv ?? 0),
      updatedAt: today?.updated_at || totals?.latestAt || new Date(nowMs).toISOString()
    };
  }

  recordVisit({ ip, userAgent, nowMs = Date.now() } = {}) {
    if (isBotUserAgent(userAgent)) {
      return { ...this.getSnapshot(nowMs), counted: false, reason: "bot" };
    }

    const day = beijingDayKey(nowMs);
    const isoNow = new Date(nowMs).toISOString();
    const cleanIp = normalizeClientIp(ip);
    const cleanUa = String(userAgent ?? "").trim().slice(0, 240);

    const outcome = this.transaction(() => {
      let saltRow = this.stmtGetSalt.get(day);
      if (!saltRow) {
        const keepAfterDay = beijingDayKey(nowMs - RETENTION_DAYS * 86400 * 1000);
        this.stmtPruneVisitors.run(keepAfterDay);
        this.stmtPruneSalts.run(keepAfterDay);
        this.stmtInsertSalt.run(day, randomBytes(32).toString("hex"));
        saltRow = this.stmtGetSalt.get(day);
      }

      const visitorHash = createHmac("sha256", saltRow.salt).update(`${cleanIp}|${cleanUa}`).digest("hex");
      const existing = this.stmtGetVisitor.get(day, visitorHash);
      this.stmtEnsureDay.run(day, isoNow);

      if (!existing) {
        this.stmtInsertVisitor.run(day, visitorHash, nowMs);
        this.stmtIncPvAndUv.run(isoNow, day);
        return { counted: true, reason: "unique" };
      }

      if (nowMs - Number(existing.last_hit_ms) >= this.burstWindowMs) {
        this.stmtTouchVisitor.run(nowMs, day, visitorHash);
        this.stmtIncPvOnly.run(isoNow, day);
        return { counted: true, reason: "repeat" };
      }

      return { counted: false, reason: "burst" };
    });

    return { ...this.getSnapshot(nowMs), ...outcome };
  }
}

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

export function createVisitStatsHandler(store, options = {}) {
  const clock = options.now || (() => Date.now());

  function respondWithStats(req, res, read) {
    let result;
    try {
      result = read();
    } catch (error) {
      // Storage faults are observable, but must not terminate the HTTP service.
      console.error("Visit stats storage unavailable:", error?.code || "UNKNOWN");
      sendJson(res, 503, { error: "Visit stats temporarily unavailable" }, req.method);
      return;
    }
    const { counted: _counted, reason: _reason, ...publicPayload } = result;
    sendJson(res, 200, publicPayload, req.method);
  }

  return (req, res) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    } catch {
      sendJson(res, 400, { error: "Malformed request URL" }, req.method);
      return;
    }

    if (pathname !== "/api/stats") {
      sendJson(res, 404, { error: "Not found" }, req.method);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      respondWithStats(req, res, () => store.getSnapshot(clock()));
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" }, req.method, { allow: "GET, HEAD, POST" });
      return;
    }

    let bytes = 0;
    let aborted = false;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES && !aborted) {
        aborted = true;
        // Finish the 413 response before closing the connection.
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
      const clientIp = typeof forwardedRealIp === "string" && forwardedRealIp.trim() ? forwardedRealIp : remoteAddr;
      const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "";
      respondWithStats(req, res, () => store.recordVisit({ ip: clientIp, userAgent, nowMs: clock() }));
    });
  };
}

export function startVisitStatsServer(options = {}) {
  const dbPath = options.dbPath ?? process.env.STATS_DB ?? "/var/lib/resnode-radar/state/visits.sqlite";
  const host = options.host ?? process.env.STATS_HOST ?? "127.0.0.1";
  const port = Number(options.port ?? process.env.STATS_PORT ?? 18920);
  const store = new VisitStatsStore(dbPath, options);
  const server = createServer(createVisitStatsHandler(store, options));

  return new Promise((resolveServer, rejectServer) => {
    server.once("error", (err) => {
      store.close();
      rejectServer(err);
    });
    server.listen(port, host, () => {
      const addr = server.address();
      resolveServer({
        store,
        server,
        port: typeof addr === "object" && addr ? addr.port : port,
        async close() {
          await new Promise((r) => server.close(() => r()));
          store.close();
        }
      });
    });
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const runtime = await startVisitStatsServer();
  console.log(`Visit stats service listening on 127.0.0.1:${runtime.port}`);
  const shutdown = async () => {
    await runtime.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
