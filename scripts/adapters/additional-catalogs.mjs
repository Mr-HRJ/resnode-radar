import { parse } from "node-html-parser";
import { parseCatalogPage } from "./catalog-pages.mjs";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const unique = (records) => [...new Map(records.map((record) => [record.id, record])).values()];

function locationFor(value, provider) {
  const text = String(value ?? "").toLowerCase();
  const choices = provider === "spartan"
    ? [["seattle", "美国 · 西雅图", /seattle|seakvm/], ["dallas", "美国 · 达拉斯", /dallas|dalkvm/], ["ashburn", "美国 · 阿什本", /ashburn|ashkvm/]]
    : [["hongkong", "香港", /hongkong/], ["tokyo", "日本 · 东京", /tokyo/], ["osaka", "日本 · 大阪", /osaka/], ["los-angeles", "美国 · 洛杉矶", /los-angeles/], ["frankfurt", "德国 · 法兰克福", /frankfurt/]];
  const match = choices.find(([, , pattern]) => pattern.test(text));
  return match ? { key: match[0], label: match[1] } : { key: "unspecified", label: null };
}

function publicBase(root, pageUrl) {
  const page = new URL(pageUrl);
  try {
    const base = new URL(root.querySelector("base[href]")?.getAttribute("href") || pageUrl, pageUrl);
    return base.origin === page.origin ? base.href : pageUrl;
  } catch { return pageUrl; }
}

function groupLabel(root, pageUrl) {
  const base = publicBase(root, pageUrl);
  return clean(root.querySelectorAll("a[href]").find((anchor) => {
    try { return new URL(anchor.getAttribute("href"), base).href === pageUrl; }
    catch { return false; }
  })?.text);
}

function enabledContinue(form) {
  return form.querySelectorAll("button, input[type='submit']").some((node) => {
    const type = (node.getAttribute("type") || "submit").toLowerCase();
    return type === "submit" && /^continue$/i.test(clean(node.text || node.getAttribute("value"))) &&
      !node.hasAttribute("disabled") && node.getAttribute("aria-disabled") !== "true" && !node.classList.contains("disabled");
  });
}

function parseZgo(source, result, { baseRecord }) {
  const pageUrl = result.finalUrl || source.url;
  const page = new URL(pageUrl);
  if (page.hostname !== "clients.zgovps.com") throw new Error("ZgoCloud requires its official public client catalog");
  const root = parse(result.html);
  const location = locationFor(pageUrl, "zgovps");
  const label = groupLabel(root, pageUrl);
  const records = [];
  for (const form of root.querySelectorAll("form")) {
    const cycleSelect = form.querySelector("select[name='cycle']");
    const productId = form.querySelector("input[name='id']")?.getAttribute("value");
    const name = clean(form.querySelector("strong.mb-3")?.text);
    if (!cycleSelect || !/^\d+$/.test(productId || "") || !name) continue;
    const text = clean(form.structuredText);
    const soldOut = /out of stock|sold out/i.test(text);
    const countText = text.match(/\b(?:stock|available)\s*:\s*(\d+)\b|\b(\d+)\s+(?:in stock|available)\b/i);
    const count = soldOut ? 0 : countText ? Number(countText[1] ?? countText[2]) : null;
    const orderable = enabledContinue(form);
    const status = soldOut || count === 0 ? "unavailable" : count > 0 || orderable ? "available" : "unknown";
    const cores = text.match(/\b\d+\s+Cores?\b(?:\s+AMD\s+EPYC\s+\d+\s+Series)?/i)?.[0];
    const ram = text.match(/\b\d+(?:\.\d+)?\s*(?:GB|MB)\s+(?:DDR[345]\s+)?RAM\b/i)?.[0];
    const disk = text.match(/\b\d+(?:\.\d+)?\s*(?:GB|MB|TB|G|T)\s+(?:NVMe\s+)?SSD\b/i)?.[0];
    const traffic = text.match(/\b\d+(?:\.\d+)?\s*(?:G|T|GB|TB)\/Month\/\d+(?:\.\d+)?\s*(?:Mbps|Gbps)\b/i)?.[0];
    const ip = text.match(/\b\d+\s+IPV4\b/i)?.[0];
    for (const option of cycleSelect.querySelectorAll("option")) {
      const cycle = option.getAttribute("value");
      const quote = clean(option.text).match(/^[\$€£¥￥]?\s*([\d,]+(?:\.\d+)?)\s+([A-Z]{3})\s+(.+)$/);
      if (!cycle || !quote) continue;
      const amount = Number(quote[1].replace(/,/g, ""));
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const [, , currency, period] = quote;
      records.push(baseRecord(source, result, {
        id: `${source.id}:plan:${location.key}:${productId}:${cycle}`,
        sourceUrl: pageUrl, name: label ? `${label} · ${name}` : name,
        category: "vps", region: location.label?.split(" · ")[0] || source.regionHint || null,
        route: [...new Set(text.match(/CN2\s*GIA|CMIN2|9929|4837/gi) || [])].join(" / ") || null,
        hardware: [cores, ram, disk].filter(Boolean).join(" / ") || null,
        bandwidth: [traffic, ip].filter(Boolean).join(" / ") || null,
        price: `${currency} ${amount} / ${period}`, priceValue: amount, currency,
        status, statusLabel: status === "unavailable" ? "不可订购" : status === "available" ? (count === null ? "可订购入口" : `库存 ${count}`) : "库存未公开",
        stockCount: count, orderUrl: pageUrl,
        note: "官方目录的独立计费周期；最终购买资格以官网结算页面为准。",
        evidence: `Official ZgoCloud product form; product=${productId}; enabled Continue=${orderable}; stock=${count ?? "not stated"}`,
        raw: { catalogPage: pageUrl, productId, billingCycle: period, cycleCode: cycle, orderable, groupLabel: label || null }
      }));
    }
  }
  return unique(records);
}

