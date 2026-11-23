import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { eventLimit, isEventTracking, isRadarEvent, retentionDays, timestampMs } from "./radar-events.mjs";
import { isFxSnapshot } from "./fx-rates.mjs";

const validStatuses = new Set(["available", "unavailable", "unknown", "blocked", "error"]);
const validEvidenceLevels = new Set(["error", "unavailable", "stock-count", "snapshot", "blocked", "official-order", "unverified"]);

export function validateMonitorPayload(payload, { expectedSourceIds } = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!payload || typeof payload !== "object") return ["payload must be an object"];
  const generatedAt = timestampMs(payload.generatedAt);
  if (payload.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (!Number.isFinite(generatedAt)) fail("generatedAt must be an ISO date");
  const publishedAt = payload.publishedAt === undefined ? generatedAt : timestampMs(payload.publishedAt);
  if (!Number.isFinite(publishedAt) || publishedAt < generatedAt) fail("publishedAt must follow generatedAt");
  if (!Array.isArray(payload.products)) fail("products must be an array");
  if (!payload.products?.length) fail("products must not be empty");

  const productIds = new Set();
  const sourceIds = new Set();
  const counts = { total: 0, available: 0, unavailable: 0, unknown: 0, blocked: 0, error: 0 };
  for (const product of Array.isArray(payload.products) ? payload.products : []) {
    if (!product || typeof product !== "object") { fail("product must be an object"); continue; }
    for (const field of ["id", "sourceId", "provider", "category", "adapter", "sourceUrl", "fetchedAt", "status", "statusLabel", "evidence"]) {
      if (product[field] === undefined || product[field] === null || product[field] === "") fail(`product ${product.id ?? "<unknown>"} missing ${field}`);
    }
    if (!validStatuses.has(product.status)) fail(`product ${product.id} has invalid status ${product.status}`);
    if (productIds.has(product.id)) fail(`duplicate product ${product.id}`);
    productIds.add(product.id);
    sourceIds.add(product.sourceId);
    counts.total += 1;
    if (validStatuses.has(product.status)) counts[product.status] += 1;
    if (timestampMs(product.fetchedAt) !== generatedAt) fail(`product ${product.id} must belong to the current collection`);
    if (product.verification) {
      const v = product.verification;
      if (!["verified", "unverified", "historical"].includes(v.state)) fail(`product ${product.id} has invalid verification state`);
      if (!["observed", "reference", "historical"].includes(v.priceKind)) fail(`product ${product.id} has invalid price kind`);
      for (const key of ["observedAt", "attemptedAt", "verifiedAt"]) {
        if (v[key] != null && (!Number.isFinite(timestampMs(v[key])) || timestampMs(v[key]) > publishedAt)) fail(`product ${product.id} has invalid ${key}`);
      }
      if (v.state === "verified" && (!v.verifiedAt || !["available", "unavailable"].includes(product.status))) fail(`product ${product.id} verification contradicts stock`);
      if (v.state === "historical" && (product.status !== "unknown" || product.stockCount != null || !product.raw?.historical)) fail(`product ${product.id} historical data must not claim live stock`);
    }
    if (product.stockCount != null && (!Number.isSafeInteger(product.stockCount) || product.stockCount < 0)) fail(`product ${product.id} has invalid stockCount`);
    if (product.status === "available" && product.stockCount === 0) fail(`available product ${product.id} has zero stock`);
    if (product.status === "available" && !product.orderUrl) fail(`available product ${product.id} must include orderUrl`);
    if (!product.evidenceLevel || typeof product.evidenceLevel !== "object") fail(`product ${product.id} missing evidenceLevel`);
    if (product.evidenceLevel && !validEvidenceLevels.has(product.evidenceLevel.value)) {
      fail(`product ${product.id} has invalid evidenceLevel ${product.evidenceLevel.value}`);
    }
    if (!product.evidenceLevel?.label) fail(`product ${product.id} missing evidenceLevel.label`);
    if (!product.evidenceLevel?.className) fail(`product ${product.id} missing evidenceLevel.className`);
    if (!Array.isArray(product.riskTags)) fail(`product ${product.id} riskTags must be an array`);
    if (Array.isArray(product.riskTags) && product.riskTags.length === 0) fail(`product ${product.id} riskTags must not be empty`);
    for (const tag of Array.isArray(product.riskTags) ? product.riskTags : []) {
      if (!tag?.value || !tag?.label || !tag?.severity) fail(`product ${product.id} has invalid risk tag`);
    }
    if (product.status !== "available" && product.status !== "unavailable" && !product.error && !product.evidence) {
      fail(`non-available product ${product.id} must include evidence or error`);
    }
  }
  if (!Number.isSafeInteger(payload.sourceCount) || payload.sourceCount !== sourceIds.size) fail("sourceCount must match collected sources");
  for (const [key, value] of Object.entries(counts)) {
    if (payload.summary?.[key] !== value) fail(`summary.${key} must match products`);
  }
  if (expectedSourceIds) {
    const expected = new Set(expectedSourceIds);
    for (const id of expected) if (!sourceIds.has(id)) fail(`missing source ${id}`);
    for (const id of sourceIds) if (!expected.has(id)) fail(`unexpected source ${id}`);
  }

  if (!isEventTracking(payload.eventTracking, payload.generatedAt)) fail("eventTracking must have a valid startedAt, retentionDays: 7 and limit: 300");
  if (!Array.isArray(payload.events)) fail("events must be an array");
  if (payload.events?.length > eventLimit) fail(`events must contain at most ${eventLimit} entries`);
  const seen = new Set();
  let lastTime = Infinity;
  for (const event of Array.isArray(payload.events) ? payload.events : []) {
    if (!isRadarEvent(event)) { fail("events contains an invalid event"); continue; }
    const time = timestampMs(event.at);
    if (time > generatedAt || time < generatedAt - retentionDays * 86400000 || time < timestampMs(payload.eventTracking?.startedAt)) {
      fail(`event ${event.id} is outside the tracked retention window`);
    }
    if (time > lastTime) fail("events must be ordered newest first");
    lastTime = time;
    const key = `${time}|${event.type}|${event.productId}`;
    if (seen.has(key)) fail(`duplicate event ${event.id}`);
    seen.add(key);
  }
  if (payload.exchangeRates !== undefined && !isFxSnapshot(payload.exchangeRates)) fail("exchangeRates must be a valid CNY reference-rate snapshot");
  if (payload.sourceHealth !== undefined) {
    if (!Array.isArray(payload.sourceHealth)) fail("sourceHealth must be an array");
    else for (const source of payload.sourceHealth) {
      if (!sourceIds.has(source.id) || !["ok", "partial", "unknown", "blocked", "error"].includes(source.status)) fail("sourceHealth contains an invalid source");
      if (!Number.isFinite(timestampMs(source.lastAttemptAt)) || timestampMs(source.lastAttemptAt) > publishedAt) fail("sourceHealth contains an invalid attempt time");
    }
  }
  if (payload.announcements !== undefined) {
    const a = payload.announcements;
    const https = (value) => { try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; } };
    if (!Array.isArray(a?.items) || !Array.isArray(a?.sources) || a.items.length > 100) fail("announcements must contain bounded items and sources");
    const announcementIds = new Set();
    for (const item of a?.items ?? []) {
      if (!item.id || announcementIds.has(item.id) || !item.title || !https(item.url) || !["official", "third-party"].includes(item.trust)) fail("invalid announcement provenance");
      announcementIds.add(item.id);
      if (item.publishedAt !== null && !Number.isFinite(timestampMs(item.publishedAt))) fail("invalid announcement publication time");
      if (!Number.isFinite(timestampMs(item.observedAt)) || timestampMs(item.observedAt) > publishedAt) fail("invalid announcement observation time");
      for (const candidate of item.candidates ?? []) {
        if (!sourceIds.has(candidate.sourceId) || !https(candidate.url) || !["pending", "verified", "blocked", "unmatched"].includes(candidate.verification?.state)) fail("invalid announcement verification");
      }
    }
  }
  return errors;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const payload = JSON.parse(readFileSync(process.env.MONITOR_OUTPUT || "data/products.json", "utf8"));
    const sources = JSON.parse(readFileSync("monitor/sources.json", "utf8"));
    const only = new Set((process.env.MONITOR_ONLY || "").split(",").filter(Boolean));
    const errors = validateMonitorPayload(payload, { expectedSourceIds: sources.filter((s) => !only.size || only.has(s.id)).map((s) => s.id) });
    for (const error of errors) console.error(error);
    if (errors.length) process.exitCode = 1;
    else console.log(`Validated ${payload.products.length} monitor records and ${payload.events.length} events`);
  } catch (error) {
    console.error(`Monitor data validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
