import { providers } from "./providers.js";
import { normalizeSearch } from "./util.js";

export const routeOptions = [
  { value: "all", label: "全部线路" },
  { value: "cn2", label: "CN2 GIA / GT" },
  { value: "9929", label: "联通 9929" },
  { value: "cmin2", label: "CMIN2" },
  { value: "bgp", label: "BGP" },
  { value: "other", label: "其他 / 未标明" }
];

// These helpers return text for summaries/search, never markup or raw response dumps.
function plain(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).normalize("NFKC")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|#160);/gi, " ")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ").trim();
}

function featureEntries(product) {
  const features = product?.raw?.features;
  if (Array.isArray(features)) return features.map((value) => ["", plain(value)]);
  if (features && typeof features === "object") return Object.entries(features).map(([key, value]) => [plain(key), plain(value)]);
  return [["", plain(features)]];
}

const routePatterns = {
  cn2: /\b(?:cn\s*2(?=$|[^a-z0-9]|gia|gt)|as\s*4809\b)/i,
  "9929": /(?:\b(?:as\s*)?9929\b|\bcuii\b|\bcu2\b)/i,
  cmin2: /\b(?:cmi\s*n\s*2|as\s*58807)\b/i,
  bgp: /\bbgp\b/i
};
const carrierKey = /^(?:route|routing|carrier|network|线路|線路|网络|網絡|运营商|運營商|电信|電信|联通|聯通|移动|移動)$/i;

export function matchesRoute(product, value) {
  if (value === "all") return true;
  const declared = [product?.route, product?.name, product?.carrier,
    ...featureEntries(product).filter(([key]) => !key || carrierKey.test(key)).map(([, content]) => content)
  ].map(plain).join(" ");
  if (value === "other") return !Object.values(routePatterns).some((pattern) => pattern.test(declared));
  return Object.hasOwn(routePatterns, value) && routePatterns[value].test(declared);
}

const fieldNames = {
  cpu: /^(?:cpu|vcpu|processor|处理器|處理器)$/i,
  memory: /^(?:ram|memory|内存|內存)$/i,
  disk: /^(?:storage|disk|ssd|nvme|hdd|硬盘|硬盤|磁盘|磁盤|存储|存儲|系统盘|系統盤|数据盘|資料盤)$/i,
  bandwidth: /^(?:bandwidth|port(?: speed)?|network speed|带宽|帶寬|頻寬)$/i,
  traffic: /^(?:traffic|transfer|data transfer|monthly (?:traffic|transfer)|流量|月流量)$/i
};
const number = String.raw`\d+(?:\.\d+)?(?:\s*[-–~]\s*\d+(?:\.\d+)?)?`;
const size = String.raw`${number}\s*[KMGT](?:i?B)?(?:\s*[-–~]\s*\d+(?:\.\d+)?\s*[KMGT](?:i?B)?)?(?![a-z]|\s*\/s\b)`;
const capacityPattern = new RegExp(size, "i");
const bareCapacity = new RegExp(`^${size}$`, "i");
const cpuPattern = new RegExp(String.raw`${number}\s*(?:[x×*]\s*)?(?:v\s*(?:cpus?|cores?)|cpus?|cores?(?:\(s\))?|核(?:心)?)(?![a-z])`, "i");
const modelCpuPattern = /\d+\s*[x×*]\s*(?:Intel|AMD|Xeon|EPYC|E\d)\b[^/|]*/i;
const memoryPattern = new RegExp(`(${size})\\s*(?:DDR\\d*(?:@[^\\s]+)?\\s*)?(?:RAM\\b|memory\\b|[内內]存)|(${size})\\s*DDR\\d*`, "i");
const diskPattern = new RegExp(`${size}\\s*(?:RAID[- ]?\\d+\\s*)?(?:SSD|NVMe|HDD|disk|storage|硬[盘盤]|磁[盘盤]|存[储儲])`, "i");
const speedPattern = new RegExp(`(${number})\\s*([KMGT])(bps|bit(?:/s)?)(?![a-z])`, "i");
const unlimitedPattern = /\bunlimited\b|\bunmetered\b|不限(?:制)?(?:流)?量|无限流量|無限流量|不计流量|不計流量/i;

