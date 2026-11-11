import { state } from "./state.js";
import { providerFor } from "./directory.js";
import { icon } from "./icons.js";
import { productSpecs, regionFlag, providerInitial } from "./discovery.js";
import { priceQuote, monthlyCny } from "./pricing.js";
import { categoryNames, productCategory, statusLabels, statusClass, numericStockCount } from "./product.js";
import { escapeHtml as html, text, safeUrl, formatDateTime } from "./util.js";

export const productHref = (product) => safeUrl(product.orderUrl || product.sourceUrl || product.finalUrl);
const providerName = (product) => providerFor(product)?.name || product.provider;
const display = (value, fallback = "未标明") => value != null && !["", "-", "—"].includes(String(value).trim()) ? String(value) : fallback;
const keyAttr = (product) => html(product._stableKey);
const flag = (region) => regionFlag(region) === "🇹🇼" ? '<span class="region-code">TW</span>' : regionFlag(region);

export function priceHtml(product) {
  const quote = priceQuote(product);
  if (quote.amount === null) return `<span class="spec-empty">${html(display(product.price, "价格未公开"))}</span>`;
  const symbols = { USD: "$", CNY: "¥", EUR: "€", GBP: "£", JPY: "JP¥", HKD: "HK$", TWD: "NT$", CAD: "CA$", AUD: "A$" };
  const amount = quote.amount.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(quote.amount) ? 0 : 2, maximumFractionDigits: 2 });
  const cny = monthlyCny(product, state.payload?.exchangeRates);
  const equivalent = cny !== null && quote.currency !== "CNY" ? `约 ¥${cny.toFixed(2)} / 月` : quote.monthly !== null && quote.months > 1 ? `折合 ${quote.currency || ""} ${quote.monthly.toFixed(2)} / 月` : "";
  return `<strong title="${html(display(product.price))}"><small>${html(symbols[quote.currency] || quote.currency || "币种待核对")}</small>${amount}</strong><span class="price-cycle">${quote.period.startsWith("周期") ? html(quote.period) : `/ ${html(quote.period)}`}${quote.baseOnly ? "起" : ""}</span>${equivalent ? `<span class="price-equivalent">${html(equivalent)}</span>` : ""}`;
}

function statusHtml(product) {
  return `<span class="chip chip-status ${statusClass(product.status)}">${icon(product.status === "available" ? "check" : product.status === "unavailable" ? "minus" : "info")}${html(text(product.statusLabel, statusLabels[product.status]))}</span>`;
}
function evidenceHtml(product) {
  return `<span class="chip chip-evidence ${html(product._evidenceBadge.className)}">${html(product._evidenceBadge.label)}</span>`;
}
function riskTags(product) {
  return (Array.isArray(product.riskTags) ? product.riskTags : []).filter((tag) => tag?.label).map((tag) => `<span class="chip chip-risk ${tag.severity === "high" ? "is-high" : ""}">${html(tag.label)}</span>`).join("");
}
function identityHtml(product) {
  const name = providerName(product);
  return `<div class="product-identity"><span class="provider-avatar" aria-hidden="true">${html(providerInitial(name))}</span><div><a class="prov" href="${html(productHref(product))}" target="_blank" rel="nofollow noopener">${html(name)}</a><span class="prov-sub">${html(text(product.name))}</span></div></div>`;
}
function saveButton(product) {
  const saved = state.saved.has(product._stableKey);
  return `<button type="button" class="save-button ${saved ? "is-saved" : ""}" data-save="${keyAttr(product)}" aria-pressed="${saved}" aria-label="${saved ? "取消收藏" : "收藏"} ${html(text(product.name))}" title="${saved ? "取消收藏" : "收藏套餐"}">${icon("bookmark")}</button>`;
}
function selectInput(product) {
  return `<input type="checkbox" data-select="${keyAttr(product)}" ${state.selected.has(product._stableKey) ? "checked" : ""} aria-label="选择 ${html(providerName(product))} ${html(text(product.name))} 对比" />`;
}
function buyLink(product) {
  const available = product.status === "available" && product.orderUrl;
  return `<a class="buy-link ${available ? "" : "is-soft"}" href="${html(productHref(product))}" target="_blank" rel="nofollow noopener">${available ? "前往官网" : "查看官网"}${icon("arrow-up-right")}</a>`;
}
function detailButton(product, mobile = false) {
  const open = state.expanded.has(product._stableKey);
  return `<button type="button" class="detail-button" data-detail="${keyAttr(product)}" data-detail-location="${mobile ? "mobile" : "table"}" aria-expanded="${open}">${open ? "收起详情" : "详情与来源"}${icon("chevron-down")}</button>`;
}
function specsLine(product) {
  const specs = productSpecs(product);
  const hardware = [specs.cpu, specs.memory, specs.disk].filter((value) => value !== "未标明");
  const network = [specs.bandwidth, specs.traffic].filter((value) => value !== "未标明");
  return `<span class="spec-primary" title="${html(display(product.hardware))}">${html(hardware.join(" / ") || display(product.hardware, "硬件规格未公开"))}</span><span class="spec-network" title="${html(display(product.bandwidth))}">${html(network.join(" · ") || display(product.bandwidth, "带宽 / 流量未公开"))}</span>${product.route ? `<span class="route-line">${html(product.route)}</span>` : ""}`;
}

