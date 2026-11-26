import {
  VISIT_RECORDED_SESSION_KEY,
  VISIT_SESSION_KEY,
  resolveSiteAssetUrl
} from "@resnode-radar/contracts";

const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;
export const VISIT_STATS_TIMEOUT_MS = 4000;

export function visitStatsDay(nowMs = Date.now()) {
  return new Date(nowMs + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

export function isValidVisitStats(data) {
  return Boolean(
    data &&
      typeof data === "object" &&
      (data.schemaVersion === undefined || data.schemaVersion === 1) &&
      typeof data.day === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(data.day) &&
      Number.isSafeInteger(data.todayPv) &&
      data.todayPv >= 0 &&
      Number.isSafeInteger(data.todayUv) &&
      data.todayUv >= 0 &&
      Number.isSafeInteger(data.totalPv) &&
      data.totalPv >= 0 &&
      Number.isSafeInteger(data.totalUv) &&
      data.totalUv >= 0 &&
      data.todayUv <= data.todayPv &&
      data.totalUv <= data.totalPv &&
      data.todayPv <= data.totalPv &&
      data.todayUv <= data.totalUv
  );
}

export function loadSessionVisitStats(storage = globalThis.sessionStorage, nowMs = Date.now()) {
  try {
    const raw = storage?.getItem(VISIT_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (isValidVisitStats(parsed) && parsed.day === visitStatsDay(nowMs)) {
      return parsed;
    }
  } catch {
    // ignore storage errors
  }
  return null;
}

export function saveSessionVisitStats(stats, storage = globalThis.sessionStorage) {
  try {
    if (isValidVisitStats(stats)) {
      storage?.setItem?.(VISIT_SESSION_KEY, JSON.stringify(stats));
    }
  } catch {
    // ignore storage errors
  }
}

export function hasRecordedSessionVisit(
  storage = globalThis.sessionStorage,
  nowMs = Date.now()
) {
  try {
    return storage?.getItem?.(VISIT_RECORDED_SESSION_KEY) === visitStatsDay(nowMs);
  } catch {
    return false;
  }
}

export function markSessionVisitRecorded(
  storage = globalThis.sessionStorage,
  day = visitStatsDay(Date.now())
) {
  try {
    if (typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
      storage?.setItem?.(VISIT_RECORDED_SESSION_KEY, day);
    }
  } catch {
    // ignore storage errors
  }
}

/**
 * Records a visit (`POST`) when `record` / `recordHit` is true and otherwise reads (`GET`).
 * Automatically falls back from `api/v1/stats` to `api/stats` if only legacy route is bound.
 */
export async function fetchVisitStats(
  endpoint = null,
  {
    record = false,
    recordHit = false,
    signal,
    timeoutMs = VISIT_STATS_TIMEOUT_MS,
    doc = globalThis.document,
    locationHref = globalThis.window?.location?.href || "https://vpsld.com/",
    fetchImpl = globalThis.fetch
  } = {}
) {
  if (signal?.aborted) return null;
  const method = record || recordHit ? "POST" : "GET";
  const reqSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  const candidates = endpoint
    ? [endpoint]
    : [
        resolveSiteAssetUrl("api/v1/stats", { doc, locationHref }),
        resolveSiteAssetUrl("api/stats", { doc, locationHref })
      ];

  for (const url of candidates) {
    if (reqSignal.aborted) return null;
    try {
      const res = await fetchImpl(url, {
        method,
        cache: "no-store",
        signal: reqSignal,
        headers: { accept: "application/json" }
      });
      if (res.status === 404 && candidates.length > 1) continue;
      if (!res.ok) return null;
      const body = await res.json();
      return isValidVisitStats(body) ? body : null;
    } catch {
      if (reqSignal.aborted) return null;
    }
  }
  return null;
}
