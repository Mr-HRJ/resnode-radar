import {
  DICT_VERSION,
  decodeEvidenceLevel,
  decodeRiskTags,
  encodeEvidenceLevel,
  encodeRiskTags
} from "./dictionaries.js";
import { savedKey } from "./identity.js";
import { monthlyCny, priceQuote } from "./pricing.js";
import { ROUTE_OPTIONS, matchesRoute } from "./format.js";
import {
  SORT_OPTIONS,
  buildEventIndex,
  normalizeProduct,
  providerHealth,
  rankProvidersByPopularity,
  sortProducts
} from "./catalog.js";
import { providers } from "./providers-catalog.js";
import { CompactSnapshotSchema } from "./schemas.js";

const RAW_SEMANTIC_KEYS = [
  "billingCycle",
  "billingDays",
  "configurable",
  "historical",
  "referencePrice",
  "strategy",
  "sourceCardIndex",
  "inventoryChecked",
  "inventoryCheckedAt",
  "inventoryAttemptedAt",
  "catalogSoldOut",
  "snapshotStatus",
  "egress",
  "pid",
  "productId",
  "stockLabel"
];

export function formatSnapshotId(generatedAt, v1Sha256) {
  const epochMs = Date.parse(generatedAt);
  if (!Number.isFinite(epochMs)) {
    throw new Error(`Invalid generatedAt timestamp for snapshotId: ${String(generatedAt)}`);
  }
  if (typeof v1Sha256 !== "string" || !/^[0-9a-f]{64}$/.test(v1Sha256)) {
    throw new Error("v1Sha256 must be a 64-character lowercase hex digest");
  }
  return `snap_${epochMs}_${v1Sha256.slice(0, 12)}`;
}

function extractRawFlags(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const flags = {};
  let hasAny = false;
  for (const key of RAW_SEMANTIC_KEYS) {
    if (raw[key] !== undefined) {
      flags[key] = raw[key];
      hasAny = true;
    }
  }
  return hasAny ? flags : undefined;
}

/**
 * Projects a validated v1 FullPayload into:
 * - `snapshot`: lossless CompactSnapshot (v2)
 * - `audits`: Map<sourceId, SourceAudit> containing full `raw` and recent `observations`
 */
