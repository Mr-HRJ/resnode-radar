import { parse } from "node-html-parser";

// Provider-specific parsers for official marketing sites / public storefront
// endpoints that the generic WHMCS-style catalog walker cannot read:
//   misaka    — server-rendered https://www.misaka.io/locations/<metro> inventory tables
//   hosthatch — plan data published in the official https://hosthatch.com/js/app.js bundle
//   goldcloud — anonymous JSON product list the official storefront loads
// Every parser is pure (no network) and throws on schema drift.

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const decodeEntities = (value) => String(value ?? "").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

export const VPS_SITE_CATALOG_FORMATS = ["misaka", "hosthatch", "goldcloud"];

export function parseVpsSiteCatalog(source, result, helpers) {
  if (source.catalogFormat === "misaka") return parseMisakaLocation(source, result, helpers);
  if (source.catalogFormat === "hosthatch") return parseHostHatchBundle(source, result, helpers);
  if (source.catalogFormat === "goldcloud") return parseGoldCloudProducts(source, result, helpers);
  throw new Error(`Unsupported VPS site catalog format: ${source.catalogFormat}`);
}

// ---------------------------------------------------------------- Misaka ----

const misakaMetros = {
  ashburn: "美国 · 阿什本", newyork: "美国 · 纽约", miami: "美国 · 迈阿密", losangeles: "美国 · 洛杉矶",
  montreal: "加拿大 · 蒙特利尔", seattle: "美国 · 西雅图", kansas: "美国 · 堪萨斯城", sanjose: "美国 · 圣何塞",
  johannesburg: "南非 · 约翰内斯堡", athens: "希腊 · 雅典", amsterdam: "荷兰 · 阿姆斯特丹", brussels: "比利时 · 布鲁塞尔",
  marseille: "法国 · 马赛", bordeaux: "法国 · 波尔多", madrid: "西班牙 · 马德里", milan: "意大利 · 米兰",
  bucharest: "罗马尼亚 · 布加勒斯特", zurich: "瑞士 · 苏黎世", vienna: "奥地利 · 维也纳", london: "英国 · 伦敦",
  copenhagen: "丹麦 · 哥本哈根", stockholm: "瑞典 · 斯德哥尔摩", oslo: "挪威 · 奥斯陆", warsaw: "波兰 · 华沙",
  berlin: "德国 · 柏林", frankfurt: "德国 · 法兰克福", saopaulo: "巴西 · 圣保罗", singapore: "新加坡",
  tokyo: "日本 · 东京", istanbul: "土耳其 · 伊斯坦布尔", lagos: "尼日利亚 · 拉各斯", lisbon: "葡萄牙 · 里斯本",
  dublin: "爱尔兰 · 都柏林", kyiv: "乌克兰 · 基辅", zagreb: "克罗地亚 · 萨格勒布", prague: "捷克 · 布拉格",
  hongkong: "香港", taipei: "台湾 · 台北"
};
const MISAKA_HEADERS = /^Plan\|Routing Profile\|vCPU\|RAM\|(NVMe|SSD)\|Transfer\|Price\|Availability$/;

function misakaError(reason) {
  return new Error(`Misaka public location inventory schema changed: ${reason}`);
}

