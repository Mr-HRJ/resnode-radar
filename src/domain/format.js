import { providers } from "../../providers.js";
import { monthlyCny, priceQuote } from "../../pricing.js";

export const ROUTE_OPTIONS = [
  { value: "all", label: "全部线路" },
  { value: "cn2", label: "CN2 GIA / GT" },
  { value: "9929", label: "联通 9929" },
  { value: "cmin2", label: "移动 CMIN2" },
  { value: "4837", label: "联通 4837" },
  { value: "bgp", label: "BGP 国际" },
  { value: "other", label: "其他 / 未标明" }
];

export const MACRO_REGIONS = [
  { value: "all", label: "全部地区", flag: "" },
  { value: "US", label: "美国", flag: "🇺🇸" },
  { value: "HK", label: "香港", flag: "🇭🇰" },
  { value: "JP", label: "日本", flag: "🇯🇵" },
  { value: "TW", label: "台湾", flag: "🇹🇼" },
  { value: "SG", label: "新加坡", flag: "🇸🇬" },
  { value: "GB", label: "英国", flag: "🇬🇧" },
  { value: "DE", label: "德国", flag: "🇩🇪" },
  { value: "KR", label: "韩国", flag: "🇰🇷" },
  { value: "EU", label: "欧洲其他", flag: "🇪🇺" },
  { value: "APAC", label: "亚太其他", flag: "🌏" },
  { value: "MULTI", label: "多地区/全球", flag: "◎" }
];

export const BUDGET_OPTIONS = [
  { value: "all", label: "不限预算", max: null },
  { value: "30", label: "≤ ¥30/月", max: 30 },
  { value: "60", label: "≤ ¥60/月", max: 60 },
  { value: "150", label: "≤ ¥150/月", max: 150 },
  { value: "300", label: "≤ ¥300/月", max: 300 },
  { value: "600", label: "≤ ¥600/月", max: 600 }
];

export const CYCLE_OPTIONS = [
  { value: "all", label: "不限周期" },
  { value: "monthly", label: "月付" },
  { value: "quarterly", label: "季付" },
  { value: "semiannual", label: "半年付" },
  { value: "annual", label: "年付及以上" }
];

export function text(value, fallback = "-") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

export function normalizeSearch(value) {
  return text(value, "").normalize("NFKC").toLocaleLowerCase("zh-CN");
}

