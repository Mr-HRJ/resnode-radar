import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchVisitStats, isValidVisitStats, visitStatsDay } from "../src/services/visits.js";

const valid = { day: "2026-11-24", todayPv: 2, todayUv: 1, totalPv: 3, totalUv: 2 };

test("stats reads respect cancellation before and during fetch", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", (_url, { signal }) => {
    requests += 1;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(await fetchVisitStats("api/stats", { signal: cancelled.signal }), null);
  assert.equal(requests, 0);
  const running = new AbortController();
  const pending = fetchVisitStats("api/stats", { signal: running.signal });
  running.abort();
  assert.equal(await pending, null);
  assert.equal(requests, 1);
});

test("statistics reject impossible totals and use the Beijing date boundary", () => {
  assert.equal(isValidVisitStats(valid), true);
  for (const patch of [{ todayUv: 3 }, { totalPv: 1 }, { totalUv: 0 }, { totalUv: 4 }, { todayPv: -1 }]) {
    assert.equal(isValidVisitStats({ ...valid, ...patch }), false);
  }
  assert.equal(visitStatsDay(Date.parse("2026-11-23T15:59:59Z")), "2026-11-23");
  assert.equal(visitStatsDay(Date.parse("2026-11-23T16:00:00Z")), "2026-11-24");
});
