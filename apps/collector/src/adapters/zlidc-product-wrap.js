import { parse } from "node-html-parser";

function zlidcFeatureMap(card, cleanText) {
  const out = {};
  for (const li of card.querySelectorAll("li")) {
    const strong = li.querySelector("strong");
    const label = cleanText(strong?.text).replace(/[：:]+$/, "");
    const value = cleanText(li.text.replace(strong?.text ?? "", ""));
    if (label && value) out[label] = value;
  }
  return out;
}

export function parseZlidcProductWrap(source, fetchResult, generatedAt, helpers) {
  const { absoluteUrl, cleanText, parsePriceValue } = helpers;
  const root = parse(fetchResult.html);
  const cards = root.querySelectorAll(".product-wrap-box");
  if (cards.length === 0) throw new Error("ZLIDC product-wrap cards not found");

  return cards.map((card, index) => {
    const name = cleanText(card.querySelector(".product-wrap-title")?.text);
    const price = cleanText(card.querySelector(".product-wrap-price")?.text);
    const order = card.querySelector('a[href*="cart.php?a=add"]');
    const orderUrl = absoluteUrl(fetchResult.finalUrl ?? source.url, order?.getAttribute("href"));
    const pid = orderUrl ? new URL(orderUrl).searchParams.get("pid") : String(index + 1);
    const features = zlidcFeatureMap(card, cleanText);
    const hardware = features["Configuration(Only Linux)"] ?? features.Configuration ?? null;
    const bandwidth = features.Bandwidth ?? null;
    const route = features["IP Address ISP"] ?? source.routeHint ?? null;

    return {
      id: `${source.id}-pid-${pid}`,
      sourceId: source.id,
      provider: source.provider,
      category: source.category,
      adapter: source.adapter,
      sourceUrl: source.url,
      finalUrl: fetchResult.finalUrl ?? source.url,
      fetchedAt: generatedAt,
      httpStatus: fetchResult.statusCode ?? null,
      region: source.regionHint ?? null,
      route,
      name,
      note: "ZLIDC SEO/ISP product page; stock may require support confirmation for pre-order products",
      hardware,
      bandwidth,
      price,
      priceValue: parsePriceValue(price),
      status: orderUrl ? "available" : "unknown",
      statusLabel: orderUrl ? "可订购" : "未知",
      stockCount: null,
      orderUrl,
      evidence: orderUrl ? `ZLIDC product-wrap order link found; pid=${pid}` : "ZLIDC product-wrap card found without order link",
      raw: {
        pid,
        features,
        sourceCardIndex: index
      }
    };
  });
}
