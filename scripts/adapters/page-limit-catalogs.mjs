import { createHash } from "node:crypto";
import { parse } from "node-html-parser";
import { cleanPublicUrl } from "./catalog-pages.mjs";

// Exact-page parsers for catalogs that previously needed an unbounded link crawl
// (FlawlessNode pricing table, Paymenter storefronts such as BUG NET, and
// LightNode per-region landing pages). Each parser reads one official public
// page, never follows checkout/cart links and throws when the markup drifts.

const clean = (value) => String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const cycleLabels = { mo: "月付", month: "月付", "3mo": "季付", qtr: "季付", yr: "年付", year: "年付" };

function schemaError(provider, reason) {
  return new Error(`${provider} public catalog schema changed: ${reason}`);
}

function stripped(html) {
  const root = parse(html);
  root.querySelectorAll("script, style, noscript, template, svg").forEach((node) => node.remove());
  return root;
}

// ---------------------------------------------------------------- FlawlessNode
// https://www.flawlessnode.com/pricing/ publishes every plan in one table per
// data-center tab; each row links a product-specific Paymenter checkout.
export function parseFlawlessNode(source, result, { baseRecord }) {
  const pageUrl = result.finalUrl || source.url;
  const page = new URL(pageUrl);
  if (page.hostname !== "www.flawlessnode.com" || !/^\/(?:[a-z]{2}_[A-Z]{2}\/)?pricing\/?$/.test(page.pathname)) {
    throw schemaError("FlawlessNode", "unsupported pricing URL");
  }
  const root = stripped(result.html);
  const routes = new Map(root.querySelectorAll("button.routing-tab[data-routing]").map((button) => [button.getAttribute("data-routing"), clean(button.text).match(/AS\d{3,6}/)?.[0] ?? null]));
  const panels = root.querySelectorAll(".region-content[id^='region-']");
  if (!panels.length) throw schemaError("FlawlessNode", "region tables missing");
  const records = [];
  for (const panel of panels) {
    const tab = root.querySelectorAll("button.region-tab[data-target]").find((button) => button.getAttribute("data-target") === panel.id);
    const location = clean(tab?.text) || panel.id.replace(/^region-/, "").toUpperCase();
    const region = /LAX|洛杉矶|Los Angeles/i.test(`${location} ${panel.id}`) ? "美国" : location;
    const headers = panel.querySelectorAll("thead th").map((th) => clean(th.text));
    if (headers.length !== 9 || !/Plan/i.test(headers[0]) || !/Price/i.test(headers[7])) throw schemaError("FlawlessNode", "pricing table header");
    const rows = panel.querySelectorAll("tr.pricing-plan-row");
    if (!rows.length) throw schemaError("FlawlessNode", `no plan rows in ${panel.id}`);
    for (const row of rows) {
      const cells = row.querySelectorAll("td").map((td) => clean(td.text));
      const name = clean(row.querySelector("th span")?.text);
      if (cells.length !== 8 || !name) throw schemaError("FlawlessNode", "plan row cells");
      const [hostType, cpu, ram, storage, traffic, uplink, priceText] = cells;
      const price = priceText.match(/^\$\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*(mo|3mo|yr)$/i);
      if (!price) throw schemaError("FlawlessNode", `price format ${priceText}`);
      const orderUrl = cleanPublicUrl(row.querySelector("a[href]")?.getAttribute("href"), pageUrl);
      const specificOrder = Boolean(orderUrl && /^https:\/\/panel\.flawlessnode\.com\/products\/[^/]+\/[^/]+\/checkout$/.test(orderUrl));
      const route = routes.get(row.getAttribute("data-routing")) ?? null;
      const status = specificOrder ? "available" : "unknown";
      records.push(baseRecord(source, result, {
        id: `${source.id}:plan:${hash(specificOrder ? orderUrl : `${panel.id}|${name}`)}`,
        sourceUrl: pageUrl, name: `${name} (${location})`, category: "vps", region, route,
        hardware: [`${cpu}`, `${ram} RAM`, storage, hostType].join(" / "),
        bandwidth: `${traffic} / ${uplink}`,
        note: "官方价目表信息；购买前请确认当前库存与计费周期",
        price: `$${price[1]} ${cycleLabels[price[2].toLowerCase()]}`, priceValue: Number(price[1]), currency: "USD",
        status, statusLabel: status === "available" ? "可订购入口" : "库存未公开",
        stockCount: null, orderUrl: specificOrder ? orderUrl : null,
        evidence: `Official pricing table; stock=not stated; order=${specificOrder ? "product-specific checkout" : "not product-specific"}`,
        raw: { catalogPage: pageUrl, name, location, routing: row.getAttribute("data-routing"), priceText, billingCycle: price[2] }
      }));
    }
  }
  return records;
}