export function escapeHtml(value) {
  return text(value, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function safeUrl(value, baseHref = globalThis.window?.location?.href || "https://resnode-radar.local/") {
  const href = text(value, "").trim();
  if (!href) return "";
  try {
    const url = new URL(href, baseHref);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch {
    return "";
  }
  return "";
}

export function plain(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value)
    .normalize("NFKC")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|#160);/gi, " ")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatShortTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatClockTime(value) {
  if (!value) return "--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDayKey(value) {
  if (!value) return "未知日期";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知日期";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatCny(amount) {
  if (!Number.isFinite(amount)) return "-";
  if (amount >= 100) return `¥${Math.round(amount)}`;
  return `¥${amount.toFixed(1)}`;
}

export const STALE_AFTER_MINUTES = 30;

export function monitorFreshness(generatedAt, now = Date.now()) {
  const validInput =
    generatedAt instanceof Date ||
    typeof generatedAt === "number" ||
    (typeof generatedAt === "string" && generatedAt.trim());
  const timestamp = validInput ? new Date(generatedAt).getTime() : NaN;
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) {
    return { stale: true, ageMinutes: null, label: "更新时间未知" };
  }
  const age = Math.max(0, now - timestamp);
  const minutes = Math.floor(age / 60000);
  const label =
    minutes < 1
      ? "刚刚同步"
      : minutes < 60
        ? `${minutes} 分钟前`
        : minutes < 1440
          ? `${Math.floor(minutes / 60)} 小时前`
          : `${Math.floor(minutes / 1440)} 天前`;
  // The collector runs every 10 minutes; three missed cycles mark the snapshot stale.
  return { stale: age > STALE_AFTER_MINUTES * 60000, ageMinutes: minutes, label };
}

export function fxFreshness(snapshot, now = Date.now()) {
  if (!snapshot || snapshot.base !== "CNY" || typeof snapshot.date !== "string") {
    return { valid: false, expired: false, date: null, label: "汇率快照缺失" };
  }
  const parsed = Date.parse(`${snapshot.date}T00:00:00Z`);
  if (!Number.isFinite(parsed) || !Number.isFinite(now)) {
    return { valid: false, expired: false, date: snapshot.date, label: "汇率日期异常" };
  }
  const age = now - parsed;
  if (age < -86400000) {
    return { valid: false, expired: false, date: snapshot.date, label: `汇率日期异常 (${snapshot.date})` };
  }
  if (age > 7 * 86400000) {
    return { valid: false, expired: true, date: snapshot.date, label: `ECB 汇率 ${snapshot.date} 已超 7 天` };
  }
  return { valid: true, expired: false, date: snapshot.date, label: `ECB ${snapshot.date}` };
}

export function describePricing(product, exchangeRates, now = Date.now()) {
  const quote = priceQuote(product || {});
  const originalLabel = plain(product?.price) || "未公开报价";
  const fx = fxFreshness(exchangeRates, now);
  const cnyMonthly = monthlyCny(product || {}, exchangeRates, now);

  if (quote.amount === null) {
    return {
      quote,
      originalLabel,
      cnyMonthly: null,
      cnyLabel: "未公开数值报价",
      cnyTone: "muted",
      formula: null,
      honestReason: "页面未提供可解析的固定数值价格，请以官网结账页为准。"
    };
  }
  if (quote.baseOnly) {
    return {
      quote,
      originalLabel,
      cnyMonthly: null,
      cnyLabel: "起步价 · 选配计费",
      cnyTone: "warn",
      formula: null,
      honestReason: "官方标注为起步配置或可选配价格，为防止误导不折算固定月均价。"
    };
  }
  if (quote.months === null) {
    return {
      quote,
      originalLabel,
      cnyMonthly: null,
      cnyLabel: `${quote.period} · 不折算`,
      cnyTone: "warn",
      formula: null,
      honestReason: `计费周期识别为「${quote.period}」，无法按自然月精确分摊。`
    };
  }
  if (!quote.currency) {
    return {
      quote,
      originalLabel,
      cnyMonthly: null,
      cnyLabel: "币种待核对 · 不折算",
      cnyTone: "warn",
      formula: null,
      honestReason: "报价币种存在缺失或冲突，未进行人民币折算。"
    };
  }
  if (quote.currency === "CNY" && Number.isFinite(cnyMonthly)) {
    const cycleSuffix = quote.months > 1 ? `按${quote.period}分摊` : "人民币月付";
    return {
      quote,
      originalLabel,
      cnyMonthly,
      cnyLabel: quote.months > 1 ? `≈ ${formatCny(cnyMonthly)}/月 (${cycleSuffix})` : `${formatCny(cnyMonthly)}/月`,
      cnyTone: "ok",
      formula:
        quote.months > 1
          ? `CNY ${quote.amount.toFixed(2)} ÷ ${quote.months} 个月 = ¥${cnyMonthly.toFixed(2)}/月`
          : `CNY ${quote.amount.toFixed(2)} / 月（原币种直付，无汇兑损益）`,
      honestReason: null
    };
  }
  if (!Number.isFinite(cnyMonthly)) {
    const reason = fx.expired
      ? `汇率超7天 (${fx.date}) · 停算`
      : !fx.valid
        ? "汇率快照不可用 · 停算"
        : `缺少 ${quote.currency} 参考汇率`;
    return {
      quote,
      originalLabel,
      cnyMonthly: null,
      cnyLabel: reason,
      cnyTone: "warn",
      formula: null,
      honestReason: fx.expired
        ? `ECB 汇率快照日期为 ${fx.date}，已超过 7 天诚实性红线，前端主动停止外币折算。`
        : "未获取到有效 ECB 汇率，仅保留原币种账单。"
    };
  }

  const rate = exchangeRates?.rates?.[quote.currency];
  return {
    quote,
    originalLabel,
    cnyMonthly,
    cnyLabel: `≈ ${formatCny(cnyMonthly)}/月`,
    cnyTone: "ok",
    formula: `${quote.currency} ${quote.amount.toFixed(2)} ÷ ${quote.months} 月 × ${Number(rate).toFixed(4)} (ECB ${fx.date}) ≈ ¥${cnyMonthly.toFixed(2)}/月`,
    honestReason: null
  };
}

export function formatEventDelta(event) {
  if (event?.type !== "price") return null;
  const prev = Number(event.previousPriceValue);
  const curr = Number(event.priceValue);
  if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev <= 0) return null;
  const diff = curr - prev;
  const pct = (diff / prev) * 100;
  return {
    diff,
    pct,
    direction: diff < 0 ? "down" : diff > 0 ? "up" : "flat",
    label: `${diff > 0 ? "+" : ""}${pct.toFixed(1)}%`
  };
}

