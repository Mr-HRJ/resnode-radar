import { readFile, stat } from "node:fs/promises";
import { LatestPointerSchema } from "@resnode-radar/contracts/schemas";

/**
 * Non-blocking async reader for `data/v2/latest.json` with mtime/TTL caching.
 * Never touches SQLite or blocks the HTTP main event loop.
 */
export function createPulseReader({ latestJsonPath = "data/v2/latest.json", ttlMs = 500 } = {}) {
  let cachedPointer = null;
  let cachedMtimeMs = -1;
  let lastCheckedMs = 0;

  return async function readPulsePointer() {
    const now = Date.now();
    if (cachedPointer && now - lastCheckedMs < ttlMs) {
      return cachedPointer;
    }
    try {
      const st = await stat(latestJsonPath);
      lastCheckedMs = now;
      if (cachedPointer && st.mtimeMs === cachedMtimeMs) {
        return cachedPointer;
      }
      const raw = await readFile(latestJsonPath, "utf8");
      const parsed = LatestPointerSchema.parse(JSON.parse(raw));
      cachedPointer = parsed;
      cachedMtimeMs = st.mtimeMs;
      return parsed;
    } catch (err) {
      if (err?.code === "ENOENT") {
        cachedPointer = null;
        cachedMtimeMs = -1;
        return null;
      }
      throw err;
    }
  };
}
