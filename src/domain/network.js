// Shared-resource CPUs/bandwidth and words such as "native" do not prove shared IP delivery.
export function hasSharedIpEvidence(product) {
  const features = product?.raw?.features;
  const declared = [
    product?.name, product?.route, product?.note, product?.hardware, product?.bandwidth,
    ...(Array.isArray(features) ? features : features && typeof features === "object"
      ? Object.entries(features).map(([key, value]) => `${key}: ${value}`) : [features])
  ].filter((value) => typeof value === "string").join(" ").normalize("NFKC");
  const text = declared.replace(/\b(?:no|without|non)[\s-]+NAT\b|(?:非|无|無)\s*NAT/gi, "");
  return /(?:^|[^a-z])NAT(?:[^a-z]|$)|共享\s*(?:IPv?[46]?|端口)|(?:IPv?[46]?|端口)\s*共享|shared\s*(?:IPv?[46]?|ports?)\b|\bIPv?[46]?\s*:\s*shared\b/i.test(text);
}
