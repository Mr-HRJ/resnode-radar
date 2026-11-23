// Parsers for SPA billing consoles whose public storefront pages load an
// anonymous JSON product list. Each provider runs a different, self-built
// console, so every format has its own small parser. All of them read only the
// JSON the provider's own public (no-login) page requests; none of them submit
// orders, log in, or touch challenge pages.
//
//   lazycat   https://dash.lazycat.wiki/api/packages/public (+ /regions)
//   nmcloud   https://new.nmcloud.cc/api/v1/catalog/products
//   breacloud https://brea.cloud/api/v1/products?currency=HKD
//   kfchost   https://kfchost.com/api/front/get-ecs-products?region=<code>
//   hhost     https://members.hhost.com/Console/Cloud/getPlans

export const SPA_CONSOLE_FORMATS = ["lazycat", "nmcloud", "breacloud", "kfchost", "hhost"];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const finite = (value) => value !== null && value !== "" && Number.isFinite(Number(value));
const money = (value) => Number(Number(value).toFixed(2));
const join = (parts) => parts.filter(Boolean).join(" / ") || null;
const homePattern = /家宽|家寬|住宅|residential|真家宽|动态IP家宽/i;

const countryNames = {
  HK: "香港", JP: "日本", US: "美国", USA: "美国", KR: "韩国", TW: "台湾", CA: "加拿大", SG: "新加坡",
  IS: "冰岛", IE: "爱尔兰", GB: "英国", UK: "英国", DE: "德国", PH: "菲律宾", NO: "挪威", MY: "马来西亚",
  FR: "法国", NL: "荷兰"
};

function countryName(code, fallback = null) {
  const key = text(code).toUpperCase();
  return countryNames[key] || text(fallback) || null;
}

function sizeFromMb(mb) {
  const value = Number(mb);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value >= 1024 ? `${Number((value / 1024).toFixed(1))} GB` : `${value} MB`;
}

function originOf(result, fallback) {
  try { return new URL(result.finalUrl || fallback).origin; } catch { return new URL(fallback).origin; }
}

export function parseSpaConsole(source, result, helpers) {
  if (source.catalogFormat === "lazycat") return parseLazyCat(source, result, helpers);
  if (source.catalogFormat === "nmcloud") return parseNmCloud(source, result, helpers);
  if (source.catalogFormat === "breacloud") return parseBreaCloud(source, result, helpers);
  if (source.catalogFormat === "kfchost") return parseKfcHost(source, result, helpers);
  if (source.catalogFormat === "hhost") return parseHHost(source, result, helpers);
  throw new Error(`Unsupported SPA console format: ${source.catalogFormat}`);
}

function json(result, label) {
  try { return JSON.parse(result.html); } catch { throw new Error(`${label} public API did not return JSON`); }
}

// ---------------------------------------------------------------- LazyCat
// The public portal (/ and /market) loads /api/packages/public and
// /api/packages/public/regions and joins them by packageIds. The collector
// walks pages one by one, so the region index from the regions page is kept
// per source for the packages page that follows it in the same run. Configure
// the regions endpoint as source.url and the packages endpoint in catalogUrls.
const lazyCatRegionIndex = new Map();
const LAZYCAT_REGION_TTL_MS = 15 * 60 * 1000;