export function detailHtml(product) {
  const stock = numericStockCount(product);
  const values = [
    ["产品", product.name], ["厂商", product.provider], ["产品类别", categoryNames[productCategory(product)]],
    ["地区 / 线路", [product.region, product.route].filter(Boolean).join(" · ")], ["IP 特征（商家描述）", product._ipType.label],
    ["原始硬件配置", product.hardware], ["原始流量 / 带宽", product.bandwidth], ["原始报价", product.price],
    ["库存数量", stock === null ? "未公开" : String(stock)], ["状态", product.statusLabel || statusLabels[product.status]],
    ["采集时间", formatDateTime(product.fetchedAt)], ["证据口径", product._evidenceBadge.label]
  ];
  return `<dl class="detail-grid">${values.map(([label, value]) => `<div><dt>${html(label)}</dt><dd>${html(display(value))}</dd></div>`).join("")}<div><dt>购买前核对</dt><dd class="detail-risk-tags">${riskTags(product) || "以官网说明为准"}</dd></div><div><dt>公开来源</dt><dd><a href="${html(safeUrl(product.sourceUrl || product.finalUrl))}" target="_blank" rel="nofollow noopener">${html(text(product.sourceUrl || product.finalUrl))}</a></dd></div></dl>${product.note ? `<p class="detail-evidence">${html(product.note)}</p>` : ""}<p class="detail-evidence">${html(text(product.evidence))}</p>`;
}

export function tableRowHtml(product) {
  const open = state.expanded.has(product._stableKey);
  return `<tr data-key="${keyAttr(product)}" class="${open ? "is-open" : ""} ${state.selected.has(product._stableKey) ? "is-selected" : ""}">
    <td class="cell-check">${selectInput(product)}</td>
    <td class="cell-product">${identityHtml(product)}</td>
    <td class="cell-region"><span class="region-name"><span class="region-flag" aria-hidden="true">${flag(product.region)}</span>${html(display(product.region, "地区未注明"))}</span><span class="chip chip-ip">${html(product._ipType.label)}</span></td>
    <td class="cell-spec">${specsLine(product)}</td>
    <td class="cell-price">${priceHtml(product)}</td>
    <td class="cell-status">${statusHtml(product)}${evidenceHtml(product)}</td>
    <td><div class="row-actions">${buyLink(product)}${saveButton(product)}</div>${detailButton(product)}</td>
  </tr>${open ? `<tr class="row-detail"><td colspan="7">${detailHtml(product)}</td></tr>` : ""}`;
}

export function cardHtml(product) {
  const specs = productSpecs(product);
  return `<article class="mobile-product-card"><div class="mobile-card-head"><span class="provider-avatar" aria-hidden="true">${html(providerInitial(providerName(product)))}</span><a class="prov" href="${html(productHref(product))}" target="_blank" rel="nofollow noopener">${html(providerName(product))}</a>${saveButton(product)}</div>
    <h3>${html(text(product.name))}</h3><div class="mobile-card-tags"><span><span class="region-flag" aria-hidden="true">${flag(product.region)}</span>${html(display(product.region, "地区未注明"))}</span>${statusHtml(product)}</div>
    <div class="card-spec-grid"><div><span>CPU</span><strong>${html(specs.cpu)}</strong></div><div><span>内存</span><strong>${html(specs.memory)}</strong></div><div><span>存储</span><strong>${html(specs.disk)}</strong></div></div>
    <div class="mobile-card-network">${html([specs.bandwidth, specs.traffic].filter((value) => value !== "未标明").join(" · ") || display(product.bandwidth, "带宽 / 流量未公开"))}<span class="route-line">${html(product.route || categoryNames[productCategory(product)])} · ${html(product._ipType.label)}</span></div>
    <div class="mobile-card-footer"><div class="cell-price">${priceHtml(product)}</div>${buyLink(product)}</div>
    <div class="mobile-card-bottom"><label>${selectInput(product)}加入对比</label>${detailButton(product, true)}</div>
    ${state.expanded.has(product._stableKey) ? `<div class="card-detail">${detailHtml(product)}</div>` : ""}
  </article>`;
}

export function compareHtml(products) {
  const fields = [
    ["地区", (p) => display(p.region)], ["产品类别", (p) => categoryNames[productCategory(p)]], ["IP 特征", (p) => p._ipType.label],
    ["网络线路", (p) => display(p.route)], ["硬件配置", (p) => display(p.hardware)], ["流量 / 带宽", (p) => display(p.bandwidth)],
    ["原始账单", (p) => display(p.price)], ["库存状态", (p) => p.statusLabel || statusLabels[p.status]],
    ["库存依据", (p) => p._evidenceBadge.label], ["采集时间", (p) => formatDateTime(p.fetchedAt)]
  ];
  return `<table class="compare-table" style="min-width:${Math.max(600, products.length * 220 + 100)}px"><caption class="sr-only">所选 VPS 参数对比，浅色行表示数值或文字有差异</caption><thead><tr><th scope="col">方案</th>${products.map((p) => `<th scope="col">${html(providerName(p))}<p>${html(text(p.name))}</p><span class="cell-price">${priceHtml(p)}</span></th>`).join("")}</tr></thead><tbody>${fields.map(([label, getter]) => {
    const values = products.map(getter);
    return `<tr class="${new Set(values).size > 1 ? "is-different" : ""}"><th scope="row">${html(label)}</th>${values.map((value) => `<td>${html(value)}</td>`).join("")}</tr>`;
  }).join("")}<tr><th scope="row">购买前核对</th>${products.map((p) => `<td><div class="detail-risk-tags">${riskTags(p) || "以官网为准"}</div></td>`).join("")}</tr><tr><th scope="row">官网</th>${products.map((p) => `<td>${buyLink(p)}</td>`).join("")}</tr></tbody></table><p class="compare-note">浅色行表示字段有差异。币种与账单周期可能不同，参考月价不代表可以月付。完整来源请查看套餐详情。</p>`;
}
