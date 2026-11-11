import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { eventLimit, isEventTracking, isRadarEvent, retentionDays, timestampMs } from "./radar-events.mjs";
import { isFxSnapshot } from "./fx-rates.mjs";

const validStatuses = new Set(["available", "unavailable", "unknown", "blocked", "error"]);
const validEvidenceLevels = new Set(["error", "unavailable", "stock-count", "snapshot", "blocked", "official-order", "unverified"]);

export function validateMonitorPayload(payload) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!payload || typeof payload !== "object") return ["payload must be an object"];
  const generatedAt = timestampMs(payload.generatedAt);
  if (payload.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (!Number.isFinite(generatedAt)) fail("generatedAt must be an ISO date");
  if (!Array.isArray(payload.products)) fail("products must be an array");
  if (!payload.products?.length) fail("products must not be empty");

  for (const product of Array.isArray(payload.products) ? payload.products : []) {
    if (!product || typeof product !== "object") { fail("product must be an object"); continue; }
    for (const field of ["id", "sourceId", "provider", "category", "adapter", "sourceUrl", "fetchedAt", "status", "statusLabel", "evidence"]) {
      if (product[field] === undefined || product[field] === null || product[field] === "") fail(`product ${product.id ?? "<unknown>"} missing ${field}`);
    }
    if (!validStatuses.has(product.status)) fail(`product ${product.id} has invalid status ${product.status}`);
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
  return errors;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const payload = JSON.parse(readFileSync("data/products.json", "utf8"));
    const errors = validateMonitorPayload(payload);
    for (const error of errors) console.error(error);
    if (errors.length) process.exitCode = 1;
    else console.log(`Validated ${payload.products.length} monitor records and ${payload.events.length} events`);
  } catch (error) {
    console.error(`Monitor data validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