export function parseLazyCat(source, result, { baseRecord, lazyCatRegions, now = Date.now() } = {}) {
  const payload = json(result, "LazyCat");
  if (Array.isArray(payload?.regions) && !("packages" in payload)) {
    const index = new Map();
    for (const region of payload.regions) {
      if (!text(region?.code) || !Array.isArray(region.packageIds)) throw new Error("LazyCat public region schema changed");
      for (const id of region.packageIds) if (!index.has(id)) index.set(id, { code: text(region.code), name: text(region.name) });
    }
    lazyCatRegionIndex.set(source.id, { at: now, index });
    return [];
  }
  if (!Array.isArray(payload?.packages)) throw new Error("LazyCat public package schema changed");
  const cached = lazyCatRegionIndex.get(source.id);
  const regions = lazyCatRegions ?? (cached && now - cached.at < LAZYCAT_REGION_TTL_MS ? cached.index : new Map());
  const origin = originOf(result, source.url);
  const records = [];
  for (const pkg of payload.packages) {
    if (!isObject(pkg) || !Number.isInteger(pkg.id) || !text(pkg.name) || !Array.isArray(pkg.plans) || typeof pkg.soldOut !== "boolean") {
      throw new Error("LazyCat public package identity changed");
    }
    if (pkg.sourceType && pkg.sourceType !== "official") continue;
    const region = regions.get(pkg.id) ?? null;
    const tags = Array.isArray(pkg.display_tags) ? pkg.display_tags.map((tag) => text(tag?.text)).filter(Boolean) : [];
    const restricted = pkg.vip_only === true ? "VIP 专享" : pkg.preorder_mode === true ? "预售" : null;
    for (const plan of pkg.plans) {
      if (!isObject(plan) || !Number.isInteger(plan.id) || !text(plan.name)) throw new Error("LazyCat public plan identity changed");
      const cents = plan.monthlyPrice ?? plan.price;
      if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("LazyCat public plan price schema changed");
      const cycleMonths = Number.isInteger(plan.billingCycle) && plan.billingCycle > 0 ? plan.billingCycle : 1;
      const amount = money(cents / 100);
      const traffic = plan.trafficLimit && plan.trafficLimit !== "0" ? Number(BigInt(plan.trafficLimit) / 1073741824n) : null;
      const status = pkg.soldOut ? "unavailable" : restricted ? "unknown" : "available";
      const query = new URLSearchParams({ source: "official", package: String(pkg.id), plan: String(plan.id) });
      if (region?.code) query.set("region", region.code.toLowerCase());
      records.push(baseRecord(source, result, {
        id: `${source.id}:plan:${pkg.id}-${plan.id}`,
        sourceUrl: `${origin}/market`,
        name: `${text(pkg.name)} · ${text(plan.name)}`,
        category: homePattern.test(`${pkg.name} ${pkg.description} ${tags.join(" ")}`) ? "home" : "vps",
        region: region ? countryName(region.code, region.name) : null,
        route: join([pkg.network_mode === "nat" ? "NAT" : text(pkg.network_mode).toUpperCase(), text(pkg.instance_type), ...tags]),
        hardware: join([
          plan.cpuCores && `${plan.cpuCores} vCPU${plan.cpuLimit ? ` (${plan.cpuLimit}%)` : ""}`,
          sizeFromMb(plan.memory) && `${sizeFromMb(plan.memory)} RAM`,
          sizeFromMb(plan.disk) && `${sizeFromMb(plan.disk)} disk`
        ]),
        bandwidth: join([
          text(plan.limitsIngress || pkg.limits_ingress).replace(/bit$/i, "bps") || null,
          traffic === null ? "流量不限" : `${traffic} GB/月`,
          plan.portLimit ? `${plan.portLimit} 端口` : null
        ]),
        price: `CNY ${amount.toFixed(2)}/${cycleMonths === 1 ? "月" : `${cycleMonths}个月（月均）`}`, priceValue: amount, currency: "CNY",
        status,
        statusLabel: status === "unavailable" ? "已售罄" : status === "unknown" ? restricted : "可开通",
        stockCount: null,
        orderUrl: `${origin}/instances/create?${query}`,
        note: restricted ? `官方公开套餐；标注${restricted}，普通账户可能无法购买。` : "官方公开套餐；未公开剩余数量，下单需登录。",
        evidence: `Official public packages API; soldOut=${pkg.soldOut}; vip_only=${pkg.vip_only === true}; preorder=${pkg.preorder_mode === true}; stock count not disclosed`,
        raw: { packageId: pkg.id, planId: plan.id, regionCode: region?.code ?? null, monthlyPriceCents: cents, billingCycle: cycleMonths, setupFeeCents: plan.setupFee ?? null, slaGuarantee: plan.slaGuarantee ?? null }
      }));
    }
  }
  return records;
}

// ---------------------------------------------------------------- NMCloud
// /pricing loads /api/v1/catalog/products; the UI marks a product sold out
// exactly when stockAvailable === 0 and links "选择配置" to
// /console/order/new?product=<code>.
const nmPeriods = { month: ["月", 1], quarter: ["季", 3], year: ["年", 12] };

function regionFromText(value) {
  const s = text(value);
  if (/HINET|苗栗|台湾|台灣|台北|Taiwan/i.test(s)) return "台湾";
  if (/香港|\bHK\b|Hong ?Kong|HKT|HKBN/i.test(s)) return "香港";
  if (/日本|东京|東京|大阪|Tokyo|Osaka|\bJP\b/i.test(s)) return "日本";
  if (/新加坡|Singapore|\bSG\b/i.test(s)) return "新加坡";
  if (/韩国|韓國|首尔|Seoul|Korea|\bKR\b/i.test(s)) return "韩国";
  if (/美国|洛杉矶|Los Angeles|\bLAX?\b|\bUS\b/i.test(s)) return "美国";
  return null;
}