function segments(value) {
  // "CPU | 1 vCore" is a label; other slashes/pipes separate declared fields.
  return plain(value).replace(/\b(CPU|RAM|Memory|Storage|Disk|Bandwidth|Traffic|Network)\s*\|/gi, "$1:")
    .split(/\s*(?:[|;]|\/(?!s\b|mo\b|month\b))\s*/i).map((part) => part.replace(/^[•\s"'“”‘’]+|[\s"'“”‘’]+$/g, "")).filter(Boolean);
}

function labeled(segment) {
  const match = segment.match(/^([^:]{1,24}):\s*(.+)$/);
  return match ? [match[1].trim(), match[2]] : ["", segment];
}

function speed(value, shorthand = false) {
  const match = value.match(speedPattern);
  if (match) return `${match[1]} ${match[2].toUpperCase()}${match[3] === "Bps" ? "Bps" : "bps"}`;
  const bytes = value.match(new RegExp(`${number}\\s*[KMGT]B/s\\b`));
  if (bytes) return bytes[0];
  const short = shorthand && value.match(new RegExp(`^(${number})\\s*([KMGT])(?![a-z])`, "i"));
  return short ? `${short[1]} ${short[2].toUpperCase()}bps` : "";
}

function declaredSpec(kind, value, key) {
  if (!value || /^(?:[-—?]|n\/?a|unknown|待核验|未知|未标明|未提供)$/i.test(value)) return "";
  if (kind === "cpu") return /\d|intel|amd|xeon|epyc/i.test(value) ? value : "";
  if (kind === "bandwidth") return speed(value, true);
  if (kind === "traffic" && (unlimitedPattern.test(value) || /^不限(?:制)?(?:$|\s|\()/.test(value))) return "不限流量";
  if (!capacityPattern.test(value)) return "";
  if (kind === "disk" && /^(?:ssd|nvme|hdd)$/i.test(key) && !new RegExp(key, "i").test(value)) return `${value} ${key.toUpperCase()}`;
  return value;
}

function networkTraffic(network) {
  for (const [key, value] of segments(network).map(labeled)) {
    if (fieldNames.bandwidth.test(key)) continue;
    if (unlimitedPattern.test(value)) return "不限流量";
    const capacity = value.match(capacityPattern)?.[0];
    // Unlabeled M/G shorthand can describe a port speed; require bytes or quota context.
    if (capacity && (/[KMGT]i?B/i.test(capacity) || /流量|traffic|transfer|双向|雙向/i.test(value))) return capacity;
  }
  return "";
}

export function productSpecs(product) {
  const features = featureEntries(product);
  const hardware = segments([plain(product?.hardware), ...features.filter(([key]) => !key || /^(?:配置|hardware)$/i.test(key)).map(([, value]) => value)].join(" / "));
  const network = plain(product?.bandwidth);
  const result = { cpu: "", memory: "", disk: "", bandwidth: "", traffic: "" };
  const declared = [...features, ...hardware.map(labeled), ...segments(network).map(labeled)];
  for (const [key, value] of declared) {
    for (const [kind, pattern] of Object.entries(fieldNames)) {
      if (!result[kind] && pattern.test(key)) result[kind] = declaredSpec(kind, value, key);
    }
  }
  for (const part of hardware) {
    result.cpu ||= part.match(cpuPattern)?.[0] || part.match(modelCpuPattern)?.[0] || "";
    const memory = part.match(memoryPattern);
    result.memory ||= memory?.[1] || memory?.[2] || "";
    result.disk ||= part.match(diskPattern)?.[0] || "";
  }
  // Only recognize the common CPU / RAM / disk shorthand in that order.
  if (cpuPattern.test(hardware[0] || "") || modelCpuPattern.test(hardware[0] || "")) {
    if (bareCapacity.test(hardware[1] || "")) result.memory ||= hardware[1];
    if (result.memory && bareCapacity.test(hardware[2] || "")) result.disk ||= hardware[2];
  }
  result.bandwidth ||= speed(network);
  result.traffic ||= networkTraffic(network);
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value || "未标明"]));
}

const countryPatterns = [
  ["US", /美国|美國|洛杉矶|洛杉磯|纽约|紐約|\b(?:us|usa|united states|los angeles|new york|seattle)\b/i],
  ["GB", /英国|英國|伦敦|倫敦|\b(?:uk|gb|united kingdom|britain|london)\b/i],
  ["HK", /香港|\b(?:hk|cnhk|hong kong)\b/i],
  ["TW", /台湾|台灣|臺灣|台北|臺北|\b(?:tw|cntw|taiwan|taipei)\b/i],
  ["MO", /澳门|澳門|\b(?:mo|macau|macao)\b/i],
  ["CN", /中国|中國|大陆|大陸|内地|內地|\b(?:cn|china)\b/i],
  ["JP", /日本|东京|東京|大阪|\b(?:jp|japan|tokyo|osaka)\b/i],
  ["SG", /新加坡|\b(?:sg|singapore)\b/i],
  ["KR", /韩国|韓國|首尔|首爾|\b(?:kr|south korea|korea|seoul)\b/i],
  ["DE", /德国|德國|法兰克福|法蘭克福|\b(?:de|germany|frankfurt)\b/i],
  ["CA", /加拿大|\b(?:ca|canada)\b/i],
  ["NL", /荷兰|荷蘭|\b(?:nl|netherlands|amsterdam)\b/i],
  ["FR", /法国|法國|\b(?:fr|france|paris)\b/i],
  ["AU", /澳大利亚|澳大利亞|澳洲|\b(?:au|australia|sydney)\b/i],
  ["MY", /马来西亚|馬來西亞|\b(?:my|malaysia)\b/i],
  ["VN", /越南|\b(?:vn|vietnam)\b/i],
  ["IN", /印度|\b(?:india)\b|^in$/i],
  ["TH", /泰国|泰國|\b(?:th|thailand)\b/i]
];

export function regionFlag(region) {
  let value = plain(region);
  if (!value || /多地区|多地區|全球|多国|多國|global|worldwide|multiple/i.test(value)) return "◎";
  value = value.replace(/(?:中国|中國|china)\s*(?=香港|澳门|澳門|台湾|台灣|臺灣|hong kong|macau|macao|taiwan)/gi, "")
    .replace(/\b(USA?|United States),?\s+CA\b/gi, "$1 California");
  const matches = countryPatterns.filter(([, pattern]) => pattern.test(value));
  if (matches.length !== 1) return "◎";
  return [...matches[0][0]].map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0))).join("");
}

