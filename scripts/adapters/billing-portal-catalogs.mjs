import { parse } from "node-html-parser";

// Parsers for billing portals whose public storefront renders the full plan
// list without login:
// - HostBill "onestep_*" order pages (WebHorizon, DataOnline): `.card.cart-product[data-value]`
//   cards with per-cycle `.product-price.cycle-*` prices and an official `outofstock` class.
// - ShanDun (魔方财务/idcsmart storefront): the public JSON list the official
//   /product/cloud-servers.html page loads from /console/v1/product?id=<region group>.
// Both throw on schema drift so a template change surfaces as an error, not empty stock.

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const regionOptions = [
  ["香港", /香港|Hong\s*Kong|\bHKG?\b/i],
  ["台湾", /台湾|台灣|Taiwan|Taipei/i],
  ["日本", /日本|Japan|Tokyo|Osaka|Nhật/i],
  ["新加坡", /新加坡|Singapore/i],
  ["美国", /美国|美國|United\s*States|\bUSA?\b|Oregon|Virginia|Hillsboro|Ashburn|Mỹ/i],
  ["英国", /英国|英國|United\s*Kingdom|\bUK\b|London/i],
  ["德国", /德国|德國|Germany|Nuremberg|Falkenstein|Frankfurt|Đức/i],
  ["芬兰", /芬兰|芬蘭|Finland|Helsinki|Phần\s*Lan/i],
  ["荷兰", /荷兰|荷蘭|Netherlands|Amsterdam/i],
  ["挪威", /挪威|Norway|Oslo/i],
  ["印度", /印度|India|Mumbai/i],
  ["越南", /越南|Vietnam|Việt\s*Nam|\bVNPT\b|\bFPT\b/i]
];

function regionFrom(value) {
  const matches = regionOptions.filter(([, pattern]) => pattern.test(value)).map(([name]) => name);
  return matches.length === 1 ? matches[0] : null;
}

