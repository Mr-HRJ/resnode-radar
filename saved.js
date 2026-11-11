const storageKey = "resnode-radar:saved:v1";

function defaultStorage() {
  try { return globalThis.localStorage; } catch { return undefined; }
}

function identityPart(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function positionalId(product, source, id) {
  const localId = id.startsWith(source) ? id.slice(source.length) : id;
  if (/^(?:-idx-|:card:)\d+$/.test(localId)) return true;
  if (/^-reader-.+-\d+$/.test(localId) &&
      (product?.adapter === "aaitr_store" || product?.raw?.strategy === "reader_snapshot")) return true;
  const index = product?.raw?.sourceCardIndex;
  if (!Number.isInteger(index) || index < 0) return false;
  if (["whmcs_group", "zlidc_product_wrap"].includes(product?.adapter) &&
      !product?.orderUrl && localId === `-pid-${index + 1}`) return true;
  return product?.adapter === "lagom_product_list" && localId.startsWith("-") && localId.endsWith(`:${index + 1}`);
}

// Collector positions are not plan IDs: use declared content when a fallback is positional.
export function savedKey(product) {
  const source = identityPart(product?.sourceId || product?.providerId || product?.provider);
  const id = identityPart(product?.id);
  if (id && !positionalId(product, source, id)) return `id:${JSON.stringify([source, id])}`;
  const fallback = [source, product?.name, product?.region, product?.route, product?.hardware, product?.orderUrl || product?.sourceUrl].map(identityPart);
  return fallback.some(Boolean) ? `fallback:${JSON.stringify(fallback)}` : "";
}

function validKey(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function loadSaved(storage = defaultStorage()) {
  try {
    const parsed = JSON.parse(storage?.getItem(storageKey) ?? "null");
    return new Set(Array.isArray(parsed) ? parsed.filter(validKey) : []);
  } catch {
    return new Set();
  }
}

// A failed write leaves the caller's Set available for the current session.
export function saveSaved(saved, storage = defaultStorage()) {
  try {
    if (!(saved instanceof Set) || !storage?.setItem) return false;
    storage.setItem(storageKey, JSON.stringify([...saved].filter(validKey)));
    return true;
  } catch {
    return false;
  }
}