export function providerInitial(name) {
  const words = plain(name).replace(/([a-z])([A-Z])/g, "$1 $2").match(/[\p{L}\p{N}]+/gu) || [];
  const initials = words.length > 1 ? words.slice(0, 2).map((word) => [...word][0]).join("") : words[0] || "?";
  return [...initials.toUpperCase()].slice(0, 2).join("");
}

export function monitorFreshness(generatedAt, now = Date.now()) {
  const validInput = generatedAt instanceof Date || typeof generatedAt === "number" || (typeof generatedAt === "string" && generatedAt.trim());
  const timestamp = validInput ? new Date(generatedAt).getTime() : NaN;
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return { stale: true, label: "更新时间未知" };
  const age = Math.max(0, now - timestamp);
  const minutes = Math.floor(age / 60000);
  const label = minutes < 1 ? "刚刚更新" : minutes < 60 ? `${minutes} 分钟前更新`
    : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时前更新` : `${Math.floor(minutes / 1440)} 天前更新`;
  return { stale: age > 90 * 60000, label };
}

export function productSearchText(product) {
  const providerName = normalizeSearch(plain(product?.provider));
  const provider = providers.find((entry) => entry.id === product?.providerId ||
    [entry.id, entry.name, ...entry.aliases, ...entry.inventoryNames].some((name) => normalizeSearch(name) === providerName));
  return normalizeSearch([
    product?.provider, provider?.name, ...(provider?.aliases || []), product?.name, product?.region,
    product?.route, product?.carrier, product?.hardware, product?.bandwidth,
    ...featureEntries(product).flat(), ...Object.values(productSpecs(product)).filter((value) => value !== "未标明")
  ].map(plain).filter(Boolean).join(" "));
}
