import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Decides whether a scheduled collection should run. Cloudflare's cron dispatches the
// workflow every 10 minutes; GitHub's own (often delayed) schedule is only a fallback,
// so both triggers share one collection per ten-minute UTC slot. An age-based
// guard can let a delayed fallback suppress the next primary tick.
export function collectionDecision({
  productsJson,
  fxJson,
  nowMs = Date.now(),
  force = false,
  intervalMinutes = 10,
  fxMaxAgeHours = 6
} = {}) {
  const generatedMs = safeTimestamp(productsJson, "generatedAt");
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) throw new Error("Invalid collection interval");
  const validSnapshot = Number.isFinite(generatedMs) && generatedMs <= nowMs;
  const ageMinutes = validSnapshot ? (nowMs - generatedMs) / 60000 : Infinity;
  const fxFetchedMs = safeTimestamp(fxJson, "fetchedAt");
  const fxStale = !Number.isFinite(fxFetchedMs) || fxFetchedMs > nowMs || nowMs - fxFetchedMs > fxMaxAgeHours * 3600000;
  const intervalMs = intervalMinutes * 60000;
  const collect = force || !validSnapshot || Math.floor(generatedMs / intervalMs) < Math.floor(nowMs / intervalMs);
  return {
    collect,
    fxStale,
    snapshotAgeMinutes: Number.isFinite(ageMinutes) ? Number(ageMinutes.toFixed(1)) : null,
    reason: force ? "forced" : collect ? (Number.isFinite(ageMinutes) ? "snapshot-due" : "no-snapshot") : "snapshot-fresh"
  };
}

function safeTimestamp(json, field) {
  try {
    const value = JSON.parse(json ?? "")?.[field];
    return typeof value === "string" ? Date.parse(value) : NaN;
  } catch {
    return NaN;
  }
}

function readOptional(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const decision = collectionDecision({
    productsJson: readOptional("data/products.json"),
    fxJson: readOptional("data/fx.json"),
    force: process.env.FORCE_COLLECTION === "true",
    intervalMinutes: Number(process.env.COLLECTION_INTERVAL_MINUTES ?? 10)
  });
  console.log(JSON.stringify(decision));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `collect=${decision.collect}\nfx_stale=${decision.fxStale}\n`);
  }
}
