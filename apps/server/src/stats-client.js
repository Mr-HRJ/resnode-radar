import { Worker } from "node:worker_threads";
import { beijingDayKey } from "./visit-stats-store.js";

/**
 * Main-thread non-blocking bridge to the dedicated SQLite Worker thread.
 * - Counts TRUE unfinished Worker tasks (`unfinishedCount`), including requests whose
 *   HTTP caller already timed out at `timeoutMs` (default 1500ms < Nginx 3s).
 * - Exposes `getCachedStats(nowMs)` in 0ms purely from RAM for `/api/v1/pulse`.
 */
export class StatsWorkerClient {
  constructor(options = {}) {
    this.dbPath = options.dbPath ?? ":memory:";
    this.burstWindowMs = options.burstWindowMs;
    this.busyTimeoutMs = options.busyTimeoutMs ?? 250;
    this.simulatedBlockMs = options.simulatedBlockMs ?? 0;
    this.maxUnfinished = Number.isInteger(options.maxUnfinished) ? options.maxUnfinished : 64;
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1500;

    this.cachedStats = null;
    this.nextId = 1;
    this.unfinishedIds = new Set();
    this.pendingCallers = new Map();
    this.closed = false;
    this.worker = null;
    this.respawnTimer = null;

    this.#spawnWorker();
  }

  #spawnWorker() {
    if (this.closed || this.worker) return;
    const worker = new Worker(new URL("./stats-worker.js", import.meta.url), {
      workerData: {
        dbPath: this.dbPath,
        burstWindowMs: this.burstWindowMs,
        busyTimeoutMs: this.busyTimeoutMs,
        simulatedBlockMs: this.simulatedBlockMs
      }
    });
    worker.unref();
    this.worker = worker;

    worker.on("message", (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "stats_snapshot") {
        this.cachedStats = msg.data || null;
        return;
      }
      if (msg.id !== undefined) {
        this.unfinishedIds.delete(msg.id);
        if (this.unfinishedIds.size === 0) {
          worker.unref();
        }
        const caller = this.pendingCallers.get(msg.id);
        if (caller) {
          clearTimeout(caller.timer);
          this.pendingCallers.delete(msg.id);
          if (msg.ok) caller.resolve(msg.result);
          else caller.reject(Object.assign(new Error(msg.code || "STATS_UNAVAILABLE"), { code: msg.code }));
        }
      }
    });

    worker.on("error", (err) => {
      console.error("Stats worker error:", err?.message || "UNKNOWN");
    });

    worker.on("exit", () => {
      if (this.worker === worker) this.worker = null;
      this.unfinishedIds.clear();
      for (const [, caller] of this.pendingCallers.entries()) {
        clearTimeout(caller.timer);
        caller.reject(Object.assign(new Error("STATS_WORKER_EXITED"), { code: "WORKER_EXITED" }));
      }
      this.pendingCallers.clear();
      if (!this.closed) {
        this.respawnTimer = setTimeout(() => {
          this.respawnTimer = null;
          this.#spawnWorker();
        }, 500);
        this.respawnTimer.unref?.();
      }
    });
  }

  get unfinishedCount() {
    return this.unfinishedIds.size;
  }

  getCachedStats(nowMs = Date.now()) {
    if (!this.cachedStats) return null;
    const currentDay = beijingDayKey(nowMs);
    if (this.cachedStats.day === currentDay) return this.cachedStats;
    return {
      ...this.cachedStats,
      day: currentDay,
      todayPv: 0,
      todayUv: 0
    };
  }

  #dispatch(op, payload = {}) {
    if (this.closed || !this.worker) {
      return Promise.reject(Object.assign(new Error("Stats worker unavailable"), { code: "UNAVAILABLE" }));
    }
    if (this.unfinishedIds.size >= this.maxUnfinished) {
      return Promise.reject(Object.assign(new Error("Stats queue overloaded"), { code: "OVERLOADED" }));
    }

    const id = this.nextId++;
    const sentWallMs = Date.now();
    const deadlineMs = sentWallMs + this.timeoutMs;
    this.unfinishedIds.add(id);
    this.worker.ref();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCallers.delete(id);
        // NOTE: unfinishedIds keeps `id` until the Worker actually dequeues/finishes it!
        reject(Object.assign(new Error("Stats worker request timed out"), { code: "TIMEOUT" }));
      }, this.timeoutMs);

      this.pendingCallers.set(id, { resolve, reject, timer });
      try {
        this.worker.postMessage({ id, op, sentWallMs, deadlineMs, ...payload });
      } catch (err) {
        clearTimeout(timer);
        this.pendingCallers.delete(id);
        this.unfinishedIds.delete(id);
        reject(err);
      }
    });
  }

  getSnapshot(nowMs = Date.now()) {
    return this.#dispatch("get", { nowMs });
  }

  recordVisit({ ip, userAgent, nowMs = Date.now() } = {}) {
    return this.#dispatch("record", { ip, userAgent, nowMs });
  }

  async close() {
    this.closed = true;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    const w = this.worker;
    if (!w) return;
    try {
      await this.#_gracefulClose(w);
    } finally {
      this.worker = null;
      this.unfinishedIds.clear();
      for (const [, caller] of this.pendingCallers.entries()) {
        clearTimeout(caller.timer);
      }
      this.pendingCallers.clear();
    }
  }

  async #_gracefulClose(w) {
    await new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        w.terminate().finally(resolve);
      }, 1000);
      killTimer.unref?.();
      w.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        w.postMessage({ id: 0, op: "close" });
        setTimeout(() => w.terminate().catch(() => {}), 50).unref?.();
      } catch {
        w.terminate().finally(resolve);
      }
    });
  }
}
