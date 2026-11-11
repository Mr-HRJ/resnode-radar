import { priceQuote } from "../pricing.js";

// A missing plan is not a sellout. A newly discovered plan is not a restock.
// Only consecutive, identifiable observations with known stock states qualify.
export const eventTypes = ["restock", "soldout", "price"];
export const retentionDays = 7;
export const eventLimit = 300;
const eventWindowMs = retentionDays * 24 * 60 * 60 * 1000;
const text = (value) => typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
const amount = (value) => Number.isFinite(value) && value >= 0;

export function timestampMs(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return NaN;
  const day = Date.parse(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value.slice(0, 10)) return NaN;
  return Date.parse(value);
}

function publicUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    url.searchParams.sort();
    return url.href;
  } catch {
    return null;
  }
}

function isPlan(record) {
  return record && !record.diagnostic && !record.error &&
    ["available", "unavailable"].includes(record.status) &&
    !["blocked", "error", "snapshot"].includes(record.evidenceLevel?.value) &&
    record.raw?.strategy !== "reader_snapshot" &&
    (record.httpStatus == null || (record.httpStatus >= 200 && record.httpStatus < 300)) &&
    text(record.id) && text(record.provider) && text(record.name);
}

// Order links can disappear on sold-out cards, changing their generated ids.
// A page/name fallback is safe only if it is unique in BOTH complete snapshots.
function fallbackKey(record) {
  const page = publicUrl(record?.raw?.catalogPage ?? record?.raw?.sourcePageUrl ?? record?.sourceUrl);
  const source = text(record?.sourceId), name = text(record?.name);
  return source && page && name ? JSON.stringify([source, page, name]) : null;
}

function uniqueIndex(records, keyFor) {
  const result = new Map();
  for (const record of records) {
    const key = keyFor(record);
    if (key) result.set(key, result.has(key) ? null : record);
  }
  return result;
}

function orderIdentity(record) {
  const order = publicUrl(record.orderUrl);
  if (!order) return null;
  const url = new URL(order);
  const identifiers = [...url.searchParams].filter(([key]) => ["pid", "product_id", "productid", "plan_id", "package_id"].includes(key));
  // Product ids outrank incidental checkout options such as currency or coupon.
  if (identifiers.length) return JSON.stringify([url.origin, url.pathname, identifiers]);
  // Some adapters use the catalog page itself when a sold-out order link is
  // missing. It is not a linked SKU, unless the URL is an explicit order route.
  const pages = [record.sourceUrl, record.raw?.catalogPage, record.raw?.sourcePageUrl].map(publicUrl);
  if (pages.includes(order) && !/\/order\/[^/]+\/?$/i.test(url.pathname)) return null;
  return order;
}

function samePlan(before, after) {
  if (!fallbackKey(before) || fallbackKey(before) !== fallbackKey(after)) return false;
  if (before.id !== after.id) {
    const oldOrder = orderIdentity(before), newOrder = orderIdentity(after);
    if (oldOrder && newOrder && oldOrder !== newOrder) return false;
  }
  // Reused positional ids, variant changes, or a changed provider must not be
  // interpreted as the same offer changing stock or price.
  for (const field of ["providerId", "provider", "adapter", "region", "hardware", "bandwidth"]) {
    if (text(before[field]) && text(after[field]) && text(before[field]) !== text(after[field])) return false;
  }
  for (const field of ["pid", "productId"]) {
    if (before.raw?.[field] != null && after.raw?.[field] != null && String(before.raw[field]) !== String(after.raw[field])) return false;
  }
  return true;
}

function comparableQuote(record) {
  const quote = priceQuote(record);
  const label = String(record.price ?? "");
  const explicit = [...label.matchAll(/\b(USD|CNY|EUR|GBP|CAD|AUD|HKD|JPY|TWD|SGD|KRW)\b/gi)].map((match) => match[1].toUpperCase());
  const symbols = [[/€/, "EUR"], [/£/, "GBP"], [/HK\$/, "HKD"], [/(?:CA|C)\$/, "CAD"], [/(?<![A-Z])A\$/, "AUD"], [/NT\$/, "TWD"], [/RMB|元/i, "CNY"]];
  if (!/^[A-Z]{3}$/.test(quote.currency ?? "") || explicit.some((currency) => currency !== quote.currency) ||
      symbols.some(([pattern, currency]) => pattern.test(label) && currency !== quote.currency) ||
      !amount(quote.amount) || !Number.isFinite(quote.months) || quote.months <= 0 || quote.baseOnly) return null;
  // A label and machine-readable cycle that disagree are not comparable prices.
  const labelQuote = priceQuote({ ...record, name: "", raw: {} });
  const cycleQuote = priceQuote({ ...record, name: "", price: "" });
  for (const declared of [labelQuote, cycleQuote]) {
    if (declared.period !== "周期未注明" && declared.months !== quote.months) return null;
  }
  return quote;
}

function eventFor(type, record, at, extra = {}) {
  const currency = priceQuote(record).currency;
  return {
    id: `${at}|${type}|${record.id}`,
    type,
    at,
    productId: record.id,
    providerId: text(record.providerId) || null,
    provider: record.provider,
    name: record.name,
    region: text(record.region) || null,
    price: typeof record.price === "string" ? record.price : null,
    priceValue: amount(record.priceValue) ? record.priceValue : null,
    currency: /^[A-Z]{3}$/.test(currency ?? "") ? currency : null,
    stockCount: Number.isSafeInteger(record.stockCount) && record.stockCount >= 0 ? record.stockCount : null,
    orderUrl: publicUrl(record.orderUrl) ?? publicUrl(record.sourceUrl),
    ...extra
  };
}

