export function createOriginPacer({ now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const nextStart = new Map();
  return async function waitForSlot(url, intervalMs = 0) {
    if (intervalMs <= 0) return;
    const origin = new URL(url).origin;
    const currentTime = now();
    const start = Math.max(currentTime, nextStart.get(origin) ?? currentTime);
    // Reserve synchronously so concurrent collector jobs cannot take the same slot.
    nextStart.set(origin, start + intervalMs);
    if (start > currentTime) await sleep(start - currentTime);
  };
}
