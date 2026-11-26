import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;
export const BURST_WINDOW_MS = 500;
export const RETENTION_DAYS = 2;
export const MAX_BODY_BYTES = 1024;

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

export function isLoopbackAddress(addr) {
  const normalized = normalizeClientIp(addr);
  return normalized === "127.0.0.1" || normalized === "::1";
}

export function stripInternalStatsFields(result) {
  if (!result || typeof result !== "object") return null;
  const { counted: _counted, reason: _reason, ...publicPayload } = result;
  return publicPayload;
}

export class VisitStatsStore {
  constructor(dbPath = ":memory:", options = {}) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.burstWindowMs = Number.isFinite(options.burstWindowMs)
      ? options.burstWindowMs
      : BURST_WINDOW_MS;
    const busyTimeoutMs = Number.isFinite(options.busyTimeoutMs) ? options.busyTimeoutMs : 250;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=${Math.max(10, Math.floor(busyTimeoutMs))};
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
    this.stmtInsertSalt = this.db.prepare(
      "INSERT OR IGNORE INTO daily_salts (day, salt) VALUES (?, ?)"
    );
    this.stmtPruneVisitors = this.db.prepare("DELETE FROM daily_visitors WHERE day < ?");
    this.stmtPruneSalts = this.db.prepare("DELETE FROM daily_salts WHERE day < ?");
    this.stmtGetVisitor = this.db.prepare(
      "SELECT last_hit_ms FROM daily_visitors WHERE day = ? AND visitor_hash = ?"
    );
    this.stmtInsertVisitor = this.db.prepare(
      "INSERT INTO daily_visitors (day, visitor_hash, last_hit_ms) VALUES (?, ?, ?)"
    );
    this.stmtTouchVisitor = this.db.prepare(
      "UPDATE daily_visitors SET last_hit_ms = ? WHERE day = ? AND visitor_hash = ?"
    );
    this.stmtEnsureDay = this.db.prepare(
      "INSERT OR IGNORE INTO daily_stats (day, pv, uv, updated_at) VALUES (?, 0, 0, ?)"
    );
    this.stmtIncPvAndUv = this.db.prepare(
      "UPDATE daily_stats SET pv = pv + 1, uv = uv + 1, updated_at = ? WHERE day = ?"
    );
    this.stmtIncPvOnly = this.db.prepare(
      "UPDATE daily_stats SET pv = pv + 1, updated_at = ? WHERE day = ?"
    );
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
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback error if transaction already aborted
      }
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
        const keepAfterDay = beijingDayKey(nowMs - RETENTION_DAYS * 86_400 * 1000);
        this.stmtPruneVisitors.run(keepAfterDay);
        this.stmtPruneSalts.run(keepAfterDay);
        this.stmtInsertSalt.run(day, randomBytes(32).toString("hex"));
        saltRow = this.stmtGetSalt.get(day);
      }

      const visitorHash = createHmac("sha256", saltRow.salt)
        .update(`${cleanIp}|${cleanUa}`)
        .digest("hex");
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