export function diffRuns(previousRecords, currentRecords, at, previousAt) {
  const now = timestampMs(at);
  if (!Number.isFinite(now)) return [];
  const previous = (Array.isArray(previousRecords) ? previousRecords : []).filter((record) => record && typeof record === "object");
  const current = (Array.isArray(currentRecords) ? currentRecords : []).filter((record) => record && typeof record === "object");
  const byId = uniqueIndex(previous, (record) => text(record.id));
  const currentById = uniqueIndex(current, (record) => text(record.id));
  const byFallback = uniqueIndex(previous, fallbackKey);
  const currentByFallback = uniqueIndex(current, fallbackKey);
  const events = [];
  const observedAt = new Date(now).toISOString();
  for (const record of current) {
    if (!isPlan(record) || currentById.get(record.id) !== record) continue;
    let before = byId.get(record.id);
    if (!byId.has(record.id)) {
      const key = fallbackKey(record);
      const candidate = byFallback.get(key);
      if (candidate && byId.get(candidate.id) === candidate && currentByFallback.get(key) === record && !currentById.has(candidate.id)) before = candidate;
    }
    if (!isPlan(before) || !samePlan(before, record)) continue;
    const previousTime = timestampMs(before.fetchedAt), currentTime = timestampMs(record.fetchedAt);
    if (!Number.isFinite(previousTime) || currentTime !== now || previousTime >= currentTime ||
        (previousAt !== undefined && previousTime !== timestampMs(previousAt))) continue;
    if (before.status === "unavailable" && record.status === "available") events.push(eventFor("restock", record, observedAt));
    else if (before.status === "available" && record.status === "unavailable") events.push(eventFor("soldout", record, observedAt));
    const oldQuote = comparableQuote(before), newQuote = comparableQuote(record);
    if (oldQuote && newQuote && oldQuote.currency === newQuote.currency && oldQuote.months === newQuote.months &&
        Math.abs(oldQuote.amount - newQuote.amount) > Number.EPSILON * Math.max(1, oldQuote.amount, newQuote.amount) * 8) {
      events.push(eventFor("price", record, observedAt, {
        previousPrice: typeof before.price === "string" ? before.price : null,
        previousPriceValue: before.priceValue
      }));
    }
  }
  return events;
}

export function isRadarEvent(event) {
  if (!event || typeof event !== "object" || !eventTypes.includes(event.type) || !Number.isFinite(timestampMs(event.at)) ||
      !text(event.productId) || event.id !== `${event.at}|${event.type}|${event.productId}` || !text(event.provider) || !text(event.name)) return false;
  for (const field of ["providerId", "region", "price", "currency", "orderUrl"]) {
    if (event[field] !== null && typeof event[field] !== "string") return false;
  }
  if (event.currency !== null && !/^[A-Z]{3}$/.test(event.currency)) return false;
  if (event.priceValue !== null && !amount(event.priceValue)) return false;
  if (event.stockCount !== null && !(Number.isSafeInteger(event.stockCount) && event.stockCount >= 0)) return false;
  if (event.orderUrl !== null && !publicUrl(event.orderUrl)) return false;
  if (event.type === "price" && (!event.currency || !amount(event.priceValue) || !amount(event.previousPriceValue) ||
      event.priceValue === event.previousPriceValue || (event.previousPrice !== null && typeof event.previousPrice !== "string"))) return false;
  return true;
}

export function isEventTracking(value, at) {
  const started = timestampMs(value?.startedAt);
  return Number.isFinite(started) && started <= timestampMs(at) && value.retentionDays === retentionDays && value.limit === eventLimit;
}

export function mergeEvents(existing, fresh, at, startedAt) {
  const now = timestampMs(at);
  if (!Number.isFinite(now)) return [];
  const cutoff = Math.max(now - eventWindowMs, Number.isFinite(timestampMs(startedAt)) ? timestampMs(startedAt) : -Infinity);
  const seen = new Set();
  return [...(Array.isArray(fresh) ? fresh : []), ...(Array.isArray(existing) ? existing : [])]
    .filter((event) => isRadarEvent(event) && timestampMs(event.at) >= cutoff && timestampMs(event.at) <= now)
    .sort((a, b) => timestampMs(b.at) - timestampMs(a.at) || a.id.localeCompare(b.id))
    .filter((event) => {
      const key = `${timestampMs(event.at)}|${event.type}|${event.productId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, eventLimit);
}

export function trackEvents(previous, current) {
  const now = timestampMs(current?.generatedAt);
  if (!Number.isFinite(now) || !Array.isArray(current?.products)) throw new Error("Current monitor snapshot must have a valid generatedAt and products");
  const previousTime = timestampMs(previous?.generatedAt);
  if (Number.isFinite(previousTime) && previousTime > now) throw new Error("Monitor snapshot cannot precede the persisted snapshot");
  const tracked = previous?.schemaVersion === 1 && Array.isArray(previous.products) && isEventTracking(previous.eventTracking, previous.generatedAt);
  const eventTracking = { startedAt: tracked ? previous.eventTracking.startedAt : current.generatedAt, retentionDays, limit: eventLimit };
  // A legacy payload or a first run establishes the baseline; it has no history.
  const fresh = tracked && now > previousTime ? diffRuns(previous.products, current.products, current.generatedAt, previous.generatedAt) : [];
  return { events: mergeEvents(tracked ? previous.events : [], fresh, current.generatedAt, eventTracking.startedAt), eventTracking };
}