export function parseNmCloud(source, result, { baseRecord }) {
  const payload = json(result, "NMCloud");
  if (!Array.isArray(payload)) throw new Error("NMCloud public catalog schema changed");
  const origin = originOf(result, source.url);
  return payload.map((product) => {
    if (!isObject(product) || !text(product.code) || !text(product.name) || !Array.isArray(product.prices) || !isObject(product.spec)) {
      throw new Error("NMCloud public product identity changed");
    }
    const prices = product.prices.map((price) => {
      if (!nmPeriods[price?.period] || !Number.isSafeInteger(price.amountCents) || !/^[A-Z]{3}$/.test(price.currency)) throw new Error("NMCloud public price schema changed");
      return price;
    });
    const primary = prices.find((price) => price.period === "month") ?? [...prices].sort((a, b) => nmPeriods[a.period][1] - nmPeriods[b.period][1])[0] ?? null;
    if (product.stockAvailable !== null && product.stockAvailable !== undefined && !Number.isInteger(product.stockAvailable)) throw new Error("NMCloud stock schema changed");
    const count = Number.isInteger(product.stockAvailable) ? Math.max(0, product.stockAvailable) : null;
    const onSale = product.status === "on_sale";
    const status = !onSale || count === 0 ? "unavailable" : primary ? "available" : "unknown";
    const spec = product.spec;
    const group = text(product.group?.name);
    const amount = primary ? money(primary.amountCents / 100) : null;
    return baseRecord(source, result, {
      id: `${source.id}:plan:${product.code}`,
      sourceUrl: `${origin}/pricing`,
      name: group ? `${group} · ${text(product.name)}` : text(product.name),
      category: homePattern.test(`${group} ${product.name}`) ? "home" : "vps",
      region: regionFromText(`${group} ${product.name}`),
      route: join([text(product.networkProfile).replace(/_/g, " ") || null, text(product.kind).toUpperCase() || null]),
      hardware: join([spec.cpuCores && `${spec.cpuCores} vCPU`, sizeFromMb(spec.memoryMib) && `${sizeFromMb(spec.memoryMib)} RAM`, spec.diskGib && `${spec.diskGib} GB ${text(spec.diskType).toUpperCase() || "disk"}`]),
      bandwidth: join([spec.bandwidthMbps && `${spec.bandwidthMbps} Mbps`, spec.trafficGb && `${spec.trafficGb} GB/月`, spec.ipv4Count ? `${spec.ipv4Count} IPv4` : null, spec.portCount ? `${spec.portCount} 端口` : null]),
      price: primary ? `${primary.currency} ${amount.toFixed(2)}/${nmPeriods[primary.period][0]}` : null,
      priceValue: amount, currency: primary?.currency ?? null,
      status,
      statusLabel: status === "unavailable" ? (onSale ? "已售罄" : "已下架") : status === "available" ? (count === null ? "可下单" : `库存 ${count}`) : "价格未配置",
      stockCount: count,
      orderUrl: `${origin}/console/order/new?product=${encodeURIComponent(product.code)}`,
      note: prices.length > 1 ? `官方公开目录；其他周期：${prices.filter((p) => p !== primary).map((p) => `${p.currency} ${money(p.amountCents / 100).toFixed(2)}/${nmPeriods[p.period][0]}`).join("，")}` : "官方公开目录；下单需登录。",
      evidence: `Official public catalog API; status=${product.status}; stockAvailable=${product.stockAvailable ?? "not stated"}`,
      raw: { code: product.code, productStatus: product.status, stockLimit: product.stockLimit ?? null, stockUsed: product.stockUsed ?? null, stockAvailable: product.stockAvailable ?? null, prices: prices.map(({ period, amountCents, currency }) => ({ period, amountCents, currency })) }
    });
  });
}

// ---------------------------------------------------------------- BreaCloud
// /products (hourly) and /products?mode=periodic load
// /api/v1/products?currency=<HKD>. Amounts are micro-units of the currency.
// The UI shows one card per product x PVE pool and blocks ordering when the
// pool is "available: false" (region full) or stock_left <= 0.
const breaCycles = { monthly: "月", quarterly: "季", semiannually: "半年", annually: "年", biennially: "两年", triennially: "三年" };