export function parseMisakaLocation(source, result, { baseRecord }) {
  const pageUrl = result.finalUrl || source.url;
  const page = new URL(pageUrl);
  const slug = page.pathname.match(/^\/locations\/([a-z]+)\/?$/)?.[1];
  if (page.hostname !== "www.misaka.io" || !slug) throw new Error("Misaka parser requires an official https://www.misaka.io/locations/<metro> page");
  const root = parse(result.html);
  const metroName = clean(root.querySelector("title")?.text).match(/^(.+?)\s+VPS\b/)?.[1] || slug;
  const region = misakaMetros[slug] || metroName;
  const inventories = root.querySelectorAll("[id$='-inventory']");
  if (!inventories.length) {
    if (root.querySelector("section#cloud-servers table")) throw misakaError("inventory container missing");
    return [];
  }
  const records = [];
  for (const inventory of inventories) {
    const regionId = inventory.id.replace(/-inventory$/, "");
    if (!/^[a-z]{3}\d{2}$/.test(regionId)) throw misakaError(`unexpected region id ${inventory.id}`);
    const facility = clean(inventory.querySelectorAll(".inventory-heading-text")[1]?.text) || null;
    for (const block of inventory.childNodes.filter((node) => node.querySelector?.("table"))) {
      const family = clean(block.querySelector("h3")?.text);
      const table = block.querySelector("table");
      const headers = table.querySelectorAll("thead th").map((cell) => clean(cell.text)).join("|");
      const diskKind = headers.match(MISAKA_HEADERS)?.[1];
      if (!family || !diskKind) throw misakaError(`table headers ${headers || "missing"}`);
      for (const row of table.querySelectorAll("tbody tr")) {
        const cells = row.querySelectorAll("td");
        if (cells.length !== 8) throw misakaError("plan row cell count");
        const [plan, profile, vcpu, ram, disk] = cells.slice(0, 5).map((cell) => clean(cell.text));
        const transferSpan = cells[5].querySelector("span");
        const transferBilling = clean(transferSpan?.text);
        const transfer = clean(cells[5].childNodes.filter((node) => node !== transferSpan).map((node) => node.text).join(" "));
        const priceText = clean(cells[6].text);
        const quote = priceText.match(/^\$\s*([\d,]+(?:\.\d+)?)\s*\/\s*month$/i);
        if (!/^[A-Z0-9][A-Z0-9-]+$/i.test(plan) || !/^\d+$/.test(vcpu) || !quote) throw misakaError(`plan row ${plan || "?"} ${priceText}`);
        const amount = Number(quote[1].replace(/,/g, ""));
        const deploy = cells[7].querySelector("a[href]")?.getAttribute("href");
        let orderUrl = null;
        if (deploy) {
          const target = new URL(decodeEntities(deploy), pageUrl);
          if (target.hostname !== "app.misaka.io" || !target.pathname.startsWith("/iaas/vm/create/")) throw misakaError("deploy link host");
          orderUrl = target.href;
        }
        const soldOut = /^sold out$/i.test(clean(cells[7].text));
        const status = orderUrl ? "available" : soldOut ? "unavailable" : "unknown";
        records.push(baseRecord(source, result, {
          id: `${source.id}:plan:${regionId}:${plan.toLowerCase()}`,
          sourceUrl: pageUrl,
          name: `${plan} · ${metroName} ${regionId.toUpperCase()}`,
          category: "vps", region,
          route: [profile, family].filter(Boolean).join(" · "),
          hardware: `${vcpu} vCPU / ${ram} RAM / ${disk} ${diskKind}`,
          bandwidth: `${transfer} transfer${transferBilling ? ` (${transferBilling.toLowerCase()})` : ""}`,
          price: `USD ${amount}/月`, priceValue: amount, currency: "USD",
          status,
          statusLabel: status === "available" ? "官方可部署" : status === "unavailable" ? "售罄" : "库存未公开",
          stockCount: status === "unavailable" ? 0 : null,
          orderUrl,
          note: `官方机房页库存表；${facility || regionId.toUpperCase()}；官方注明库存以结算时为准。`,
          evidence: `Official Misaka location page inventory table; region=${regionId}; plan=${plan}; availability=${orderUrl ? "Deploy link" : soldOut ? "Sold out" : "not stated"}`,
          raw: { regionId, metro: slug, family, routingProfile: profile, priceText, transferBilling: transferBilling || null, features: { CPU: `${vcpu} vCPU`, 内存: ram, 硬盘: `${disk} ${diskKind}`, 流量: transfer } }
        }));
      }
    }
  }
  if (!records.length) throw misakaError("no plan rows in inventory tables");
  return records;
}

// ------------------------------------------------------------- HostHatch ----

const hostHatchLocations = {
  AMS: "荷兰", STO: "瑞典", LAX: "美国", CHI: "美国", NY: "美国", VIE: "奥地利", OSL: "挪威", LON: "英国",
  ZRH: "瑞士", WAW: "波兰", MAD: "西班牙", MIL: "意大利", HKG: "香港", SGP: "新加坡", TOK: "日本", SYD: "澳大利亚"
};
const HOSTHATCH_PLAN = /label:"([^"]+)",price:\{value:([\d.e+]+),currency:"([A-Z]{3})",cycle:"(\w+)"\},locations:\{([^}]*)\},hardware:\{/g;