export function featureEntries(product) {
  const features = product?.raw?.features;
  if (Array.isArray(features)) return features.map((value) => ["", plain(value)]);
  if (features && typeof features === "object") {
    return Object.entries(features).map(([key, value]) => [plain(key), plain(value)]);
  }
  return [["", plain(features)]];
}

const routePatterns = {
  cn2: /\b(?:cn\s*2(?=$|[^a-z0-9]|gia|gt)|as\s*4809\b)/i,
  "9929": /(?:\b(?:as\s*)?9929\b|\bcuii\b|\bcu2\b)/i,
  cmin2: /\b(?:cmi\s*n\s*2|as\s*58807)\b/i,
  "4837": /\b(?:as\s*)?4837\b/i,
  bgp: /\bbgp\b/i
};

const coreRouteKeys = ["cn2", "9929", "cmin2", "4837", "bgp"];
const carrierKey = /^(?:route|routing|carrier|network|线路|線路|网络|網絡|运营商|運營商|电信|電信|联通|聯通|移动|移動)$/i;

export function declaredRouteText(product) {
  return [
    product?.route,
    product?.name,
    product?.carrier,
    ...featureEntries(product)
      .filter(([key]) => !key || carrierKey.test(key))
      .map(([, content]) => content)
  ]
    .map(plain)
    .filter(Boolean)
    .join(" ");
}

export function matchesRoute(product, value) {
  if (value === "all") return true;
  const declared = declaredRouteText(product);
  if (value === "other") return !coreRouteKeys.some((key) => routePatterns[key].test(declared));
  return Object.hasOwn(routePatterns, value) && routePatterns[value].test(declared);
}

export function detectedRoutes(product) {
  const declared = declaredRouteText(product);
  const found = [];
  if (routePatterns.cn2.test(declared)) found.push("CN2");
  if (routePatterns["9929"].test(declared)) found.push("9929");
  if (routePatterns.cmin2.test(declared)) found.push("CMIN2");
  if (routePatterns["4837"].test(declared)) found.push("4837");
  if (routePatterns.bgp.test(declared)) found.push("BGP");
  return found;
}

const fieldNames = {
  cpu: /^(?:cpu|vcpu|processor|处理器|處理器)$/i,
  memory: /^(?:ram|memory|内存|內存)$/i,
  disk: /^(?:storage|disk|ssd|nvme|hdd|硬盘|硬盤|磁盘|磁盤|存储|存儲|系统盘|系統盤|数据盘|資料盤)$/i,
  bandwidth: /^(?:bandwidth|port(?: speed)?|network speed|带宽|帶寬|頻寬)$/i,
  traffic: /^(?:traffic|transfer|data transfer|monthly (?:traffic|transfer)|流量|月流量)$/i
};