function euroAmount(value) {
  const amount = value.includes(",") ? value.replace(/\./g, "").replace(",", ".") : value;
  return Number(amount);
}

function beroField(text, field) {
  const keys = "CPU|RAM|NVME|IPv4|IPv6|Backups|Traffic|Laufzeit";
  return clean(text.match(new RegExp(`\\b${field}\\s*:\\s*(.*?)(?=\\s+(?:${keys})\\s*:|$)`, "i"))?.[1]);
}

function parseBero(source, result, { baseRecord }) {
  const pageUrl = result.finalUrl || source.url;
  if (!["bero-host.de", "www.bero-host.de"].includes(new URL(pageUrl).hostname)) throw new Error("BERO HOST requires its official public catalog");
  const root = parse(result.html);
  const records = [];
  for (const card of root.querySelectorAll(".default-package-background")) {
    let wrapper = card;
    while (wrapper && !/^selectPackage\(\d+\)$/.test(wrapper.getAttribute?.("wire:click") || "")) wrapper = wrapper.parentNode;
    if (!wrapper) continue;
    const productId = wrapper.getAttribute("wire:click").match(/\d+/)[0];
    const name = clean(card.querySelector("h4")?.text);
    const priceText = clean(card.querySelector("h5")?.text);
    const price = priceText.match(/([\d.,]+)\s*€/);
    const text = clean(card.structuredText);
    const days = text.match(/\bLaufzeit\s*:\s*(\d+)\s*Tage\b/i);
    if (!name || !price || !days) continue;
    const amount = euroAmount(price[1]);
    const duration = Number(days[1]);
    if (!Number.isFinite(amount) || amount <= 0 || duration <= 0) continue;
    // The sold-out overlay is a sibling of the price/specification card.
    const soldOut = /\bAusverkauft\b/i.test(clean(wrapper.structuredText));
    const vatIncluded = /inkl\.?\s*mwst\.?/i.test(priceText);
    records.push(baseRecord(source, result, {
      id: `${source.id}:plan:${productId}`,
      sourceUrl: pageUrl, name, category: "vps", region: source.regionHint || null, route: null,
      hardware: ["CPU", "RAM", "NVME"].map((key) => { const value = beroField(text, key); return value ? `${key}: ${value}` : null; }).filter(Boolean).join(" / ") || null,
      bandwidth: ["IPv4", "IPv6", "Traffic"].map((key) => { const value = beroField(text, key); return value ? `${key}: ${value}` : null; }).filter(Boolean).join(" / ") || null,
      price: `EUR ${amount} / ${duration} days${vatIncluded ? " (incl. VAT)" : ""}`,
      priceValue: amount, currency: "EUR",
      // selectPackage is a configuration choice, not a stock assertion.
      status: soldOut ? "unavailable" : "unknown", statusLabel: soldOut ? "不可订购" : "库存未公开",
      stockCount: soldOut ? 0 : null, orderUrl: pageUrl,
      note: `页面按 ${duration} 天计费${vatIncluded ? "，价格含增值税" : ""}；可选配置未明确声明库存。`,
      evidence: `Official BERO HOST package; product=${productId}; sold-out overlay=${soldOut}; selection action does not confirm stock`,
      raw: { catalogPage: pageUrl, productId, billingCycle: `${duration} Tage`, billingDays: duration, vatIncluded, selectable: true }
    }));
  }
  return unique(records);
}

function parseSpartan(source, result, helpers) {
  const pageUrl = result.finalUrl || source.url;
  const page = new URL(pageUrl);
  const route = page.searchParams.get("rp") || page.pathname;
  if (page.hostname !== "billing.spartanhost.net" || !(/^\/store\/[^/]+\/?$/.test(route) || (page.pathname === "/cart.php" && /^\d+$/.test(page.searchParams.get("gid") || "")))) {
    throw new Error("Spartan sources must use official billing catalog group URLs");
  }
  return unique(parseCatalogPage(source, result, helpers).map((record) => {
    const location = locationFor(`${record.orderUrl || ""} ${pageUrl}`, "spartan");
    const order = record.orderUrl ? new URL(record.orderUrl) : null;
    const sku = order?.searchParams.get("pid") || order?.pathname.split("/").filter(Boolean).at(-1);
    return {
      ...record,
      ...(sku ? { id: `${source.id}:plan:${location.key}:${encodeURIComponent(route)}:${encodeURIComponent(sku)}` } : {}),
      region: location.label?.split(" · ")[0] || source.regionHint || record.region,
      raw: { ...record.raw, ...(sku ? { productId: sku } : {}), location: location.key }
    };
  }));
}

export function parseAdditionalCatalog(source, result, helpers) {
  if (source.catalogFormat === "zgovps") return parseZgo(source, result, helpers);
  if (source.catalogFormat === "berohost") return parseBero(source, result, helpers);
  if (source.catalogFormat === "spartan") return parseSpartan(source, result, helpers);
  throw new Error(`Unsupported additional catalog format: ${source.catalogFormat}`);
}
