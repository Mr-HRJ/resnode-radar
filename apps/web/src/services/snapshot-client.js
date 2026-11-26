import {
  LatestPointerSchema,
  SourceAuditSchema,
  buildEventIndex,
  decodeCompactSnapshot,
  normalizeProduct,
  resolveSiteAssetUrl
} from "@resnode-radar/contracts";
import { isValidVisitStats } from "./visits-client.js";

export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const SNAPSHOT_TIMEOUT_MS = 20_000;
export const PULSE_TIMEOUT_MS = 5_000;
export const FRAME_SLICE_BUDGET_MS = 8;

function requestError(err, signal) {
  return {
    code:
      signal?.reason?.name === "TimeoutError"
        ? "TIMEOUT"
        : signal?.aborted
          ? "ABORTED"
          : "NETWORK",
    status: null,
    message:
      signal?.reason?.name === "TimeoutError"
        ? "库存快照读取超时，请重试"
        : "网络连接失败，无法触达库存快照接口",
    detail: err instanceof Error ? err.message : "Network request failed"
  };
}

export function validV1Snapshot(payload) {
  if (
    !payload ||
    payload.schemaVersion !== 1 ||
    typeof payload.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(payload.generatedAt)) ||
    !Array.isArray(payload.products) ||
    !payload.products.length
  ) {
    return false;
  }
  const ids = new Set();
  for (const record of payload.products) {
    if (
      !record ||
      typeof record !== "object" ||
      typeof record.id !== "string" ||
      !record.id.trim() ||
      ids.has(record.id) ||
      !["available", "unavailable", "unknown", "blocked", "error"].includes(record.status)
    ) {
      return false;
    }
    ids.add(record.id);
  }
  return (
    payload.events === undefined ||
    (Array.isArray(payload.events) &&
      payload.events.every(
        (event) =>
          event &&
          typeof event.productId === "string" &&
          ["restock", "soldout", "price"].includes(event.type) &&
          typeof event.at === "string" &&
          Number.isFinite(Date.parse(event.at))
      ))
  );
}

/**
 * Normalizes decoded v1-shaped payload records into rich UI models, yielding
 * cooperatively whenever wall-clock slice time reaches 8ms so input stays responsive.
 */