const numRe = String.raw`\d+(?:\.\d+)?(?:\s*[-–~]\s*\d+(?:\.\d+)?)?`;
const sizeRe = String.raw`${numRe}\s*[KMGT](?:i?B)?(?:\s*[-–~]\s*\d+(?:\.\d+)?\s*[KMGT](?:i?B)?)?(?![a-z]|\s*\/s\b)`;
const capacityPattern = new RegExp(sizeRe, "i");
const bareCapacity = new RegExp(`^${sizeRe}$`, "i");
const cpuPattern = new RegExp(String.raw`${numRe}\s*(?:[x×*]\s*)?(?:v\s*(?:cpus?|cores?)|cpus?|cores?(?:\(s\))?|核(?:心)?)(?![a-z])`, "i");
const modelCpuPattern = /\d+\s*[x×*]\s*(?:Intel|AMD|Xeon|EPYC|E\d)\b[^/|]*/i;
const memoryPattern = new RegExp(`(${sizeRe})\\s*(?:DDR\\d*(?:@[^\\s]+)?\\s*)?(?:RAM\\b|memory\\b|[内內]存)|(${sizeRe})\\s*DDR\\d*`, "i");
const diskPattern = new RegExp(`${sizeRe}\\s*(?:RAID[- ]?\\d+\\s*)?(?:SSD|NVMe|HDD|disk|storage|硬[盘盤]|磁[盘盤]|存[储儲])`, "i");
const speedPattern = new RegExp(`(${numRe})\\s*([KMGT])(bps|bit(?:/s)?)(?![a-z])`, "i");
const unlimitedPattern = /\bunlimited\b|\bunmetered\b|不限(?:制)?(?:流)?量|无限流量|無限流量|不计流量|不計流量/i;

