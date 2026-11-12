import { parse } from "node-html-parser";
import { catalogUrlAllowed, cleanPublicUrl, parseCatalogPage } from "./catalog-pages.mjs";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const featureLabels = { CPU: "CPU", RAM: "内存", "Hard drive": "硬盘", Bandwidth: "流量", Port: "带宽", IPv4: "IPv4", IPv6: "IPv6" };
// Match the published Location field, never the plan name, SKU, or site domain.
const locationCountries = new Map([
  ["加拿大", ["Canada", "Toronto, ON (Canada)"]],
  ["美国", ["USA", "United States", "Dallas, TX (USA)", "Dallas, TX", "Los Angeles, CA", "Ogden, UT", "Phoenix, AZ", "San Jose, CA", "Jacksonville, FL", "Kansas City, MO", "Chicago, IL", "Ashburn, VA", "Buffalo, NY", "Staten Island, NY"]],
  ["荷兰", ["Netherlands", "Amsterdam, NL"]],
  ["德国", ["Germany", "Frankfurt, DE"]],
  ["英国", ["United Kingdom", "Coventry, UK"]],
  ["新加坡", ["Singapore"]],
  ["日本", ["Japan", "Tokyo, JP"]],
  ["香港", ["Hong Kong"]],
  ["罗马尼亚", ["Romania", "Bucharest, RO"]]
].flatMap(([country, locations]) => locations.map((location) => [location.toLowerCase(), country])));

function countryForLocation(location) {
  const label = clean(location).replace(/^Location:\s*/i, "").replace(/\s+(?:DC\d+|(?:IIJ|Softbank) Line)$/i, "");
  return locationCountries.get(label.toLowerCase()) || null;
}

function schemaError(reason) {
  return new Error(`GreenCloud public catalog schema changed: ${reason}`);
}

function cardFields(card) {
  const fields = new Map();
  for (const item of card.querySelectorAll(".product-desc li")) {
    const values = item.querySelectorAll(".feature-value");
    if (values.length !== 1 || values[0].parentNode !== item) throw schemaError("feature value markup");
    const value = clean(values[0].text);
    const label = clean(item.childNodes.filter((node) => node !== values[0]).map((node) => node.text).join(" "));
    if (!label || !value || fields.has(label)) throw schemaError("empty or duplicate feature label");
    fields.set(label, value);
  }
  for (const label of [...Object.keys(featureLabels), "Location"]) {
    if (!fields.has(label)) throw schemaError(`missing ${label} feature`);
  }
  // The catalog calls a transfer allowance "Bandwidth"; only Port is a speed.
  if (!/^\d+(?:\.\d+)?\s*[KMGT]i?B$/i.test(fields.get("Bandwidth")) || !/^\d+(?:\.\d+)?\s*[KMGT]bps$/i.test(fields.get("Port"))) {
    throw schemaError("transfer allowance or port units");
  }
  return fields;
}

export function parseGreenCloudCatalog(source, result, helpers) {
  const pageUrl = result.finalUrl || source.url;
  const page = new URL(pageUrl);
  if (!["greencloudvps.com", "www.greencloudvps.com"].includes(page.hostname) || !/^\/billing\/store\/(?:ssd-kvm-vps|budget-kvm-sale)\/?$/.test(page.pathname)) {
    throw schemaError("unsupported official catalog group URL");
  }
  const root = parse(result.html);
  root.querySelectorAll("script, style, noscript, template").forEach((node) => node.remove());
  const candidateBase = cleanPublicUrl(root.querySelector("base[href]")?.getAttribute("href"), pageUrl);
  const documentBase = candidateBase && catalogUrlAllowed(candidateBase, source) ? candidateBase : pageUrl;
  const cards = root.querySelectorAll(".product");
  if (!cards.length) throw schemaError("product cards missing");
  const byOrderUrl = new Map();
  for (const card of cards) {
    const names = card.querySelectorAll("header [id$='-name']");
    const prices = card.querySelectorAll(".product-pricing .price");
    const orders = card.querySelectorAll("a.btn-order-now[href]");
    if (!/^product\d+$/.test(card.id) || names.length !== 1 || prices.length !== 1 || orders.length !== 1) {
      throw schemaError("product name, price, or order markup");
    }
    const name = clean(names[0].text);
    const orderUrl = cleanPublicUrl(orders[0].getAttribute("href"), documentBase);
    if (!name || !orderUrl || !catalogUrlAllowed(orderUrl, source) || byOrderUrl.has(orderUrl)) throw schemaError("missing or duplicate product order URL");
    byOrderUrl.set(orderUrl, {
      name, fields: cardFields(card),
      priceText: clean(prices[0].text),
      priceAndCycle: clean(card.querySelector(".product-pricing").text)
    });
  }

  const records = parseCatalogPage(source, result, helpers);
  if (records.length !== cards.length) throw schemaError("parsed record/card count mismatch");
  return records.map((record) => {
    const card = byOrderUrl.get(cleanPublicUrl(record.orderUrl, pageUrl));
    if (!card || card.name !== record.name) throw schemaError("parsed record has no matching product card");
    const price = card.priceText.match(/^\$\s*([\d,]+(?:\.\d+)?)\s+USD$/i);
    const cycle = record.raw?.billingCycle;
    if (!price || Number(price[1].replace(/,/g, "")) !== record.priceValue || (record.currency && record.currency !== "USD") || !/^(?:Monthly|Annually)$/.test(cycle || "") || card.priceAndCycle !== `${card.priceText} ${cycle}`) {
      throw schemaError("published USD price or billing cycle mismatch");
    }
    const features = Object.fromEntries(Object.entries(featureLabels).map(([label, key]) => [key, card.fields.get(label)]));
    const publishedLocation = card.fields.get("Location");
    return {
      ...record,
      region: countryForLocation(publishedLocation),
      bandwidth: `${features.流量} Traffic / ${features.带宽} Port / ${features.IPv4} IPv4 / ${features.IPv6} IPv6`,
      price: `${card.priceText} ${cycle}`,
      currency: "USD",
      raw: { ...record.raw, priceText: card.priceText, publishedLocation, features }
    };
  });
}
