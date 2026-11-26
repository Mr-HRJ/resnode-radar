import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  CompactSnapshotSchema,
  LatestPointerSchema,
  SourceAuditSchema,
  assertLosslessParity,
  formatSnapshotId
} from "@resnode-radar/contracts";
import {
  eventLimit,
  isEventTracking,
  isRadarEvent,
  retentionDays,
  timestampMs
} from "./events/radar-events.js";
import { isFxSnapshot } from "./fx/fx-rates.js";

const validStatuses = new Set(["available", "unavailable", "unknown", "blocked", "error"]);
const validEvidenceLevels = new Set([
  "error",
  "unavailable",
  "stock-count",
  "snapshot",
  "blocked",
  "official-order",
  "unverified"
]);

export function validateMonitorPayload(payload, { expectedSourceIds } = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!payload || typeof payload !== "object") return ["payload must be an object"];
  const generatedAt = timestampMs(payload.generatedAt);
  if (payload.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (!Number.isFinite(generatedAt)) fail("generatedAt must be an ISO date");
  const publishedAt =
    payload.publishedAt === undefined ? generatedAt : timestampMs(payload.publishedAt);
  if (!Number.isFinite(publishedAt) || publishedAt < generatedAt) {
    fail("publishedAt must follow generatedAt");
  }
  if (!Array.isArray(payload.products)) fail("products must be an array");
  if (!payload.products?.length) fail("products must not be empty");

  const productIds = new Set();
  const sourceIds = new Set();
  const counts = { total: 0, available: 0, unavailable: 0, unknown: 0, blocked: 0, error: 0 };
  for (const product of Array.isArray(payload.products) ? payload.products : []) {
    if (!product || typeof product !== "object") {
      fail("product must be an object");
      continue;
    }
    for (const field of [
      "id",
      "sourceId",
      "provider",
      "category",
      "adapter",
      "sourceUrl",
      "fetchedAt",
      "status",
      "statusLabel",
      "evidence"
    ]) {
      if (product[field] === undefined || product[field] === null || product[field] === "") {
        fail(`product ${product.id ?? "<unknown>"} missing ${field}`);
      }
    }
    if (!validStatuses.has(product.status)) {
      fail(`product ${product.id} has invalid status ${product.status}`);
    }
    if (productIds.has(product.id)) fail(`duplicate product ${product.id}`);
    productIds.add(product.id);
    sourceIds.add(product.sourceId);
    counts.total += 1;
    if (validStatuses.has(product.status)) counts[product.status] += 1;
    if (timestampMs(product.fetchedAt) !== generatedAt) {
      fail(`product ${product.id} must belong to the current collection`);
    }
    if (product.verification) {
      const v = product.verification;
      if (!["verified", "unverified", "historical"].includes(v.state)) {
        fail(`product ${product.id} has invalid verification state`);
      }
      if (!["observed", "reference", "historical"].includes(v.priceKind)) {
        fail(`product ${product.id} has invalid price kind`);
      }
      for (const key of ["observedAt", "attemptedAt", "verifiedAt"]) {
        if (
          v[key] != null &&
          (!Number.isFinite(timestampMs(v[key])) || timestampMs(v[key]) > publishedAt)
        ) {
          fail(`product ${product.id} has invalid ${key}`);
        }
      }
      if (
        v.state === "verified" &&
        (!v.verifiedAt || !["available", "unavailable"].includes(product.status))
      ) {
        fail(`product ${product.id} verification contradicts stock`);
      }
      if (
        v.state === "historical" &&
        (product.status !== "unknown" || product.stockCount != null || !product.raw?.historical)
      ) {
        fail(`product ${product.id} historical data must not claim live stock`);
      }
    }
    if (
      product.stockCount != null &&
      (!Number.isSafeInteger(product.stockCount) || product.stockCount < 0)
    ) {
      fail(`product ${product.id} has invalid stockCount`);
    }
    if (product.status === "available" && product.stockCount === 0) {
      fail(`available product ${product.id} has zero stock`);
    }
    if (product.status === "available" && !product.orderUrl) {
      fail(`available product ${product.id} must include orderUrl`);
    }
    if (!product.evidenceLevel || typeof product.evidenceLevel !== "object") {
      fail(`product ${product.id} missing evidenceLevel`);
    }
    if (product.evidenceLevel && !validEvidenceLevels.has(product.evidenceLevel.value)) {
      fail(`product ${product.id} has invalid evidenceLevel ${product.evidenceLevel.value}`);
    }
    if (!product.evidenceLevel?.label) fail(`product ${product.id} missing evidenceLevel.label`);
    if (!product.evidenceLevel?.className) {
      fail(`product ${product.id} missing evidenceLevel.className`);
    }
    if (!Array.isArray(product.riskTags)) fail(`product ${product.id} riskTags must be an array`);
    if (Array.isArray(product.riskTags) && product.riskTags.length === 0) {
      fail(`product ${product.id} riskTags must not be empty`);
    }
    for (const tag of Array.isArray(product.riskTags) ? product.riskTags : []) {
      if (!tag?.value || !tag?.label || !tag?.severity) {
        fail(`product ${product.id} has invalid risk tag`);
      }
    }
    if (
      product.status !== "available" &&
      product.status !== "unavailable" &&
      !product.error &&
      !product.evidence
    ) {
      fail(`non-available product ${product.id} must include evidence or error`);
    }
  }
  if (!Number.isSafeInteger(payload.sourceCount) || payload.sourceCount !== sourceIds.size) {
    fail("sourceCount must match collected sources");
  }
  for (const [key, value] of Object.entries(counts)) {
    if (payload.summary?.[key] !== value) fail(`summary.${key} must match products`);
  }
  if (expectedSourceIds) {
    const expected = new Set(expectedSourceIds);
    for (const id of expected) if (!sourceIds.has(id)) fail(`missing source ${id}`);
    for (const id of sourceIds) if (!expected.has(id)) fail(`unexpected source ${id}`);
  }

  if (!isEventTracking(payload.eventTracking, payload.generatedAt)) {
    fail("eventTracking must have a valid startedAt, retentionDays: 7 and limit: 300");
  }
  if (!Array.isArray(payload.events)) fail("events must be an array");
  if (payload.events?.length > eventLimit) {
    fail(`events must contain at most ${eventLimit} entries`);
  }
  const seen = new Set();
  let lastTime = Infinity;
  for (const event of Array.isArray(payload.events) ? payload.events : []) {
    if (!isRadarEvent(event)) {
      fail("events contains an invalid event");
      continue;
    }
    const time = timestampMs(event.at);
    if (
      time > generatedAt ||
      time < generatedAt - retentionDays * 86_400_000 ||
      time < timestampMs(payload.eventTracking?.startedAt)
    ) {
      fail(`event ${event.id} is outside the tracked retention window`);
    }
    if (time > lastTime) fail("events must be ordered newest first");
    lastTime = time;
    const key = `${time}|${event.type}|${event.productId}`;
    if (seen.has(key)) fail(`duplicate event ${event.id}`);
    seen.add(key);
  }
  if (payload.exchangeRates !== undefined && !isFxSnapshot(payload.exchangeRates)) {
    fail("exchangeRates must be a valid CNY reference-rate snapshot");
  }
  if (payload.sourceHealth !== undefined) {
    if (!Array.isArray(payload.sourceHealth)) fail("sourceHealth must be an array");
    else {
      for (const source of payload.sourceHealth) {
        if (
          !sourceIds.has(source.id) ||
          !["ok", "partial", "unknown", "blocked", "error"].includes(source.status)
        ) {
          fail("sourceHealth contains an invalid source");
        }
        if (
          !Number.isFinite(timestampMs(source.lastAttemptAt)) ||
          timestampMs(source.lastAttemptAt) > publishedAt
        ) {
          fail("sourceHealth contains an invalid attempt time");
        }
      }
    }
  }
  if (payload.announcements !== undefined) {
    const a = payload.announcements;
    const https = (value) => {
      try {
        const u = new URL(value);
        return u.protocol === "https:" && !u.username && !u.password;
      } catch {
        return false;
      }
    };
    if (!Array.isArray(a?.items) || !Array.isArray(a?.sources) || a.items.length > 100) {
      fail("announcements must contain bounded items and sources");
    }
    const announcementIds = new Set();
    for (const item of a?.items ?? []) {
      if (
        !item.id ||
        announcementIds.has(item.id) ||
        !item.title ||
        !https(item.url) ||
        !["official", "third-party"].includes(item.trust)
      ) {
        fail("invalid announcement provenance");
      }
      announcementIds.add(item.id);
      if (item.publishedAt !== null && !Number.isFinite(timestampMs(item.publishedAt))) {
        fail("invalid announcement publication time");
      }
      if (
        !Number.isFinite(timestampMs(item.observedAt)) ||
        timestampMs(item.observedAt) > publishedAt
      ) {
        fail("invalid announcement observation time");
      }
      for (const candidate of item.candidates ?? []) {
        if (
          !sourceIds.has(candidate.sourceId) ||
          !https(candidate.url) ||
          !["pending", "verified", "blocked", "unmatched"].includes(candidate.verification?.state)
        ) {
          fail("invalid announcement verification");
        }
      }
    }
  }
  return errors;
}