export function projectToCompact(
  fullPayload,
  { v1Sha256, snapshotId, observationsByProduct = new Map() } = {}
) {
  if (!fullPayload || !Array.isArray(fullPayload.products) || !fullPayload.products.length) {
    throw new Error("Cannot project empty or invalid FullPayload");
  }
  const resolvedSnapId = snapshotId || formatSnapshotId(fullPayload.generatedAt, v1Sha256);
  const publishedAt = fullPayload.publishedAt || fullPayload.generatedAt;
  const sources = Object.create(null);
  const healthMap = new Map(
    (Array.isArray(fullPayload.sourceHealth) ? fullPayload.sourceHealth : []).map((h) => [h.id, h])
  );
  const audits = new Map();

  const compactProducts = fullPayload.products.map((record) => {
    const sourceId = record.sourceId;
    if (!Object.hasOwn(sources, sourceId)) {
      sources[sourceId] = {
        id: sourceId,
        provider: record.provider,
        providerId: record.providerId ?? null,
        adapter: record.adapter,
        defaultSourceUrl: record.sourceUrl
      };
    }
    const src = sources[sourceId];

    if (!audits.has(sourceId)) {
      audits.set(sourceId, {
        schemaVersion: 2,
        snapshotId: resolvedSnapId,
        sourceId,
        generatedAt: fullPayload.generatedAt,
        sourceHealth: healthMap.get(sourceId) ?? null,
        records: Object.create(null)
      });
    }

    audits.get(sourceId).records[record.id] = {
      id: record.id,
      name: record.name ?? null,
      status: record.status,
      httpStatus: record.httpStatus ?? null,
      evidence: record.evidence,
      error: record.error ?? null,
      verification: record.verification ?? null,
      collection: record.collection ?? null,
      raw: record.raw ?? null,
      observations: observationsByProduct.get(record.id) ?? []
    };

    const computedSavedKey = savedKey(record);
    const computedQuote = priceQuote(record);
    const rawFlags = extractRawFlags(record.raw);
    const effectiveSourceUrl = record.sourceUrl;

    const compact = {
      id: record.id,
      sourceId,
      savedKey: computedSavedKey,
      category: record.category,
      status: record.status,
      statusLabel: record.statusLabel,
      evidence: record.evidence,
      ev: encodeEvidenceLevel(record.evidenceLevel, record.stockCount ?? null),
      rk: encodeRiskTags(record.riskTags),
      quote: computedQuote
    };

    if (record.provider !== src.provider) compact.provider = record.provider;
    if ((record.providerId ?? null) !== src.providerId) {
      compact.providerId = record.providerId ?? null;
    }
    if (record.adapter !== src.adapter) compact.adapter = record.adapter;
    if (effectiveSourceUrl !== src.defaultSourceUrl) compact.sourceUrl = effectiveSourceUrl;
    if (record.finalUrl !== undefined) {
      if (record.finalUrl === effectiveSourceUrl) compact.sameFinalUrl = true;
      else compact.finalUrl = record.finalUrl;
    }
    if (record.fetchedAt && record.fetchedAt !== fullPayload.generatedAt) {
      compact.fetchedAt = record.fetchedAt;
    }
    if (record.observedAt !== undefined) compact.observedAt = record.observedAt;
    if (record.stockCount !== undefined) compact.stockCount = record.stockCount;
    if (record.price !== undefined) compact.price = record.price;
    if (record.priceValue !== undefined) compact.priceValue = record.priceValue;
    if (record.currency !== undefined) compact.currency = record.currency;
    if (record.name !== undefined) compact.name = record.name;
    if (record.region !== undefined) compact.region = record.region;
    if (Array.isArray(record.regions) && record.regions.length > 0) {
      compact.regions = record.regions;
    }
    if (record.route !== undefined) compact.route = record.route;
    if (record.carrier !== undefined) compact.carrier = record.carrier;
    if (record.ipType !== undefined) compact.ipType = record.ipType;
    if (record.hardware !== undefined) compact.hardware = record.hardware;
    if (record.bandwidth !== undefined) compact.bandwidth = record.bandwidth;
    if (record.orderUrl !== undefined) compact.orderUrl = record.orderUrl;
    if (record.note !== undefined) compact.note = record.note;
    if (record.error !== undefined) compact.error = record.error;
    if (record.diagnostic) compact.diagnostic = true;
    if (record.httpStatus !== undefined) compact.httpStatus = record.httpStatus;
    if (record.raw?.features !== undefined) compact.features = record.raw.features;
    if (rawFlags) compact.rawFlags = rawFlags;
    if (record.verification !== undefined) compact.verification = record.verification;
    if (record.collection !== undefined) compact.collection = record.collection;

    return compact;
  });

  const snapshot = {
    schemaVersion: 2,
    dictVersion: DICT_VERSION,
    snapshotId: resolvedSnapId,
    v1Sha256,
    generatedAt: fullPayload.generatedAt,
    publishedAt,
    sourceCount: fullPayload.sourceCount,
    summary: { ...fullPayload.summary },
    eventTracking: { ...fullPayload.eventTracking },
    events: fullPayload.events ?? [],
    ...(fullPayload.exchangeRates !== undefined
      ? { exchangeRates: fullPayload.exchangeRates }
      : {}),
    ...(fullPayload.sourceHealth !== undefined ? { sourceHealth: fullPayload.sourceHealth } : {}),
    ...(fullPayload.announcements !== undefined
      ? { announcements: fullPayload.announcements }
      : {}),
    sources,
    products: compactProducts
  };

  return { snapshot, audits };
}

/**
 * Decodes a validated v2 CompactSnapshot back into full business-equivalent product records
 * without requiring any `audit/<sourceId>.json` request.
 */
