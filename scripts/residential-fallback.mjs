const eligibleSources = new Set(["catalog-greencloud", "catalog-novixlink"]);
const usable = (record) => !record.diagnostic && !["blocked", "error"].includes(record.status);

function needsFallback(records) {
  return records.some((record) => record.status === "error" ||
    (record.status === "blocked" && record.raw?.attempts?.some((attempt) =>
      ["challenge", "access-denied", "http-403"].includes(attempt.reason))));
}

function attemptSummary(egress, records) {
  return { egress, products: records.filter(usable).length,
    failures: records.filter((p) => !usable(p)).map((p) => ({ status: p.status, httpStatus: p.httpStatus, reason: p.error || p.evidence })) };
}

export async function collectWithResidentialFallback(source, collect, proxyUrl) {
  const direct = await collect(source);
  if (!proxyUrl || source.adapter !== "public_catalog" || !eligibleSources.has(source.id) || !needsFallback(direct)) return direct;
  const fallback = await collect({ ...source, proxyUrl });
  if (!fallback.length) return direct;
  const attempts = [attemptSummary("direct", direct), attemptSummary("residential", fallback)];
  const products = new Map(direct.filter(usable).map((p) => [p.id, p]));
  for (const record of fallback.filter(usable)) {
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
