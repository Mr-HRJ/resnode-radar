export const VISIT_STATS_TIMEOUT_MS = 4000;

export function isValidVisitStats(data) {
  return Boolean(
    data &&
      typeof data === "object" &&
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

export async function fetchVisitStats(endpoint = "api/stats", { record = false, signal } = {}) {
  if (signal?.aborted) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISIT_STATS_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener?.("abort", onOuterAbort, { once: true });

  try {
    const res = await fetch(endpoint, {
      method: record ? "POST" : "GET",
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!res.ok) return null;
    const json = await res.json();
    return isValidVisitStats(json) ? json : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onOuterAbort);
  }
}

export function visitStatsDay(now = Date.now()) {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
