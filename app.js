import { renderDirectory, bindDirectory } from "./directory.js";
import { priceQuote } from "./pricing.js";
import { state } from "./state.js";
import { setText, setHidden, debounce, formatDateTime, formatRelativeAge, text, escapeHtml as html, safeUrl } from "./util.js";
import { statusLabels, categoryNames, productCategories, productCategory, ipTypeCategories, ipTypeOrder, statusRank, normalizeProduct, numericStockCount } from "./product.js";
import { filterBaseProducts, visibleProducts } from "./filter.js";
import { routeOptions, monitorFreshness, productRegions } from "./discovery.js";
import { loadSaved, saveSaved } from "./saved.js";
import { icon, hydrateIcons } from "./icons.js";
import { tableRowHtml, cardHtml, compareHtml } from "./product-view.js";

const pageSize = 30;
const maxCompare = 4;
const views = {
  inventory: { title: "发现好 VPS，少一点折腾。", description: "从建站开发到家宽住宅，把配置、线路与价格放在一起，找到适合你的下一台 VPS。" },
  providers: { title: "发现更多，值得了解的厂商。", description: "从品牌、地区和产品特征出发，查看公开套餐与每一家厂商的采集状态。" },
  activity: { title: "库存与价格的变化，都在这里。", description: "关注真实的可订购状态与价格变化，回到来源确认每一次发现。" },
  guide: { title: "选购 VPS，先把这些弄明白。", description: "读懂线路、算清账单、核对库存证据，为下一台 VPS 做好功课。" }
};
const selectBindings = [
  ["region", "[data-filter-region]"], ["provider", "[data-filter-provider]"], ["ipType", "[data-filter-ip-type]"],
  ["status", "[data-filter-status]"], ["currency", "[data-filter-currency]"], ["billing", "[data-filter-billing]"]
];
let dataLoadError = "", page = 1, activeView = "inventory", layout = "table", eventType = "all", loadSequence = 0, toastTimer;
let lastLoadAt = 0, loading = false;
const each = (selector, fn) => document.querySelectorAll(selector).forEach(fn);
const bind = (selector, event, fn) => each(selector, (node) => node.addEventListener(event, fn));
const focusProductControl = (attribute, key, location) => {
  const node = [...document.querySelectorAll(`[${attribute}]`)].find((n) => n.getAttribute(attribute) === key && (!location || n.dataset.detailLocation === location) && (typeof n.getClientRects !== "function" || n.getClientRects().length > 0));
  node?.focus?.({ preventScroll: true });
};

function toast(message) {
  const node = document.querySelector("[data-toast]");
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
}
function syncThemeToggle() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  each("[data-theme-toggle]", (button) => {
    button.innerHTML = icon(isDark ? "sun" : "moon");
    button.setAttribute("aria-label", isDark ? "切换到浅色模式" : "切换到深色模式");
  });
}
function toggleTheme() {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("fff-ui-theme", next); } catch { /* Keep the theme for this visit. */ }
  syncThemeToggle();
}

