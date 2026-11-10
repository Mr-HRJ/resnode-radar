import { parse } from "node-html-parser";

export function parseRacknerdKvm(source, fetchResult, helpers) {
  const { cleanText, parsePriceValue, baseRecord } = helpers;
  const table = parse(fetchResult.html).querySelector("table.plan-list");
  if (!table) throw new Error("RackNerd KVM plan table not found");
  const headings = table.querySelectorAll("th").map((cell) => cleanText(cell.text).toLowerCase());
  const expected = ["plan", "cpu", "ssd storage", "bandwidth", "ipv4", "pricing", "order"];
  if (headings.length !== expected.length || headings.some((heading, i) => heading !== expected[i])) {
    throw new Error("RackNerd KVM table columns changed");
  }

  const records = [];
  for (const row of table.querySelectorAll("tr")) {
    const cells = row.querySelectorAll("td");
    if (cells.length === 0 || (cells.length === 1 && !cleanText(cells[0].text))) continue;
    if (cells.length !== expected.length) throw new Error("RackNerd KVM row is incomplete");
    const [memory, cpu, storage, bandwidth, ipv4, price, orderText] = cells.map((cell) => cleanText(cell.text));
    const priceValue = parsePriceValue(price);
    if (!memory || !Number.isFinite(priceValue)) throw new Error("RackNerd KVM plan name or price missing");
    const link = cells[6].querySelector("a[href]");
    const href = link?.getAttribute("href");
    const url = href ? new URL(href, fetchResult.finalUrl || source.url) : null;
    if (url && (url.origin !== "https://my.racknerd.com" || url.pathname !== "/cart.php" || url.searchParams.get("a") !== "add" || !/^\d+$/.test(url.searchParams.get("pid") ?? ""))) {
      throw new Error("RackNerd KVM order link is not a recognized product URL");
    }
    const disabled = link?.hasAttribute("disabled") || link?.getAttribute("aria-disabled") === "true" || link?.classList.contains("disabled");
    const soldOut = /sold out|out of stock|unavailable/i.test(orderText);
    const orderUrl = !disabled && !soldOut ? url?.href ?? null : null;
    const status = soldOut ? "unavailable" : orderUrl ? "available" : "unknown";
    records.push(baseRecord(source, fetchResult, {
      id: `${source.id}:${url ? `pid:${url.searchParams.get("pid")}` : memory.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      name: `KVM VPS · ${memory}`,
      region: source.regionHint ?? null,
      route: source.routeHint ?? null,
      note: "KVM 虚拟化；可选机房以订购页面为准",
      hardware: `${cpu} / ${memory} / ${storage}`,
      bandwidth: `${bandwidth} / ${ipv4}`,
      price,
      priceValue,
      status,
      statusLabel: soldOut ? "不可订购" : orderUrl ? "可订购入口" : "未知",
      stockCount: soldOut ? 0 : null,
      orderUrl,
      evidence: `RackNerd KVM plan parsed from official page; stock=${soldOut ? "sold out" : "not stated"}; order=${orderUrl ? "yes" : "no"}`,
      raw: { memory, cpu, storage, bandwidth, ipv4, orderText }
    }));
  }
  if (records.length === 0) throw new Error("RackNerd KVM table has no plans");
  return records;
}
