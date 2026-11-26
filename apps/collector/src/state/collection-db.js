import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const product = (row) => !row.diagnostic && !["blocked", "error"].includes(row.status);
const known = (row) =>
  product(row) &&
  ["available", "unavailable"].includes(row.status) &&
  !row.raw?.historical &&
  row.raw?.strategy !== "reader_snapshot";
const parse = (value) => (value ? JSON.parse(value) : null);
const iso = (ms) => new Date(ms).toISOString();

export class CollectionState {
  constructor(path) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, pid TEXT,
        record TEXT NOT NULL, last_seen TEXT NOT NULL, last_attempt TEXT, last_verified TEXT, last_known_status TEXT);
      CREATE INDEX IF NOT EXISTS products_source ON products(source_id);
      CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS feeds (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, item_key TEXT NOT NULL,
        content_hash TEXT NOT NULL, record TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
        UNIQUE(source_id,item_key));
      CREATE TABLE IF NOT EXISTS jobs (url TEXT PRIMARY KEY, source_id TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', result TEXT);
      CREATE TABLE IF NOT EXISTS runs (started_at TEXT PRIMARY KEY, finished_at TEXT, summary TEXT);
      CREATE TABLE IF NOT EXISTS observations (product_id TEXT NOT NULL, at TEXT NOT NULL, record TEXT NOT NULL,
        UNIQUE(product_id,at,record));
    `);
  }
  close() {
    this.db.close();
  }
  transaction(action) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  seed(payload) {
    if (this.db.prepare("SELECT value FROM meta WHERE key='seeded'").get()) return;
    this.transaction(() => {
      for (const row of payload?.products ?? []) {
        if (product(row)) this.saveProduct(row, row.fetchedAt, true);
      }
      this.db.prepare("INSERT INTO meta VALUES('seeded','1')").run();
    });
  }
  saveProduct(row, seenAt, seed = false) {
    const previous = this.db.prepare("SELECT * FROM products WHERE id=?").get(row.id);
    const isDmit = row.sourceId === "catalog-dmit";
    const checked = known(row) && (!isDmit || row.raw?.inventoryChecked || row.raw?.catalogSoldOut);
    const verifiedAt = checked
      ? row.raw?.inventoryCheckedAt || row.observedAt || seenAt
      : previous?.last_verified ?? null;
    const attemptedAt = isDmit ? row.raw?.inventoryAttemptedAt || null : seenAt;
    const verification = {
      observedAt: row.observedAt || seenAt,
      attemptedAt,
      verifiedAt,
      lastKnownStatus: checked ? row.status : previous?.last_known_status ?? null,
      lastVerifiedQuote:
        checked && !row.raw?.referencePrice && Number.isFinite(row.priceValue)
          ? {
              price: row.price,
              priceValue: row.priceValue,
              currency: row.currency || null,
              at: verifiedAt
            }
          : parse(previous?.record)?.verification?.lastVerifiedQuote ?? null,
      state: checked ? "verified" : "unverified",
      priceKind: row.raw?.referencePrice ? "reference" : "observed"
    };
    const record = { ...row, verification };
    const summary = (r) =>
      JSON.stringify({
        status: r.status,
        stockCount: r.stockCount,
        price: r.price,
        priceValue: r.priceValue,
        priceKind: r.verification?.priceKind,
        hardware: r.hardware,
        orderUrl: r.orderUrl
      });
    if (checked && (!previous || summary(parse(previous.record)) !== summary(record))) {
      this.db
        .prepare("INSERT OR IGNORE INTO observations VALUES(?,?,?)")
        .run(row.id, seenAt, summary(record));
    }
    this.db
      .prepare(
        `INSERT INTO products VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      source_id=excluded.source_id,pid=excluded.pid,record=excluded.record,last_seen=excluded.last_seen,
      last_attempt=coalesce(excluded.last_attempt,products.last_attempt),last_verified=excluded.last_verified,last_known_status=excluded.last_known_status`
      )
      .run(
        row.id,
        row.sourceId,
        row.raw?.pid ? String(row.raw.pid) : null,
        JSON.stringify(record),
        seenAt,
        seed && isDmit && row.raw?.inventoryChecked ? seenAt : attemptedAt,
        verifiedAt,
        verification.lastKnownStatus
      );
    return record;
  }
  sourceState(id) {
    return parse(this.db.prepare("SELECT state FROM sources WHERE id=?").get(id)?.state);
  }
  due(id, at) {
    return !(Date.parse(this.sourceState(id)?.cooldownUntil) > Date.parse(at));
  }
  priorityPids(id) {
    const queued = this.pendingJobs(id)
      .map((job) => new URL(job.url).searchParams.get("pid"))
      .filter(Boolean);
    const stale = this.db
      .prepare(
        "SELECT pid FROM products WHERE source_id=? AND pid IS NOT NULL ORDER BY coalesce(last_attempt,''),id"
      )
      .all(id)
      .map((p) => p.pid);
    return [...new Set([...queued, ...stale])].slice(0, 200);
  }
  pendingJobs(id) {
    return this.db
      .prepare(
        "SELECT * FROM jobs WHERE source_id=? AND state IN ('pending','blocked','unmatched') ORDER BY CASE state WHEN 'pending' THEN 0 ELSE 1 END, updated_at LIMIT 30"
      )
      .all(id);
  }
  enqueue(url, sourceId, at) {
    this.db
      .prepare(
        `INSERT INTO jobs(url,source_id,created_at,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(url) DO UPDATE SET updated_at=excluded.updated_at,state='pending',result=NULL`
      )
      .run(url, sourceId, at, at);
  }
  saveSource(source, records, attemptedAt, cycleAt, { skipped = false } = {}) {
    return this.transaction(() => {
      records = records.map((row) =>
        !product(row) && this.db.prepare("SELECT id FROM products WHERE id=?").get(row.id)
          ? { ...row, id: `${row.id}:diagnostic`, diagnostic: true }
          : row
      );
      const prior = this.sourceState(source.id);
      const failures = records.filter(
        (r) => r.diagnostic || ["error", "blocked"].includes(r.status)
      );
      const failure = failures[0];
      const streak = skipped ? (prior?.failureStreak ?? 0) : failure ? (prior?.failureStreak ?? 0) + 1 : 0;
      const limited = failure && (failure.status === "blocked" || failure.httpStatus === 429);
      let nextMs = Date.parse(attemptedAt) + 20 * 60_000;
      if (limited) {
        nextMs = Date.parse(attemptedAt) + Math.min(120, 20 * 2 ** Math.min(streak - 1, 3)) * 60_000;
      }
      for (const attempt of failure?.raw?.attempts ?? []) {
        if (Number.isFinite(Date.parse(attempt.retryAfterAt))) {
          nextMs = Math.max(nextMs, Date.parse(attempt.retryAfterAt));
        }
      }
      const health = skipped
        ? prior
        : {
            id: source.id,
            provider: source.provider,
            status: failure ? (records.some(product) ? "partial" : failure.status) : "ok",
            lastAttemptAt: attemptedAt,
            lastSuccessAt: failure ? (prior?.lastSuccessAt ?? null) : attemptedAt,
            nextAttemptAt: limited ? iso(nextMs) : iso(Date.parse(cycleAt) + 20 * 60_000),
            cooldownUntil: limited ? iso(nextMs) : null,
            failureStreak: streak,
            error: failure?.error || failure?.evidence || null,
            products: records.filter(product).length,
            collection: records.find((p) => p.collection)?.collection ?? null
          };
      if (!skipped) {
        this.db
          .prepare(
            "INSERT INTO sources VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state"
          )
          .run(source.id, JSON.stringify(health));
      }
      const current = records.map((row) => (product(row) ? this.saveProduct(row, attemptedAt) : row));
      const ids = new Set(current.map((r) => r.id));
      const cutoff = iso(Date.parse(attemptedAt) - 7 * 86_400_000);
      for (const old of this.db
        .prepare("SELECT * FROM products WHERE source_id=? AND last_seen>=?")
        .all(source.id, cutoff)) {
        if (ids.has(old.id)) continue;
        const row = parse(old.record);
        current.push({
          ...row,
          fetchedAt: cycleAt,
          status: "unknown",
          statusLabel: "历史资料·本轮未核验",
          stockCount: null,
          evidence: "保留历史套餐资料；本轮未取得有效结果，当前库存无法确认。",
          error: null,
          verification: {
            ...row.verification,
            state: "historical",
            priceKind: "historical",
            observedAt: old.last_seen,
            attemptedAt: skipped ? (row.verification?.attemptedAt ?? null) : attemptedAt
          },
          raw: { ...row.raw, historical: true, referencePrice: true, inventoryChecked: false },
          collection: {
            ...row.collection,
            failedPages: Math.max(1, row.collection?.failedPages || 0),
            retainedHistory: true
          }
        });
      }
      const scheduled = new Set(this.pendingJobs(source.id).map((job) => job.url));
      for (const job of this.db.prepare("SELECT * FROM jobs WHERE source_id=?").all(source.id)) {
        const match = current.find(
          (r) =>
            product(r) &&
            r.orderUrl &&
            normalizeOrder(r.orderUrl) === normalizeOrder(job.url) &&
            !r.raw?.historical
        );
        if (!match && !scheduled.has(job.url) && job.state !== "verified") continue;
        const state = match && known(match) ? "verified" : failure ? "blocked" : "unmatched";
        const result = {
          state,
          checkedAt: skipped ? (parse(job.result)?.checkedAt ?? null) : attemptedAt,
          productId: match?.id ?? null,
          status: state === "verified" ? match.status : "unknown",
          message:
            state === "verified"
              ? match.statusLabel
              : failure?.error || "尚未匹配可核验的公开 SKU"
        };
        this.db
          .prepare("UPDATE jobs SET state=?,updated_at=?,result=? WHERE url=?")
          .run(state, attemptedAt, JSON.stringify(result), job.url);
      }
      return current;
    });
  }
  sourceHealth() {
    return this.db
      .prepare("SELECT state FROM sources ORDER BY id")
      .all()
      .map((r) => parse(r.state));
  }
  recentObservationsByProduct(limitPerProduct = 10) {
    const out = new Map();
    const rows = this.db
      .prepare("SELECT product_id, at, record FROM observations ORDER BY at DESC")
      .all();
    for (const r of rows) {
      const list = out.get(r.product_id) || [];
      if (list.length < limitPerProduct) {
        const parsed = parse(r.record);
        if (parsed) list.push({ at: r.at, ...parsed });
        out.set(r.product_id, list);
      }
    }
    return out;
  }
  feedState(id) {
    return parse(this.db.prepare("SELECT state FROM feeds WHERE id=?").get(id)?.state);
  }
  saveFeed(id, state) {
    this.db
      .prepare("INSERT INTO feeds VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state")
      .run(id, JSON.stringify(state));
  }
  ingestAnnouncement(source, item, at) {
    const old = this.db
      .prepare("SELECT * FROM announcements WHERE source_id=? AND item_key=?")
      .get(source.id, item.key);
    const record = {
      ...item,
      id: old?.id || `${source.id}:${item.key}`,
      sourceId: source.id,
      source: source.name,
      providerId: source.providerId || null,
      trust: source.trust,
      firstSeenAt: old?.first_seen || at,
      updatedAt: old?.content_hash === item.hash ? parse(old.record).updatedAt : at,
      baseline: old ? parse(old.record).baseline : !this.feedState(source.id)?.initialized
    };
    this.db
      .prepare(
        `INSERT INTO announcements VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_id,item_key) DO UPDATE SET
      content_hash=excluded.content_hash,record=excluded.record,last_seen=excluded.last_seen`
      )
      .run(record.id, source.id, item.key, item.hash, JSON.stringify(record), record.firstSeenAt, at);
    return { record, created: !old, changed: !old || old.content_hash !== item.hash };
  }
  announcementPayload(at) {
    const cutoff = iso(Date.parse(at) - 30 * 86_400_000);
    const items = this.db
      .prepare("SELECT record FROM announcements WHERE last_seen>=? ORDER BY first_seen DESC LIMIT 100")
      .all(cutoff)
      .map(({ record }) => {
        const item = parse(record);
        return {
          ...item,
          candidates: (item.candidates ?? []).map((c) => ({
            ...c,
            verification: (() => {
              const job = this.db.prepare("SELECT result FROM jobs WHERE url=?").get(c.url);
              return (
                parse(job?.result) ||
                (job
                  ? { state: "pending", message: "等待目录及 SKU 核验" }
                  : { state: "unmatched", message: "历史线索未加入优先核验队列" })
              );
            })()
          }))
        };
      })
      .sort(
        (a, b) =>
          (Date.parse(b.publishedAt || b.firstSeenAt) || 0) -
          (Date.parse(a.publishedAt || a.firstSeenAt) || 0)
      );
    return {
      items,
      sources: this.db
        .prepare("SELECT id,state FROM feeds ORDER BY id")
        .all()
        .map(({ id, state }) => {
          const { name, url, kind, trust, status, checkedAt, lastSuccessAt, error, items: cnt } =
            parse(state);
          return { id, name, url, kind, trust, status, checkedAt, lastSuccessAt, error, items: cnt };
        })
    };
  }
  finishRun(startedAt, summary) {
    this.db
      .prepare("INSERT OR REPLACE INTO runs VALUES(?,?,?)")
      .run(startedAt, new Date().toISOString(), JSON.stringify(summary));
    const cutoff = iso(Date.parse(startedAt) - 30 * 86_400_000);
    this.db.prepare("DELETE FROM runs WHERE started_at<?").run(cutoff);
    this.db.prepare("DELETE FROM announcements WHERE last_seen<?").run(cutoff);
    this.db.prepare("DELETE FROM jobs WHERE updated_at<?").run(cutoff);
    this.db.prepare("DELETE FROM observations WHERE at<?").run(cutoff);
    this.db
      .prepare("DELETE FROM products WHERE last_seen<?")
      .run(iso(Date.parse(startedAt) - 7 * 86_400_000));
  }
}

export function normalizeOrder(value) {
  try {
    const u = new URL(value);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|aff|ref)/i.test(key)) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    return u.href;
  } catch {
    return null;
  }
}