export function parseHaloCloudCatalog(source, result, { baseRecord }) {
  const root = parse(result.html);
  const script = root.querySelectorAll("script:not([src])").map((node) => node.text).find((text) => text.includes("window.__SimplifiedCartPayload"));
  const json = script?.match(/^\s*window\.__SimplifiedCartPayload\s*=\s*(\{[\s\S]*\})\s*;?\s*$/)?.[1];
  if (!json) throw new Error("HaloCloud public catalog payload missing");
  const payload = JSON.parse(json);
  if (payload.result !== "success" || !Array.isArray(payload.packages) || !Array.isArray(payload.data?.nodes) || !Array.isArray(payload.data?.regions) || !Array.isArray(payload.data?.types)) throw new Error("HaloCloud public catalog schema changed");
  if (!/currencyPrefix\s*:\s*"\$"/.test(result.html)) throw new Error("HaloCloud storefront currency changed");
  const cycleNames = { monthly: "Monthly", quarterly: "Quarterly", semiannually: "Semi-Annually", annually: "Annually", biennially: "Biennially", triennially: "Triennially" };
  const vpsTypes = new Set(payload.data.types.filter((type) => /\bVPS\b/i.test(type.name)).map((type) => type.id));
  return payload.packages.flatMap((plan) => {
    const node = payload.data.nodes.find((node) => node.product_group_id === plan.groupId);
    if (!node || !Array.isArray(node.supported_types_array)) throw new Error("HaloCloud catalog group mapping changed");
    if (!node.supported_types_array.some((id) => vpsTypes.has(id))) return [];
    const cycle = Object.keys(cycleNames).find((cycle) => typeof plan.pricing?.[cycle] === "string" && /^\d+(?:\.\d+)?$/.test(plan.pricing[cycle]) && Number(plan.pricing[cycle]) > 0);
    if (!Number.isSafeInteger(plan.id) || plan.id <= 0 || !plan.name || !cycle || typeof plan.stockcontrol !== "boolean" || (plan.stockcontrol && !Number.isSafeInteger(plan.qty))) throw new Error("HaloCloud plan price or stock schema changed");
    const lines = String(plan.description || "").split(/\r?\n|<br\s*\/?>/i).map((line) => clean(parse(line).text)).filter(Boolean);
    const count = plan.stockcontrol ? Math.max(0, plan.qty) : null;
    const status = count === 0 ? "unavailable" : "available";
    const order = new URL("/cart.php", result.finalUrl);
    order.search = new URLSearchParams({ a: "add", pid: String(plan.id), billingcycle: cycle, skipconfig: "1", carttpl: "halocloud-studio-cart" }).toString();
    const setupFee = Number(plan.setupFees?.[cycle] || 0);
    if (!Number.isFinite(setupFee) || setupFee < 0) throw new Error("HaloCloud setup fee changed");
    return [baseRecord(source, result, {
      id: `${source.id}:plan:${plan.id}`, sourceUrl: result.finalUrl, name: plan.name, category: "vps",
      region: regionFrom(payload.data.regions.find((region) => region.id === node.region_id)?.name || plan.group_name), route: node.name,
      hardware: lines.filter((line) => /CPU|Memory|Disk|RAM|SSD|NVMe/i.test(line)).join(" / ") || null,
      bandwidth: lines.filter((line) => /Bandwidth|Traffic|IPv[46]/i.test(line)).join(" / ") || null,
      price: `$${Number(plan.pricing[cycle]).toFixed(2)} / ${cycleNames[cycle]}`, priceValue: Number(plan.pricing[cycle]), currency: "USD",
      status, statusLabel: status === "unavailable" ? "已售罄" : count === null ? "可订购入口" : `库存 ${count}`, stockCount: count, orderUrl: order.href,
      note: `官方公开订购目录；未启用数量限制的产品不推断库存数量。${setupFee ? `另收一次性设置费 USD ${setupFee}。` : ""}`,
      evidence: `Official anonymous storefront payload; stockcontrol=${plan.stockcontrol}; quantity=${count ?? "not limited"}`,
      raw: { productId: plan.id, groupId: plan.groupId, billingCycle: cycle, stockcontrol: plan.stockcontrol, setupFee }
    })];
  });
}

