import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { timestampMs } from "./radar-events.mjs";

export const ecbDailyUrl = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const sourceUrl = "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html";

function validDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function isFxSnapshot(value, now = Date.now()) {
  if (!value || value.base !== "CNY" || !validDay(value.date) || !Number.isFinite(now) || value.date > new Date(now).toISOString().slice(0, 10) ||
      !value.rates || typeof value.rates !== "object" || Array.isArray(value.rates)) return false;
  if (value.rates.CNY !== 1 || !(value.rates.USD > 0) || !(value.rates.EUR > 0)) return false;
  if (!Object.entries(value.rates).every(([code, rate]) => /^[A-Z]{3}$/.test(code) && Number.isFinite(rate) && rate > 0)) return false;
  try {
    const url = new URL(value.sourceUrl);
    if (url.protocol !== "https:" || url.username || url.password) return false;
  } catch {
    return false;
  }
  if (value.fetchedAt !== undefined && (!Number.isFinite(timestampMs(value.fetchedAt)) || timestampMs(value.fetchedAt) > now ||
      value.date > new Date(timestampMs(value.fetchedAt)).toISOString().slice(0, 10))) return false;
  return true;
}

// ECB quotes units per EUR. Rebase those actual observations to CNY per unit of
// each currency; never fill missing currencies with assumed exchange rates.
export function parseEcbRates(xml) {
  const perEuro = { EUR: 1 };
  let date;
  for (const [, attributes] of String(xml).matchAll(/<Cube\b([^<>]*?)\/?\s*>/g)) {
    const attrs = {};
    const attributePattern = /([\w:-]+)\s*=\s*(['"])(.*?)\2/g;
    if (attributes.replace(attributePattern, "").trim()) throw new Error("ECB contains malformed XML attributes");
    for (const [, name, , value] of attributes.matchAll(attributePattern)) {
      if (Object.hasOwn(attrs, name)) throw new Error(`ECB contains duplicate ${name} attributes`);
      attrs[name] = value;
    }
    if (Object.hasOwn(attrs, "time")) {
      if (date || !validDay(attrs.time)) throw new Error("ECB reference date is invalid or ambiguous");
      date = attrs.time;
    }
    if (Object.hasOwn(attrs, "currency") || Object.hasOwn(attrs, "rate")) {
      if (!/^[A-Z]{3}$/.test(attrs.currency ?? "") || !/^\d+(?:\.\d+)?$/.test(attrs.rate ?? "") ||
          !Number.isFinite(Number(attrs.rate)) || Number(attrs.rate) <= 0 || Object.hasOwn(perEuro, attrs.currency)) {
        throw new Error("ECB contains an invalid or duplicate currency rate");
      }
      perEuro[attrs.currency] = Number(attrs.rate);
    }
  }
  if (!date || !perEuro.CNY || !perEuro.USD) throw new Error("ECB reference rates are missing the date, CNY or USD");
  const snapshot = {
    base: "CNY",
    date,
    source: "European Central Bank euro foreign exchange reference rates",
    sourceUrl,
    rates: Object.fromEntries(Object.entries(perEuro).map(([code, rate]) => [code, Number((perEuro.CNY / rate).toPrecision(12))]))
  };
  if (!isFxSnapshot(snapshot)) throw new Error("ECB produced invalid rebased rates");
  return snapshot;
}

export function readFxSnapshot(filePath = "data/fx.json", logger = console) {
  try {
    const snapshot = JSON.parse(readFileSync(filePath, "utf8"));
    if (!isFxSnapshot(snapshot)) throw new Error("invalid FX snapshot");
    return snapshot;
  } catch (error) {
    if (error.code !== "ENOENT") logger.warn(`Ignoring ${filePath}: ${error.message}`);
    return null;
  }
}

export async function updateRates({ filePath = "data/fx.json", fetchImpl = globalThis.fetch, now = new Date().toISOString(), logger = console } = {}) {
  const previous = readFxSnapshot(filePath, logger);
  try {
    if (!Number.isFinite(timestampMs(now))) throw new Error("Invalid FX fetch timestamp");
    const response = await fetchImpl(ecbDailyUrl, { headers: { accept: "application/xml" }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`ECB returned HTTP ${response.status}`);
    const snapshot = { ...parseEcbRates(await response.text()), fetchedAt: now };
    if (!isFxSnapshot(snapshot)) throw new Error("ECB returned rates dated after the fetch timestamp");
    if (previous && snapshot.date < previous.date) throw new Error(`ECB returned an older reference date (${snapshot.date})`);
    mkdirSync(dirname(resolve(filePath)), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`);
    logger.log(`Wrote ${filePath} with ECB reference rates for ${snapshot.date}`);
    return { updated: true, snapshot };
  } catch (error) {
    logger.warn(`ECB update failed: ${error.message}. ${previous ? `Keeping reference rates dated ${previous.date}.` : "No reference rates available."}`);
    return { updated: false, snapshot: previous, error: error.message };
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await updateRates();
}
