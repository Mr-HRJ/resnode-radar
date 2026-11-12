import { parse } from "node-html-parser";
import { cleanPublicUrl, catalogUrlAllowed } from "./catalog-pages.mjs";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const countries = { Japan: "日本", "Hong Kong": "香港", Malaysia: "马来西亚", "United States": "美国", "United Kingdom": "英国", Germany: "德国", Netherlands: "荷兰", "The Netherlands": "荷兰", Amsterdam: "荷兰", Poland: "波兰", Singapore: "新加坡", Australia: "澳大利亚", Canada: "加拿大", France: "法国", Sweden: "瑞典" };
function regionLabel(published) {
  if (!published) return null;
  if (published.includes("·")) return "多地区（下单选择）";
  return countries[published.replace(/\s*\(.*\)$/, "")] || published;
}
const families = new Set(["cloud-kvm-vps", "performance-kvm-vps", "edge-kvm-vps", "storage-kvm-vps", "mini-kvm-vps", "nano-kvm-vps"]);

// Marketing purchase links and aggregate offer counts do not establish stock.
function availability(node) {
  const marker = node.querySelector(".stock, .stock-status, [itemprop='availability']");
  const text = clean(marker?.getAttribute("content") || marker?.text);
  if (/\b(?:sold out|out of stock|OutOfStock)\b|售罄|无库存|缺货/i.test(`${text} ${clean(node.text)}`)) {
    return { status: "unavailable", statusLabel: "不可订购", stockCount: 0 };
  }
  if (/^(?:In Stock|InStock|https?:\/\/schema\.org\/InStock)$/i.test(text)) {
    return { status: "available", statusLabel: "官方标注可用", stockCount: null };
  }
  return { status: "unknown", statusLabel: "库存未公开", stockCount: null };
}

function quote(node, currency, amountSelector, periodSelector) {
  const amountText = clean(node.querySelector(amountSelector)?.text);
  const cycleText = clean(node.querySelector(periodSelector)?.text);
  const expectedSymbol = currency === "EUR" ? "€" : "$";
  const value = Number(amountText.replace(expectedSymbol, "").replace(/,/g, ""));
  const cycle = /^\/\s*(?:mo|month)$/i.test(cycleText) ? "month" : /^\/\s*(?:yr|year)$/i.test(cycleText) ? "year" : null;
  if (!amountText.startsWith(expectedSymbol) || !Number.isFinite(value) || value <= 0 || !cycle) {
    throw new Error("Official marketing catalog price or billing period changed");
  }
  return { price: `${currency} ${amountText.slice(1)}/${cycle}`, priceValue: value, currency, cycle, amountText, cycleText };
}

function evoxt(source, result, baseRecord, root, base) {
  const groups = root.querySelectorAll("section.region-block");
  if (!groups.length) throw new Error("Evoxt public pricing region tables missing");
  const records = [];
  const port = /All regions are on a 1 Gigabit port/i.test(clean(root.querySelector("#pricing-table .fine-print")?.text)) ? "1 Gigabit port" : null;
  for (const group of groups) {
    const family = group.getAttribute("id");
    const groupName = clean(group.querySelector(".region-heading h3")?.text);
    const publishedRegions = clean(group.querySelector(".region-note")?.text).replace(/^Regions\s*/, "").replace(/\p{Regional_Indicator}/gu, "").replace(/\s+/g, " ").trim();
    const table = group.querySelector("table.pricing-table");
    const headings = table?.querySelectorAll("thead th").map((cell) => clean(cell.text)) ?? [];
    if (!family || !groupName || !publishedRegions || headings.slice(0, 7).join("|") !== "Plan|CPU|RAM|Storage|Monthly Transfer|Backup|Price") {
      throw new Error("Evoxt public pricing table schema changed");
    }
    for (const row of table.querySelectorAll("tbody tr")) {
      const cells = row.querySelectorAll("td");
      const plan = clean(cells[0]?.querySelector(".plan-name")?.text);
      if (cells.length !== 8 || !/^VM-\d+(?:\.\d+)?$/.test(plan)) throw new Error("Evoxt public plan row schema changed");
      const specs = cells.slice(1, 6).map((cell) => clean(cell.text));
      if (specs.some((spec) => !spec)) throw new Error("Evoxt public plan specifications missing");
      const pricing = quote(row, "USD", ".price-amount", ".price-period");
      const stock = availability(row);
      const order = row.querySelector("a.row-cta[href]")?.getAttribute("href");
      const candidateUrl = cleanPublicUrl(order, base);
      const orderUrl = candidateUrl && catalogUrlAllowed(candidateUrl, source) ? candidateUrl : null;
      records.push(baseRecord(source, result, {
        id: `${source.id}:plan:evoxt:${family}:${plan}`,
        sourceUrl: base, name: `${plan} · ${groupName}`, category: "vps",
        region: regionLabel(publishedRegions),
        regions: [...new Set(publishedRegions.split("·").map((region) => regionLabel(clean(region))).filter(Boolean))],
        route: groupName,
        hardware: `${specs[0]} CPU / ${specs[1]} RAM / ${specs[2]} Storage`,
        bandwidth: [`${specs[3]} Monthly Transfer`, port].filter(Boolean).join(" / "),
        price: pricing.price, priceValue: pricing.priceValue, currency: pricing.currency,
        ...stock, orderUrl,
        note: `官方公开价格表；${publishedRegions}；${specs[4]} backup；实际库存以官方部署页面为准。`,
        evidence: `Official marketing catalog; region group=${family}; plan=${plan}; stock=${stock.stockCount ?? "not stated"}; status=${stock.status}`,
        raw: { catalogPage: base, catalogFamily: family, planName: plan, regionGroup: groupName, publishedRegions, backup: specs[4], priceText: pricing.amountText, billingCycle: pricing.cycle, publishedCycle: pricing.cycleText,
          features: { CPU: specs[0], 内存: specs[1], 硬盘: specs[2], 流量: `${specs[3]} / month`, ...(port ? { 带宽: port } : {}) } }
      }));
    }
  }
  if (!records.length) throw new Error("Evoxt public pricing plans missing");
  return records;
}