function segments(value) {
  return plain(value)
    .replace(/\b(CPU|RAM|Memory|Storage|Disk|Bandwidth|Traffic|Network)\s*\|/gi, "$1:")
    .split(/\s*(?:[|;]|\/(?!s\b|mo\b|month\b))\s*/i)
    .map((part) => part.replace(/^[•\s"'“”‘’]+|[\s"'“”‘’]+$/g, ""))
    .filter(Boolean);
}

function normalizeParentheses(str) {
  return str.replace(/\s*（\s*/g, "(").replace(/\s*）\s*/g, ")");
}

function labeled(segment) {
  const match = segment.match(/^([^:：]{1,24})[:：]\s*(.+)$/);
  return match
    ? [match[1].trim(), normalizeParentheses(match[2])]
    : ["", normalizeParentheses(segment)];
}

function speed(value, shorthand = false) {
  const match = value.match(speedPattern);
  if (match) return `${match[1]} ${match[2].toUpperCase()}${match[3] === "Bps" ? "Bps" : "bps"}`;
  const bytes = value.match(new RegExp(`${numRe}\\s*[KMGT]B/s\\b`));
  if (bytes) return bytes[0];
  const short = shorthand && value.match(new RegExp(`^(${numRe})\\s*([KMGT])(?![a-z])`, "i"));
  return short ? `${short[1]} ${short[2].toUpperCase()}bps` : "";
}

function declaredSpec(kind, value, key) {
  if (!value || /^(?:[-—?]|n\/?a|unknown|待核验|未知|未标明|未提供)$/i.test(value)) return "";
  if (kind === "cpu") return /\d|intel|amd|xeon|epyc/i.test(value) ? normalizeParentheses(value) : "";
  if (kind === "bandwidth") return speed(value, true);
  if (kind === "traffic" && (unlimitedPattern.test(value) || /^不限(?:制)?(?:$|\s|\()/.test(value))) return "不限流量";
  if (!capacityPattern.test(value)) return "";
  if (kind === "disk" && /^(?:ssd|nvme|hdd)$/i.test(key) && !new RegExp(key, "i").test(value)) {
    return `${normalizeParentheses(value)} ${key.toUpperCase()}`;
  }
  return normalizeParentheses(value);
}

function networkTraffic(network) {
  for (const [key, value] of segments(network).map(labeled)) {
    if (fieldNames.bandwidth.test(key)) continue;
    if (unlimitedPattern.test(value)) return "不限流量";
    const capacity = value.match(capacityPattern)?.[0];
    if (capacity && (/[KMGT]i?B/i.test(capacity) || /流量|traffic|transfer|双向|雙向|in\+out/i.test(value))) {
      const suffixMatch = value.slice(value.indexOf(capacity) + capacity.length).match(/^\((?:in\+out|双向|雙向)\)/i);
      return suffixMatch ? `${capacity}${suffixMatch[0]}` : capacity;
    }
  }
  return "";
}

export function productSpecs(product) {
  const features = featureEntries(product);
  const hardware = segments(
    [plain(product?.hardware), ...features.filter(([key]) => !key || /^(?:配置|hardware)$/i.test(key)).map(([, value]) => value)].join(" / ")
  );
  const network = plain(product?.bandwidth);
  const result = { cpu: "", memory: "", disk: "", bandwidth: "", traffic: "" };
  const declared = [
    ...features.map(([k, v]) => [k, normalizeParentheses(v)]),
    ...hardware.map(labeled),
    ...segments(network).map(labeled)
  ];
  for (const [key, value] of declared) {
    for (const [kind, pattern] of Object.entries(fieldNames)) {
      if (!result[kind] && pattern.test(key)) result[kind] = declaredSpec(kind, value, key);
    }
  }
  for (const part of hardware) {
    const cleanPart = normalizeParentheses(part);
    result.cpu ||= cleanPart.match(cpuPattern)?.[0] || cleanPart.match(modelCpuPattern)?.[0] || "";
    const memory = cleanPart.match(memoryPattern);
    result.memory ||= memory?.[1] || memory?.[2] || "";
    result.disk ||= cleanPart.match(diskPattern)?.[0] || "";
  }
  if (cpuPattern.test(hardware[0] || "") || modelCpuPattern.test(hardware[0] || "")) {
    if (bareCapacity.test(hardware[1] || "")) result.memory ||= hardware[1];
    if (result.memory && bareCapacity.test(hardware[2] || "")) result.disk ||= hardware[2];
  }
  result.bandwidth ||= speed(network);
  result.traffic ||= networkTraffic(network);
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value || "未标明"]));
}

const countryPatterns = [
  ["US", /美国|美國|洛杉矶|洛杉磯|纽约|紐約|芝加哥|西雅图|达拉斯|圣何塞|硅谷|夏威夷|\b(?:us|usa|united states|los angeles|new york|seattle|chicago|dallas|san jose|hawaii)\b/i],
  ["GB", /英国|英國|伦敦|倫敦|\b(?:uk|gb|united kingdom|britain|london)\b/i],
  ["HK", /香港|\b(?:hk|cnhk|hong kong)\b/i],
  ["TW", /台湾|台灣|臺灣|台北|臺北|彰化|\b(?:tw|cntw|taiwan|taipei)\b/i],
  ["MO", /澳门|澳門|\b(?:mo|macau|macao)\b/i],
  ["CN", /中国|中國|大陆|大陸|内地|內地|\b(?:cn|china)\b/i],
  ["JP", /日本|东京|東京|大阪|\b(?:jp|japan|tokyo|osaka)\b/i],
  ["SG", /新加坡|\b(?:sg|sgp|singapore)\b/i],
  ["KR", /韩国|韓國|首尔|首爾|\b(?:kr|icn|south korea|korea|seoul)\b/i],
  ["DE", /德国|德國|法兰克福|法蘭克福|\b(?:de|germany|frankfurt)\b/i],
  ["CA", /加拿大|\b(?:ca|canada|toronto)\b/i],
  ["NL", /荷兰|荷蘭|\b(?:nl|netherlands|amsterdam)\b/i],
  ["FR", /法国|法國|\b(?:fr|france|paris)\b/i],
  ["AU", /澳大利亚|澳大利亞|澳洲|\b(?:au|australia|sydney)\b/i],
  ["MY", /马来西亚|馬來西亞|\b(?:my|malaysia)\b/i],
  ["VN", /越南|\b(?:vn|vietnam)\b/i],
  ["RO", /罗马尼亚|羅馬尼亞|\b(?:ro|romania)\b/i],
  ["EE", /爱沙尼亚|\b(?:ee|estonia)\b/i],
  ["IN", /印度|\b(?:india)\b|^in$/i],
  ["TH", /泰国|泰國|\b(?:th|thailand)\b/i]
];

const euCodes = new Set(["NL", "FR", "RO", "EE"]);
const apacCodes = new Set(["AU", "MY", "VN", "IN", "TH", "MO", "CN"]);

function cleanRegionInput(region) {
  return plain(region)
    .replace(/(?:中国|中國|china)\s*(?=香港|澳门|澳門|台湾|台灣|臺灣|hong kong|macau|macao|taiwan)/gi, "")
    .replace(/\b(USA?|United States),?\s+CA\b/gi, "$1 California");
}

export function regionFlag(region) {
  const raw = plain(region);
  if (!raw || /多地区|多地區|全球|多国|多國|global|worldwide|multiple/i.test(raw)) return "◎";
  const value = cleanRegionInput(raw);
  const matches = countryPatterns.filter(([, pattern]) => pattern.test(value));
  if (matches.length !== 1) return "◎";
  const code = matches[0][0];
  return [...code].map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0))).join("");
}