export async function normalizeSnapshotPayload(
  payload,
  { nowMs = Date.now(), signal, sliceBudgetMs = FRAME_SLICE_BUDGET_MS } = {}
) {
  const events = [...(payload.events || [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const eventIndex = buildEventIndex(events);
  const allRecords = [];
  let sliceStart = performance.now();

  for (let idx = 0; idx < payload.products.length; idx += 1) {
    const schedule = globalThis.window?.setTimeout ?? globalThis.setTimeout;
    if (
      idx > 0 &&
      sliceBudgetMs > 0 &&
      (performance.now() - sliceStart >= sliceBudgetMs || idx % 512 === 0) &&
      typeof schedule === "function"
    ) {
      await new Promise((resolve) => schedule(resolve, 0));
      sliceStart = performance.now();
    }
    if (signal?.aborted) throw requestError(signal.reason, signal);
    allRecords.push(
      normalizeProduct(payload.products[idx], idx, payload.exchangeRates, eventIndex, nowMs)
    );
  }

  const plans = [];
  const diagnostics = [];
  for (const rec of allRecords) {
    if (rec.diagnostic) diagnostics.push(rec);
    else plans.push(rec);
  }

  return {
    payload,
    allRecords,
    plans,
    diagnostics,
    events,
    eventIndex
  };
}

/**
 * Synchronous re-normalization used when reactive clock `nowMs` crosses the 7-day FX boundary.
 */
export function normalizeSnapshotPayloadSync(payload, nowMs = Date.now()) {
  const events = [...(payload.events || [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const eventIndex = buildEventIndex(events);
  const allRecords = payload.products.map((r, idx) =>
    normalizeProduct(r, idx, payload.exchangeRates, eventIndex, nowMs)
  );
  const plans = [];
  const diagnostics = [];
  for (const rec of allRecords) {
    if (rec.diagnostic) diagnostics.push(rec);
    else plans.push(rec);
  }
  return { payload, allRecords, plans, diagnostics, events, eventIndex };
}

/**
 * Fetches and decodes a single snapshot URL (accepting either v2 CompactSnapshot or v1 FullPayload).
 */
export async function fetchSnapshot(
  endpoint = "data/products.json",
  {
    signal,
    timeoutMs = SNAPSHOT_TIMEOUT_MS,
    nowMs = Date.now(),
    fetchImpl = globalThis.fetch
  } = {}
) {
  const requestSignal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(signal ? [signal] : [])
  ]);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      cache: "default",
      signal: requestSignal,
      headers: { accept: "application/json" }
    });
  } catch (err) {
    throw requestError(err, requestSignal);
  }

  if (!response.ok) {
    let serverMsg = "";
    try {
      const body = await response.json();
      if (body && typeof body.error === "string") serverMsg = body.error;
    } catch {
      // ignore non-json error body
    }
    throw {
      code: "HTTP",
      status: response.status,
      message:
        response.status === 503
          ? "上游数据源暂时不可用（HTTP 503）"
          : `库存快照请求返回异常状态（HTTP ${response.status}）`,
      detail: serverMsg || `HTTP ${response.status}`
    };
  }

  let rawPayload;
  try {
    rawPayload = await response.json();
  } catch (err) {
    if (requestSignal.aborted) throw requestError(err, requestSignal);
    throw {
      code: "PARSE",
      status: response.status,
      message: "快照响应体不是有效的 JSON 数据",
      detail: "Invalid JSON payload"
    };
  }

  let fullShaped;
  if (rawPayload && rawPayload.schemaVersion === 2) {
    try {
      fullShaped = decodeCompactSnapshot(rawPayload);
    } catch (err) {
      throw {
        code: "SCHEMA",
        status: response.status,
        message: "新版分片快照结构或字典版本不兼容，请刷新页面升级",
        detail: err instanceof Error ? err.message : "Malformed v2 snapshot"
      };
    }
  } else if (validV1Snapshot(rawPayload)) {
    fullShaped = rawPayload;
  } else {
    throw {
      code: "SCHEMA",
      status: response.status,
      message: "快照数据结构不符合监控契约（版本、时间或记录格式异常）",
      detail: "Malformed snapshot schema"
    };
  }

  return normalizeSnapshotPayload(fullShaped, { nowMs, signal: requestSignal });
}

async function tryFetchJson(url, { signal, timeoutMs = PULSE_TIMEOUT_MS, fetchImpl = globalThis.fetch }) {
  if (signal?.aborted) throw requestError(signal.reason, signal);
  const reqSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  try {
    const res = await fetchImpl(url, {
      cache: "no-cache",
      signal: reqSignal,
      headers: { accept: "application/json" }
    });
    if (!res.ok) {
      return { ok: false, status: res.status, data: null };
    }
    const data = await res.json();
    return { ok: true, status: 200, data };
  } catch (err) {
    if (signal?.aborted) throw requestError(signal.reason, signal);
    return { ok: false, status: null, data: null, error: err };
  }
}

function parsePointerOrThrow(rawPointer) {
  const parsed = LatestPointerSchema.safeParse(rawPointer);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw {
      code: "SCHEMA",
      status: 200,
      message: "快照指针协议或字典版本不兼容，请刷新页面升级",
      detail: detail || "Malformed LatestPointer schema"
    };
  }
  return parsed.data;
}

/**
 * Dual-protocol loader:
 * 1. Polls `/api/v1/pulse` (300B); on 404/5xx/timeout/non-JSON falls back to `data/v2/latest.json`.
 * 2. Strictly validates returned pointer JSON via `LatestPointerSchema` BEFORE trusting `unchanged` or `mode`.
 * 3. Honors rollback `mode: "v1-fallback"` AND defense-in-depth stale pointer probe -> switches to `data/products.json`.
 * 4. Skips downloading `snapshot.json` when validated `snapshotId` is unchanged!
 */
