import { setTimeout as delay } from "node:timers/promises";

export function createOriginPacer({ now = Date.now, sleep = (ms, signal) => delay(ms, undefined, { signal }) } = {}) {
  const nextStart = new Map();
  return async function waitForSlot(url, intervalMs = 0, signal) {
    signal?.throwIfAborted();
    if (intervalMs <= 0) return;
    const origin = new URL(url).origin;
    const currentTime = now();
    const start = Math.max(currentTime, nextStart.get(origin) ?? currentTime);
    // Reserve synchronously so concurrent collector jobs cannot take the same slot.
    nextStart.set(origin, start + intervalMs);
    if (start > currentTime) await sleep(start - currentTime, signal);
    signal?.throwIfAborted();
  };
}
