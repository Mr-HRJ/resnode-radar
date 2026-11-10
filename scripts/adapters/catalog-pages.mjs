import { createHash } from "node:crypto";
import { parse } from "node-html-parser";

const pricePattern = /(?:US\$|CA\$|C\$|HK\$|A\$|[¥￥$€£]|\b(?:USD|CNY|CAD|EUR|GBP|HKD|RMB)\b)\s*[0-9][0-9,.]*|[0-9][0-9,.]*\s*(?:元|USD\b|CNY\b|CAD\b|EUR\b|GBP\b|HKD\b)/i;
const specsPattern = /\b(?:vCPU|vCore|CPU|RAM|DDR[345]|KVM|VDS|VPS|NVMe|SSD|HDD)\b|\d\s*(?:GB|MB|TB|G)[\s/]|内存|記憶體|云服务器|雲伺服器|虚拟服务器/i;
const excludedPattern = /独立服务器|獨立伺服器|独服|獨服|裸金属|bare\s*metal|dedicated\s*server|域名注册|域名註冊|domain\s*registration|reseller\s*hosting|shared\s*hosting|cpanel\s*hosting|SSL\s*certificates/i;
const hardwarePattern = /\d+\s*(?:vCPU|vCore|CPU|Cores?\b|核)|(?:CPU|内存|RAM|Memory)\s*[:：]?\s*\d+|\d+\s*(?:GB|MB|G)\s*(?:RAM|DDR|内存)|\d+\s*(?:GB|MB)\s+(?:Memory|内存)/i;
const orderPattern = /订购|訂購|购买|購買|立即开通|部署|選購|Order|Buy|Purchase|Deploy|Configure|Get started/i;
const cardSelector = ".package, .product, .product-card, .card-product, .fh-product-card, .pricing-card, .pricing-box, .pricing-plan, .plan, .plan-card, .price-box, #products .card, [data-product-id], [itemtype*='Product']";
const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export function cleanPublicUrl(href, base) {
  if (!href || href.startsWith("#")) return null;
  try {
    const url = new URL(href, base);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || !url.hostname.includes(".") || /^[\d.]+$/.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:aff.*|ref.*|utm_.*|vcd|coupon|promocode)$/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.href;
  } catch { return null; }
}

export function catalogUrlAllowed(url, source) {
  const target = new URL(url);
  const original = new URL(source.url);
  const baseHost = original.hostname.replace(/^(?:www|my|billing|store|client|clients|portal|app|console|account|buy|cloud)\./, "");
  return target.hostname === baseHost || target.hostname.endsWith(`.${baseHost}`) || (source.allowedOrigins ?? []).includes(target.origin);
}