// MoonVM renders every group on each store route. The DOM carries the real
// group/product/variant IDs even when a sold-out card has no order link.
export function parseMoonvmCatalog(source, result, { baseRecord }) {
  const root = parse(result.html);
  const sections = root.querySelectorAll(".moonvm-catalog-section");
  if (!sections.length) throw new Error("MoonVM catalog sections missing");
  const records = [];
  for (const section of sections) {
    const group = clean(section.querySelector(".moonvm-catalog-divider h2")?.text);
    for (const card of section.querySelectorAll("li[id]")) {
      const identity = card.id.match(/^productg(\d+)-p(\d+)-b(\d+)$/);
      if (!identity) continue;
      const [, groupId, pid, variant] = identity;
      const name = clean(card.querySelector(".pricing-title")?.text);
      const cycles = card.querySelectorAll(".moonvm-cycle-option[data-cycle]");
      const primary = cycles.find((node) => node.getAttribute("data-cycle") === "monthly") ?? cycles[0];
      const amountText = clean(primary?.querySelector(".pricing-price")?.text);
      const cycle = clean(primary?.querySelector(".billing-cycle")?.text);
      if (!group || !name || !/^\$[\d,]+(?:\.\d+)?$/.test(amountText) || !cycle) throw new Error("MoonVM catalog plan schema changed");
      const amount = Number(amountText.slice(1).replaceAll(",", ""));
      const lines = card.querySelectorAll(".pricing-details li").filter((node) => !node.querySelector("li")).map((node) => clean(node.text));
      const button = card.querySelector(".pricing-link a[href]");
      const disabled = button?.hasAttribute("disabled") || button?.getAttribute("aria-disabled") === "true" || button?.classList.contains("disabled");
      const href = button?.getAttribute("href");
      const order = href ? new URL(href, result.finalUrl) : null;
      if (order && (order.origin !== new URL(source.url).origin || !/^\/store\/[^/]+\/[^/]+\/?$/.test(order.searchParams.get("rp") || order.pathname))) throw new Error("MoonVM order link outside official product routes");
      const soldOut = /Out of Stock|Sold Out/i.test(clean(card.querySelector(".pricing-link")?.text));
      const status = soldOut ? "unavailable" : order && !disabled ? "available" : "unknown";
      records.push(baseRecord(source, result, {
        id: `${source.id}:plan:${pid}:${variant}`, sourceUrl: source.url,
        name, category: /HiNet|HGC|HKT|WTT|APOL/i.test(group) ? "home" : "vps",
        region: regionFrom(group), route: group,
        hardware: lines.filter((line) => /CPU|RAM|DDR|SSD|NVMe|HDD/i.test(line)).join(" / ") || null,
        bandwidth: lines.filter((line) => /Mbps|Gbps|IPv[46]|traffic|\b\d+\s*[GT]B\b/i.test(line) && !/CPU|RAM|DDR|SSD|NVMe|HDD/i.test(line)).join(" / ") || null,
        price: `${amountText} ${cycle}`, priceValue: amount, currency: source.currency || "USD",
        status, statusLabel: soldOut ? "已售罄" : status === "available" ? "可订购入口" : "库存未确认",
        stockCount: soldOut ? 0 : null, orderUrl: order?.href ?? null,
        note: "官方完整目录；仅购买入口不代表精确库存，部分套餐需人工开通。",
        evidence: `Official MoonVM catalog; pid=${pid}; group=${groupId}; soldOut=${soldOut}; order=${Boolean(order && !disabled)}`,
        raw: { productId: pid, groupId, variant, billingCycle: primary.getAttribute("data-cycle"), catalogPage: source.url }
      }));
    }
  }
  if (!records.length) throw new Error("MoonVM catalog has no product cards");
  return records;
}

function parseAmount(text) {
  const numeric = String(text ?? "").match(/[0-9][0-9.,]*/)?.[0] ?? "";
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(numeric)) return Number(numeric.replace(/,/g, ""));
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(numeric)) return Number(numeric.replace(/\./g, "").replace(",", "."));
  return Number(numeric.replace(",", "."));
}

const hostbillCycleOrder = ["m", "q", "s", "a", "b", "t", "p4", "p5", "w", "d", "h"];
// HostBill cycle codes are locale independent; page labels may be Vietnamese/Chinese.
const hostbillCycleNames = { m: "Monthly", q: "Quarterly", s: "Semi-Annually", a: "Annually", b: "Biennially", t: "Triennially", p4: "Quadrennially", p5: "Quinquennially", w: "Weekly", d: "Daily", h: "Hourly" };

