import { providers } from "./providers.js";
import { escapeHtml, safeUrl, normalizeSearch, formatDateTime } from "./util.js";

export function providerFor(product) {
  return providers.find((p) => p.id === product.providerId || p.inventoryNames.includes(product.provider));
}
export function providerHealth(provider, records, loaded = true) {
  const own = records.filter((r) => r.providerId === provider.id || provider.inventoryNames.includes(r.provider));
  const plans = own.filter((r) => !r.diagnostic && !["error", "blocked"].includes(r.status));
  const issues = own.filter((r) => r.diagnostic || ["error", "blocked"].includes(r.status));
  const known = plans.filter((r) => ["available", "unavailable"].includes(r.status)).length;
  const state = !loaded ? "pending" : plans.length ? (issues.length ? "partial" : known ? "active" : "unknown") : own.some((r) => r.status === "blocked") ? "blocked" : own.some((r) => r.status === "error") ? "error" : "unknown";
  const labels = { pending: "等待采集数据", active: "已采集库存", partial: "部分页面受限", unknown: "库存未公开", blocked: "访问受限", error: "采集异常" };
  return { state, label: labels[state], plans, issues, records: own, known, available: plans.filter((r) => r.status === "available").length, attempted: own.length > 0 };
}

let directoryRecords = [], loaded = false, callbacks = {}, activeProviderId = null, filters = { search: "", region: "all", status: "all" };
const regionNames = { US: "美国", JP: "日本", CNHK: "香港", CNTW: "台湾", SG: "新加坡", CN: "中国大陆", DE: "德国", UK: "英国", other: "其他地区" };
const html = escapeHtml;
export function renderDirectory(records = directoryRecords, hasData = loaded) {
  directoryRecords = records; loaded = hasData;
  const rows = [...providers].sort((a, b) => a.name.localeCompare(b.name, "zh-CN")).map((provider) => ({ provider, health: providerHealth(provider, records, loaded) }));
  const visible = rows.filter(({ provider: p, health: h }) => {
    const query = normalizeSearch(filters.search).trim();
    return (!query || query.split(/\s+/).every((word) => normalizeSearch([p.name, ...p.aliases, ...p.features, ...p.regions.map((r) => regionNames[r]), p.website].join(" ")).includes(word))) &&
      (filters.region === "all" || p.regions.includes(filters.region)) &&
      (filters.status === "all" || (filters.status === "active" ? h.known > 0 : h.known === 0 || h.issues.length > 0));
  });
  document.querySelectorAll("[data-directory-count]").forEach((n) => { n.textContent = `${visible.length} / ${providers.length} 家厂商`; });
  document.querySelectorAll("[data-provider-count]").forEach((n) => { n.textContent = providers.length; });
  document.querySelectorAll("[data-provider-coverage]").forEach((n) => { n.textContent = loaded ? rows.filter((r) => r.health.attempted).length : "—"; });
  document.querySelectorAll("[data-provider-live]").forEach((n) => { n.textContent = loaded ? rows.filter((r) => r.health.known > 0).length : "—"; });
  document.querySelectorAll("[data-provider-issues]").forEach((n) => { n.textContent = loaded ? rows.filter((r) => r.health.known === 0 || r.health.issues.length).length : "—"; });
  const grid = document.querySelector("[data-provider-grid]");
  if (grid) grid.innerHTML = visible.length ? visible.map(({ provider: p, health: h }) => `<article class="provider-card">
    <div class="provider-card-heading"><span class="provider-monogram" aria-hidden="true">${html(p.name.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "").slice(0,2))}</span><div><h3>${html(p.name)}</h3><span class="provider-domain">${html(new URL(p.website).hostname.replace(/^www\./, ""))}</span></div><span class="health-tag is-${h.state}">${html(h.label)}</span></div>
    <p class="provider-regions">${html(p.regions.map((r) => regionNames[r] || r).join(" / "))}</p>
    <div class="provider-tags">${p.features.slice(0,3).map((tag) => `<span>${html(tag)}</span>`).join("")}</div>
    <p class="provider-result">${h.plans.length ? `<strong>${h.plans.length}</strong> 个套餐周期 <span>${h.available} 个可订购</span>` : loaded ? "暂无可核验的公开库存" : "正在加载本站监控数据"}</p>
    <div class="provider-actions"><button type="button" data-provider-inventory="${p.id}" ${h.plans.length ? "" : "disabled"}>查看套餐</button><button class="text-button" type="button" data-provider-detail="${p.id}">采集详情</button><a href="${html(safeUrl(p.website))}" target="_blank" rel="noopener nofollow">官网 ↗</a></div>
  </article>`).join("") : '<p class="directory-empty">没有找到符合条件的厂商。试试品牌别名，或清除筛选。</p>';
  document.querySelectorAll("[data-provider-inventory]").forEach((button) => button.addEventListener("click", () => callbacks.showInventory?.(providers.find((p) => p.id === button.dataset.providerInventory))));
  document.querySelectorAll("[data-provider-detail]").forEach((button) => button.addEventListener("click", () => showProviderDetail(button.dataset.providerDetail)));
  const strip = document.querySelector("[data-provider-shortcuts]");
  if (strip) {
    const picks = ["racknerd", "bwh", "dmit", "lisahost", "zorocloud", "100tb", "greencloud", "akko", "miraigrid", "netcup"];
    strip.innerHTML = picks.map((id) => { const p = providers.find((p) => p.id === id), h = providerHealth(p, records, loaded); return `<button type="button" data-shortcut="${id}"><span class="status-dot is-${h.state}"></span>${html(p.name.replace(/\(.*|（.*/, ""))}<small>${h.plans.length || "—"}</small></button>`; }).join("");
    strip.querySelectorAll("[data-shortcut]").forEach((button) => button.addEventListener("click", () => {
      const p = providers.find((p) => p.id === button.dataset.shortcut);
      if (providerHealth(p, directoryRecords, loaded).plans.length) callbacks.showInventory?.(p); else showProviderDetail(p.id);
    }));
  }
  if (activeProviderId && document.querySelector("[data-provider-dialog]")?.open) showProviderDetail(activeProviderId);
}
function showProviderDetail(id) {
  activeProviderId = id;
  const p = providers.find((p) => p.id === id), h = providerHealth(p, directoryRecords, loaded);
  const body = document.querySelector("[data-provider-detail-body]");
  if (!body) return;
  const issue = h.issues[0];
  const paths = [...new Map(h.records.flatMap((r) => [r, ...(r.raw?.attempts ?? []).filter((a) => a.url).map((a) => ({ sourceUrl: a.url }))]).map((r) => [r.sourceUrl, r])).values()];
  body.innerHTML = `<h2 id="provider-detail-title">${html(p.name)}</h2><span class="health-tag is-${h.state}">${html(h.label)}</span><p>${loaded ? `${h.plans.length} 个套餐周期，其中 ${h.available} 个可订购。${h.attempted ? "已纳入每 30 分钟的自动采集。" : "等待下一次监控数据。"}` : "本站监控数据暂不可用，当前库存未知。请稍后重新读取数据或前往官网核对。"}</p>
    ${issue ? `<p class="collection-note">${html(issue.evidence || issue.error)}</p>` : ""}
    ${h.records.some((r) => r.collection?.pageLimitReached) ? '<p class="collection-note">本轮已达到公开页面采集上限，可能还有未覆盖的产品组。</p>' : ""}
    <dl class="detail-grid"><div><dt>最后检查</dt><dd>${html(formatDateTime(h.records[0]?.fetchedAt))}</dd></div><div><dt>目录来源</dt><dd><a href="${html(safeUrl(p.directorySource))}" target="_blank" rel="noopener nofollow">查看目录出处</a></dd></div></dl>
    <h3>已检查的官方来源</h3><ul class="source-links">${paths.slice(0,15).map((r) => `<li><a href="${html(safeUrl(r.sourceUrl))}" target="_blank" rel="noopener nofollow">${html(r.sourceUrl)}</a></li>`).join("") || '<li>尚无采集记录</li>'}</ul>
    <p class="muted">公开目录中的地区与特征用于查找厂商，不代表本站已验证所有机房或 IP 属性。访问受限与解析异常不能用于判断缺货。</p><a class="button primary" href="${html(safeUrl(p.website))}" target="_blank" rel="noopener nofollow">前往官网核对 ↗</a>`;
  const dialog = document.querySelector("[data-provider-dialog]");
  if (!dialog?.open) dialog?.showModal();
}
export function bindDirectory(options) {
  callbacks = options;
  activeProviderId = null;
  filters = { search: "", region: "all", status: "all" };
  for (const key of ["search", "region", "status"]) {
    document.querySelectorAll(`[data-directory-${key}]`).forEach((input) => input.addEventListener(key === "search" ? "input" : "change", (event) => { filters[key] = event.target.value; renderDirectory(); }));
  }
  document.querySelectorAll("[data-directory-reset]").forEach((button) => button.addEventListener("click", () => { filters = { search: "", region: "all", status: "all" }; for (const [key, value] of Object.entries(filters)) document.querySelectorAll(`[data-directory-${key}]`).forEach((input) => { input.value = value; }); renderDirectory(); }));
}
