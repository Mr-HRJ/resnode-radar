import { text, normalizeSearch } from "./util.js";

export const statusLabels = {
  available: "可订购",
  unavailable: "不可订购",
  unknown: "未知",
  blocked: "被阻断",
  error: "抓取失败"
};

export const categoryNames = {
  all: "全部产品",
  vps: "普通 VPS",
  home: "家宽 / 住宅 VPS",
  unclassified: "待分类"
};

export const productCategories = ["vps", "home", "unclassified"];

// Product category comes from the reviewed source catalog, independently of IP claims.
export function productCategory(product) {
  return productCategories.includes(product.category) ? product.category : "unclassified";
}

export const ipTypeCategories = [
  { value: "home", label: "真家宽", dot: "#0ba678", desc: "真实家庭宽带" },
  { value: "residential", label: "住宅IP", dot: "#4f46e5", desc: "住宅 ISP" },
  { value: "native", label: "原生IP", dot: "#2563eb", desc: "原生 IP" },
  { value: "dual-isp", label: "双ISP", dot: "#7c3aed", desc: "双 ISP" },
  { value: "pending", label: "待核验", dot: "#8b94a3", desc: "待核验" }
];

export const ipTypeOrder = ["home", "dual-isp", "residential", "native", "pending"];

export const priceBands = [
  { value: "under-5", label: "≤ 5", test: (price) => Number.isFinite(price) && price <= 5 },
  { value: "5-10", label: "5-10", test: (price) => Number.isFinite(price) && price > 5 && price <= 10 },
  { value: "10-20", label: "10-20", test: (price) => Number.isFinite(price) && price > 10 && price <= 20 },
  { value: "20-50", label: "20-50", test: (price) => Number.isFinite(price) && price > 20 && price <= 50 },
  { value: "50-plus", label: "> 50", test: (price) => Number.isFinite(price) && price > 50 },
  { value: "unknown", label: "未标价", test: (price) => !Number.isFinite(price) }
];

export function statusClass(status) {
  return `is-${statusLabels[status] ? status : "unknown"}`;
}

export function statusRank(status) {
  if (status === "available") return 1;
  if (status === "unavailable") return 2;
  if (status === "unknown") return 3;
  if (status === "blocked") return 4;
  return 5;
}

export function searchableText(product) {
  return normalizeSearch([product.provider, product.name, product.region, product.route, product.note, product.evidence].filter(Boolean).join(" "));
}

export function stableProductKey(product, index) {
  return [
    product.id,
    product.sourceId,
    product.provider,
    product.name,
    product.region,
    product.route,
    product.price,
    product.orderUrl || product.sourceUrl,
    index
  ]
    .map((part) => encodeURIComponent(text(part, "")))
    .join("|");
}

export function inferIpType(product) {
  const value = [
    product.provider,
    product.name,
    product.region,
    product.route,
    product.note,
    product.hardware,
    product.bandwidth,
    product.evidence
  ]
    .filter(Boolean)
    .join(" ");

  if (/真家宽|家庭宽带|家里云|真实家宽|真实住宅|本地住宅ISP家寬|home broadband/i.test(value)) {
    return { value: "home", label: "真家宽", className: "is-home" };
  }
  if (/双\s*ISP|雙\s*ISP|\bdual[-\s]?isp\b/i.test(value)) {
    return { value: "dual-isp", label: "双ISP", className: "is-isp" };
  }
  if (/住宅|家宽|家寬|residential|AT&T|Frontier|T-Mobile|HiNet|HKT|HGC|HKBN|iCable|SoftBank|KDDI|Biglobe|Atlas Networks/i.test(value)) {
    return { value: "residential", label: "住宅IP", className: "is-residential" };
  }
  if (/原生\s*IP|native/i.test(value)) {
    return { value: "native", label: "原生IP", className: "is-native" };
  }
  return { value: "pending", label: "待核验", className: "is-pending" };
}

export function evidenceText(product) {
  return normalizeSearch(
    [
      product.evidence,
      product.status,
      product.statusLabel,
      product.note,
      product.raw?.strategy,
      product.raw?.stockLabel,
      product.raw?.official?.outcome
    ]
      .filter(Boolean)
      .join(" ")
  );
}

export function numericStockCount(product) {
  if (product.stockCount === undefined || product.stockCount === null || product.stockCount === "") return null;
  const value = Number(product.stockCount);
  return Number.isFinite(value) ? value : null;
}

export function evidenceBadge(product) {
  const evidence = evidenceText(product);
  const stockCount = numericStockCount(product);
  const hasPreciseStock = stockCount !== null;
  const isSnapshot = /reader_snapshot|third-party|snapshot|快照/i.test(evidence);

  if (product.status === "error" || /\berror\b|抓取失败|fetch failed|timeout/i.test(evidence)) {
    return { value: "error", label: "抓取失败", className: "is-error" };
  }
  if (product.status === "unavailable" || stockCount === 0) {
    return { value: "unavailable", label: "不可订购", className: "is-unavailable" };
  }
  if (hasPreciseStock) {
    return { value: "stock-count", label: `精确库存 ${stockCount}`, className: "is-count" };
  }
  if (isSnapshot) {
    return { value: "snapshot", label: "第三方快照", className: "is-snapshot" };
  }
  if (product.status === "blocked" || /blocked|被阻断|403|429|official direct fetch blocked/i.test(evidence)) {
    return { value: "blocked", label: "直连受阻", className: "is-blocked" };
  }
  if (product.orderUrl || /order link found|order=yes|official page|product card parsed from official page|立即订购|product-wrap order link/i.test(evidence)) {
    return { value: "official-order", label: "官方订购入口", className: "is-official" };
  }
  return { value: "unverified", label: "证据待核验", className: "is-unknown" };
}

export function orderabilityRank(product) {
  const stockCount = numericStockCount(product);
  const hasOrderUrl = Boolean(product.orderUrl);
  if (product.status === "available" && stockCount !== null && stockCount > 0) return 1;
  if (product.status === "available" && hasOrderUrl) return 2;
  if (product.status === "available") return 3;
  if (product.status === "unavailable") return 4;
  if (product.status === "unknown") return 5;
  if (product.status === "blocked") return 6;
  return 7;
}

export function stableCompare(a, b) {
  return a._stableKey.localeCompare(b._stableKey, "zh-CN");
}

export function normalizeProduct(product, index) {
  const ipType = inferIpType(product);
  const normalized = {
    ...product,
    _index: index,
    _stableKey: stableProductKey(product, index),
    _ipType: ipType,
    _searchText: searchableText(product)
  };
  normalized._evidenceBadge = evidenceBadge(normalized);
  return normalized;
}

export function priceBandFor(product) {
  return priceBands.find((band) => band.test(Number(product.priceValue)))?.value ?? "unknown";
}