export async function loadRadarSnapshot({
  endpoint = null,
  currentSnapshotId = null,
  signal,
  nowMs = Date.now(),
  doc = globalThis.document,
  locationHref = globalThis.window?.location?.href || "https://vpsld.com/",
  fetchImpl = globalThis.fetch
} = {}) {
  if (endpoint) {
    const res = await fetchSnapshot(endpoint, { signal, nowMs, fetchImpl });
    return {
      unchanged: false,
      mode: res.payload.v2SnapshotId ? "v2" : "v1",
      snapshotId: res.payload.v2SnapshotId || `v1_${res.payload.generatedAt}`,
      stats: null,
      ...res
    };
  }

  const resolve = (rel) => resolveSiteAssetUrl(rel, { doc, locationHref });

  // Step 1: Probe /api/v1/pulse -> fallback to data/v2/latest.json, validating strictly via LatestPointerSchema
  let pointer = null;
  let pulseStats = null;
  let pulseReached = false;

  const pulseRes = await tryFetchJson(resolve("api/v1/pulse"), { signal, fetchImpl });
  if (pulseRes.ok) {
    pointer = parsePointerOrThrow(pulseRes.data);
    pulseStats = isValidVisitStats(pulseRes.data?.stats) ? pulseRes.data.stats : null;
    pulseReached = true;
  } else {
    const latestRes = await tryFetchJson(resolve("data/v2/latest.json"), { signal, fetchImpl });
    if (latestRes.ok) {
      pointer = parsePointerOrThrow(latestRes.data);
    }
  }

  // Step 2: Check v1-fallback or missing v2 pointer
  let useV1Fallback = !pointer || pointer.mode === "v1-fallback";

  // Defense-in-depth: if pulse returned 404/error (rolled back to v1 server) AND latest.json is >25m old,
  // check data/products.json directly so already-open v2 tabs recover even if rollback forgot latest.json!
  if (!useV1Fallback && !pulseReached && pointer.mode === "v2") {
    const pointerAgeMs = nowMs - Date.parse(pointer.generatedAt || "");
    if (!Number.isFinite(pointerAgeMs) || pointerAgeMs > 25 * 60_000) {
      try {
        const v1Data = await fetchSnapshot(resolve("data/products.json"), {
          signal,
          nowMs,
          fetchImpl
        });
        if (
          Date.parse(v1Data.payload.generatedAt) >
          (Date.parse(pointer.generatedAt || "") || 0)
        ) {
          return {
            unchanged: false,
            mode: "v1",
            snapshotId: `v1_${v1Data.payload.generatedAt}`,
            stats: null,
            ...v1Data
          };
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        // Continue with v2 snapshot if v1 probe failed
      }
    }
  }

  if (useV1Fallback) {
    const v1Data = await fetchSnapshot(resolve("data/products.json"), {
      signal,
      nowMs,
      fetchImpl
    });
    const v1Id = `v1_${v1Data.payload.generatedAt}`;
    if (currentSnapshotId && currentSnapshotId === v1Id) {
      return { unchanged: true, mode: "v1", snapshotId: v1Id, stats: pulseStats };
    }
    return {
      unchanged: false,
      mode: "v1",
      snapshotId: v1Id,
      stats: pulseStats,
      ...v1Data
    };
  }

  // Step 3: v2 immutable snapshot load (skip if snapshotId unchanged!)
  if (currentSnapshotId && pointer.snapshotId === currentSnapshotId) {
    return {
      unchanged: true,
      mode: "v2",
      snapshotId: pointer.snapshotId,
      stats: pulseStats
    };
  }

  const snapUrl = resolve(
    pointer.snapshotPath || `data/snapshots/${pointer.snapshotId}/snapshot.json`
  );
  const v2Data = await fetchSnapshot(snapUrl, { signal, nowMs, fetchImpl });
  return {
    unchanged: false,
    mode: "v2",
    snapshotId: pointer.snapshotId,
    stats: pulseStats,
    ...v2Data
  };
}

/**
 * Fetches per-source audit shard (`raw`, `attempts`, `observations`) on demand when
 * the user opens the Inspector drawer. Throws `code: "AUDIT_EXPIRED"` on HTTP 404.
 */
export async function fetchSourceAudit({
  snapshotId,
  sourceId,
  signal,
  cache = null,
  doc = globalThis.document,
  locationHref = globalThis.window?.location?.href || "https://vpsld.com/",
  fetchImpl = globalThis.fetch
} = {}) {
  if (!snapshotId || !sourceId || snapshotId.startsWith("v1_")) return null;
  const cacheKey = `${snapshotId}:${sourceId}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey);

  const safeSnap = encodeURIComponent(snapshotId);
  const safeSrc = encodeURIComponent(sourceId);
  const url = resolveSiteAssetUrl(`data/snapshots/${safeSnap}/audit/${safeSrc}.json`, {
    doc,
    locationHref
  });
  const reqSignal = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
  let res;
  try {
    res = await fetchImpl(url, {
      cache: "default",
      signal: reqSignal,
      headers: { accept: "application/json" }
    });
  } catch (err) {
    throw requestError(err, reqSignal);
  }

  if (res.status === 404) {
    throw {
      code: "AUDIT_EXPIRED",
      status: 404,
      message: "当前页面快照证据已归档，正在同步最新批次…"
    };
  }
  if (!res.ok) {
    throw {
      code: "HTTP",
      status: res.status,
      message: `审计证据加载失败（HTTP ${res.status}）`
    };
  }

  const parsed = SourceAuditSchema.parse(await res.json());
  cache?.set(cacheKey, parsed);
  return parsed;
}