export function parseBreaCloud(source, result, { baseRecord }) {
  const payload = json(result, "BreaCloud");
  const products = payload?.data?.products;
  if (payload?.code !== "OK" || !Array.isArray(products)) throw new Error("BreaCloud public product schema changed");
  const currency = new URL(result.finalUrl || source.url).searchParams.get("currency")?.toUpperCase() || "USD";
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("BreaCloud currency missing");
  const origin = originOf(result, source.url);
  const records = [];
  for (const product of products) {
    if (!isObject(product) || !Number.isInteger(product.id) || !text(product.slug) || !text(product.name) || !Array.isArray(product.pricing)) {
      throw new Error("BreaCloud public product identity changed");
    }
    if (product.status !== "active" || (product.product_type && product.product_type !== "vps")) continue;
    const pools = Array.isArray(product.pve_pools) ? product.pve_pools.filter((pool) => pool?.enabled !== false) : [];
    const usage = product.billing_mode === "usage";
    for (const pool of pools.length ? pools : [null]) {
      const pricing = Array.isArray(pool?.pricing) && pool.pricing.length ? pool.pricing : product.pricing;
      for (const price of pricing) if (!breaCycles[price?.cycle] || !Number.isSafeInteger(price.price)) throw new Error("BreaCloud public price schema changed");
      const primary = pricing.find((price) => price.cycle === "monthly") ?? pricing[0] ?? null;
      const estimate = primary ? money(primary.price / 1e6) : null;
      const hourly = Number.isSafeInteger(product.hourly_price) && product.hourly_price >= 0 ? product.hourly_price / 1e6 : null;
      const amount = usage ? hourly : estimate;
      const stockLeft = Number.isInteger(product.stock_left) ? product.stock_left : null;
      const status = stockLeft !== null && stockLeft <= 0 ? "unavailable"
        : pool?.available === false ? "unavailable"
          : !pool || pool.online === false || amount === null ? "unknown" : "available";
      const orderUrl = !pool ? `${origin}/products${usage ? "" : "?mode=periodic"}`
        : usage ? `${origin}/products?region=${pool.pool_id}&product=${encodeURIComponent(product.slug)}`
          : `${origin}/checkout?product=${encodeURIComponent(product.slug)}&currency=${currency}&region=${pool.pool_id}`;
      records.push(baseRecord(source, result, {
        id: `${source.id}:plan:${product.id}-${pool?.pool_id ?? "nopool"}`,
        sourceUrl: `${origin}/products${usage ? "" : "?mode=periodic"}`,
        name: `${text(product.name)} · ${text(pool?.name) || text(product.group_name)}`,
        category: homePattern.test(`${product.name} ${product.description} ${pool?.name}`) ? "home" : "vps",
        region: text(pool?.location) || null,
        route: text(pool?.description) || null,
        hardware: join([product.cpu_cores && `${product.cpu_cores} vCPU`, sizeFromMb(product.memory_mb) && `${sizeFromMb(product.memory_mb)} RAM`, product.disk_gb && `${product.disk_gb} GB disk`]),
        bandwidth: join([
          product.bandwidth_mbps && `${product.bandwidth_mbps} Mbps`,
          product.traffic_unlimited ? "流量不限" : product.traffic_quota_gb ? `${product.traffic_quota_gb} GB/月` : product.traffic_mode === "overage" ? "流量按量计费" : null,
          product.free_ipv4_count ? `${product.free_ipv4_count} IPv4` : null
        ]),
        price: amount === null ? null : usage ? `${currency} ${amount}/小时` : `${currency} ${amount.toFixed(2)}/${breaCycles[primary.cycle]}`,
        priceValue: amount, currency: amount === null ? null : currency,
        status,
        statusLabel: status === "unavailable" ? (stockLeft !== null && stockLeft <= 0 ? "已售罄" : "地区已满") : status === "available" ? (usage ? "可按量开通" : "可订购") : "可用性未确认",
        stockCount: stockLeft !== null ? Math.max(0, stockLeft) : null,
        orderUrl,
        note: usage ? `官方按量计费套餐${hourly !== null ? `（${currency} ${hourly}/小时）` : "（小时价格未公开）"}${primary ? `；官方参考折算 ${currency} ${estimate.toFixed(2)}/${breaCycles[primary.cycle]}` : ""}；流量与额外 IP 另计。` : "官方周期付费套餐；下单需登录。",
        evidence: `Official public products API; billing_mode=${product.billing_mode}; pool.available=${pool?.available ?? "no pool"}; stock_limited=${product.stock_limited ?? "not stated"}; stock_left=${stockLeft ?? "not stated"}`,
        raw: { productId: product.id, slug: product.slug, poolId: pool?.pool_id ?? null, billingMode: product.billing_mode, billingCycle: usage ? "hourly" : primary?.cycle ?? null, pricing: pricing.map(({ cycle, price: micro }) => ({ cycle, micro })), stockLimited: product.stock_limited ?? null }
      }));
    }
  }
  return records;
}