/**
 * Validates published v2 pointer, immutable snapshot directory, gzip round-trip
 * byte identity, audit shard completeness, and lossless business parity with v1.
 */
export function validateV2PublishedData({
  dataDir = "data",
  fullPayload,
  v1Bytes,
  v1OutputPath = join(dataDir, "products.json")
} = {}) {
  const errors = [];
  const latestPath = join(dataDir, "v2/latest.json");
  if (!existsSync(latestPath)) return errors;

  try {
    const latestRaw = JSON.parse(readFileSync(latestPath, "utf8"));
    const latest = LatestPointerSchema.parse(latestRaw);
    if (latest.mode === "v1-fallback") {
      return errors;
    }

    const resolvedV1Bytes =
      v1Bytes ?? (existsSync(v1OutputPath) ? readFileSync(v1OutputPath) : null);
    const v1GzPath = `${v1OutputPath}.gz`;
    if (resolvedV1Bytes) {
      if (!existsSync(v1GzPath)) {
        errors.push(`Missing v1 gzip file ${v1GzPath}`);
      } else {
        const v1Unz = gunzipSync(readFileSync(v1GzPath));
        if (!resolvedV1Bytes.equals(v1Unz)) {
          errors.push("products.json.gz decompression does not match products.json bytes");
        }
      }
    }

    const expectedSha = resolvedV1Bytes
      ? createHash("sha256").update(resolvedV1Bytes).digest("hex")
      : latest.v1Sha256;
    if (resolvedV1Bytes && latest.v1Sha256 !== expectedSha) {
      errors.push(`v2 latest.v1Sha256 (${latest.v1Sha256}) !== products.json sha256 (${expectedSha})`);
    }
    if (fullPayload) {
      const expectedSnapId = formatSnapshotId(fullPayload.generatedAt, expectedSha);
      if (latest.snapshotId !== expectedSnapId) {
        errors.push(`v2 latest.snapshotId (${latest.snapshotId}) !== expected (${expectedSnapId})`);
      }
    }

    const snapDir = join(dataDir, "snapshots", latest.snapshotId);
    const snapJsonPath = join(snapDir, "snapshot.json");
    const snapGzPath = `${snapJsonPath}.gz`;
    if (!existsSync(snapJsonPath) || !existsSync(snapGzPath)) {
      errors.push(`Missing snapshot.json or snapshot.json.gz in ${snapDir}`);
      return errors;
    }

    const snapBytes = readFileSync(snapJsonPath);
    const unzBytes = gunzipSync(readFileSync(snapGzPath));
    if (!snapBytes.equals(unzBytes)) {
      errors.push("snapshot.json.gz decompression does not match snapshot.json bytes");
    }

    const compact = CompactSnapshotSchema.parse(JSON.parse(snapBytes.toString("utf8")));
    if (compact.snapshotId !== latest.snapshotId) {
      errors.push("snapshot.json snapshotId mismatch with latest.json");
    }

    for (const sourceId of Object.keys(compact.sources)) {
      const auditJsonPath = join(snapDir, "audit", `${sourceId}.json`);
      const auditGzPath = `${auditJsonPath}.gz`;
      if (!existsSync(auditJsonPath) || !existsSync(auditGzPath)) {
        errors.push(`Missing audit shard or .gz for source ${sourceId}`);
        continue;
      }
      const auditBytes = readFileSync(auditJsonPath);
      const auditUnz = gunzipSync(readFileSync(auditGzPath));
      if (!auditBytes.equals(auditUnz)) {
        errors.push(`Audit .gz byte mismatch for source ${sourceId}`);
      }
      const auditParsed = SourceAuditSchema.parse(JSON.parse(auditBytes.toString("utf8")));
      if (auditParsed.snapshotId !== latest.snapshotId || auditParsed.sourceId !== sourceId) {
        errors.push(`Audit metadata mismatch for source ${sourceId}`);
      }
    }

    if (fullPayload) {
      assertLosslessParity(fullPayload, snapBytes);
    }
  } catch (err) {
    errors.push(`v2 validation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return errors;
}