// ------------------------------------------------------------------- Paymenter
// Paymenter default theme (e.g. https://bug.pw). Category pages list name and
// "from" price and show a checkout link only for purchasable products; product
// pages carry an explicit in-stock / out-of-stock badge plus the spec text.
// Both page types emit the same id per product URL, so a product page read
// later in the same run replaces the thinner category-page record.
// Badge strings come from Paymenter's lang files: "In stock" / "Product :name is
// out of stock" (zh: "有現貨" / "產品 :name 已售罄").
const inStockPattern = /^(?:有現貨|有现货|In stock)$/i;
const outOfStockPattern = /^(?:(?:產品|产品|Product)\s.+\s)?(?:已售罄|(?:is\s+)?out of stock|缺貨|缺货)$/i;

function paymenterRegion(slug) {
  if (/seattle|us-|united-states|los-angeles|san-jose/i.test(slug)) return "美国";
  if (/tokyo|japan|osaka/i.test(slug)) return "日本";
  if (/hong-?kong/i.test(slug)) return "香港";
  if (/singapore/i.test(slug)) return "新加坡";
  return null;
}

function paymenterPrice(text, name) {
  const match = clean(text).match(/^([£$€¥])\s*([0-9][0-9,]*(?:\.[0-9]+)?)$/);
  if (!match) return null;
  const currency = { "£": "GBP", $: "USD", "€": "EUR", "¥": "CNY" }[match[1]];
  const yearly = /billed\s*yearly|年付/i.test(name);
  return { display: `${match[1]}${match[2]}${yearly ? " 年付" : " 起"}`, value: Number(match[2].replace(/,/g, "")), currency, cycle: yearly ? "yearly" : null };
}

export function parsePaymenterCatalog(source, result, { baseRecord }) {
  const pageUrl = result.finalUrl || source.url;
  const page = new URL(pageUrl);
  const segments = page.pathname.split("/").filter(Boolean);
  if (segments[0] !== "products" || ![2, 3].includes(segments.length)) throw schemaError(source.provider, "unsupported Paymenter URL");
  const root = stripped(result.html);
  if (!/Paymenter/i.test(root.querySelector("a[href*='paymenter.org']")?.toString() ?? "") && !/wire:snapshot/.test(result.html)) {
    throw schemaError(source.provider, "Paymenter storefront markers missing");
  }
  const record = ({ productUrl, name, priceText, status, statusLabel, orderUrl, specs = [], evidence, kind }) => {
    const price = paymenterPrice(priceText, name);
    if (!price) throw schemaError(source.provider, `price format ${priceText}`);
    const slug = new URL(productUrl).pathname.split("/")[2];
    const hardware = specs.filter((line) => /^(?:CPU|RAM|Memory|Storage|Disk)\b/i.test(line)).join(" / ");
    const bandwidth = specs.filter((line) => /^(?:Traffic|Bandwidth|Port|IP)\b/i.test(line)).join(" / ");
    return baseRecord(source, result, {
      id: `${source.id}:plan:${hash(productUrl)}`,
      sourceUrl: pageUrl, name, category: "vps", region: paymenterRegion(slug), route: null,
      hardware: hardware || null, bandwidth: bandwidth || null,
      note: price.cycle ? "官方商店信息；购买前请确认当前库存" : "官方商店展示最低周期价格，具体计费周期以结账页为准",
      price: price.display, priceValue: price.value, currency: price.currency,
      status, statusLabel, stockCount: status === "unavailable" ? 0 : null, orderUrl,
      evidence, raw: { catalogPage: pageUrl, productUrl, name, priceText: clean(priceText), billingCycle: price.cycle, pageType: kind }
    });
  };

  if (segments.length === 3) {
    const main = root.querySelector("main");
    const name = clean(main?.querySelector("h2")?.text);
    const priceText = clean(main?.querySelector("h3")?.text);
    if (!name || !priceText) throw schemaError(source.provider, "product name or price missing");
    const badge = main.querySelectorAll("span").map((span) => clean(span.text)).find((text) => inStockPattern.test(text) || outOfStockPattern.test(text)) ?? null;
    const productUrl = `${page.origin}/products/${segments[1]}/${segments[2]}`;
    const checkout = cleanPublicUrl(main.querySelectorAll("a[href]").map((a) => a.getAttribute("href")).find((href) => /\/checkout\/?$/.test(href)), pageUrl);
    const status = badge && outOfStockPattern.test(badge) ? "unavailable" : badge && inStockPattern.test(badge) ? "available" : checkout ? "available" : "unknown";
    const specs = main.querySelectorAll("article p, article li").map((n) => clean(n.text)).filter(Boolean);
    return [record({
      productUrl, name, priceText, status, specs, kind: "product",
      statusLabel: status === "available" ? "有现货" : status === "unavailable" ? "已售罄" : "库存未公开",
      orderUrl: status === "available" ? (checkout || productUrl) : null,
      evidence: `Official Paymenter product page; stock badge=${badge ?? "none"}; order=${checkout ? "product-specific checkout" : "none"}`
    })];
  }

  const category = segments[1];
  const productHref = new RegExp(`^/products/${category}/([^/?#]+)/?$`);
  const views = new Map();
  for (const anchor of root.querySelectorAll("a[href]")) {
    const href = cleanPublicUrl(anchor.getAttribute("href"), pageUrl);
    if (!href || new URL(href).origin !== page.origin) continue;
    const path = new URL(href).pathname;
    if (productHref.test(path)) views.set(path.replace(/\/$/, ""), anchor);
  }
  if (!views.size) throw schemaError(source.provider, "category has no product cards");
  const checkouts = new Set(root.querySelectorAll("a[href]").map((a) => cleanPublicUrl(a.getAttribute("href"), pageUrl)).filter((href) => href && /\/checkout\/?$/.test(href)).map((href) => new URL(href).pathname.replace(/\/checkout\/?$/, "")));
  const records = [];
  for (const [path, anchor] of views) {
    let card = anchor.parentNode;
    while (card && !card.querySelector("h2")) card = card.parentNode;
    const name = clean(card?.querySelector("h2")?.text);
    const priceText = clean(card?.querySelector("h3")?.text);
    if (!name || !priceText) throw schemaError(source.provider, "category card name or price missing");
    const purchasable = checkouts.has(path);
    records.push(record({
      productUrl: `${page.origin}${path}`, name, priceText, kind: "category",
      status: purchasable ? "available" : "unknown",
      statusLabel: purchasable ? "可订购入口" : "库存未公开",
      orderUrl: purchasable ? `${page.origin}${path}/checkout` : null,
      evidence: `Official Paymenter category page; stock=not stated; order=${purchasable ? "product-specific checkout" : "no checkout link shown"}`
    }));
  }
  return records;
}

