import { buildEventIndex, normalizeProduct } from "../domain/catalog.js";

export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const SNAPSHOT_TIMEOUT_MS = 20_000;

function requestError(err, signal) {
  return {
    code: signal.reason?.name === "TimeoutError" ? "TIMEOUT" : signal.aborted ? "ABORTED" : "NETWORK",
    status: null,
    message: signal.reason?.name === "TimeoutError" ? "库存快照读取超时，请重试" : "网络连接失败，无法触达库存快照接口",
    detail: err instanceof Error ? err.message : "Network request failed"
  };
}

function validSnapshot(payload) {
  if (!payload || payload.schemaVersion !== 1 || typeof payload.generatedAt !== "string" ||
      !Number.isFinite(Date.parse(payload.generatedAt)) || !Array.isArray(payload.products) || !payload.products.length) return false;
  const ids = new Set();
  for (const record of payload.products) {
    if (!record || typeof record !== "object" || typeof record.id !== "string" || !record.id.trim() ||
        ids.has(record.id) || !["available", "unavailable", "unknown", "blocked", "error"].includes(record.status)) return false;
    ids.add(record.id);
  }
  return payload.events === undefined || (Array.isArray(payload.events) && payload.events.every((event) =>
    event && typeof event.productId === "string" && ["restock", "soldout", "price"].includes(event.type) &&
    typeof event.at === "string" && Number.isFinite(Date.parse(event.at))));
}

/**
 * Reads published monitor snapshot JSON cleanly without ever inventing fallback data.
 * Uses relative `data/products.json` by default so both root Cloudflare Worker
 * (`/data/products.json`) and subpath static hosts (GitHub Pages) resolve reliably.
 */
export async function fetchSnapshot(endpoint = "data/products.json", { signal, timeoutMs = SNAPSHOT_TIMEOUT_MS } = {}) {
  const requestSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  const sep = endpoint.includes("?") ? "&" : "?";
  const url = `${endpoint}${sep}t=${Date.now()}`;
  let response;
  try {
    response = await fetch(url, {
      cache: "no-store",
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

  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    if (requestSignal.aborted) throw requestError(err, requestSignal);
    throw {
      code: "PARSE",
      status: response.status,
      message: "快照响应体不是有效的 JSON 数据",
      detail: "Invalid JSON payload"
    };
  }

  if (!validSnapshot(payload)) {
    throw {
      code: "SCHEMA",
      status: response.status,
      message: "快照数据结构不符合监控契约（版本、时间或记录格式异常）",
      detail: "Malformed snapshot schema"
    };
  }

  const now = Date.now();
  const events = [...(payload.events || [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const eventIndex = buildEventIndex(events);
  const allRecords = payload.products.map((raw, idx) =>
    normalizeProduct(raw, idx, payload.exchangeRates, eventIndex, now)
  );
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
