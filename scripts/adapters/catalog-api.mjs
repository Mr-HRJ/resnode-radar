import { parse } from "node-html-parser";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const regionNames = { "cn-hkg": "香港", "jp-tyo": "日本", "us-lax": "美国", "sg-sin": "新加坡", "sg-sgp": "新加坡" };
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

const jdidcCycleLabels = {
  monthly: "月",
  quarterly: "季",
  semiannually: "半年",
  annually: "年",
  biennially: "两年",
  triennially: "三年",
  onetime: "一次性"
};

function jdidcRegion(text) {
  const choices = [
    ["香港", /香港|HKG/i],
    ["台湾", /台湾|台灣|台北/i],
    ["日本", /日本|东京|大阪/i],
    ["新加坡", /新加坡/i],
    ["韩国", /韩国|首尔/i],
    ["美国", /美国|洛杉矶|圣何塞|芝加哥|纽约|西雅图|达拉斯|硅谷/i],
    ["英国", /英国|伦敦/i],
    ["德国", /德国|法兰克福/i],
    ["荷兰", /荷兰|阿姆斯特丹/i],
    ["法国", /法国|巴黎/i],
    ["澳大利亚", /澳洲|澳大利亚|悉尼/i],
    ["加拿大", /加拿大|多伦多/i],
    ["越南", /越南/i],
    ["泰国", /泰国/i],
    ["马来西亚", /马来/i],
    ["中国内地", /大陆|宁波|十堰|西安|内蒙|德阳|成都|广州|深圳|上海|北京|浙江|江苏|湖北|宿迁|枣庄|镇江|泉州|福州|厦门|佛山|重庆|四川|辽宁|青岛/]
  ];
  return choices.find(([, re]) => re.test(text))?.[0] || null;
}

export function parseJdidcApi(source, result, { baseRecord }) {
  const payload = JSON.parse(result.html);
  const fgs = payload?.data?.fgs;
  if (!Array.isArray(fgs)) throw new Error("JDIDC public product API schema changed: fgs missing");
  const baseOrigin = new URL(source.website || source.url).origin;
  const records = [];
  for (const fg of fgs) {
    const fgName = clean(fg?.name);
    if (/物理机|面板服|SCDN|实名认证|云电脑/i.test(fgName)) continue;
    for (const group of Array.isArray(fg?.group) ? fg.group : []) {
      const groupName = clean(group?.name);
      if (/物理机|面板服|CDN|实名认证|云电脑/i.test(groupName)) continue;
      for (const item of Array.isArray(group?.products) ? group.products : []) {
        if (!["dcimcloud", "cloud"].includes(item?.type)) continue;
        if (!item?.id || !clean(item?.name)) continue;
        const amount = Number(item.product_price);
        if (!Number.isFinite(amount) || amount <= 0) continue;
        const cycleKey = String(item.billingcycle || "").toLowerCase();
        const cycleLabel = clean(item.billingcycle_zh) || jdidcCycleLabels[cycleKey] || "";
        const controlled = Number(item.stock_control) === 1;
        const qty = ["number", "string"].includes(typeof item.qty) && String(item.qty).trim() ? Number(item.qty) : NaN;
        let status = "available";
        let stockCount = null;
        if (controlled) {
          status = "unknown";
          if (Number.isSafeInteger(qty) && qty <= 0) {
            status = "unavailable";
            stockCount = 0;
          } else if (Number.isSafeInteger(qty)) {
            status = "available";
            stockCount = qty;
          }
        }
        const descLines = parse(String(item.description || "")).structuredText.split(/\r?\n/).map(clean).filter(Boolean);
        const features = {};
        for (const line of descLines) {
          const m = line.match(/^([^:：]{1,12})[:：]\s*(.+)$/);
          if (m) features[clean(m[1])] = clean(m[2]);
        }
        const hardware = [
          features.CPU || features["核心"],
          features["内存"],
          features["硬盘"] || features["系统盘"]
        ].filter(Boolean).join(" / ") || descLines.filter((l) => /CPU|核心|内存|硬盘|SSD|NVMe/i.test(l)).slice(0, 3).join(" / ") || null;
        const bandwidth = [
          features["带宽"],
          features["流量"]
        ].filter(Boolean).join(" / ") || descLines.filter((l) => /带宽|流量|Mbps|Gbps/i.test(l)).slice(0, 2).join(" / ") || null;
        const blob = `${fgName} ${groupName} ${item.name} ${descLines.join(" ")}`;
        const routes = [...new Set(blob.match(/CN2\s*GIA|CN2\s*GT|CN2|CMIN2|9929|4837|BGP|IIJ|HiNet/gi) || [])].join(" / ");
        const route = features["路线"] || features["线路"] || routes || null;
        const isHome = /双\s*ISP|家宽|住宅/i.test(blob);
        const orderUrl = `${baseOrigin}/user/product-config.php?id=${encodeURIComponent(item.id)}`;
        records.push(baseRecord(source, result, {
          id: `${source.id}:plan:${item.id}`,
          sourceUrl: source.url,
          name: clean(item.name),
          category: isHome ? "home" : "vps",
          region: jdidcRegion(item.name) || jdidcRegion(groupName) || jdidcRegion(fgName) || jdidcRegion(descLines.join(" ")),
          route,
          hardware,
          bandwidth,
          price: `CNY ${amount}${cycleLabel ? `/${cycleLabel}` : ""}`,
          priceValue: amount,
          currency: "CNY",
          status,
          statusLabel: status === "unknown" ? "库存待核验" : status === "unavailable" ? "不可订购" : stockCount !== null ? `库存 ${stockCount}` : "可订购入口",
          stockCount,
          orderUrl,
          note: `${fgName}${groupName && groupName !== fgName ? ` · ${groupName}` : ""}`,
          evidence: `Official JDIDC public API; id=${item.id}; stock_control=${controlled ? 1 : 0}; qty=${Number.isFinite(qty) ? qty : "unstated"}`,
          raw: {
            productId: item.id,
            groupId: item.gid ?? group?.id ?? null,
            groupName,
            firstGroupName: fgName,
            billingCycle: cycleLabel || cycleKey || null,
            features
          }
        }));
      }
    }
  }
  return [...new Map(records.map((r) => [r.id, r])).values()];
}