function isCatalogLink(url, label) {
  const u = new URL(url);
  const route = u.searchParams.get("rp") || u.pathname;
  if (["language", "language_iso", "currency"].some((key) => u.searchParams.has(key))) return false;
  if (excludedPattern.test(`${route} ${label}`) || /(?:blog|news|knowledgebase|announcements|login|register|signup|terms|privacy|affiliate|logout|cart\.php\?a=add)/i.test(url) || u.searchParams.get("a") === "add" || u.searchParams.has("pid")) return false;
  if (u.searchParams.has("gid") || u.searchParams.get("cmd") === "cart") return true;
  if (/\?\/cart\//i.test(url)) return true;
  if (/\/store(?:\/|$)/i.test(route)) return route.split(/\/store\/?/i)[1].split("/").filter(Boolean).length <= 1;
  return /(?:vps|vds|kvm|pricing|cloud-server|virtual-server|products|plans|server\/vps)/i.test(route);
}

export function discoverCatalogLinks(html, base, source) {
  const root = parse(html);
  const links = new Map();
  for (const anchor of root.querySelectorAll("a[href]")) {
    const href = cleanPublicUrl(anchor.getAttribute("href"), base);
    const label = clean(anchor.text);
    if (!href || !catalogUrlAllowed(href, source) || !isCatalogLink(href, label)) continue;
    const score = /vps|vds|kvm|cn2|9929|云服务器|雲伺服器|家宽|住宅/i.test(`${href} ${label}`) ? 2 : 1;
    if (!links.has(href)) links.set(href, { url: href, label, score });
  }
  return [...links.values()].sort((a, b) => b.score - a.score);
}

function textLines(node) {
  const copy = parse(node.toString());
  copy.querySelectorAll("script, style, noscript, template").forEach((n) => n.remove());
  return copy.structuredText.replace(/\u00a0/g, " ").split(/\n|\r/).map(clean).filter(Boolean);
}

function regionFrom(value) {
  const options = [["香港", /香港|Hong Kong|\bHKG\b/i], ["台湾", /台湾|台灣|Taipei|Taiwan|\bTPE\b/i], ["日本", /日本|Tokyo|Osaka|Japan|\bTYO\b/i], ["新加坡", /新加坡|Singapore|\bSIN\b/i], ["美国", /美国|美國|Los Angeles|San Jose|Seattle|Dallas|Phoenix|New York|United States|New Jersey|Manassas|Miami|Hawaii|\bUS\b|\bLAX\b/i], ["英国", /英国|英國|London|United Kingdom|\bUK\b/i], ["德国", /德国|德國|Germany|Frankfurt|\bDE\b/i], ["荷兰", /荷兰|Netherlands|Amsterdam|\bAMS\b/i], ["韩国", /韩国|韓國|Korea|Seoul/i], ["加拿大", /加拿大|Canada|Toronto/i], ["澳大利亚", /Australia|Sydney|澳大利亚/i], ["土耳其", /Turkey|Türkiye|土耳其/i]];
  const matches = options.filter(([, pattern]) => pattern.test(value)).map(([name]) => name);
  return matches.length === 1 ? matches[0] : matches.length > 1 ? "多地区（下单选择）" : null;
}

function orderLinks(node, base) {
  return node.querySelectorAll("a[href]").map((a) => ({ node: a, url: cleanPublicUrl(a.getAttribute("href"), base), label: clean(a.text) })).filter((a) => a.url && (orderPattern.test(a.label) || /(?:cart\.php.*(?:pid=|a=add)|\/(?:store|products)\/[^/]+\/[^/]+)/i.test(a.url)));
}

function candidates(root, base) {
  const semantic = root.querySelectorAll(cardSelector);
  const nodes = new Set(semantic);
  for (const row of root.querySelectorAll("tr")) {
    if (row.querySelectorAll("td").length >= 3 && pricePattern.test(clean(row.text)) && specsPattern.test(clean(row.text))) nodes.add(row);
  }
  for (const order of orderLinks(root, base)) {
    let node = order.node.parentNode;
    for (let depth = 0; node && depth < 7; depth++, node = node.parentNode) {
      if (["BODY", "HTML"].includes(node.tagName)) break;
      const value = clean(node.text);
      if (value.length > 3500) break;
      if (pricePattern.test(value) && specsPattern.test(value) && orderLinks(node, base).length <= 2) { nodes.add(node); break; }
    }
  }
  // Sold-out cards often omit their order anchor. Start from the visible plan
  // title as well, so an absent button cannot silently remove empty inventory.
  for (const heading of root.querySelectorAll("h2, h3, h4, h5, .product-name, .plan-name, .package-title")) {
    if (!clean(heading.text) || pricePattern.test(clean(heading.text))) continue;
    let node = heading.parentNode;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentNode) {
      if (["BODY", "HTML"].includes(node.tagName) || clean(node.text).length > 1800) break;
      if (pricePattern.test(clean(node.text)) && specsPattern.test(clean(node.text))) { nodes.add(node); break; }
    }
  }
  const contains = (node, other) => {
    for (let parent = other.parentNode; parent; parent = parent.parentNode) if (parent === node) return true;
    return false;
  };
  const leaves = semantic.filter((node) => !semantic.some((other) => other !== node && contains(node, other)));
  const remaining = [...nodes].filter((node) => leaves.includes(node) || !leaves.some((other) => contains(other, node)));
  return remaining.filter((node) => leaves.includes(node) || !remaining.some((other) => other !== node && contains(node, other) && specsPattern.test(clean(other.text)) && pricePattern.test(clean(other.text))));
}