function hostHatchError(reason) {
  return new Error(`HostHatch public plan bundle schema changed: ${reason}`);
}

function hostHatchField(segment, key) {
  const match = segment.match(new RegExp(`${key}:\\{([^{}]*)\\}`));
  if (!match) return null;
  const label = match[1].match(/label:"([^"]*)"/)?.[1] ?? null;
  const note = match[1].match(/note:"([^"]*)"/)?.[1] || null;
  const tooltip = match[1].match(/tooltip:"([^"]*)"/)?.[1] || null;
  return label ? { label, note, tooltip } : null;
}

export function parseHostHatchBundle(source, result, { baseRecord }) {
  const pageUrl = result.finalUrl || source.url;
  const page = new URL(pageUrl);
  if (page.hostname !== "hosthatch.com" || page.pathname !== "/js/app.js") throw new Error("HostHatch parser requires the official https://hosthatch.com/js/app.js bundle");
  const text = result.html;
  const matches = [...text.matchAll(HOSTHATCH_PLAN)];
  if (!matches.length) throw hostHatchError("no published plan objects");
  const records = [];
  const seen = new Set();
  matches.forEach((match, index) => {
    const [, label, valueText, currency, cycle, locationText] = match;
    const end = matches[index + 1]?.index ?? match.index + 2000;
    const segment = text.slice(match.index + match[0].length, Math.min(end, match.index + match[0].length + 2000));
    const amount = Number(valueText);
    const codes = locationText.split(",").map((item) => item.split(":")[0].trim()).filter(Boolean);
    const cpu = hostHatchField(segment, "cpu");
    const ram = hostHatchField(segment, "ram");
    const storage = hostHatchField(segment, "storage");
    const bandwidth = hostHatchField(segment, "bandwidth");
    if (!Number.isFinite(amount) || amount <= 0 || cycle !== "month" || !codes.length || !cpu || !ram || !storage || !bandwidth) {
      throw hostHatchError(`plan ${label}`);
    }
    const unknownCode = codes.find((code) => !hostHatchLocations[code]);
    if (unknownCode) throw hostHatchError(`unknown location code ${unknownCode}`);
    const family = /^storage\b/i.test(label) ? "storage" : /^nvme\b/i.test(label) ? "compute" : "other";
    const id = `${source.id}:plan:${family}:${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
    if (seen.has(id)) return;
    seen.add(id);
    const regions = [...new Set(codes.map((code) => hostHatchLocations[code]))];
    records.push(baseRecord(source, result, {
      id, sourceUrl: "https://hosthatch.com/products",
      name: `${label} · ${family === "storage" ? "Storage VM" : "Compute VM"}`,
      category: "vps",
      region: regions.length > 1 ? "多地区（下单选择）" : regions[0], regions,
      route: null,
      hardware: [cpu.label + (cpu.note ? ` ${cpu.note}` : ""), `${ram.label} RAM`, storage.label].join(" / "),
      bandwidth: `${bandwidth.label} transfer`,
      price: `${currency} ${amount}/月`, priceValue: amount, currency,
      status: "unknown", statusLabel: "库存未公开", stockCount: null, orderUrl: null,
      note: [`官方产品页公开价格；可选机房 ${codes.join(" / ")}`, bandwidth.tooltip, "官网未公开库存，需登录控制台部署确认。"].filter(Boolean).join("；"),
      evidence: `Official HostHatch products bundle (js/app.js); plan=${label}; locations=${codes.join(",")}; stock not published`,
      raw: { planLabel: label, family, locations: codes, billingCycle: cycle, features: { CPU: cpu.label, 内存: ram.label, 硬盘: storage.label, 流量: bandwidth.label } }
    }));
  });
  return records;
}

// ------------------------------------------------------------- GoldCloud ----

const goldCloudRegions = { HK: "香港", US: "美国", DE: "德国", JP: "日本", SG: "新加坡" };

function goldCloudError(reason) {
  return new Error(`GoldCloud public product API schema changed: ${reason}`);
}

function descriptionFields(text) {
  const fields = {};
  for (const line of String(text ?? "").split(/\n+/)) {
    const match = line.match(/^\s*([^：:]+)[：:]\s*(.+?)\s*$/);
    if (match) fields[clean(match[1])] = clean(match[2]);
  }
  return fields;
}

export function parseGoldCloudProducts(source, result, { baseRecord }) {
  const pageUrl = result.finalUrl || source.url;
  const page = new URL(pageUrl);
  if (page.hostname !== "goldcloud.dev" || page.pathname !== "/api/v1/products") throw new Error("GoldCloud parser requires the official https://goldcloud.dev/api/v1/products endpoint");
  let data;
  try { data = JSON.parse(result.html); } catch { throw goldCloudError("response is not JSON"); }
  if (!Array.isArray(data) || !data.length) throw goldCloudError("category list missing");
  const records = [];
  for (const group of data) {
    if (typeof group?.key !== "string" || typeof group?.name !== "string" || !Array.isArray(group.products)) throw goldCloudError("category fields");
    const intro = clean(group.intro);
    const regionCode = group.name.match(/^([A-Z]{2})-/)?.[1];
    const region = goldCloudRegions[regionCode] || null;
    const routes = [...new Set((intro.match(/CN2\s*GT|CN2\s*GIA|CN2|4837|9929|10099|CMIN2|CMI|GTT/gi) || []).map((item) => item.toUpperCase().replace(/\s+/g, " ")))];
    const peak = intro.match(/峰值\s*(\d+\s*M(?:bps)?)/i)?.[1];
    const floor = intro.match(/保底\s*(\d+\s*M(?:bps)?)/i)?.[1];
    const cpuModel = intro.match(/CPU[:：]\s*([^\s]+(?:\s+[^\s峰去回测]+)?)/)?.[1] || null;
    for (const product of group.products) {
      const { id, urlToken, name, priceMonth, stock } = product ?? {};
      if (!Number.isInteger(id) || typeof urlToken !== "string" || !/^[A-Za-z0-9_-]+$/.test(urlToken) || typeof name !== "string" || !Number.isFinite(priceMonth) || priceMonth <= 0 || !Number.isInteger(stock) || stock < 0) {
        throw goldCloudError(`product ${name ?? id ?? "?"}`);
      }
      const fields = descriptionFields(product.description);
      const status = stock > 0 ? "available" : "unavailable";
      const orderUrl = `https://my.goldcloud.dev/products/${urlToken}`;
      records.push(baseRecord(source, result, {
        id: `${source.id}:plan:${id}`,
        sourceUrl: `https://my.goldcloud.dev/products/category/${group.key}`,
        name, category: "vps", region,
        route: routes.join(" / ") || null,
        hardware: [fields.CPU && `${fields.CPU} CPU`, fields["内存"] && `${fields["内存"]} RAM`, fields["系统盘"] && `${fields["系统盘"]} 系统盘`, fields["数据盘"] && `${fields["数据盘"]} 数据盘`].filter(Boolean).join(" / ") || null,
        bandwidth: [peak && `峰值 ${peak}`, floor && `保底 ${floor}`, fields["流量"] && `${fields["流量"]} 流量`, fields["IP数量"]].filter(Boolean).join(" / ") || null,
        price: `CNY ${priceMonth}/月`, priceValue: priceMonth, currency: "CNY",
        status, statusLabel: status === "available" ? `库存 ${stock}` : "售罄",
        stockCount: stock, orderUrl,
        note: [`${group.name} 机房`, cpuModel && `CPU ${cpuModel}`, group.trafficNote].filter(Boolean).join("；"),
        evidence: `Official GoldCloud storefront product API; category=${group.name}; productId=${id}; stock=${stock}`,
        raw: { productId: id, urlToken, categoryKey: group.key, categoryName: group.name, lineCategory: product.category ?? null, intro, features: fields }
      }));
    }
  }
  if (!records.length) throw goldCloudError("no products");
  return records;
}