// ---------------------------------------------------------------- KFCHost
// /center/pricing loads /api/front/get-ecs-products?region=<code> (the same
// endpoint answers GET). The UI prices a card from price_json (cents, the
// lowest period key in months), marks it sold out when is_sell_out === 1 and
// links "立即购买" to /center/product/ecs/create/plan/<id>.
export function parseKfcHost(source, result, { baseRecord }) {
  const payload = json(result, "KFCHost");
  const products = Array.isArray(payload?.data) ? payload.data : payload?.data?.data;
  if (payload?.code !== 0 || !Array.isArray(products)) throw new Error("KFCHost public product schema changed");
  const regionCode = new URL(result.finalUrl || source.url).searchParams.get("region") || null;
  const origin = originOf(result, source.url);
  return products.filter((product) => product?.product_group === undefined || product.product_group === "ecs").map((product) => {
    if (!isObject(product) || !Number.isInteger(product.id) || !text(product.name) || !isObject(product.price_json) || !isObject(product.option_json)) {
      throw new Error("KFCHost public product identity changed");
    }
    const key = Object.keys(product.price_json).sort((a, b) => Number(a) - Number(b))[0];
    const entry = key ? product.price_json[key] : null;
    if (entry && (!finite(entry.price) || !Number.isInteger(Number(key)))) throw new Error("KFCHost price schema changed");
    const months = key ? Number(key) : null;
    const amount = entry ? money(Number(entry.price) / 100) : null;
    const original = entry && finite(entry.show_price) ? money(Number(entry.show_price) / 100) : null;
    const option = product.option_json;
    const soldOut = Number(product.is_sell_out) === 1;
    const listed = product.status === undefined || Number(product.status) === 1;
    const status = soldOut || !listed ? "unavailable" : entry ? "available" : "unknown";
    const flow = Number(String(option.flow ?? "").replace(/[^\d.]/g, ""));
    return baseRecord(source, result, {
      id: `${source.id}:plan:${product.id}`,
      sourceUrl: `${origin}/center/pricing`,
      name: text(product.name_en) && text(product.name_en) !== text(product.name) ? `${text(product.name)} ${text(product.name_en)}` : text(product.name),
      category: homePattern.test(`${product.name} ${product.desc}`) ? "home" : "vps",
      region: countryName(option.region || option.ecs_region || regionCode),
      route: null,
      hardware: join([option.cpu && `${option.cpu} vCPU`, sizeFromMb(option.memory) && `${sizeFromMb(option.memory)} RAM`, option.system_disk && `${option.system_disk} GB disk`]),
      bandwidth: join([
        text(option.bandwidth_desc) || (option.bandwidth ? `${option.bandwidth} Mbps` : null),
        option.ecs_billing_mode === "fixedBandwidth" ? "流量不限" : option.ecs_billing_mode === "fixedFlow" && flow > 0 ? `${flow} GB/月` : null,
        option.ip ? `${option.ip} IPv4` : null
      ]),
      price: entry ? `USD ${amount.toFixed(2)}/${months === 1 ? "月" : `${months}个月`}` : null,
      priceValue: amount, currency: entry ? "USD" : null,
      status,
      statusLabel: status === "unavailable" ? (soldOut ? "已售罄" : "已下架") : status === "available" ? "可订购" : "价格未公开",
      stockCount: soldOut ? 0 : null,
      orderUrl: `${origin}/center/product/ecs/create/plan/${encodeURIComponent(String(product.id))}`,
      note: original !== null && original > amount ? `官方公开套餐；原价 USD ${original.toFixed(2)}，下单需登录。` : "官方公开套餐；下单需登录。",
      evidence: `Official public ECS product API; is_sell_out=${product.is_sell_out ?? "not stated"}; status=${product.status ?? "not stated"}; stock count not disclosed`,
      raw: { productId: product.id, region: option.region || regionCode, periodMonths: months, priceCents: entry ? Number(entry.price) : null, showPriceCents: entry && finite(entry.show_price) ? Number(entry.show_price) : null, billingMode: option.ecs_billing_mode ?? null }
    });
  });
}