function renderSummary() {
  setText("[data-sync]", state.payload ? formatDateTime(state.payload.generatedAt) : "-");
  const freshness = monitorFreshness(state.payload?.generatedAt);
  setText("[data-freshness]", state.payload ? freshness.label : "正在读取数据");
  setHidden("[data-stale-notice]", !state.payload || !freshness.stale);
  setText("[data-monitor-summary]", state.payload
    ? `来源 ${state.payload.sourceCount} 个，记录 ${state.payload.summary.total} 条，可订购 ${state.payload.summary.available ?? 0} 条，不可订购 ${state.payload.summary.unavailable ?? 0} 条，访问受限 ${state.payload.summary.blocked ?? 0} 条，失败 ${state.payload.summary.error ?? 0} 条。`
    : dataLoadError || "监控数据尚未加载。");
  if (!state.payload) {
    each("[data-monitor-status]", (node) => { node.textContent = dataLoadError ? "本站数据加载失败" : "加载监控数据中"; node.classList.toggle("has-warning", Boolean(dataLoadError)); });
    for (const selector of ["[data-stat-total]", "[data-stat-available]", "[data-stat-unavailable]", "[data-stat-sources]", "[data-stat-exact]", "[data-trust-age]"]) setText(selector, "-");
    setText("[data-trust-state]", dataLoadError ? "本站监控数据不可用" : "等待真实监控数据");
    setText("[data-trust-freshness]", dataLoadError ? "当前库存未知" : "加载中");
    setText("[data-fx-note]", "");
    return;
  }
  setText("[data-stat-total]", state.products.length);
  setText("[data-stat-available]", state.products.filter((p) => p.status === "available").length);
  setText("[data-stat-exact]", state.products.filter((p) => p.status === "available" && numericStockCount(p) > 0).length);
  setText("[data-stat-unavailable]", state.payload.summary.unavailable ?? 0);
  setText("[data-stat-sources]", state.payload.sourceCount);
  const hasProblems = (state.payload.summary.blocked ?? 0) + (state.payload.summary.error ?? 0) > 0;
  each("[data-monitor-status]", (node) => { node.textContent = hasProblems ? "监控有异常源" : "监控正常"; node.classList.toggle("has-warning", hasProblems); });
  const snapshots = state.products.filter((p) => p._evidenceBadge.value === "snapshot").length;
  setText("[data-trust-state]", `已加载 ${state.products.length} 条真实记录`);
  setText("[data-trust-age]", formatRelativeAge(state.payload.generatedAt));
  setText("[data-trust-freshness]", snapshots ? `${snapshots} 条第三方快照需复核` : "官方入口可核验");
  const fx = state.payload.exchangeRates;
  setText("[data-fx-note]", fx?.date ? `人民币参考汇率：ECB ${fx.date}，非实际扣款价。` : "汇率暂不可用，价格保留原币种。");
}
function renderCounts() {
  setText("[data-count-all]", state.products.length);
  for (const category of productCategories) {
    const count = state.products.filter((p) => productCategory(p) === category).length;
    setText(`[data-count-${category}]`, count);
    if (category === "unclassified") setHidden(`[data-category="${category}"]`, count === 0);
  }
  renderIpDist();
}
function renderIpDist() {
  const container = document.querySelector("[data-ip-dist]");
  if (!container) return;
  const products = filterBaseProducts();
  container.innerHTML = ipTypeCategories.map((type) => `<button class="dist-row" data-ip-type="${type.value}" type="button">${html(type.label)}<span class="dist-count">${products.filter((p) => p._ipType.value === type.value).length}</span></button>`).join("");
  bind("[data-ip-type]", "click", (event) => { state.filters.ipType = event.currentTarget.dataset.ipType; syncFilterControls(); renderTable(true); });
}
function renderResultCount(count) {
  const total = filterBaseProducts().length;
  setText("[data-result-count]", count > pageSize ? `显示 ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, count)} / ${count} 条` : `显示 ${count} / ${total} 条`);
}
function renderSelectedCount() {
  setText("[data-selected-count]", state.selected.size);
  setText("[data-saved-count]", state.saved.size);
  setHidden("[data-compare-dock]", state.selected.size === 0);
  document.body?.classList.toggle("has-comparison", state.selected.size > 0);
  each("[data-open-compare]", (button) => { button.disabled = state.selected.size < 2; });
  const names = state.products.filter((p) => state.selected.has(p._stableKey));
  const holder = document.querySelector("[data-compare-names]");
  if (holder) holder.innerHTML = names.map((p) => `<span title="${html(text(p.name))}">${html(p.provider)}</span>`).join("");
}
function emptyHtml(message) {
  return `${icon(dataLoadError ? "info" : state.savedOnly ? "bookmark" : "search")}<h3>${dataLoadError ? "暂时无法读取库存" : state.savedOnly ? "这里还没有匹配的收藏" : "没有找到匹配的套餐"}</h3><p>${html(message)}</p><button type="button" data-empty-action>${dataLoadError ? "重新读取数据" : "查看全部套餐"}</button>`;
}
function renderEmpty(message) {
  const markup = emptyHtml(message);
  const body = document.querySelector("[data-products]");
  if (body) body.innerHTML = `<tr><td class="empty-row" colspan="7">${markup}</td></tr>`;
  const cards = document.querySelector("[data-mobile-products]");
  if (cards) cards.innerHTML = `<div class="empty-state">${markup}</div>`;
  bind("[data-empty-action]", "click", () => dataLoadError ? loadMonitorData() : clearAllFilters());
  renderResultCount(0);
}
function syncFilterControls() {
  each("[data-search]", (input) => { input.value = state.filters.search; });
  for (const [key, selector] of selectBindings) each(selector, (select) => { select.value = state.filters[key]; });
  each("[data-sort]", (select) => { select.value = state.activeSort; });
  each("[data-available-only]", (input) => { input.checked = state.filters.status === "available"; });
}
function syncActiveControls() {
  for (const [attribute, value] of [["category", state.activeCategory], ["region", state.filters.region], ["route", state.filters.route], ["ip-type", state.filters.ipType]]) {
    each(`[data-${attribute}]`, (button) => { const active = button.getAttribute(`data-${attribute}`) === value; button.classList.toggle("is-active", active); button.setAttribute("aria-pressed", String(active)); });
  }
  each("[data-saved-filter]", (button) => { button.classList.toggle("is-active", state.savedOnly); button.setAttribute("aria-pressed", String(state.savedOnly)); });
  setHidden("[data-saved-indicator]", !state.savedOnly);
  const count = Object.entries(state.filters).filter(([key, value]) => key !== "price" && value && value !== "all").length;
  setText("[data-filter-count]", count);
  setHidden("[data-filter-count]", count === 0);
  const active = document.querySelector("[data-active-filters]");
  if (!active) return;
  const labels = { search: "搜索", region: "地区", provider: "厂商", ipType: "IP", status: "库存", currency: "币种", billing: "周期", route: "线路" };
  active.innerHTML = Object.entries(state.filters).filter(([key, value]) => labels[key] && value && value !== "all").map(([key, value]) => {
    const selector = selectBindings.find(([field]) => key === field)?.[1];
    const selected = selector ? [...document.querySelectorAll(`${selector} option`)].find((option) => option.getAttribute("value") === value)?.textContent : null;
    const title = selected || (key === "route" ? routeOptions.find((option) => option.value === value)?.label : value) || value;
    return `<button type="button" data-remove-filter="${key}" aria-label="移除${labels[key]}筛选">${labels[key]}：${html(title)}${icon("x")}</button>`;
  }).join("");
  active.hidden = active.innerHTML === "";
  bind("[data-remove-filter]", "click", (event) => { const key = event.currentTarget.dataset.removeFilter; state.filters[key] = key === "search" ? "" : "all"; syncFilterControls(); renderTable(true); });
}
function renderTable(resetPage = false) {
  if (resetPage) page = 1;
  syncActiveControls();
  setText("[data-title-category]", categoryNames[state.activeCategory]);
  syncQuery();
  const all = visibleProducts();
  const pages = Math.max(1, Math.ceil(all.length / pageSize));
  page = Math.max(1, Math.min(page, pages));
  setText("[data-page-label]", `${page} / ${pages}`);
  each("[data-page-prev]", (button) => { button.disabled = page <= 1; });
  each("[data-page-next]", (button) => { button.disabled = page >= pages; });
  const list = all.slice((page - 1) * pageSize, page * pageSize);
  if (!list.length) {
    renderEmpty(dataLoadError || (state.savedOnly ? "点击套餐旁的书签即可收藏。收藏保存在本机；本轮未采集到或不符合筛选条件的收藏不会出现在这里。" : "试试减少筛选条件，或到商家导航查看采集状态。"));
  } else {
    const table = document.querySelector("[data-products]");
    if (table) table.innerHTML = list.map(tableRowHtml).join("");
    const cards = document.querySelector("[data-mobile-products]");
    if (cards) cards.innerHTML = list.map(cardHtml).join("");
    bindProductControls();
    renderResultCount(all.length);
  }
  renderSelectedCount();
}
function bindProductControls() {
  bind("[data-select]", "change", (event) => {
    const input = event.currentTarget, key = input.dataset.select;
    if (input.checked && !state.selected.has(key) && state.selected.size >= maxCompare) { input.checked = false; toast("最多对比 4 个方案，请先取消一个。"); return; }
    if (input.checked) state.selected.add(key); else state.selected.delete(key);
    each("[data-select]", (peer) => { if (peer.dataset.select === key) peer.checked = input.checked; });
    each("[data-key]", (row) => { if (row.dataset.key === key) row.classList.toggle("is-selected", input.checked); });
    renderSelectedCount();
  });
  bind("[data-detail]", "click", (event) => {
    const { detail: key, detailLocation } = event.currentTarget.dataset;
    if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key);
    renderTable();
    focusProductControl("data-detail", key, detailLocation);
  });
  bind("[data-save]", "click", (event) => {
    const key = event.currentTarget.dataset.save;
    const saved = !state.saved.has(key);
    if (saved) state.saved.add(key); else state.saved.delete(key);
    const stored = saveSaved(state.saved);
    renderTable();
    toast(stored ? saved ? "已收藏，可在「我的收藏」中查看" : "已取消收藏" : "本次访问已保存；浏览器存储不可用，关闭页面后不会保留。");
    focusProductControl("data-save", key);
  });
}
function clearAllFilters(render = true) {
  state.activeCategory = "all";
  state.savedOnly = false;
  resetFilters(render);
}
function resetFilters(render = true) {
  for (const key of Object.keys(state.filters)) state.filters[key] = key === "search" ? "" : "all";
  syncFilterControls();
  renderIpDist();
  if (render) renderTable(true);
}
function countedOptions(list, getValue, getLabel = getValue) {
  const values = new Map();
  for (const item of list) {
    const value = getValue(item);
    if (!value) continue;
    const option = values.get(value) || { value, label: getLabel(item), count: 0 };
    option.count += 1; values.set(value, option);
  }
  return [...values.values()].sort((a, b) => text(a.label).localeCompare(text(b.label), "zh-CN"));
}
function populateSelect(selector, allLabel, options, key) {
  const rendered = [...options];
  if (state.filters[key] !== "all" && !rendered.some((option) => option.value === state.filters[key])) rendered.push({ value: state.filters[key], label: state.filters[key], count: null });
  each(selector, (select) => { select.innerHTML = `<option value="all">${allLabel}</option>${rendered.map((option) => `<option value="${html(option.value)}">${html(option.count === null ? `${option.label}（当前筛选）` : `${option.label} (${option.count})`)}</option>`).join("")}`; select.value = state.filters[key]; });
}
function hydrateFilterOptions() {
  populateSelect("[data-filter-region]", "全部地区", countedOptions(state.products.flatMap(productRegions), (region) => region), "region");
  populateSelect("[data-filter-provider]", "全部厂商", countedOptions(state.products, (p) => p.provider), "provider");
  populateSelect("[data-filter-ip-type]", "全部 IP 特征", countedOptions(state.products, (p) => p._ipType.value, (p) => p._ipType.label).sort((a, b) => ipTypeOrder.indexOf(a.value) - ipTypeOrder.indexOf(b.value)), "ipType");
  populateSelect("[data-filter-status]", "全部状态", countedOptions(state.products, (p) => p.status, (p) => statusLabels[p.status] || p.status).sort((a, b) => statusRank(a.value) - statusRank(b.value)), "status");
  populateSelect("[data-filter-currency]", "全部币种", countedOptions(state.products, (p) => priceQuote(p).currency), "currency");
}
function openCompare() {
  const chosen = state.products.filter((product) => state.selected.has(product._stableKey));
  if (chosen.length < 2) return;
  const grid = document.querySelector("[data-compare-grid]");
  if (grid) grid.innerHTML = compareHtml(chosen);
  document.querySelector("[data-compare-dialog]")?.showModal();
}
function renderEvents() {
  const container = document.querySelector("[data-event-list]");
  if (!container) return;
  const labels = { restock: "恢复可订购", soldout: "变为不可订购", price: "价格变化" };
  const icons = { restock: "check", soldout: "minus", price: "wallet" };
  const classes = { restock: "is-available", soldout: "is-unavailable", price: "is-unknown" };
  const all = (Array.isArray(state.payload?.events) ? state.payload.events : []).filter((event) => labels[event.type] && Date.parse(event.at) >= Date.now() - 7 * 86400000).sort((a, b) => b.at.localeCompare(a.at));
  const events = all.filter((event) => eventType === "all" || event.type === eventType);
  setText("[data-event-count]", `${events.length} 条动态 · 近 7 天`);
  each("[data-event-type]", (button) => { const selected = button.dataset.eventType === eventType; button.classList.toggle("is-active", selected); button.setAttribute("aria-pressed", String(selected)); });
  container.innerHTML = events.length ? events.map((event) => `<article class="event-row"><div><span class="chip ${classes[event.type]}">${icon(icons[event.type])}${labels[event.type]}</span><p><time datetime="${html(event.at)}">${html(formatDateTime(event.at))}</time></p></div><div><h3>${html(event.provider)} · ${html(event.name)}</h3><p>${html(event.region || "地区未注明")}</p></div><div class="event-price">${event.type === "price" ? `<del>${html(event.previousPrice || "先前价格未注明")}</del>` : ""}${html(event.price || "价格未公开")}</div><a href="${html(safeUrl(event.orderUrl))}" target="_blank" rel="nofollow noopener">核对官方来源 ↗</a></article>`).join("")
    : `<div class="empty-state">${icon(dataLoadError ? "info" : "activity")}<h2>${dataLoadError ? "动态数据暂不可用" : all.length ? "这个分类暂无变化" : "等待下一次值得关注的变化"}</h2><p>${html(dataLoadError || (all.length ? "可以切换其他动态类型，查看近期库存与价格变化。" : state.payload?.eventTracking?.startedAt ? `已于 ${formatDateTime(state.payload.eventTracking.startedAt)} 建立采集基线。后续发现恢复可订购、变为不可订购或价格变化时，将记录在这里。` : "采集历史尚未建立。首次记录用于建立基线，不会将已有套餐标成刚刚补货。"))}</p></div>`;
}

