import { constants, createHash, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";

const countries = { "asia-hk": "香港", "asia-jp": "日本", "asia-kr": "韩国", "asia-sg": "新加坡", "asia-tw": "台湾", "na-us": "美国" };
const cycles = { monthly: "月", quarterly: "季", semi_annually: "半年", annually: "年", biennially: "两年", triennially: "三年" };
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => String(value ?? "").trim();
const quote = (currency, amount, cycle) => amount === null ? null : `${currency} ${amount}${cycle ? `/${cycle}` : ""}`;
const knownCurrency = (value) => typeof value === "string" && /^[A-Z]{3}$/.test(value);

export function parseDynamicCatalog(source, result, helpers) {
  const payload = JSON.parse(result.html);
  if (source.catalogFormat === "neburst") return parseNeburst(source, result, payload, helpers);
  if (source.catalogFormat === "skyline") return parseSkyline(source, result, payload, helpers);
  throw new Error(`Unsupported dynamic catalog format: ${source.catalogFormat}`);
}

function priceInCents(price) {
  if (Number.isSafeInteger(price.price_cents) && price.price_cents >= 0) return price.price_cents;
  if (price.price_cents !== undefined && price.price_cents !== null) throw new Error("Neburst price_cents schema changed");
  if (price.price === null || price.price === undefined || price.price === "") throw new Error("Neburst price missing");
  const amount = Number(price.price);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(Math.round(amount * 100))) throw new Error("Neburst price schema changed");
  return Math.round(amount * 100);
}

function neburstPromotion(cents, shapeId, cycle, promotions) {
  // The public client applies the first qualifying promotion, without stacking.
  const promotion = promotions.find((p) =>
    !(p.applicable_shapes?.length && !p.applicable_shapes.includes(shapeId)) &&
    !(p.allowed_pay_cycles?.length && !p.allowed_pay_cycles.includes(cycle)));
  if (!promotion) return { cents, promotion: null };
  let discounted;
  if (promotion.discount_type === "percent") {
    const percent = Number(promotion.discount_value);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error("Neburst percentage discount schema changed");
    discounted = Math.round(cents * (1 - percent / 100));
  } else if (["fixed", "deduction"].includes(promotion.discount_type)) {
    const deduction = promotion.discount_value_cents ?? Math.round(Number(promotion.discount_value) * 100);
    if (!Number.isSafeInteger(deduction) || deduction < 0) throw new Error("Neburst fixed discount schema changed");
    discounted = cents - deduction;
  } else return { cents, promotion: null };
  if (discounted < 0 || !Number.isSafeInteger(discounted)) throw new Error("Neburst discount exceeds quoted price");
  return { cents: discounted, promotion };
}

function shapeSpec(value, fallbackUnit) {
  if (!isObject(value) || value.default === undefined || value.default === null) return null;
  return `${value.default} ${text(value.unit) || fallbackUnit}`;
}

