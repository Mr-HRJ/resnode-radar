import { parse } from "node-html-parser";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const regionNames = { "cn-hkg": "香港", "jp-tyo": "日本", "us-lax": "美国", "sg-sin": "新加坡" };
function stockStatus(available, count) {
  if (available === false || count === 0) return "unavailable";
  if (available === true || count > 0) return "available";
  return "unknown";
}
export function parseCatalogApi(source, result, { baseRecord }) {
  const data = JSON.parse(result.html);
  const list = source.catalogFormat === "miraigrid" ? data.data?.products : data.data?.list;
  if (!Array.isArray(list)) throw new Error("Public product API schema changed: product list missing");
  const records = [];
  for (const item of list) {
    if (source.catalogFormat === "100tb" && (item.service_type !== "compute" || item.is_active !== true || item.is_hidden === true)) continue;
    if (!item.id || !item.name) throw new Error("Public product API schema changed: product identity missing");
    const count = Number.isInteger(item.stock) && item.stock >= 0 ? item.stock : null;
    const status = stockStatus(item.available, count);
    const specs = item.specs ?? {};
    const detail = parse(item.description_zh_cn || item.description || "").structuredText.split("\n").map(clean).filter(Boolean);
    const hardware = source.catalogFormat === "100tb"
      ? [specs.cpu && `${specs.cpu} vCPU`, specs.memory && `${specs.memory} MB RAM`, specs.disk && `${specs.disk} GB`].filter(Boolean).join(" / ")
      : detail.filter((s) => /CPU|RAM|内存|SSD|NVMe|Storage/i.test(s)).join(" / ");
    const bandwidth = source.catalogFormat === "100tb"
      ? [specs.bandwidth && `${specs.bandwidth} Mbps`, specs.traffic && `${specs.traffic} GB`, specs.ip_count && `${specs.ip_count} IPv4`].filter(Boolean).join(" / ")
      : detail.filter((s) => /带宽|流量|Traffic|Bandwidth|IPv[46]/i.test(s)).slice(0,4).join(" / ");
    const plans = source.catalogFormat === "miraigrid" ? item.plans : [{ id: "default", price: { amount: item.price, currency_code: item.currency }, name: item.billing_cycle }];
    if (!Array.isArray(plans)) throw new Error("Public product API plan prices missing");
    for (const plan of plans) {
      const amount = Number(plan.price?.amount);
      const currency = plan.price?.currency_code;
      if (!Number.isFinite(amount) || amount <= 0 || !/^[A-Z]{3}$/.test(currency)) throw new Error("Public product API price schema changed");
      const configurable = specs.product_type === "diy";
      const base = source.website || source.url;
      const name = item.name_zh_cn || item.name;
      records.push(baseRecord(source, result, {
        id: `${source.id}:plan:${item.id}:${plan.id}`, name,
        category: /住宅|家宽|residential/i.test(`${name} ${item.category?.name}`) ? "home" : "vps",
        region: source.catalogFormat === "miraigrid" ? "日本" : item.regions?.map((r) => regionNames[r] || r).join(" / ") || null,
        route: source.catalogFormat === "miraigrid" ? "SoftBank 住宅网络" : null,
        hardware: hardware || null, bandwidth: bandwidth || null,
        price: `${currency} ${amount}/${plan.name}${configurable ? "起（基础价）" : ""}`, priceValue: amount, currency,
        status, statusLabel: status === "available" ? (count === null ? "官方标注可用" : `库存 ${count}`) : status === "unavailable" ? "不可订购" : "库存未公开",
        stockCount: count, orderUrl: base,
        note: configurable ? "可配置套餐，所列为基础价；默认资源及附加项以官网结算为准。" : "官方公开产品接口；计费周期分别列出。",
        evidence: `Official public product API; stock=${count ?? "not stated"}; available=${item.available ?? "not stated"}`,
        raw: { productId: item.id, planId: plan.id, billingPeriod: plan.billing_period, billingUnit: plan.billing_unit, configurable }
      }));
    }
  }
  return records;
}

export function parseNodeMach(source, result, { baseRecord }) {
  const root = parse(result.html);
  const script = root.querySelector('script[data-page="app"][type="application/json"]');
  if (!script) throw new Error("NodeMach public product payload missing");
  const list = JSON.parse(script.text).props?.data?.data;
  if (!Array.isArray(list)) throw new Error("NodeMach public product list missing");
  return list.filter((p) => ["instance", "premium"].includes(p.type)).map((p) => {
    if (!p.name || typeof p.in_stock !== "boolean" || typeof p.payable !== "boolean" || !Number.isFinite(p.display)) throw new Error("NodeMach product schema changed");
    const spec = Object.fromEntries((p.description ?? []).map((s) => [s.key, s.value]));
    const status = p.in_stock && p.payable ? "available" : "unavailable";
    return baseRecord(source, result, {
      id: `${source.id}:plan:${p.id}`, name: p.name, category: p.type === "premium" ? "vps" : "unclassified",
      region: "美国", route: p.type === "premium" ? "CN2 GIA" : null,
      hardware: [spec.CPU, spec["内存"], spec["硬盘"]].filter(Boolean).join(" / "),
      bandwidth: [spec["带宽"], spec["流量"], spec.IP].filter(Boolean).join(" / "),
      price: `USD ${p.display}/月起`, priceValue: p.display, currency: "USD",
      status, statusLabel: status === "available" ? "官方标注可用" : "不可订购", stockCount: null,
      orderUrl: source.url, note: "原 VIRCS 已迁移至 NodeMach；页面为起步配置，最终价格以选配为准。",
      evidence: `Official NodeMach products; in_stock=${p.in_stock}; payable=${p.payable}`,
      raw: { productId: p.id, type: p.type }
    });
  });
}
