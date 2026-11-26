import { setTimeout as delay } from "node:timers/promises";

/**
 * Serializes request launches per origin in strict FIFO order and advances the next allowed
 * timestamp ONLY at actual post-wakeup release time.
 *
 * Cancelling a queued waiter rejects immediately for that caller while keeping its queue node
 * chained behind `prevTail` so later waiters can NEVER overtake an still-active predecessor.
 */
export function createOriginPacer({
  now = Date.now,
  sleep = (ms, signal) => delay(ms, undefined, { signal })
} = {}) {
  const nextAllowedAt = new Map();
  const tails = new Map();

  return async function waitForSlot(url, intervalMs = 0, signal) {
    signal?.throwIfAborted();
    if (intervalMs <= 0) return;

    const origin = new URL(url).origin;
    const prevTail = tails.get(origin) ?? Promise.resolve();

    let cancelled = false;
    let onAbort = null;
    const abortPromise = signal
      ? new Promise((_, reject) => {
          onAbort = () => {
            cancelled = true;
            reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
          };
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        })
      : null;
    abortPromise?.catch(() => {});

    let slotError = null;
    let slotAcquired = false;

    const myTurn = prevTail.then(async () => {
      if (cancelled || signal?.aborted) return;
      try {
        let target = nextAllowedAt.get(origin) ?? 0;
        let current = now();
        while (target > current) {
          await sleep(target - current, signal);
          signal?.throwIfAborted();
          current = now();
          target = nextAllowedAt.get(origin) ?? 0;
        }
        // Advance next allowed time strictly based on ACTUAL release time
        nextAllowedAt.set(origin, current + intervalMs);
        slotAcquired = true;
      } catch (err) {
        slotError = err;
      }
    });

    const nodeTail = myTurn.finally(() => {
      if (tails.get(origin) === nodeTail) {
        tails.delete(origin);
      }
    });
    tails.set(origin, nodeTail);

    try {
      if (abortPromise) {
        await Promise.race([nodeTail, abortPromise]);
      } else {
        await nodeTail;
      }
      signal?.throwIfAborted();
      if (slotError) throw slotError;
      if (!slotAcquired) {
        throw signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
      }
    } finally {
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  };
}