export function decodeCompactSnapshot(compactInput) {
  if (!compactInput || typeof compactInput !== "object") {
    throw new Error("CompactSnapshot payload must be an object");
  }
  if (compactInput.schemaVersion !== 2) {
    throw new Error(`Unsupported CompactSnapshot schemaVersion: ${compactInput.schemaVersion}`);
  }
  if (compactInput.dictVersion !== DICT_VERSION) {
    throw new Error(`Unsupported CompactSnapshot dictVersion: ${compactInput.dictVersion}`);
  }
  const parsed = CompactSnapshotSchema.parse(compactInput);

  const products = parsed.products.map((c) => {
    const src = Object.hasOwn(parsed.sources, c.sourceId) ? parsed.sources[c.sourceId] : null;
    if (!src) {
      throw new Error(`Product ${c.id} references missing source ${c.sourceId}`);
    }
    const sourceUrl = c.sourceUrl ?? src.defaultSourceUrl;
    const finalUrl = c.sameFinalUrl ? sourceUrl : c.finalUrl;
    const rawReconstructed =
      c.features !== undefined || c.rawFlags !== undefined
        ? {
            ...(c.features !== undefined ? { features: c.features } : {}),
            ...(c.rawFlags || {})
          }
        : undefined;

    const record = {
      id: c.id,
      sourceId: c.sourceId,
      savedKey: c.savedKey,
      provider: c.provider ?? src.provider,
      ...(c.providerId !== undefined
        ? { providerId: c.providerId }
        : src.providerId !== null
          ? { providerId: src.providerId }
          : {}),
      category: c.category,
      adapter: c.adapter ?? src.adapter,
      sourceUrl,
      ...(finalUrl !== undefined ? { finalUrl } : {}),
      fetchedAt: c.fetchedAt ?? parsed.generatedAt,
      ...(c.observedAt !== undefined ? { observedAt: c.observedAt } : {}),
      status: c.status,
      statusLabel: c.statusLabel,
      ...(c.stockCount !== undefined ? { stockCount: c.stockCount } : {}),
      ...(c.price !== undefined ? { price: c.price } : {}),
      ...(c.priceValue !== undefined ? { priceValue: c.priceValue } : {}),
      ...(c.currency !== undefined ? { currency: c.currency } : {}),
      ...(c.name !== undefined ? { name: c.name } : {}),
      ...(c.region !== undefined ? { region: c.region } : {}),
      ...(c.regions !== undefined ? { regions: c.regions } : {}),
      ...(c.route !== undefined ? { route: c.route } : {}),
      ...(c.carrier !== undefined ? { carrier: c.carrier } : {}),
      ...(c.ipType !== undefined ? { ipType: c.ipType } : {}),
      ...(c.hardware !== undefined ? { hardware: c.hardware } : {}),
      ...(c.bandwidth !== undefined ? { bandwidth: c.bandwidth } : {}),
      ...(c.orderUrl !== undefined ? { orderUrl: c.orderUrl } : {}),
      evidence: c.evidence,
      ...(c.note !== undefined ? { note: c.note } : {}),
      ...(c.error !== undefined ? { error: c.error } : {}),
      ...(c.diagnostic ? { diagnostic: true } : {}),
      ...(c.httpStatus !== undefined ? { httpStatus: c.httpStatus } : {}),
      evidenceLevel: decodeEvidenceLevel(c.ev, c.stockCount ?? null, parsed.dictVersion),
      riskTags: decodeRiskTags(c.rk, parsed.dictVersion),
      ...(c.verification !== undefined ? { verification: c.verification } : {}),
      ...(c.collection !== undefined ? { collection: c.collection } : {}),
      ...(rawReconstructed !== undefined ? { raw: rawReconstructed } : {})
    };
    return record;
  });

  return {
    schemaVersion: 1,
    v2SnapshotId: parsed.snapshotId,
    v1Sha256: parsed.v1Sha256,
    generatedAt: parsed.generatedAt,
    publishedAt: parsed.publishedAt,
    sourceCount: parsed.sourceCount,
    summary: parsed.summary,
    eventTracking: parsed.eventTracking,
    events: parsed.events,
    ...(parsed.exchangeRates !== undefined ? { exchangeRates: parsed.exchangeRates } : {}),
    ...(parsed.sourceHealth !== undefined ? { sourceHealth: parsed.sourceHealth } : {}),
    ...(parsed.announcements !== undefined ? { announcements: parsed.announcements } : {}),
    products
  };
}

/**
 * Verifies on actual serialized CompactSnapshot JSON bytes (re-parsed & decoded) that
 * EVERY product's identity, savedKey (?cmp=), pricing, CNY conversion, route matching,
 * full-text search, evidence rank/label, 7+8 tag evaluation, sort order, and provider health
 * match the source v1 FullPayload with zero divergence.
 */