export function parseCatalogPage(source, result, helpers) {
  const { baseRecord } = helpers;
  const root = parse(result.html);
  root.querySelectorAll("script, style, noscript, template, del, s, .old-price, .price-old, .price-discount, .section-product-card").forEach((n) => n.remove());
  const pageTitle = clean(root.querySelector("h1")?.text || root.querySelector("title")?.text);
  const base = result.finalUrl || source.url;
  if ((source.excludePaths ?? []).some((path) => base.toLowerCase().includes(path.toLowerCase()))) return [];
  const records = [];
  for (const node of candidates(root, base)) {
    const lines = textLines(node);
    const value = clean(lines.join(" "));
    if (!hardwarePattern.test(value) || value.length > 4000) continue;
    const nameNode = [source.nameSelector, ".package-title", ".product-title", ".product-name", ".plan-name", ".aether-plan-title", "[itemprop='name']", "h2", "h3", "h4", "h5"].filter(Boolean).map((selector) => node.querySelector(selector)).find((n) => n && !pricePattern.test(clean(n.text)) && !/^\d+(\.\d+)?$/.test(clean(n.text)));
    let name = clean(nameNode?.text || node.querySelector("td")?.text || lines.find((line) => !/^(?:\d+\s*(?:可用|Available)|Sold Out|缺货中)/i.test(line)));
    name = name.replace(/^(?:Sold Out|缺货中)\s*/i, "").replace(/\s*\d+\s*(?:Available|可用)\s*$/i, "").trim();
    if (!name || name.length > 140 || /[?？]$/.test(name) || pricePattern.test(name) || /^(?:News|place new order|choose your plan|全方位解决方案|购买产品|ESTIMATE|Order Summary)/i.test(name) || excludedPattern.test(name) || (excludedPattern.test(`${pageTitle} ${source.pageLabel || ""}`) && !/\b(?:VPS|VDS|KVM)\b/i.test(name))) continue;
    const priceNode = [source.priceSelector, ".price-ammount", ".price-amount", ".price-cls", ".price", ".package-price", ".product-price", ".pricing-price"].filter(Boolean).map((selector) => node.querySelector(selector)).find(Boolean);
    const priceText = clean(`${source.priceSelector && source.currency ? `${source.currency} ` : ""}${priceNode?.text ?? ""}`);
    const priceMatch = (pricePattern.test(priceText) ? priceText : value).match(pricePattern);
    if (!priceMatch) continue;
    const numeric = priceMatch[0].match(/[0-9][0-9,.]*/)?.[0] ?? "";
    const amount = Number(/^\d+,\d{1,2}$/.test(numeric) ? numeric.replace(",", ".") : numeric.replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const cycleNode = clean(node.querySelector(".price-cycle, .cycle, .billing-cycle, .price-period, .text-small.text-muted")?.text);
    const nearPrice = value.slice(value.indexOf(priceMatch[0]), value.indexOf(priceMatch[0]) + priceMatch[0].length + 55);
    const period = cycleNode || (nearPrice.match(/(?:\/\s*(?:mo(?:nth)?|yr|year|月|年|季|小时|hour)|per\s+(?:month|year|hour)|monthly|quarterly|annually|yearly|每月|每年|每季|月付|月缴|月繳|年付|年缴|季付)/i)?.[0] ?? "");
    const orders = orderLinks(node, base);
    const order = orders.find((a) => !a.node.hasAttribute("disabled") && a.node.getAttribute("aria-disabled") !== "true" && !a.node.classList.contains("disabled"));
    const soldOut = /Sold Out|Out of Stock|售罄|已售完|缺货|無庫存|无库存/i.test(value);
    const stock = value.match(/(?:库存|庫存)\s*[:：]?\s*(\d+)|(\d+)\s*(?:可用|Available\b|in stock\b)/i);
    const count = soldOut ? 0 : stock ? Number(stock[1] ?? stock[2]) : null;
    const specificOrder = order && /(?:pid=|product_id=|plan_id=|\/(?:store|products|cart)\/[^/]+\/[^/?#]+|\/order\/[^/?#]+|\/configure\/[^/?#]+)/i.test(order.url);
    const status = soldOut || count === 0 ? "unavailable" : (count > 0 || specificOrder) ? "available" : "unknown";
    const features = node.querySelectorAll("li, .package-features div, .product-features div").map((n) => clean(n.text)).filter((x) => specsPattern.test(x) || /流量|带宽|頻寬|\b(?:transfer|traffic|bandwidth|IPv[46]|Gbps|Mbps)\b/i.test(x));
    const cellFeatures = node.tagName === "TR" ? node.querySelectorAll("td").slice(1).map((n) => clean(n.text)).filter((x) => specsPattern.test(x) || /Gbps|Mbps|IPv[46]/i.test(x)) : [];
    const specs = [...new Set([...features, ...cellFeatures, ...lines.filter((x) => specsPattern.test(x) || /Gbps|Mbps|流量|带宽/i.test(x))])].filter((x) => x.length < 180);
    const hardware = specs.filter((x) => /CPU|vCore|RAM|DDR|SSD|NVMe|HDD|Storage|内存|記憶體|硬盘|磁碟|核心/i.test(x)).slice(0,5).join(" / ");
    const bandwidth = specs.filter((x) => /流量|带宽|頻寬|transfer|traffic|bandwidth|IPv[46]|Gbps|Mbps/i.test(x)).slice(0,3).join(" / ");
    const routes = [...new Set(value.match(/CN2\s*GIA|CN2\s*GT|CMIN2|9929|4837|AS\d{3,6}|BGP|IIJ|HiNet/g) ?? [])].join(" / ");
    const category = /住宅|家宽|家寬|residential|双\s*ISP|dual[- ]?isp|\b(?:HKT|HKBN|HGC)-HOME\b/i.test(`${name} ${value}`) ? "home" : "vps";
    const identity = specificOrder ? order.url : `${base}|${name}`;
    records.push(baseRecord(source, result, {
      id: `${source.id}:plan:${createHash("sha256").update(identity).digest("hex").slice(0,16)}`,
      sourceUrl: base, name, category,
      region: regionFrom(`${name} ${source.pageLabel || ""}`) || regionFrom(value) || regionFrom(pageTitle),
      route: routes || null,
      hardware: hardware || null, bandwidth: bandwidth || null,
      note: "官方产品页信息；购买前请确认当前库存与计费周期",
      price: `${priceMatch[0]}${period ? ` ${period}` : ""}`, priceValue: amount, currency: source.currency || null,
      status, statusLabel: status === "available" ? (count !== null ? `库存 ${count}` : "可订购入口") : status === "unavailable" ? "不可订购" : "库存未公开",
      stockCount: count, orderUrl: order?.url || (count > 0 ? base : null),
      evidence: `Official catalog page; stock=${count ?? "not stated"}; order=${specificOrder ? "yes" : "not product-specific"}`,
      raw: { catalogPage: base, name, priceText: priceMatch[0], billingCycle: period || null }
    }));
  }
  return [...new Map(records.map((record) => [record.id, record])).values()];
}
