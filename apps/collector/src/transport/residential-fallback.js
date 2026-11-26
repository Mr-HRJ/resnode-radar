const eligibleSources = new Set(["catalog-greencloud", "catalog-novixlink"]);
const usable = (record) => !record.diagnostic && !["blocked", "error"].includes(record.status);

function needsFallback(records) {
  if (records.some((record) => record.httpStatus === 429 || record.raw?.attempts?.some((attempt) =>
    attempt.httpStatus === 429 || attempt.reason === "rate-limited"))) return false;
  return records.some((record) => record.status === "error" ||
    (record.status === "blocked" && record.raw?.attempts?.some((attempt) =>
      ["challenge", "access-denied", "http-403"].includes(attempt.reason))));
}

function attemptSummary(egress, records) {
  return { egress, products: records.filter(usable).length,
    failures: records.filter((p) => !usable(p)).map((p) => ({ status: p.status, httpStatus: p.httpStatus, reason: p.error || p.evidence })) };
}

export async function collectWithResidentialFallback(source, collect, proxyUrl, { dmitEnabled = false } = {}) {
  const direct = await collect(source);
  const eligible = eligibleSources.has(source.id) || (dmitEnabled && source.id === "catalog-dmit" && source.catalogFormat === "dmit");
  if (!proxyUrl || source.adapter !== "public_catalog" || !eligible || !needsFallback(direct)) return direct;
  const fallback = await collect({ ...source, proxyUrl });
  if (!fallback.length) return direct;
  const attempts = [attemptSummary("direct", direct), attemptSummary("residential", fallback)];
  const products = new Map(direct.filter(usable).map((p) => [p.id, p]));
  for (const record of fallback.filter(usable)) {
    // A failed SKU retry must not replace inventory verified earlier in this run.
    if (source.id === "catalog-dmit" && products.get(record.id)?.raw?.inventoryChecked && !record.raw?.inventoryChecked) continue;
    products.set(record.id, { ...record, raw: { ...record.raw, egress: "residential", fallbackFrom: "direct" } });
  }
  const diagnostic = fallback.find((record) => !usable(record));
  if (diagnostic) {
    products.set(diagnostic.id, { ...diagnostic,
      evidence: `${diagnostic.evidence || diagnostic.error || "采集异常"}（已尝试家宽备用出口）`,
      raw: { ...diagnostic.raw, egress: "residential", egressAttempts: attempts } });
  }
  return [...products.values()];
}
