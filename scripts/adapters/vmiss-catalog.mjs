import { parse } from "node-html-parser";
import { cleanPublicUrl } from "./catalog-pages.mjs";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const invalid = (field) => new Error(`VMISS public catalog schema changed: ${field}`);

export function parseVmissCatalog(source, result, { baseRecord }) {
  const root = parse(result.html);
  const page = new URL(result.finalUrl);
  const route = page.searchParams.get("rp") || page.pathname;
  if (/dedicated|\/others(?:\/|$)/i.test(route)) return [];
  const cards = root.querySelectorAll('.package[id^="product"]');
  if (!cards.length) throw invalid("product cards missing");
  const seen = new Set();
  return cards.map((card) => {
    const pid = card.id.match(/^product(\d+)$/)?.[1];
    const name = clean(card.querySelector(".package-title")?.text);
    const prices = [...new Set(card.querySelectorAll(".price-amount").map((n) => clean(n.text)))];
    const cycles = [...new Set(card.querySelectorAll(".price-cycle").map((n) => clean(n.text)))];
    const price = prices[0]?.match(/^\$?\s*([\d,]+\.\d{2})\s+(CAD|USD)$/);
    if (!pid || seen.has(pid) || !name || prices.length !== 1 || !price || cycles.length !== 1 || !/^(Monthly|Quarterly|Semi-Annually|Annually|Biennially|Triennially)$/i.test(cycles[0])) throw invalid("identity, currency or billing cycle");
    seen.add(pid);
    const amount = Number(price[1].replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) throw invalid("price");
    const lines = (card.querySelector(".package-content")?.structuredText || "").split(/\r?\n/).map(clean).filter(Boolean);
    const cpu = lines.find((s) => /^\d+\s+Cores?$/i.test(s));
    const memory = lines.find((s) => /^\d+\s*(?:MB|GB)(?:\s+RAM)?$/i.test(s));
    const disk = lines.find((s) => /\d+\s*(?:GB|TB)\s*(?:SSD|NVMe|HDD)/i.test(s));
    if (!cpu || !memory || !disk) throw invalid(`hardware for PID ${pid}`);
    const anchor = card.querySelector('a[id$="-order-button"]');
    const orderUrl = cleanPublicUrl(anchor?.getAttribute("href"), result.finalUrl);
    if (!orderUrl || new URL(orderUrl).origin !== "https://app.vmiss.com" || !/^\/store\/[^/]+\/[^/]+$/.test(new URL(orderUrl).pathname)) throw invalid(`order link for PID ${pid}`);
    const qty = clean(card.querySelector(".package-qty")?.text);
    if (qty && !/^\d+ Available$/i.test(qty)) throw invalid(`inventory for PID ${pid}`);
    const stockCount = qty ? Number(qty.match(/^\d+/)[0]) : null;
    if (stockCount !== null && !Number.isSafeInteger(stockCount)) throw invalid("inventory quantity");
    const disabled = anchor.hasAttribute("disabled") || anchor.getAttribute("aria-disabled") === "true" || anchor.classList.contains("disabled");
    const status = stockCount === 0 ? "unavailable" : disabled ? "unknown" : "available";
    const region = /^CN\.HK\./.test(name) ? "香港" : /^JP\./.test(name) ? "日本" : /^KR\./.test(name) ? "韩国" : /^US\./.test(name) ? "美国" : null;
    const network = name.match(/\.(CMIN2|9929|CN2|IIJ|BGP|TRI|STD|INTL)(?:\.|$)/)?.[1];
    return baseRecord(source, result, {
      id: `${source.id}:pid:${pid}`, sourceUrl: result.finalUrl, name, category: "vps", region,
      route: network === "CN2" && /CN2 GIA/i.test(root.querySelector("h1")?.text || "") ? "CN2 GIA" : network || null,
      hardware: `${cpu} / ${memory.replace(/\s+RAM$/i, "")} RAM / ${disk}`,
      bandwidth: lines.filter((s) => /Port|Bandwidth|IPv[46]/i.test(s)).join(" / ") || null,
      price: `${price[2]} ${price[1]} ${cycles[0]}`, priceValue: amount, currency: price[2],
      status, statusLabel: status === "unavailable" ? "不可订购" : status === "unknown" ? "订购入口不可用" : stockCount === null ? "可订购入口" : `库存 ${stockCount}`,
      stockCount, orderUrl,
      note: "官方公开套餐目录；未公开数量时仅表示订购入口可用，最终库存及报价以下单配置页为准。",
      evidence: `VMISS public catalog PID=${pid}; stock=${stockCount ?? "not published"}; orderEnabled=${!disabled}`,
      raw: { pid, catalogPage: result.finalUrl, billingCycle: cycles[0], priceText: prices[0], orderEnabled: !disabled }
    });
  });
}