// ------------------------------------------------------------------- LightNode
// go.lightnode.com/<location>-vps pages each publish four standard plans with a
// region+config specific console deep link. The console requires sign-in and
// the per-zone sale status API is request-signed, so stock stays "unknown".
export function parseLightNodeLanding(source, result, { baseRecord }) {
  const pageUrl = result.finalUrl || source.url;
  if (new URL(pageUrl).hostname !== "go.lightnode.com") throw schemaError("LightNode", "unsupported landing URL");
  const root = stripped(result.html);
  const cards = root.querySelectorAll("[data-pricing-card='true']");
  if (!cards.length) throw schemaError("LightNode", "pricing cards missing");
  const records = [];
  for (const card of cards) {
    const plan = clean(card.querySelector("[class*='_planName_']")?.text);
    const amountText = clean(card.querySelector("[data-price-value='true']")?.text);
    const currency = clean(card.querySelector("[class*='_currency_']")?.text);
    const unit = clean(card.querySelector("[class*='_priceUnit_']")?.text);
    const product = clean(card.querySelector("[class*='_productName_']")?.text);
    const link = cleanPublicUrl(card.querySelector("a[href*='/product/instance/create']")?.getAttribute("href"), pageUrl);
    if (!plan || !/^[0-9]+(?:\.[0-9]+)?$/.test(amountText) || currency !== "$" || !product || !link) throw schemaError("LightNode", "pricing card fields");
    const deepLink = new URL(link);
    const regionCode = deepLink.searchParams.get("region");
    const config = deepLink.searchParams.get("config");
    if (deepLink.hostname !== "console.lightnode.com" || !regionCode || !config) throw schemaError("LightNode", "console deep link params");
    const specs = card.querySelectorAll("li").map((li) => clean(li.text)).filter(Boolean);
    const location = clean(product.replace(/\b(?:VPS|Hosting|Server)\b/gi, " "));
    records.push(baseRecord(source, result, {
      id: `${source.id}:plan:${regionCode}:${config}`,
      sourceUrl: pageUrl, name: `${plan} ${config} (${location})`, category: "vps", region: location, route: null,
      hardware: specs.filter((line) => /vCPU|Memory|Storage|NVMe|SSD/i.test(line)).join(" / ") || null,
      bandwidth: specs.filter((line) => /Bandwidth|Traffic/i.test(line)).join(" / ") || null,
      note: "官方区域落地页标准套餐（按小时计费，月价为参考）；下单需登录控制台，库存未公开",
      price: `$${amountText}${unit ? ` ${unit}` : ""}`, priceValue: Number(amountText), currency: "USD",
      status: "unknown", statusLabel: "库存未公开（控制台需登录）", stockCount: null, orderUrl: link,
      evidence: "Official LightNode location page; stock=not stated; order=region+config console link (sign-in required)",
      raw: { catalogPage: pageUrl, plan, regionCode, zone: deepLink.searchParams.get("zone"), config, dataCenter: specs.find((line) => /Data Center/i.test(line)) ?? null, billingCycle: unit || null }
    }));
  }
  return [...new Map(records.map((record) => [record.id, record])).values()];
}

export const pageLimitCatalogFormats = ["flawlessnode", "paymenter", "lightnode"];

export function parsePageLimitCatalog(source, result, helpers) {
  if (source.catalogFormat === "flawlessnode") return parseFlawlessNode(source, result, helpers);
  if (source.catalogFormat === "paymenter") return parsePaymenterCatalog(source, result, helpers);
  if (source.catalogFormat === "lightnode") return parseLightNodeLanding(source, result, helpers);
  throw new Error(`Unsupported page-limit catalog format ${source.catalogFormat}`);
}