function syncQuery(push = false) {
  const url = new URL(window.location.href);
  for (const key of ["view", "category", "q", "region", "provider", "ipType", "status", "currency", "sort", "route", "billing", "saved"]) url.searchParams.delete(key);
  if (activeView !== "inventory") url.searchParams.set("view", activeView);
  if (state.activeCategory !== "all") url.searchParams.set("category", state.activeCategory);
  for (const [key, value] of Object.entries(state.filters)) if (value && value !== "all" && key !== "price") url.searchParams.set(key === "search" ? "q" : key, value);
  if (state.activeSort !== "recommend") url.searchParams.set("sort", state.activeSort);
  if (state.savedOnly) url.searchParams.set("saved", "1");
  if (url.hash === "#guide") url.hash = "";
  if (url.href !== window.location.href) {
    if (push && window.history?.pushState) window.history.pushState(null, "", url.href);
    else window.history?.replaceState(null, "", url.href);
  }
}
function readQuery() {
  const url = new URL(window.location.href), query = url.searchParams;
  activeView = Object.hasOwn(views, query.get("view")) ? query.get("view") : url.hash === "#guide" ? "guide" : "inventory";
  state.activeCategory = productCategories.includes(query.get("category")) ? query.get("category") : "all";
  state.activeSort = ["price", "cny", "stock", "updated"].includes(query.get("sort")) ? query.get("sort") : "recommend";
  state.savedOnly = query.get("saved") === "1";
  for (const key of Object.keys(state.filters)) state.filters[key] = key === "price" ? "all" : query.get(key === "search" ? "q" : key) || (key === "search" ? "" : "all");
  if (!routeOptions.some((option) => option.value === state.filters.route)) state.filters.route = "all";
  if (!["all", "1", "3", "6", "12", "long", "unknown"].includes(state.filters.billing)) state.filters.billing = "all";
  syncFilterControls();
}
function showView(view, push = false) {
  activeView = Object.hasOwn(views, view) ? view : "inventory";
  for (const [name, selector] of [["inventory", "[data-inventory-view]"], ["providers", "[data-directory-view]"], ["activity", "[data-activity-view]"], ["guide", "[data-guide-view]"]]) setHidden(selector, name !== activeView);
  const title = document.querySelector("[data-view-title]");
  if (title) title.innerHTML = activeView === "inventory" ? "发现好 VPS，<span>少一点折腾。</span>" : html(views[activeView].title);
  setText("[data-view-description]", views[activeView].description);
  each(".primary-nav [data-view]", (button) => { const current = button.dataset.view === activeView; button.classList.toggle("is-active", current); button.setAttribute("aria-current", current ? "page" : "false"); });
  document.title = `${activeView === "inventory" ? "发现好 VPS，少一点折腾" : activeView === "providers" ? "商家导航" : activeView === "activity" ? "库存动态" : "选购指南"} · VPS 节点雷达`;
  if (activeView === "activity") renderEvents();
  syncQuery(push);
  if (push) document.querySelector("#main")?.scrollIntoView({ block: "start" });
}
function setLayout(value) {
  layout = value === "cards" ? "cards" : "table";
  document.querySelector(".inventory-panel")?.classList.toggle("is-card-layout", layout === "cards");
  each("[data-layout]", (button) => { const active = button.dataset.layout === layout; button.classList.toggle("is-active", active); button.setAttribute("aria-pressed", String(active)); });
  try { localStorage.setItem("resnode-radar:layout", layout); } catch { /* View remains usable without storage. */ }
}
function setLoading(isLoading) {
  loading = isLoading;
  each("[data-refresh]", (button) => { button.disabled = loading; button.setAttribute("aria-busy", String(loading)); });
  document.querySelector(".inventory-panel")?.classList.toggle("is-loading", loading && Boolean(state.payload));
}
async function loadMonitorData() {
  const requestId = ++loadSequence;
  lastLoadAt = Date.now();
  dataLoadError = "";
  setLoading(true);
  if (!state.payload) {
    renderSummary();
    const body = document.querySelector("[data-products]");
    if (body) body.innerHTML = Array.from({ length: 6 }, (_, i) => `<tr class="skel-row"><td colspan="7"><span class="skel" style="width:${55 + i % 3 * 12}%"></span></td></tr>`).join("");
    const cards = document.querySelector("[data-mobile-products]");
    if (cards) cards.innerHTML = '<div class="empty-state">加载监控数据中…</div>';
  }
  try {
    const response = await fetch(`data/products.json?t=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (requestId !== loadSequence) return;
    if (!payload || !Array.isArray(payload.products) || !payload.summary || typeof payload.summary !== "object" || !Number.isFinite(Date.parse(payload.generatedAt))) throw new Error("数据格式无效");
    state.payload = payload;
    state.records = payload.products.filter((record) => record && typeof record === "object");
    state.products = state.records.filter((p) => !p.diagnostic && !["blocked", "error"].includes(p.status)).map(normalizeProduct);
    const keys = new Set(state.products.map((p) => p._stableKey));
    state.selected = new Set([...state.selected].filter((key) => keys.has(key)));
    state.expanded = new Set([...state.expanded].filter((key) => keys.has(key)));
    renderDirectory(state.records, true);
    hydrateFilterOptions();
    syncFilterControls();
    renderCounts();
    renderSummary();
    renderTable();
    renderEvents();
    const compare = document.querySelector("[data-compare-dialog]");
    if (compare?.open) { if (state.selected.size < 2) compare.close(); else { const grid = document.querySelector("[data-compare-grid]"); if (grid) grid.innerHTML = compareHtml(state.products.filter((p) => state.selected.has(p._stableKey))); } }
  } catch (error) {
    if (requestId !== loadSequence) return;
    dataLoadError = `本站监控数据加载失败：${error.message}。当前库存未知。`;
    state.payload = null; state.products = []; state.records = []; state.selected.clear(); state.expanded.clear();
    document.querySelector("[data-compare-dialog]")?.close?.();
    renderDirectory([], false);
    hydrateFilterOptions();
    syncFilterControls();
    renderCounts();
    renderSummary();
    renderTable(true);
    renderEvents();
  } finally {
    if (requestId === loadSequence) setLoading(false);
  }
}
function bindControls() {
  bind("form.filter-bar, form.directory-filters", "submit", (event) => event.preventDefault());
  bind("[data-mobile-filter-toggle]", "click", (event) => {
    const button = event.currentTarget, expanded = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(expanded));
    setHidden("#advanced-filters", !expanded);
  });
  bind("[data-view]", "click", (event) => showView(event.currentTarget.dataset.view, true));
  bind("[data-category]", "click", (event) => { state.activeCategory = event.currentTarget.dataset.category; resetFilters(); });
  bind("[data-region]", "click", (event) => { state.filters.region = event.currentTarget.dataset.region; syncFilterControls(); renderTable(true); });
  bind("[data-route]", "click", (event) => { state.filters.route = event.currentTarget.dataset.route; renderTable(true); });
  bind("[data-layout]", "click", (event) => setLayout(event.currentTarget.dataset.layout));
  const debouncedRender = debounce(() => renderTable(true), 180);
  bind("[data-search]", "input", (event) => { state.filters.search = event.target.value; debouncedRender(); });
  for (const [key, selector] of selectBindings) bind(selector, "change", (event) => { state.filters[key] = event.target.value; syncFilterControls(); renderTable(true); });
  bind("[data-sort]", "change", (event) => { state.activeSort = event.target.value; renderTable(true); });
  bind("[data-available-only]", "change", (event) => { state.filters.status = event.target.checked ? "available" : "all"; syncFilterControls(); renderTable(true); });
  bind("[data-filter-reset]", "click", resetFilters);
  bind("[data-saved-filter]", "click", () => { state.savedOnly = !state.savedOnly; renderTable(true); });
  bind("[data-open-saved]", "click", () => { clearAllFilters(false); state.savedOnly = true; showView("inventory", true); renderTable(true); document.querySelector("#products")?.scrollIntoView({ block: "start" }); });
  bind("[data-page-prev], [data-page-next]", "click", (event) => { page += event.currentTarget.hasAttribute("data-page-next") ? 1 : -1; renderTable(); document.querySelector("#products")?.scrollIntoView({ block: "start" }); });
  bind("[data-refresh]", "click", loadMonitorData);
  bind("[data-open-compare]", "click", openCompare);
  bind("[data-clear-compare]", "click", () => { state.selected.clear(); renderTable(); });
  bind("[data-theme-toggle]", "click", toggleTheme);
  bind("[data-event-type]", "click", (event) => { eventType = event.currentTarget.dataset.eventType; renderEvents(); });
  bind("[data-guide-category]", "click", (event) => { clearAllFilters(false); state.activeCategory = event.currentTarget.dataset.guideCategory; showView("inventory", true); renderTable(true); });
  bind("[data-guide-route]", "click", (event) => { clearAllFilters(false); state.filters.route = event.currentTarget.dataset.guideRoute; showView("inventory", true); renderTable(true); });
  bindDirectory({ showInventory(provider) {
    clearAllFilters(false);
    state.filters.provider = provider.inventoryNames.find((name) => state.products.some((p) => p.provider === name)) || "all";
    syncFilterControls(); showView("inventory", true); renderTable(true); document.querySelector("#products")?.scrollIntoView({ block: "start" });
  } });
  bind("dialog", "click", (event) => {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect?.();
    if (box && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) event.currentTarget.close();
  });
  const toTop = document.querySelector("[data-to-top]");
  window.addEventListener("scroll", () => toTop?.classList.toggle("is-visible", window.scrollY > 600), { passive: true });
  toTop?.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  window.addEventListener("popstate", () => { readQuery(); showView(activeView); renderTable(true); });
  window.addEventListener("storage", (event) => { if (event.key === "resnode-radar:saved:v1") { state.saved = loadSaved(); renderTable(); } });
  const refreshIfDue = () => {
    if (document.visibilityState !== "visible" || loading) return;
    renderSummary();
    if (Date.now() - lastLoadAt >= 5 * 60000) loadMonitorData();
  };
  setInterval(refreshIfDue, 60000);
  document.addEventListener?.("visibilitychange", refreshIfDue);
  document.addEventListener?.("keydown", (event) => {
    if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable || document.querySelector("dialog[open]")) return;
    event.preventDefault();
    if (activeView !== "inventory") showView("inventory", true);
    document.querySelector("[data-search]")?.focus();
  });
}

state.payload = null;
state.products = [];
state.records = [];
state.selected.clear();
state.expanded.clear();
state.saved = loadSaved();
hydrateIcons();
readQuery();
renderSummary();
bindControls();
renderDirectory([], false);
showView(activeView);
syncThemeToggle();
try { setLayout(localStorage.getItem("resnode-radar:layout")); } catch { setLayout("table"); }
renderSelectedCount();
loadMonitorData();
