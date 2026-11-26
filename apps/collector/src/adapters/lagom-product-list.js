import { parse } from "node-html-parser";

const defaultCardSelector = ".product, .package";
const defaultNameSelector = ".package-title, .product-title, h3, h4";
const pricePattern = /(?:¥|￥|\$)\s*[0-9][0-9,.]*(?:\.[0-9]+)?\s*(?:CNY|USD|CAD|元)?|[0-9][0-9,.]*(?:\.[0-9]+)?\s*元/i;
const stockPattern = /(\d+)\s*可用|Sold Out|Out of Stock|缺货中|缺货|售罄|已售罄/i;

function firstText(card, selectors, cleanText) {
  for (const selector of selectors.split(",")) {
    const value = cleanText(card.querySelector(selector.trim())?.text);
    if (value) return value;
  }
  return "";
}

function extractPrice(card, text, cleanText) {
  const fromNode = cleanText(card.querySelector(".price-amount, .price, .product-price, .package-price")?.text);
  const match = (fromNode || text).match(pricePattern);
  return match ? cleanText(match[0]) : null;
}

function extractPeriod(card, lines, cleanText) {
  const fromNode = cleanText(card.querySelector(".price-cycle, .cycle, .billing-cycle")?.text);
  if (fromNode) return fromNode;
  const priceIndex = lines.findIndex((line) => pricePattern.test(line));
  if (priceIndex >= 0 && /每月|月缴|Monthly|月/i.test(lines[priceIndex + 1] ?? "")) return lines[priceIndex + 1];
  return "";
}

function lagomFeatureMap(card, lines, cleanText) {
  const out = {};
  const candidates = [...card.querySelectorAll(".package-features li, .product-features li, li")].map((li) => cleanText(li.text));
  for (const line of [...candidates, ...lines]) {
    const direct = line.match(/^(CPU|内存|硬盘|带宽|流量|IP|系统|Bandwidth|RAM|Storage|Monthly Transfer)\s*[:：]?\s*(.+)$/i);
    if (direct) {
      out[cleanText(direct[1])] ??= cleanText(direct[2]);
      continue;
    }
    const reverse = line.match(/^(.+?)\s+(CPU|内存|硬盘|带宽|流量|IP|RAM|Storage|Bandwidth)$/i);
    if (reverse) out[cleanText(reverse[2])] ??= cleanText(reverse[1]);
    const kv = line.match(/^([^:：]{1,14})[:：]\s*(.+)$/);
    if (kv) out[cleanText(kv[1])] ??= cleanText(kv[2]);
  }
  return out;
}

function stockState(text) {
  const match = text.match(stockPattern);
  if (!match) return { status: null, label: "", count: null };
  if (match[1] != null) {
    const count = Number(match[1]);
    return {
      status: count > 0 ? "available" : "unavailable",
      label: `${count} 可用`,
      count
    };
  }
  return {
    status: "unavailable",
    label: match[0],
    count: 0
  };
}

function orderLink(card, baseUrl, absoluteUrl, cleanText) {
  const links = card.querySelectorAll("a");
  for (const link of links) {
    const text = cleanText(link.text);
    const href = link.getAttribute("href");
    if (!href || href === "#" || /cart\.php\?a=view/i.test(href)) continue;
    if (/立即购买|立即订购|在线订购|Order|Buy|Purchase/i.test(text) || /\/store\//i.test(href)) {
      return absoluteUrl(baseUrl, href);
    }
  }
  return null;
}

function recordId(source, name, orderUrl, index) {
  const url = orderUrl ? new URL(orderUrl) : null;
  const path = url?.searchParams.get("rp") ?? url?.pathname;
  const orderSlug = path?.match(/\/store\/[^/]+\/([^/]+)\/?$/i)?.[1];
  if (orderSlug) return `${source.id}:store:${orderSlug}`;
  const pid = url?.searchParams.get("pid");
  if (pid) return `${source.id}:pid:${pid}`;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
  return slug ? `${source.id}-${slug}` : `${source.id}:card:${index + 1}`;
}

export function parseLagomProductList(source, fetchResult, generatedAt, helpers) {
  const { absoluteUrl, cleanText, nodeLines, parsePriceValue } = helpers;
  const root = parse(fetchResult.html);
  const cards = root.querySelectorAll(source.cardSelector ?? defaultCardSelector);
  if (cards.length === 0) throw new Error("Lagom product cards not found");

  const records = [];
  cards.forEach((card, index) => {
    const lines = nodeLines(card, cleanText);
    const text = cleanText(lines.join(" "));
    const name = firstText(card, source.nameSelector ?? defaultNameSelector, cleanText) || lines[0] || "";
    const price = extractPrice(card, text, cleanText);
    if (!name || !price || /购买建议|精选|ZoroCare/i.test(name)) return;

    const period = extractPeriod(card, lines, cleanText);
    const features = lagomFeatureMap(card, lines, cleanText);
    const orderUrl = orderLink(card, fetchResult.finalUrl ?? source.url, absoluteUrl, cleanText);
    const stock = stockState(text);
    const status = stock.status ?? (orderUrl ? "available" : "unknown");
    const statusLabel = stock.label || (orderUrl ? "可订购入口" : "未知");
    const hardware = cleanText([features.CPU, features["内存"] ?? features.RAM, features["硬盘"] ?? features.Storage, features["配置"]].filter(Boolean).join(" / "));
    const bandwidth = cleanText([features["带宽"] ?? features.Bandwidth, features["流量"] ?? features["Monthly Transfer"], features.IP].filter(Boolean).join(" / "));
    const routeLine = lines.find((line) => /测试\s*IP|NTT|GTT|Cogent|HKC|TM|Tier-1|家宽|ISP/i.test(line));
    const noteLines = lines
      .filter((line) => line !== name && line !== price && line !== period)
      .filter((line) => !/立即购买|立即订购|在线订购|可用|起价/i.test(line))
      .filter((line) => !Object.values(features).includes(line))
      .slice(0, 3);

    records.push({
      id: recordId(source, name, orderUrl, index),
      sourceId: source.id,
      provider: source.provider,
      category: source.category,
      adapter: source.adapter,
      sourceUrl: source.url,
      finalUrl: fetchResult.finalUrl ?? source.url,
      fetchedAt: generatedAt,
      httpStatus: fetchResult.statusCode ?? null,
      region: source.regionHint ?? null,
      route: source.routeHint ?? routeLine ?? null,
      name,
      note: source.note ?? cleanText(noteLines.join(" / ")),
      hardware,
      bandwidth,
      price: period ? `${price}/${period}` : price,
      priceValue: parsePriceValue(price),
      status,
      statusLabel,
      stockCount: stock.count,
      orderUrl,
      evidence: `${source.provider} Lagom product card parsed from official page; stock=${stock.label || "not stated"}; order=${orderUrl ? "yes" : "no"}`,
      raw: {
        features,
        sourceCardIndex: index
      }
    });
  });

  if (records.length === 0) throw new Error("Lagom product cards found but no priced products");
  // Only colliding name fallbacks need positions; ':' cannot occur in a name slug.
  const fallbackCounts = new Map();
  for (const record of records) {
    if (!record.id.startsWith(`${source.id}-`)) continue;
    fallbackCounts.set(record.id, (fallbackCounts.get(record.id) ?? 0) + 1);
  }
  for (const record of records) {
    if (fallbackCounts.get(record.id) > 1) record.id += `:${record.raw.sourceCardIndex + 1}`;
  }
  return records;
}