function parseNeburst(source, result, payload, { baseRecord }) {
  const data = payload.data;
  if (payload.code !== 0 || !isObject(data) || data.product_type !== "cloud_instance" ||
      !Array.isArray(data.regions) || !isObject(data.shapes) || !isObject(data.prices) || !isObject(data.availability)) {
    throw new Error("Neburst public pricing schema changed");
  }
  const promotions = data.auto_apply_promotions ?? [];
  if (!Array.isArray(promotions)) throw new Error("Neburst public promotions schema changed");
  const regions = new Map();
  for (const region of data.regions) {
    if (!text(region.code) || !text(region.display)) throw new Error("Neburst region identity missing");
    if (region.shape_ids !== undefined && !Array.isArray(region.shape_ids)) throw new Error("Neburst region shape membership schema changed");
    regions.set(region.code, region);
  }
  const records = [];
  for (const [shapeId, shape] of Object.entries(data.shapes)) {
    if (!isObject(shape) || String(shape.id) !== shapeId || !text(shape.display_name || shape.name)) throw new Error("Neburst shape identity missing");
    const configurable = ["cpu", "memory", "disk", "bandwidth", "network_speed"].some((key) => {
      const spec = shape[key];
      return isObject(spec) && ["min", "max"].some((bound) => spec[bound] != null && Number.isFinite(Number(spec[bound])) && Number(spec[bound]) !== Number(spec.default));
    });
    const memberships = [];
    const signals = [];
    for (const region of regions.values()) {
      const key = `${region.code}:${shapeId}`;
      const available = data.availability[key];
      if (available !== undefined && typeof available !== "boolean") throw new Error("Neburst availability schema changed");
      if (available !== undefined) signals.push({ region: region.code, available });
      // A false cell in the full region x shape matrix does not establish that
      // this particular region ever offers the shape. Retain declared members
      // and true cells; never turn incompatible combinations into sold-out SKUs.
      if (available === true || region.shape_ids?.includes(shapeId)) memberships.push({ region, available });
    }
    if (!memberships.length) memberships.push({ region: null, available: undefined });
    const listedPrices = data.prices[shapeId];
    if (listedPrices !== undefined && !Array.isArray(listedPrices)) throw new Error("Neburst shape prices schema changed");
    const prices = listedPrices?.length ? listedPrices : [null];
    for (const membership of memberships) for (const price of prices) {
      const cycle = price?.pay_cycle ?? null;
      const currency = price?.currency ?? null;
      if (price && (!text(cycle) || !knownCurrency(currency))) throw new Error("Neburst billing cycle or currency missing");
      const originalCents = price ? priceInCents(price) : null;
      const discounted = price ? neburstPromotion(originalCents, shapeId, cycle, promotions) : { cents: null, promotion: null };
      const amount = discounted.cents === null ? null : discounted.cents / 100;
      const region = membership.region;
      const availability = region?.available === false ? false : membership.available;
      // These booleans describe public offering availability, never unit counts.
      const status = availability === false ? "unavailable" : availability === true && price ? "available" : "unknown";
      const memory = shapeSpec(shape.memory, "GB"), disk = shapeSpec(shape.disk, "GB");
      const hardware = [shapeSpec(shape.cpu, "vCPU"), memory && `${memory} RAM`, disk && `${disk} storage`].filter(Boolean).join(" / ");
      const bandwidth = [shapeSpec(shape.bandwidth, "GB"), shapeSpec(shape.network_speed, "Mbps")].filter(Boolean).join(" / ");
      const features = Object.fromEntries(Object.entries({ CPU: shapeSpec(shape.cpu, "vCPU"), RAM: memory, Storage: disk, "Network speed": shapeSpec(shape.network_speed, "Mbps"), Traffic: shapeSpec(shape.bandwidth, "GB") }).filter(([, value]) => value));
      const priceText = quote(currency, amount, cycles[cycle] || cycle);
      records.push(baseRecord(source, result, {
        id: `${source.id}:plan:${region?.code || "unmapped"}:${shapeId}:${cycle || "unpriced"}`,
        name: text(shape.display_name || shape.name), category: "vps",
        region: region ? countries[region.code] || null : null, route: null,
        hardware: hardware || null, bandwidth: bandwidth || null,
        price: priceText && configurable ? `${priceText}起（默认配置）` : priceText, priceValue: amount, currency,
        status, statusLabel: status === "available" ? "官方标注可用" : status === "unavailable" ? "官方标注不可用" : "库存未确认",
        stockCount: null, orderUrl: source.website || "https://neburst.com/pricing/cloud/",
        note: discounted.promotion ? "官方公开目录；已应用匹配地区套餐和周期的自动优惠，最终订单以官网为准。" : "官方公开目录；可用标记不代表具体剩余数量。",
        evidence: `Official public pricing API; region=${region?.code || "not mapped"}; available=${availability ?? "not established"}; stock count not disclosed`,
        raw: {
          shapeId, regionCode: region?.code || null, city: region?.display || null, group: shape.group || null,
          features, configurable, basePrice: configurable,
          billingCycle: cycle, originalPrice: originalCents === null ? null : originalCents / 100,
          priceCents: discounted.cents, originalPriceCents: originalCents,
          promotion: discounted.promotion ? { code: discounted.promotion.code, type: discounted.promotion.discount_type, value: discounted.promotion.discount_value } : null,
          availability: availability ?? null, unmappedAvailability: region ? null : signals,
          capacityType: price?.capacity_type || null, lastUpdated: data.last_updated || null, cacheTtl: payload.cache_ttl ?? null
        }
      }));
    }
  }
  return records;
}