// ---------------------------------------------------------------- HHost
// www.hhost.com links each cloud plan to the guest-accessible
// members.hhost.com/#/affCloud?type=1&pid=<id>, which loads
// /Console/Cloud/getPlans. Prices are USD cents per month; stock is
// {unlimited:true} or {unlimited:false, available, sold_out}.
function hhostSoldOut(stock) {
  return Boolean(stock && ((stock.unlimited === false && stock.sold_out === true) || (Number(stock.sold_out) === 1 && stock.unlimited !== true)));
}

export function parseHHost(source, result, { baseRecord }) {
  const payload = json(result, "HHost");
  if (!isObject(payload) || !Object.keys(payload).length) throw new Error("HHost public cloud plan schema changed");
  const records = [];
  for (const [country, datacenters] of Object.entries(payload)) {
    if (!isObject(datacenters)) throw new Error("HHost public datacenter schema changed");
    for (const [dcId, dc] of Object.entries(datacenters)) {
      if (!isObject(dc) || !text(dc.name) || !Array.isArray(dc.ip_groups)) throw new Error("HHost public datacenter identity changed");
      for (const group of dc.ip_groups) {
        if (!isObject(group) || !Array.isArray(group.plans)) throw new Error("HHost public line schema changed");
        for (const plan of group.plans) {
          if (!isObject(plan) || !Number.isInteger(plan.id) || !Number.isSafeInteger(plan.price) || !isObject(plan.stock)) throw new Error("HHost public plan schema changed");
          const stock = plan.stock;
          const soldOut = hhostSoldOut(stock);
          const count = stock.unlimited === true ? null : soldOut ? 0 : Number.isInteger(stock.available) ? Math.max(0, stock.available) : null;
          const disabled = Number(group.disabled) === 1;
          const status = soldOut || count === 0 ? "unavailable" : disabled ? "unknown" : "available";
          const amount = money(plan.price / 100);
          const memory = sizeFromMb(plan.memory);
          records.push(baseRecord(source, result, {
            id: `${source.id}:plan:${plan.id}`,
            sourceUrl: "https://www.hhost.com/#pricing",
            name: `${text(dc.name)} · ${text(group.group_name)} ${plan.cpu}C/${memory ?? "?"}/${plan.hdd_size ?? "?"} GB`,
            category: "vps",
            region: countryName(country),
            route: text(group.group_name) || null,
            hardware: join([plan.cpu && `${plan.cpu} vCPU`, memory && `${memory} RAM`, plan.hdd_size && `${plan.hdd_size} GB disk`]),
            bandwidth: join([
              plan.down_bandwidth > 0 ? `${plan.down_bandwidth}${plan.up_bandwidth > 0 && plan.up_bandwidth !== plan.down_bandwidth ? `/${plan.up_bandwidth}` : ""} Mbps` : null,
              plan.traffic > 0 ? `${plan.traffic} GB/月` : null,
              plan.nat_port_count > 0 ? `NAT ${plan.nat_port_count} 端口` : null
            ]),
            price: `USD ${amount.toFixed(2)}/月`, priceValue: amount, currency: "USD",
            status,
            statusLabel: status === "unavailable" ? "已售罄" : status === "unknown" ? "线路已停用" : count === null ? "官方标注不限库存" : `库存 ${count}`,
            stockCount: count,
            orderUrl: `https://members.hhost.com/index.html#/affCloud?type=1&pid=${plan.id}&cycle=0`,
            note: Number(plan.os_limit) === 1 ? "官方公开云服务器套餐；仅支持 Linux。" : "官方公开云服务器套餐。",
            evidence: `Official public cloud plan API; stock.unlimited=${stock.unlimited ?? "not stated"}; stock.available=${stock.available ?? "not stated"}; sold_out=${stock.sold_out ?? false}`,
            raw: { planId: plan.id, datacenterId: dcId, lineId: group.id ?? null, priceCents: plan.price, stock }
          }));
        }
      }
    }
  }
  return records;
}