function vps(source, result, baseRecord, root, base) {
  const family = new URL(base).pathname.match(/^\/products\/([^/]+)\/?$/)?.[1];
  if (!families.has(family)) throw new Error("V.PS parser requires a published VPS family page");
  const records = [];
  for (const card of root.querySelectorAll("a[href]")) {
    let order;
    try { order = new URL(card.getAttribute("href"), base); } catch { continue; }
    if (order.origin !== "https://vps.hosting" || order.searchParams.get("cmd") !== "cart" || order.searchParams.get("action") !== "add") continue;
    const productId = order.searchParams.get("id");
    const name = clean(card.childNodes.find((node) => node.tagName === "SPAN")?.text);
    const specs = card.querySelectorAll("ul li").map((li) => clean(li.text));
    if (!/^\d+$/.test(productId ?? "") || !name || !specs.length) throw new Error("V.PS public plan card schema changed");
    const pricing = quote(card, "EUR", ".font-mono", ".font-mono + .text-mute");
    const stock = availability(card);
    let locationUrl = null;
    let publishedCountry = null;
    let publishedCity = null;
    for (let parent = card.parentNode, depth = 0; parent && depth < 3; parent = parent.parentNode, depth++) {
      const link = parent.querySelector("a[href^='/locations/']");
      if (link) {
        locationUrl = new URL(link.getAttribute("href"), base).href;
        publishedCountry = clean(link.querySelector("img[alt]")?.getAttribute("alt")) || null;
        publishedCity = clean(link.getAttribute("title")).replace(/ VPS$/, "") || null;
        break;
      }
    }
    const hardware = specs.filter((spec) => /CPU|cores?\b|memory|RAM|NVMe|SSD|HDD|storage/i.test(spec)).join(" / ");
    if (!hardware) throw new Error("V.PS public plan hardware missing");
    records.push(baseRecord(source, result, {
      id: `${source.id}:plan:vps:${family}:${productId}`,
      sourceUrl: base, name, category: "vps", region: /^Hong Kong$/i.test(publishedCity ?? "") ? "香港" : regionLabel(publishedCountry), route: null,
      hardware, bandwidth: specs.filter((spec) => /transfer|IPv[46]|\bport\b|Gbps|Mbps/i.test(spec)).join(" / ") || null,
      price: pricing.price, priceValue: pricing.priceValue, currency: pricing.currency,
      ...stock, orderUrl: order.href,
      note: "官方公开产品页价格和规格；订购链接不代表实时库存。",
      evidence: `Official marketing catalog; family=${family}; product=${productId}; stock=${stock.stockCount ?? "not stated"}; status=${stock.status}`,
      raw: { catalogPage: base, catalogFamily: family, productId, locationUrl, publishedCountry, publishedCity, specs, priceText: pricing.amountText, billingCycle: pricing.cycle, publishedCycle: pricing.cycleText }
    }));
  }
  if (!records.length) throw new Error("V.PS public plan cards missing");
  return records;
}

export function parseMarketingCatalog(source, result, { baseRecord }) {
  const root = parse(result.html);
  root.querySelectorAll("script, style, noscript").forEach((node) => node.remove());
  const base = result.finalUrl || source.url;
  const records = source.catalogFormat === "evoxt" ? evoxt(source, result, baseRecord, root, base)
    : source.catalogFormat === "vps" ? vps(source, result, baseRecord, root, base)
      : (() => { throw new Error(`Unsupported marketing catalog: ${source.catalogFormat}`); })();
  return [...new Map(records.map((record) => [record.id, record])).values()];
}
