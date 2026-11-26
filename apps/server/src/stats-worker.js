import { parentPort, workerData } from "node:worker_threads";
import { VisitStatsStore, stripInternalStatsFields } from "./visit-stats-store.js";

const dbPath = workerData?.dbPath ?? ":memory:";
const storeOptions = {
  burstWindowMs: workerData?.burstWindowMs,
  busyTimeoutMs: workerData?.busyTimeoutMs ?? 250
};
const simulatedBlockMs = Number(workerData?.simulatedBlockMs ?? 0);

let store = null;
let reconnectTimer = null;

function blockSync(ms) {
  if (!(ms > 0)) return;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // intentional synchronous busy wait for lock-contention fault injection tests only
  }
}

function tryOpenStore() {
  if (store) return true;
  try {
    store = new VisitStatsStore(dbPath, storeOptions);
    const snap = store.getSnapshot(Date.now());
    parentPort?.postMessage({ type: "stats_snapshot", data: snap });
    return true;
  } catch (err) {
    store = null;
    parentPort?.postMessage({ type: "stats_snapshot", data: null });
    scheduleReconnect();
    void err;
    return false;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    tryOpenStore();
  }, 1500);
  reconnectTimer.unref?.();
}

tryOpenStore();

parentPort?.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.op === "close") {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try {
      store?.close();
    } catch {
      // ignore close errors
    }
    store = null;
    parentPort?.postMessage({ id: msg.id, ok: true, closed: true });
    parentPort?.close();
    return;
  }

  const nowCheck = Number.isFinite(msg.sentWallMs) ? Date.now() : 0;
  if (Number.isFinite(msg.deadlineMs) && nowCheck >= msg.deadlineMs) {
    parentPort?.postMessage({ id: msg.id, ok: false, expired: true, code: "DEADLINE_EXCEEDED" });
    return;
  }

  if (simulatedBlockMs > 0) {
    blockSync(simulatedBlockMs);
  }

  if (!store && !tryOpenStore()) {
    parentPort?.postMessage({ id: msg.id, ok: false, code: "DB_UNAVAILABLE" });
    return;
  }

  try {
    const nowMs = Number.isFinite(msg.nowMs) ? msg.nowMs : Date.now();
    const raw =
      msg.op === "record"
        ? store.recordVisit({ ip: msg.ip, userAgent: msg.userAgent, nowMs })
        : store.getSnapshot(nowMs);
    const publicData = stripInternalStatsFields(raw);
    parentPort?.postMessage({ type: "stats_snapshot", data: publicData });
    parentPort?.postMessage({ id: msg.id, ok: true, result: publicData });
  } catch (err) {
    const code = err?.code || "SQLITE_ERROR";
    if (code === "SQLITE_CORRUPT" || code === "SQLITE_CANTOPEN" || code === "SQLITE_NOTADB") {
      try {
        store?.close();
      } catch {
        // ignore
      }
      store = null;
      scheduleReconnect();
    }
    parentPort?.postMessage({ id: msg.id, ok: false, code });
  }
});