export function parseHostbillOnestep(source, result, { baseRecord }) {
  const root = parse(result.html);
  const page = new URL(result.finalUrl || source.url);
  const cards = root.querySelectorAll(".card.cart-product[data-value]");
  if (!cards.length) {
    throw new Error(`HostBill onestep catalog markup not found at ${page.href}`);
  }
  const pageContext = clean([
    root.querySelector(".cart-category.selected")?.text,
    root.querySelector("#cart-datacenters")?.getAttribute("data-datacenters"),
    root.querySelector("h1")?.text
  ].filter(Boolean).join(" "));
  return cards.map((card) => {
    const pid = card.getAttribute("data-value");
    const baseName = clean(card.querySelector("h4")?.text);
    if (!/^\d+$/.test(pid ?? "") || !baseName) throw new Error("HostBill onestep card is missing its product id or name");
    const variant = clean(card.querySelector("p.d-none")?.text);
    const name = variant ? `${baseName} (${variant.replace(/-/g, " ")})` : baseName;
    const prices = new Map();
    for (const node of card.querySelectorAll(".product-price")) {
      const cycle = node.classNames.split(/\s+/).find((cls) => cls.startsWith("cycle-"))?.slice(6);
      const text = clean(node.text);
      if (cycle && text && !prices.has(cycle)) prices.set(cycle, text);
    }
    const labels = new Map(card.querySelectorAll(".product-cycle").map((node) => [
      node.classNames.split(/\s+/).find((cls) => cls.startsWith("cycle-"))?.slice(6), clean(node.text)
    ]));
    const cycle = hostbillCycleOrder.find((key) => prices.has(key)) ?? [...prices.keys()][0];
    if (!cycle) throw new Error(`HostBill onestep card ${pid} has no published price`);
    const priceText = prices.get(cycle);
    const amount = parseAmount(priceText);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error(`HostBill onestep card ${pid} has an unreadable price`);
    const currency = priceText.match(/\b([A-Z]{3})\s*$/)?.[1] ?? source.currency ?? null;
    const specs = card.querySelectorAll(".cart-product-section .row").map((row) => {
      const cols = row.childNodes.filter((child) => child.nodeType === 1 && child.tagName === "DIV").map((col) => clean(col.text));
      return cols.length >= 2 && cols[0] && cols[1] ? [cols[0], cols[1]] : null;
    }).filter(Boolean);
    const describe = (pattern) => specs.filter(([label]) => pattern.test(label)).map(([label, value]) => `${label}: ${value}`);
    const hardware = describe(/CPU|Core|RAM|Memory|Disk|Storage|NVMe|SSD/i).slice(0, 4).join(" / ");
    const bandwidth = describe(/Network|Transfer|Bandwidth|Traffic|Connectivity|Port|Speed|IPv4|IPv6/i).slice(0, 4).join(" / ");
    const soldOut = card.classList.contains("outofstock") || Boolean(card.querySelector(".product-out-of-stock, .cart-product-outofstock-badge"));
    const status = soldOut ? "unavailable" : "available";
    const orderUrl = `${page.origin}/?cmd=cart&action=add&id=${pid}`;
    return baseRecord(source, result, {
      id: `${source.id}:plan:${pid}`,
      sourceUrl: page.href,
      name,
      category: "vps",
      region: regionFrom(variant) || regionFrom(baseName) || regionFrom(pageContext) || null,
      route: null,
      hardware: hardware || null,
      bandwidth: bandwidth || null,
      note: "官方 HostBill 公开订购页套餐；价格为页面展示的首个计费周期，下单前请确认配置与周期。",
      price: `${priceText} / ${hostbillCycleNames[cycle] ?? labels.get(cycle) ?? cycle}`,
      priceValue: amount,
      currency,
      status,
      statusLabel: soldOut ? "缺货" : "可订购入口",
      stockCount: soldOut ? 0 : null,
      orderUrl,
      evidence: `Official HostBill order page card pid=${pid}; outofstock=${soldOut}; stock count not published`,
      raw: { productId: Number(pid), variant: variant || null, billingCycle: hostbillCycleNames[cycle] ?? cycle, cycleLabel: labels.get(cycle) || null, cyclePrices: Object.fromEntries(prices), cartUrl: orderUrl }
    });
  });
}

const shandunRegions = { "中國香港": "香港", "中国香港": "香港", "香港": "香港", "美國": "美国", "美国": "美国", "德國": "德国", "德国": "德国", "英國": "英国", "英国": "英国", "日本": "日本", "新加坡": "新加坡" };

function shandunSpecs(html) {
  const root = parse(String(html ?? ""));
  const rows = root.querySelectorAll(".funidc-specs > div, .funidc-plan-list > div, .funidc-spec-lines > div").map((node) => clean(node.text)).filter(Boolean);
  return rows.length ? rows : clean(root.text).split(/[,，;；|｜]/).map((item) => item.trim()).filter(Boolean);
}

