import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function tryAcquireEvictGuard(guardDir, staleGuardMs = 10_000) {
  try {
    mkdirSync(guardDir);
    return true;
  } catch (err) {
    if (err?.code !== "EEXIST") return false;
    try {
      const st = statSync(guardDir);
      if (Date.now() - st.mtimeMs > staleGuardMs) {
        rmdirSync(guardDir);
        mkdirSync(guardDir);
        return true;
      }
    } catch {
      // Another process is actively evicting or already cleaned up
    }
    return false;
  }
}

function inspectLockState(lockPath, staleMs, initGraceMs) {
  let st;
  try {
    st = statSync(lockPath);
  } catch (err) {
    if (err?.code === "ENOENT") return { absent: true, evictable: false, ino: null };
    throw err;
  }

  try {
    const raw = readFileSync(lockPath, "utf8");
    if (!raw.trim()) {
      // Empty file may be an external caller still initializing; never evict within initGraceMs!
      const fileAge = Date.now() - st.mtimeMs;
      return { absent: false, evictable: fileAge > initGraceMs, ino: st.ino };
    }
    const existing = JSON.parse(raw);
    const holderAge = Date.now() - Number(existing?.acquiredAt || st.mtimeMs);
    const deadOrStale = !isPidAlive(existing?.pid) || holderAge > staleMs;
    return {
      absent: false,
      evictable: deadOrStale,
      ino: st.ino,
      token: existing?.token ?? null
    };
  } catch {
    // Partial write or malformed JSON: wait out initGraceMs before treating as abandoned corrupt file
    const fileAge = Date.now() - st.mtimeMs;
    return { absent: false, evictable: fileAge > initGraceMs, ino: st.ino };
  }
}

/**
 * Single-writer exclusive file lock protecting publish transactions,
 * pre-cycle reconciliation, --seed-v2-from-v1, and snapshot GC.
 *
 * Uses write+fsync to a private temp file followed by atomic POSIX `link(2)` so `lockPath`
 * is born complete (zero initialization window), refuses to evict initializing locks,
 * and serializes stale-lock eviction by inode check.
 */
export async function withPublishLock(
  lockPath,
  action,
  {
    timeoutMs = 60_000,
    retryMs = 50,
    staleMs = 15 * 60_000,
    initGraceMs = Math.min(staleMs, 10_000),
    hooks = null
  } = {}
) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 10)}`;
  const token = `${process.pid}:${nonce}`;
  const evictGuardDir = `${lockPath}.evict`;

  let acquired = false;
  let acquiredIno = null;

  while (!acquired) {
    const tmpPath = `${lockPath}.tmp.${nonce}`;
    try {
      const fd = openSync(tmpPath, "wx", 0o600);
      try {
        const body = JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() });
        writeSync(fd, body);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }

      if (hooks?.beforeLink) {
        await hooks.beforeLink({ tmpPath, lockPath });
      }

      linkSync(tmpPath, lockPath);
      acquiredIno = statSync(lockPath).ino;
      acquired = true;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;

      const observed = inspectLockState(lockPath, staleMs, initGraceMs);
      if (observed.absent) continue;

      if (observed.evictable && tryAcquireEvictGuard(evictGuardDir)) {
        try {
          const recheck = inspectLockState(lockPath, staleMs, initGraceMs);
          if (!recheck.absent && recheck.evictable && recheck.ino === observed.ino) {
            try {
              unlinkSync(lockPath);
            } catch (unlinkErr) {
              if (unlinkErr?.code !== "ENOENT") throw unlinkErr;
            }
            continue;
          }
        } finally {
          try {
            rmdirSync(evictGuardDir);
          } catch {
            // ignore
          }
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for single-writer publish lock: ${lockPath}`);
      }
      await delay(retryMs);
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Temp staging file already removed
      }
    }
  }

  if (hooks?.afterAcquire) {
    await hooks.afterAcquire({ lockPath, token, ino: acquiredIno });
  }

  try {
    return await action();
  } finally {
    try {
      const st = statSync(lockPath);
      if (st.ino === acquiredIno) {
        const current = JSON.parse(readFileSync(lockPath, "utf8"));
        if (current?.token === token) {
          unlinkSync(lockPath);
        }
      }
    } catch {
      // Already cleaned or absent
    }
  }
}