export function assertLosslessParity(fullPayload, serializedCompactJson, nowMs = Date.now()) {
  const text =
    typeof serializedCompactJson === "string"
      ? serializedCompactJson
      : Buffer.from(serializedCompactJson).toString("utf8");
  const decodedPayload = decodeCompactSnapshot(JSON.parse(text));

  if (decodedPayload.products.length !== fullPayload.products.length) {
    throw new Error(
      `Parity failure: product count ${decodedPayload.products.length} !== ${fullPayload.products.length}`
    );
  }

  const eventIndex = buildEventIndex(fullPayload.events || []);
  const normFullAll = fullPayload.products.map((r, i) =>
    normalizeProduct(r, i, fullPayload.exchangeRates, eventIndex, nowMs)
  );
  const normDecAll = decodedPayload.products.map((r, i) =>
    normalizeProduct(r, i, decodedPayload.exchangeRates, eventIndex, nowMs)
  );

  for (let i = 0; i < normFullAll.length; i += 1) {
    const f = normFullAll[i];
    const d = normDecAll[i];
    const orig = fullPayload.products[i];
    const decRaw = decodedPayload.products[i];

    // Check raw savedKey calculation (ignoring cached property) as well as normalized _key (?cmp=)
    const recomputedKey = savedKey({ ...decRaw, savedKey: undefined });
    if (f._key !== d._key || savedKey(orig) !== recomputedKey) {
      throw new Error(`Parity failure [${f.id}]: savedKey mismatch (${f._key} vs ${d._key})`);
    }
    if (JSON.stringify(priceQuote(orig)) !== JSON.stringify(priceQuote(decRaw))) {
      throw new Error(`Parity failure [${f.id}]: priceQuote mismatch`);
    }
    if (
      monthlyCny(orig, fullPayload.exchangeRates, nowMs) !==
      monthlyCny(decRaw, decodedPayload.exchangeRates, nowMs)
    ) {
      throw new Error(`Parity failure [${f.id}]: monthlyCny mismatch`);
    }
    if (f._declaredRouteText !== d._declaredRouteText) {
      throw new Error(`Parity failure [${f.id}]: declaredRouteText mismatch`);
    }
    for (const opt of ROUTE_OPTIONS) {
      if (matchesRoute(f, opt.value) !== matchesRoute(d, opt.value)) {
        throw new Error(`Parity failure [${f.id}]: matchesRoute(${opt.value}) mismatch`);
      }
    }
    if (f._search !== d._search) {
      throw new Error(`Parity failure [${f.id}]: search text mismatch`);
    }
    if (
      f._evidenceRank !== d._evidenceRank ||
      JSON.stringify(f.evidenceLevel) !== JSON.stringify(d.evidenceLevel)
    ) {
      throw new Error(`Parity failure [${f.id}]: evidenceLevel/rank mismatch`);
    }
    if (JSON.stringify(f.riskTags) !== JSON.stringify(d.riskTags)) {
      throw new Error(`Parity failure [${f.id}]: riskTags mismatch`);
    }
    if (JSON.stringify(f._planTags) !== JSON.stringify(d._planTags)) {
      throw new Error(`Parity failure [${f.id}]: planTags mismatch`);
    }
  }

  const fullPlans = normFullAll.filter((p) => !p.diagnostic);
  const decPlans = normDecAll.filter((p) => !p.diagnostic);

  for (const opt of SORT_OPTIONS) {
    const idsF = sortProducts(fullPlans, opt.value).map((p) => p.id);
    const idsD = sortProducts(decPlans, opt.value).map((p) => p.id);
    if (idsF.length !== idsD.length || idsF.some((id, idx) => id !== idsD[idx])) {
      throw new Error(`Parity failure: sortProducts(${opt.value}) order mismatch`);
    }
  }

  const rankedF = rankProvidersByPopularity(fullPlans).map((x) => ({
    id: x.provider.id,
    shopTags: x.shopTags
  }));
  const rankedD = rankProvidersByPopularity(decPlans).map((x) => ({
    id: x.provider.id,
    shopTags: x.shopTags
  }));
  if (JSON.stringify(rankedF) !== JSON.stringify(rankedD)) {
    throw new Error("Parity failure: rankProvidersByPopularity / shopTags mismatch");
  }

  for (const prov of providers) {
    const hf = providerHealth(prov, normFullAll);
    const hd = providerHealth(prov, normDecAll);
    if (
      hf.state !== hd.state ||
      hf.available !== hd.available ||
      hf.unavailable !== hd.unavailable ||
      hf.blocked !== hd.blocked ||
      hf.error !== hd.error ||
      hf.pageLimitReached !== hd.pageLimitReached
    ) {
      throw new Error(`Parity failure: providerHealth(${prov.id}) mismatch`);
    }
  }

  return true;
}