export function parseShandunCatalog(source, result, { baseRecord }) {
  let payload;
  try { payload = JSON.parse(result.html); } catch { throw new Error("ShanDun product API did not return JSON"); }
  if (Number(payload?.status) !== 200 || !Array.isArray(payload?.data?.list)) {
    throw new Error(`ShanDun product API schema changed (status=${payload?.status ?? "missing"})`);
  }
  const page = new URL(result.finalUrl || source.url);
  const firstGroup = Number(source.firstGroupId ?? 1);
  const storeUrl = new URL(source.storePath ?? "/store/cloud-servers.html", page.origin).href;
  return payload.data.list.filter((item) => Number(item.product_group_id_first) === firstGroup).map((item) => {
    const id = Number(item.id);
    const name = clean(item.name);
    const amount = Number(item.price);
    if (!Number.isInteger(id) || !name || !("stock_control" in item) || !("qty" in item)) {
      throw new Error("ShanDun product entry is missing id, name or stock fields");
    }
    // Mirrors the official store's isProductSoldOut: only stock_control=1 with qty<=0 is sold out.
    const controlled = Number(item.stock_control) === 1;
    const qty = item.qty === null || item.qty === undefined || item.qty === "" ? null : Number(item.qty);
    const count = controlled && Number.isFinite(qty) ? Math.max(0, Math.trunc(qty)) : null;
    const soldOut = count === 0;
    const specs = shandunSpecs(item.description).slice(0, 8);
    const hardware = specs.filter((line) => /處理器|处理器|CPU|EPYC|Xeon|Platinum|NVMe|SSD|內存|内存|RAM/i.test(line)).join(" / ");
    const bandwidth = specs.filter((line) => /Mbps|Gbps|頻寬|频宽|带宽|流量|IPv4|IPv6|\bIP\b|DDoS|防禦|防御/i.test(line)).join(" / ");
    const routes = [...new Set(`${name} ${specs.join(" ")}`.match(/CN2\s*GIA|CN2|CMIN2|9929|4837|BGP/gi) ?? [])].map((r) => r.toUpperCase()).join(" / ");
    const cycle = clean(item.cycle) || "1個月";
    const priced = Number.isFinite(amount) && amount > 0;
    const orderUrl = `${storeUrl}?id=${encodeURIComponent(id)}`;
    const regionName = clean(item.product_group_name_second);
    return baseRecord(source, result, {
      id: `${source.id}:plan:${id}`,
      sourceUrl: page.href,
      name,
      category: /雙\s*ISP|双\s*ISP|原生\s*IP|家寬|家宽|住宅/i.test(specs.join(" ")) && /ISP/i.test(name) ? "home" : "vps",
      region: shandunRegions[regionName] ?? regionFrom(regionName) ?? null,
      route: routes || null,
      hardware: hardware || null,
      bandwidth: bandwidth || null,
      note: "官方公开商品列表；价格为可配置机型的起步价（起），实际以下单配置为准。",
      price: priced ? `US$${item.price} 起/${cycle}` : `定制/${cycle}`,
      priceValue: priced ? amount : null,
      currency: source.currency ?? "USD",
      status: soldOut ? "unavailable" : "available",
      statusLabel: soldOut ? "售罄（官方库存 0）" : count !== null ? `库存 ${count}` : "可订购入口",
      stockCount: count,
      orderUrl,
      evidence: `Official ShanDun product API; stock_control=${item.stock_control}; qty=${item.qty ?? "null"}`,
      raw: { productId: id, regionGroupId: Number(item.product_group_id_second), regionGroup: regionName || null, module: item.module ?? null, stockControl: Number(item.stock_control), qty: item.qty ?? null, billingCycle: /^1\s*[個个]?月$/.test(cycle) ? "Monthly" : cycle, configurable: true }
    });
  });
}
