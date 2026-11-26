import { parse } from "node-html-parser";

const cycles = { monthly: "月", quarterly: "季", semiannually: "半年", annually: "年", biennially: "两年", triennially: "三年" };
const clean = (value) => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;
const schemaError = (reason) => new Error(`666Clouds public SKU catalog schema changed: ${reason}`);

function publicGroups(html) {
  // Decode JSON string chunks only. Flight scripts are data, never executable code.
  const chunks = [];
  for (const script of parse(html).querySelectorAll("script")) {
    for (const match of script.text.matchAll(/self\.__next_f\.push\(\s*(\[1\s*,\s*"(?:\\.|[^"\\])*"\s*\])\s*\)/g)) {
      chunks.push(JSON.parse(match[1])[1]);
    }
  }
  const groups = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value) && Object.hasOwn(value, "groups")) groups.push(value.groups);
    for (const child of Object.values(value)) visit(child);
  };
  for (const line of chunks.join("").split("\n")) {
    const match = line.match(/^[a-f0-9]+:([\[{].*)$/i);
    if (match) visit(JSON.parse(match[1]));
  }
  if (groups.length !== 1 || !Array.isArray(groups[0]) || !groups[0].length) throw schemaError("public groups missing or ambiguous");
  return groups[0];
}

function publishedRegion(group, product) {
  const names = ["美国", "菲律宾", "韩国", "香港", "德国", "英国", "日本"];
  const groupMatches = names.filter((name) => group.includes(name));
  const matches = groupMatches.length ? groupMatches : names.filter((name) => product.includes(name));
  return matches.length === 1 ? matches[0] : null;
}

export function parseSixCloudsCatalog(source, result, { baseRecord }) {
  const page = new URL(result.finalUrl || source.url);
  if (!["666clouds.com", "www.666clouds.com"].includes(page.hostname) || !/^\/shop\/?$/.test(page.pathname)) throw schemaError("unsupported official catalog URL");
  const records = [];
  const ids = new Set();
  for (const group of publicGroups(result.html)) {
    if (!positiveId(group.id) || !clean(group.name) || !Array.isArray(group.products)) throw schemaError("invalid group");
    for (const product of group.products) {
      if (product.hidden === true || product.retired === true) continue;
      const options = product.planOptions;
      if (!positiveId(product.id) || !clean(product.name) || product.nativePlans !== true || !positiveId(options?.revision) || !Array.isArray(options.plans) || !options.plans.length) throw schemaError("native SKU options missing");
      for (const plan of options.plans) {
        if (plan.enabled === false) continue;
        if (!positiveId(plan.subId) || !clean(plan.name) || !Number.isSafeInteger(plan.stock) || plan.stock < -1 || !plan.prices || typeof plan.prices !== "object") throw schemaError("invalid SKU identity or inventory");
        for (const key of ["cpu", "memMb", "sysDiskGb", "bwMbps", "flowGb"]) {
          if (!Number.isFinite(plan[key]) || plan[key] <= 0) throw schemaError(`invalid ${key}`);
        }
        const prices = {};
        for (const cycle of Object.keys(cycles)) {
          const value = plan.prices[cycle];
          if (value == null) continue;
          if (typeof value !== "string" || !/^-?\d+(?:\.\d{1,2})?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) < -1) throw schemaError("invalid SKU price");
          // -1 is an explicitly disabled billing cycle, not a discounted price.
          if (Number(value) >= 0) prices[cycle] = Number(value);
        }
        const cycle = Object.keys(prices)[0];
        if (!cycle) throw schemaError("SKU has no published billing cycle");
        const id = `${source.id}:sku:${product.id}:${plan.subId}`;
        if (ids.has(id)) throw schemaError("duplicate SKU");
        ids.add(id);
        const order = new URL(`/shop/${product.id}`, page);
        order.searchParams.set("planSubId", String(plan.subId));
        order.searchParams.set("selectionRevision", String(options.revision));
        order.searchParams.set("cycle", cycle);
        const available = plan.stock !== 0;
        records.push(baseRecord(source, result, {
          id, name: `${clean(product.name)} · ${clean(plan.name)}`,
          category: /家宽|家寬|住宅|双\s*ISP/i.test(product.name) ? "home" : "vps",
          region: publishedRegion(group.name, product.name),
          route: [...new Set(product.name.match(/CN2\s*GIA|CMIN2|9929|4837|NTT|GTT|AT&T|软银/gi) || [])].join(" / ") || null,
          hardware: `${plan.cpu} vCPU / ${plan.memMb} MB RAM / ${plan.sysDiskGb} GB Disk`,
          bandwidth: `${plan.bwMbps} Mbps / ${plan.flowGb} GB Traffic`,
          currency: "CNY", price: `CNY ${prices[cycle].toFixed(2)}/${cycles[cycle]}`, priceValue: prices[cycle],
          status: available ? "available" : "unavailable",
          statusLabel: !available ? "缺货" : plan.stock === -1 ? "官方标注库存不限" : `库存 ${plan.stock}`,
          stockCount: plan.stock === -1 ? null : plan.stock, orderUrl: order.href,
          evidence: `官方公开 SKU 数据：productId=${product.id}，planSubId=${plan.subId}，stock=${plan.stock}；-1 表示库存不限。`,
          raw: { productId: product.id, planSubId: plan.subId, selectionRevision: options.revision, groupId: group.id, billingCycle: cycle, prices, stock: plan.stock }
        }));
      }
    }
  }
  if (!records.length) throw schemaError("no published SKUs");
  return records;
}
