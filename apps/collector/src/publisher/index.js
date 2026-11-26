import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  DICT_VERSION,
  LatestPointerSchema,
  PublishJournalSchema,
  assertLosslessParity,
  formatSnapshotId,
  projectToCompact
} from "@resnode-radar/contracts";
import { withPublishLock } from "../lock.js";
import { validateMonitorPayload } from "../validate.js";

export const SNAPSHOT_HARD_CEILING_BYTES = 20 * 1024 * 1024;
export const AUDIT_HARD_CEILING_BYTES = 5 * 1024 * 1024;
export const SNAPSHOT_SOFT_WARN_GZIP_BYTES = 700 * 1024;
export const AUDIT_SOFT_WARN_GZIP_BYTES = 48 * 1024;

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fsyncDir(dirPath) {
  const fd = openSync(dirPath, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function atomicWriteAndSync(targetPath, content) {
  const dir = dirname(resolve(targetPath));
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  const tmpPath = `${resolve(targetPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;

  const fd = openSync(tmpPath, "wx", 0o644);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(tmpPath, resolve(targetPath));
  fsyncDir(dir);
  return bytes;
}

function writeSyncedJsonAndGzip(jsonPath, data, mtimeDate = new Date()) {
  const jsonBytes = Buffer.from(`${JSON.stringify(data)}\n`, "utf8");
  const gzBytes = gzipSync(jsonBytes, { level: 9 });
  const roundtrip = gunzipSync(gzBytes);
  if (!roundtrip.equals(jsonBytes)) {
    throw new Error(`Gzip round-trip integrity check failed for ${jsonPath}`);
  }

  const gzPath = `${jsonPath}.gz`;
  for (const [path, buf] of [
    [jsonPath, jsonBytes],
    [gzPath, gzBytes]
  ]) {
    const fd = openSync(path, "wx", 0o644);
    try {
      writeSync(fd, buf);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    utimesSync(path, mtimeDate, mtimeDate);
  }

  return { jsonBytes, gzBytes };
}

export function verifyPublishedSnapDir(snapDir, expectedSnapId, expectedSnapshotSha256 = null) {
  try {
    const snapJsonPath = join(snapDir, "snapshot.json");
    const snapGzPath = `${snapJsonPath}.gz`;
    if (!existsSync(snapJsonPath) || !existsSync(snapGzPath)) return false;

    const snapBytes = readFileSync(snapJsonPath);
    if (expectedSnapshotSha256 && sha256Hex(snapBytes) !== expectedSnapshotSha256) return false;
    if (!gunzipSync(readFileSync(snapGzPath)).equals(snapBytes)) return false;

    const compact = JSON.parse(snapBytes.toString("utf8"));
    if (compact.schemaVersion !== 2 || compact.snapshotId !== expectedSnapId) return false;

    for (const sourceId of Object.keys(compact.sources || {})) {
      const aJson = join(snapDir, "audit", `${sourceId}.json`);
      const aGz = `${aJson}.gz`;
      if (!existsSync(aJson) || !existsSync(aGz)) return false;
      const aBytes = readFileSync(aJson);
      if (!gunzipSync(readFileSync(aGz)).equals(aBytes)) return false;
      const aParsed = JSON.parse(aBytes.toString("utf8"));
      if (aParsed.snapshotId !== expectedSnapId || aParsed.sourceId !== sourceId) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function writeJournal(dataDir, entry) {
  const journalPath = join(dataDir, "v2/journal.json");
  const record = PublishJournalSchema.parse({
    schemaVersion: 2,
    ...entry,
    updatedAt: new Date().toISOString()
  });
  atomicWriteAndSync(journalPath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

function buildStagingDirectory(
  fullPayload,
  { dataDir, v1Sha256, snapId, observationsByProduct = new Map(), logger = console }
) {
  const stagingRoot = join(dataDir, ".staging");
  mkdirSync(stagingRoot, { recursive: true });
  const stagingDir = join(
    stagingRoot,
    `${snapId}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`
  );
  const auditDir = join(stagingDir, "audit");
  mkdirSync(auditDir, { recursive: true });

  const mtimeDate = new Date(Date.parse(fullPayload.publishedAt || fullPayload.generatedAt) || Date.now());
  try {
    const { snapshot, audits } = projectToCompact(fullPayload, {
      v1Sha256,
      snapshotId: snapId,
      observationsByProduct
    });

    const { jsonBytes: snapBytes, gzBytes: snapGz } = writeSyncedJsonAndGzip(
      join(stagingDir, "snapshot.json"),
      snapshot,
      mtimeDate
    );

    if (snapBytes.length > SNAPSHOT_HARD_CEILING_BYTES) {
      throw new Error(
        `CompactSnapshot exceeded hard safety ceiling (${snapBytes.length} > ${SNAPSHOT_HARD_CEILING_BYTES})`
      );
    }
    if (snapGz.length > SNAPSHOT_SOFT_WARN_GZIP_BYTES) {
      logger.warn?.(
        `[publisher] Soft budget warning: snapshot.json.gz is ${(snapGz.length / 1024).toFixed(1)} KiB`
      );
    }

    assertLosslessParity(fullPayload, snapBytes);

    for (const [sourceId, auditPayload] of audits.entries()) {
      const { jsonBytes: aBytes, gzBytes: aGz } = writeSyncedJsonAndGzip(
        join(auditDir, `${sourceId}.json`),
        auditPayload,
        mtimeDate
      );
      if (aBytes.length > AUDIT_HARD_CEILING_BYTES) {
        throw new Error(`Audit shard ${sourceId} exceeded hard safety ceiling (${aBytes.length})`);
      }
      if (aGz.length > AUDIT_SOFT_WARN_GZIP_BYTES) {
        logger.warn?.(
          `[publisher] Soft budget warning: audit/${sourceId}.json.gz is ${(aGz.length / 1024).toFixed(1)} KiB`
        );
      }
    }

    fsyncDir(auditDir);
    fsyncDir(stagingDir);
    fsyncDir(stagingRoot);

    return {
      stagingDir,
      snapshotSha256: sha256Hex(snapBytes),
      snapshotGzipBytes: snapGz.length
    };
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Safely publishes a verified staging directory to `data/snapshots/<snapId>`.
 * Handles non-empty corrupt existing directories via `.quarantine` move + parent dir fsync
 * to prevent Linux rename(2) ENOTEMPTY/EEXIST failures across recovery cycles.
 */
export function publishVerifiedSnapDir({
  dataDir,
  snapId,
  v1Sha256,
  generatedAt,
  stagingDir,
  snapshotSha256,
  onQuarantined
}) {
  const snapshotsRoot = join(dataDir, "snapshots");
  mkdirSync(snapshotsRoot, { recursive: true });
  const finalDir = join(snapshotsRoot, snapId);

  if (!existsSync(finalDir)) {
    renameSync(stagingDir, finalDir);
    fsyncDir(dirname(stagingDir));
    fsyncDir(snapshotsRoot);
    return { reused: false, quarantined: null };
  }

  if (verifyPublishedSnapDir(finalDir, snapId, snapshotSha256)) {
    rmSync(stagingDir, { recursive: true, force: true });
    fsyncDir(dirname(stagingDir));
    return { reused: true, quarantined: null };
  }

  // Existing directory is corrupt or incomplete -> isolate into .quarantine before replacing
  const quarantineRoot = join(dataDir, ".quarantine");
  mkdirSync(quarantineRoot, { recursive: true });
  const quarantineDir = join(
    quarantineRoot,
    `${snapId}.${Date.now()}.${process.pid}.${Math.random().toString(16).slice(2, 8)}`
  );

  writeJournal(dataDir, {
    snapId,
    generatedAt,
    v1Sha256,
    snapshotSha256,
    state: "quarantining",
    quarantineDir
  });

  renameSync(finalDir, quarantineDir);
  fsyncDir(quarantineRoot);
  fsyncDir(snapshotsRoot);

  if (typeof onQuarantined === "function") {
    onQuarantined({ finalDir, quarantineDir });
  }

  renameSync(stagingDir, finalDir);
  fsyncDir(dirname(stagingDir));
  fsyncDir(snapshotsRoot);
  return { reused: false, quarantined: quarantineDir };
}

function writeLatestPointer(dataDir, { snapId, v1Sha256, generatedAt, publishedAt }) {
  const pointer = LatestPointerSchema.parse({
    schemaVersion: 2,
    dictVersion: DICT_VERSION,
    mode: "v2",
    snapshotId: snapId,
    v1Sha256,
    generatedAt,
    publishedAt: publishedAt || generatedAt,
    snapshotPath: `data/snapshots/${snapId}/snapshot.json`,
    auditDirPath: `data/snapshots/${snapId}/audit`
  });
  atomicWriteAndSync(join(dataDir, "v2/latest.json"), `${JSON.stringify(pointer, null, 2)}\n`);
  return pointer;
}

/**
 * Garbage-collects expired immutable snapshots (>24h or beyond maxSnapshots),
 * stale .staging (>30m), and .quarantine (>10m) ONLY while journal is completed.
 * Must be called inside `.publish.lock`.
 */
export function collectGarbageUnlocked(
  dataDir,
  {
    activeSnapId,
    protectedSnapIds = [],
    retainHours = 24,
    maxSnapshots = 96,
    nowMs = Date.now(),
    quarantineMaxAgeMs = 10 * 60_000,
    stagingMaxAgeMs = 30 * 60_000
  } = {}
) {
  let journalCompleted = true;
  const journalPath = join(dataDir, "v2/journal.json");
  if (existsSync(journalPath)) {
    try {
      const j = JSON.parse(readFileSync(journalPath, "utf8"));
      journalCompleted = j.state === "completed";
    } catch {
      journalCompleted = false;
    }
  }
  if (!journalCompleted) return { removedSnapshots: 0 };

  const keep = new Set([activeSnapId, ...protectedSnapIds].filter(Boolean));
  const snapshotsRoot = join(dataDir, "snapshots");
  let removedSnapshots = 0;

  if (existsSync(snapshotsRoot)) {
    const entries = readdirSync(snapshotsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("snap_"))
      .map((d) => {
        const parts = d.name.split("_");
        const ts = Number(parts[1]);
        const full = join(snapshotsRoot, d.name);
        const mtimeMs = Number.isFinite(ts) ? ts : statSync(full).mtimeMs;
        return { name: d.name, full, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    // Always protect the two newest snapshots (current + immediate predecessor)
    for (const item of entries.slice(0, 2)) keep.add(item.name);

    const cutoffMs = nowMs - retainHours * 3600_000;
    entries.forEach((item, idx) => {
      if (keep.has(item.name)) return;
      if (idx >= maxSnapshots || item.mtimeMs < cutoffMs) {
        rmSync(item.full, { recursive: true, force: true });
        removedSnapshots += 1;
      }
    });
    if (removedSnapshots > 0) fsyncDir(snapshotsRoot);
  }

  for (const [sub, maxAge] of [
    [".quarantine", quarantineMaxAgeMs],
    [".staging", stagingMaxAgeMs]
  ]) {
    const dir = join(dataDir, sub);
    if (!existsSync(dir)) continue;
    let changed = false;
    for (const entry of readdirSync(dir)) {
      const target = join(dir, entry);
      try {
        if (nowMs - statSync(target).mtimeMs >= maxAge) {
          rmSync(target, { recursive: true, force: true });
          changed = true;
        }
      } catch {
        // ignore concurrent disappearance
      }
    }
    if (changed) fsyncDir(dir);
  }

  return { removedSnapshots };
}

/**
 * Idempotent pre-cycle & startup recovery state machine.
 * Reconciles `data/v2/latest.json` and `data/snapshots/<expectedSnapId>/` against
 * the authoritative committed `data/products.json`.
 */
export async function reconcilePublishedState({
  dataDir = "data",
  v1OutputPath = join(dataDir, "products.json"),
  logger = console,
  hooks = {}
} = {}) {
  const lockPath = join(dataDir, ".publish.lock");
  return withPublishLock(lockPath, async () => {
    if (!existsSync(v1OutputPath)) {
      return { action: "no_v1_baseline" };
    }

    let v1Bytes;
    let v1Payload;
    try {
      v1Bytes = readFileSync(v1OutputPath);
      v1Payload = JSON.parse(v1Bytes.toString("utf8"));
    } catch (err) {
      logger.warn?.(`[reconcile] Unable to parse ${v1OutputPath}: ${err.message}`);
      return { action: "invalid_v1_baseline" };
    }

    const v1Errors = validateMonitorPayload(v1Payload);
    if (v1Errors.length > 0) {
      logger.warn?.(`[reconcile] Skipping invalid v1 baseline: ${v1Errors[0]}`);
      return { action: "invalid_v1_baseline", errors: v1Errors };
    }

    // Respect explicit v1-fallback rollback mode if set intentionally by rollback.sh
    const latestPath = join(dataDir, "v2/latest.json");
    if (existsSync(latestPath)) {
      try {
        const rawLatest = JSON.parse(readFileSync(latestPath, "utf8"));
        if (rawLatest?.mode === "v1-fallback") {
          return { action: "v1_fallback_preserved", baseline: v1Payload };
        }
      } catch {
        // Corrupt latest.json -> proceed to repair below
      }
    }

    const actualV1Sha256 = sha256Hex(v1Bytes);
    const expectedSnapId = formatSnapshotId(v1Payload.generatedAt, actualV1Sha256);
    const expectedSnapDir = join(dataDir, "snapshots", expectedSnapId);

    let latestValid = false;
    if (existsSync(latestPath)) {
      try {
        const parsedLatest = LatestPointerSchema.parse(JSON.parse(readFileSync(latestPath, "utf8")));
        latestValid =
          parsedLatest.mode === "v2" &&
          parsedLatest.snapshotId === expectedSnapId &&
          parsedLatest.v1Sha256 === actualV1Sha256;
      } catch {
        latestValid = false;
      }
    }

    const dirValid = verifyPublishedSnapDir(expectedSnapDir, expectedSnapId);
    let journalValid = false;
    const journalPath = join(dataDir, "v2/journal.json");
    if (existsSync(journalPath)) {
      try {
        const j = JSON.parse(readFileSync(journalPath, "utf8"));
        journalValid = j?.state === "completed" && j?.snapId === expectedSnapId;
      } catch {
        journalValid = false;
      }
    }

    if (latestValid && dirValid) {
      if (!journalValid) {
        writeJournal(dataDir, {
          snapId: expectedSnapId,
          generatedAt: v1Payload.generatedAt,
          v1Sha256: actualV1Sha256,
          state: "completed"
        });
      }
      collectGarbageUnlocked(dataDir, { activeSnapId: expectedSnapId });
      return {
        action: journalValid ? "clean" : "repaired",
        snapshotId: expectedSnapId,
        baseline: v1Payload
      };
    }

    // Repair needed: reuse verified dir if already intact, else stage + publish (with quarantine if corrupt)
    if (!dirValid) {
      const staged = buildStagingDirectory(v1Payload, {
        dataDir,
        v1Sha256: actualV1Sha256,
        snapId: expectedSnapId,
        logger
      });
      writeJournal(dataDir, {
        snapId: expectedSnapId,
        generatedAt: v1Payload.generatedAt,
        v1Sha256: actualV1Sha256,
        snapshotSha256: staged.snapshotSha256,
        state: "staged"
      });
      publishVerifiedSnapDir({
        dataDir,
        snapId: expectedSnapId,
        v1Sha256: actualV1Sha256,
        generatedAt: v1Payload.generatedAt,
        stagingDir: staged.stagingDir,
        snapshotSha256: staged.snapshotSha256,
        onQuarantined: hooks.onQuarantined
      });
      writeJournal(dataDir, {
        snapId: expectedSnapId,
        generatedAt: v1Payload.generatedAt,
        v1Sha256: actualV1Sha256,
        snapshotSha256: staged.snapshotSha256,
        state: "snapshot_published"
      });
    }

    if (typeof hooks.beforeLatestCommit === "function") {
      hooks.beforeLatestCommit();
    }

    writeLatestPointer(dataDir, {
      snapId: expectedSnapId,
      v1Sha256: actualV1Sha256,
      generatedAt: v1Payload.generatedAt,
      publishedAt: v1Payload.publishedAt || v1Payload.generatedAt
    });
    writeJournal(dataDir, {
      snapId: expectedSnapId,
      generatedAt: v1Payload.generatedAt,
      v1Sha256: actualV1Sha256,
      state: "completed"
    });
    collectGarbageUnlocked(dataDir, { activeSnapId: expectedSnapId });
    logger.log?.(`[reconcile] Repaired v2 state -> ${expectedSnapId}`);

    return { action: "repaired", snapshotId: expectedSnapId, baseline: v1Payload };
  });
}

/**
 * Full 4-phase transactional publish of a newly collected batch:
 * Phase A (`staged`) -> Phase B (`snapshot_published`) -> Phase C (`v1_committed`) -> Phase D (`completed`)
 */
export async function publishBatch({
  fullPayload,
  dataDir = "data",
  v1OutputPath = join(dataDir, "products.json"),
  expectedSourceIds,
  observationsByProduct = new Map(),
  retainHours = 24,
  maxSnapshots = 96,
  logger = console,
  hooks = {}
} = {}) {
  const lockPath = join(dataDir, ".publish.lock");
  return withPublishLock(lockPath, async () => {
    const errors = validateMonitorPayload(fullPayload, { expectedSourceIds });
    if (errors.length > 0) {
      throw new Error(`Monitor data validation failed: ${errors.slice(0, 5).join("; ")}`);
    }

    const v1Bytes = Buffer.from(`${JSON.stringify(fullPayload, null, 2)}\n`, "utf8");
    const v1Sha256 = sha256Hex(v1Bytes);
    const snapId = formatSnapshotId(fullPayload.generatedAt, v1Sha256);

    let prevSnapId = null;
    const latestPath = join(dataDir, "v2/latest.json");
    if (existsSync(latestPath)) {
      try {
        prevSnapId = JSON.parse(readFileSync(latestPath, "utf8"))?.snapshotId || null;
      } catch {
        prevSnapId = null;
      }
    }

    // Phase A: Stage & verify
    const staged = buildStagingDirectory(fullPayload, {
      dataDir,
      v1Sha256,
      snapId,
      observationsByProduct,
      logger
    });
    writeJournal(dataDir, {
      snapId,
      generatedAt: fullPayload.generatedAt,
      v1Sha256,
      snapshotSha256: staged.snapshotSha256,
      state: "staged"
    });

    if (typeof hooks.afterStage === "function") hooks.afterStage({ snapId });

    // Phase B: Publish immutable snapshot directory
    publishVerifiedSnapDir({
      dataDir,
      snapId,
      v1Sha256,
      generatedAt: fullPayload.generatedAt,
      stagingDir: staged.stagingDir,
      snapshotSha256: staged.snapshotSha256,
      onQuarantined: hooks.onQuarantined
    });
    writeJournal(dataDir, {
      snapId,
      generatedAt: fullPayload.generatedAt,
      v1Sha256,
      snapshotSha256: staged.snapshotSha256,
      state: "snapshot_published"
    });

    if (typeof hooks.afterSnapPublished === "function") hooks.afterSnapPublished({ snapId });

    // Phase C: Commit authoritative v1 baseline
    atomicWriteAndSync(v1OutputPath, v1Bytes);
    writeJournal(dataDir, {
      snapId,
      generatedAt: fullPayload.generatedAt,
      v1Sha256,
      snapshotSha256: staged.snapshotSha256,
      state: "v1_committed"
    });

    if (typeof hooks.afterV1Committed === "function") hooks.afterV1Committed({ snapId });

    // Phase D: Commit v2 latest pointer & complete journal
    const pointer = writeLatestPointer(dataDir, {
      snapId,
      v1Sha256,
      generatedAt: fullPayload.generatedAt,
      publishedAt: fullPayload.publishedAt || fullPayload.generatedAt
    });
    writeJournal(dataDir, {
      snapId,
      generatedAt: fullPayload.generatedAt,
      v1Sha256,
      snapshotSha256: staged.snapshotSha256,
      state: "completed"
    });

    collectGarbageUnlocked(dataDir, {
      activeSnapId: snapId,
      protectedSnapIds: prevSnapId ? [prevSnapId] : [],
      retainHours,
      maxSnapshots
    });

    return {
      snapshotId: snapId,
      v1Sha256,
      snapshotGzipBytes: staged.snapshotGzipBytes,
      pointer
    };
  });
}

/**
 * Seeds initial v2 immutable snapshot & latest.json directly from an existing validated
 * v1 `products.json` without crawling any upstream providers, preserving original `generatedAt`.
 */
export async function seedV2FromV1({
  dataDir = "data",
  v1OutputPath = join(dataDir, "products.json"),
  logger = console
} = {}) {
  const lockPath = join(dataDir, ".publish.lock");
  return withPublishLock(lockPath, async () => {
    if (!existsSync(v1OutputPath)) {
      throw new Error(`Cannot seed v2: v1 baseline file not found at ${v1OutputPath}`);
    }
    const v1Bytes = readFileSync(v1OutputPath);
    const v1Payload = JSON.parse(v1Bytes.toString("utf8"));
    const errors = validateMonitorPayload(v1Payload);
    if (errors.length > 0) {
      throw new Error(`Cannot seed v2 from invalid v1 payload: ${errors.slice(0, 5).join("; ")}`);
    }

    const v1Sha256 = sha256Hex(v1Bytes);
    const snapId = formatSnapshotId(v1Payload.generatedAt, v1Sha256);
    const staged = buildStagingDirectory(v1Payload, {
      dataDir,
      v1Sha256,
      snapId,
      logger
    });
    writeJournal(dataDir, {
      snapId,
      generatedAt: v1Payload.generatedAt,
      v1Sha256,
      snapshotSha256: staged.snapshotSha256,
      state: "staged"
    });
    publishVerifiedSnapDir({
      dataDir,
      snapId,
      v1Sha256,
      generatedAt: v1Payload.generatedAt,
      stagingDir: staged.stagingDir,
      snapshotSha256: staged.snapshotSha256
    });
    const pointer = writeLatestPointer(dataDir, {
      snapId,
      v1Sha256,
      generatedAt: v1Payload.generatedAt,
      publishedAt: v1Payload.publishedAt || v1Payload.generatedAt
    });
    writeJournal(dataDir, {
      snapId,
      generatedAt: v1Payload.generatedAt,
      v1Sha256,
      snapshotSha256: staged.snapshotSha256,
      state: "completed"
    });
    logger.log?.(`[seed-v2] Seeded ${snapId} from ${v1OutputPath} (generatedAt=${v1Payload.generatedAt})`);
    return { snapshotId: snapId, v1Sha256, pointer };
  });
}

/**
 * Used during rollback to v1 so any already-open v2 browser tabs immediately
 * switch their active transport back to `data/products.json`.
 */
export async function writeV1FallbackPointer({ dataDir = "data", logger = console } = {}) {
  const lockPath = join(dataDir, ".publish.lock");
  return withPublishLock(lockPath, async () => {
    const pointer = LatestPointerSchema.parse({
      schemaVersion: 2,
      mode: "v1-fallback",
      updatedAt: new Date().toISOString(),
      fallbackPath: "data/products.json"
    });
    atomicWriteAndSync(join(dataDir, "v2/latest.json"), `${JSON.stringify(pointer, null, 2)}\n`);
    logger.log?.("[rollback] Wrote mode=v1-fallback to data/v2/latest.json");
    return pointer;
  });
}

export function clearFallbackPointerPath(dataDir = "data") {
  const p = join(dataDir, "v2/latest.json");
  if (existsSync(p)) {
    unlinkSync(p);
    fsyncDir(dirname(resolve(p)));
  }
}