function parseSkyline(source, result, payload, { baseRecord }) {
  if (payload.code !== 200 || !Array.isArray(payload.data)) throw new Error("Skyline public product schema changed");
  const currency = source.currency || "USD";
  if (!knownCurrency(currency)) throw new Error("Skyline currency missing");
  const records = [];
  for (const group of payload.data) {
    if (String(group.groupId) !== "0") continue;
    if (!text(group.packageId) || !text(group.packageName) || !Array.isArray(group.shopList)) throw new Error("Skyline package identity missing");
    for (const shop of group.shopList) {
      if (String(shop.groupId) !== "0") continue;
      const price = Number(shop.price), period = Number(shop.period);
      if (!text(shop.shopid) || !Number.isFinite(price) || price <= 0 || !Number.isFinite(period) || period <= 0) throw new Error("Skyline billing SKU schema changed");
      const cycle = ({ 720: "月", 2160: "季", 4320: "半年", 8760: "年" })[period] || `${period}小时`;
      const configurable = group.allowAddon === 1 || group.allowAddon === true;
      records.push(baseRecord(source, result, {
        id: `${source.id}:plan:${group.packageId}:${shop.shopid}`, name: group.packageName, category: "vps",
        region: /日本/.test(group.packageName) ? "日本" : /新加坡/.test(group.packageName) ? "新加坡" : null,
        route: null,
        hardware: [shop.cpu != null && `${shop.cpu} vCPU`, shop.memory != null && `${shop.memory} GB RAM`, shop.storage != null && `${shop.storage} GB storage`].filter(Boolean).join(" / ") || null,
        bandwidth: [shop.bandwidthLimit != null && `${shop.bandwidthLimit} Mbps`, shop.trafficLimit != null && `${shop.trafficLimit} GB`, shop.ipv4Count != null && `${shop.ipv4Count} IPv4`].filter(Boolean).join(" / ") || null,
        price: `${quote(currency, price, cycle)}${configurable ? "起（基础配置）" : ""}`, priceValue: price, currency,
        // The public UI does not establish whether stocks is a cap, remaining
        // inventory, or a sentinel. Neither stocks nor stocks-stocksSold is a
        // verified remaining count; enable=1 also does not establish capacity.
        status: "unknown", statusLabel: "库存未确认", stockCount: null,
        orderUrl: source.website || "https://www.skylineconnect.io/products",
        note: "官方公开基础套餐价格；库存字段含义尚未确认，附加配置另计。",
        evidence: `Official public product API; enable=${shop.enable ?? "not stated"}; stocks=${shop.stocks ?? "not stated"}; stocksSold=${shop.stocksSold ?? "not stated"}; remaining inventory not established`,
        raw: {
          packageId: group.packageId, shopId: shop.shopid, hypervisorId: group.hypervisorId,
          billingCycle: shop.name || null, billingPeriodHours: period,
          originalPrice: shop.originalPrice ?? null, discountPercent: shop.discount ?? null,
          // price is already discounted in the API; do not discount it again.
          allowAddon: group.allowAddon, configurable, basePrice: configurable, description: group.packageDescription || null,
          enable: shop.enable ?? null, stocks: shop.stocks ?? null, stocksSold: shop.stocksSold ?? null,
          saleBeginTime: shop.saleBeginTime ?? null, saleCloseTime: shop.saleCloseTime ?? null
        }
      }));
    }
  }
  return records;
}

export function buildSkylinePublicCatalogRequest(publicClientScript, { now = Date.now(), nonce, platform = "mac" } = {}) {
  if (!["mac", "windows", "android"].includes(platform)) throw new Error("Unsupported published Skyline platform key");
  // Read the current public SPKI encryption key from the advertised client
  // bundle. No private keys, auth cookies, or recorded signature are used.
  const pattern = new RegExp(`\\[[\\w$]+\\.${platform.toUpperCase()}\\]:["']([A-Za-z0-9+/=]+)["']`);
  const encodedKey = publicClientScript.match(pattern)?.[1];
  if (!encodedKey) throw new Error("Skyline published public encryption key missing");
  const publicKey = createPublicKey({ key: Buffer.from(encodedKey, "base64"), format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "rsa") throw new Error("Skyline public encryption key is not RSA");
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("Invalid Skyline public request timestamp");
  const alphabet = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
  const freshNonce = nonce ?? [...randomBytes(8)].map((value) => alphabet[value & 63]).join("");
  if (typeof freshNonce !== "string" || freshNonce.length !== 8) throw new Error("Invalid Skyline public request nonce");
  const plaintext = JSON.stringify({ nonce: freshNonce, timestamp: String(now), group_id: "0" });
  const signature = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(plaintext)).toString("base64");
  return {
    url: "https://api.skylineconnect.io/v1/api/payment/payment_product_list",
    method: "POST", headers: { "Content-Type": "application/json", platform, language: "zh" },
    body: JSON.stringify({ signature })
  };
}

export const NEBURST_PUBLIC_CATALOG_URL = "https://neburst.com/api/v1/public/pricing/cloud?include_unpriced=true";

// Reproduce the published client's random fallback when browser fingerprinting
// is unavailable. Each anonymous read creates its own non-auth identifier;
// no browser cookie or session identifier is imported or retained.
export function buildNeburstPublicCatalogRequest({ userAgent, now = Date.now(), deviceId = randomBytes(16).toString("hex") } = {}) {
  if (typeof userAgent !== "string" || !userAgent.trim() || /[\r\n]/.test(userAgent)) throw new Error("Neburst requires the actual transport user-agent");
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("Invalid Neburst request timestamp");
  if (typeof deviceId !== "string" || !/^[0-9a-f]{32}$/.test(deviceId)) throw new Error("Invalid Neburst anonymous device identifier");
  const url = NEBURST_PUBLIC_CATALOG_URL;
  const timestamp = String(now);
  // Published generateRequestId: MD5(path + method + time + body + UA + auth).
  // Anonymous public GET has an empty body/auth; query parameters are excluded.
  const requestId = createHash("md5").update(new URL(url).pathname + "GET" + timestamp + userAgent).digest("hex");
  return {
    url, method: "GET",
    headers: {
      "user-agent": userAgent, "content-type": "application/json",
      "neburst-request-language": "en-us", "neburst-request-time": timestamp,
      "neburst-request-id": requestId, "neburst-device-fp": deviceId,
      cookie: `nb_dfp=${deviceId}`
    }
  };
}