export function productRegions(product) {
  return [
    ...new Set(
      [product?.region, ...(Array.isArray(product?.regions) ? product.regions : [])]
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim())
    )
  ];
}

export function macroRegionsFor(product) {
  const declared = productRegions(product);
  const fallback = declared.length ? declared : [product?.name, product?.provider].filter(Boolean);
  const macros = new Set();
  for (const item of fallback) {
    if (declared.length && /多地区|多地區|全球|多国|多國|global|worldwide|multiple/i.test(item)) {
      macros.add("MULTI");
      continue;
    }
    const cleaned = cleanRegionInput(item);
    const matchedCodes = countryPatterns.filter(([, pattern]) => pattern.test(cleaned)).map(([code]) => code);
    if (declared.length && matchedCodes.length > 1) macros.add("MULTI");
    for (const code of matchedCodes) {
      if (["US", "HK", "JP", "TW", "SG", "GB", "DE", "KR"].includes(code)) macros.add(code);
      else if (euCodes.has(code)) macros.add("EU");
      else if (apacCodes.has(code)) macros.add("APAC");
    }
    if (!declared.length && macros.size) break;
  }
  return [...macros];
}

export function providerInitial(name) {
  const cleaned = plain(name);
  const primary = cleaned.replace(/\s*[（(].*$/, "").trim() || cleaned;
  const words = primary.replace(/([a-z])([A-Z])/g, "$1 $2").match(/[\p{L}\p{N}]+/gu) || [];
  const initials =
    words.length > 1
      ? words.slice(0, 2).map((word) => [...word][0]).join("")
      : [...(words[0] || "?")].slice(0, 2).join("");
  return [...initials.toUpperCase()].slice(0, 2).join("");
}

const searchProviderById = new Map(providers.map((p) => [normalizeSearch(p.id), p]));
const searchProviderByName = new Map();
for (const provider of providers) {
  for (const name of [provider.id, provider.name, ...(provider.aliases || []), ...(provider.inventoryNames || [])]) {
    const key = normalizeSearch(name);
    if (!searchProviderByName.has(key)) searchProviderByName.set(key, provider);
  }
}

export function productSearchText(product, specs = productSpecs(product)) {
  if (!product || typeof product !== "object") return "";
  const providerName = normalizeSearch(plain(product?.provider));
  const provider = searchProviderById.get(normalizeSearch(product.providerId)) || searchProviderByName.get(providerName);
  return normalizeSearch(
    [
      product?.provider,
      provider?.name,
      ...(provider?.aliases || []),
      product?.name,
      ...productRegions(product),
      product?.route,
      product?.carrier,
      product?.hardware,
      product?.bandwidth,
      ...featureEntries(product).flat(),
      ...Object.values(specs).filter((value) => value !== "未标明")
    ]
      .map(plain)
      .filter(Boolean)
      .join(" ")
  );
}
