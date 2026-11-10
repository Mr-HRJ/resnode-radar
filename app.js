import { renderDirectory, bindDirectory, providerFor } from "./directory.js";
import { priceQuote } from "./pricing.js";
import { state } from "./state.js";
import { setText, setHidden, debounce, formatDateTime, formatRelativeAge, text, escapeHtml, safeUrl } from "./util.js";
import { statusLabels, categoryNames, productCategories, productCategory, ipTypeCategories, ipTypeOrder, priceBands, statusClass, statusRank, normalizeProduct, priceBandFor, numericStockCount } from "./product.js";
import { filterBaseProducts, visibleProducts } from "./filter.js";

let dataLoadError = "";
let page = 1;
const pageSize = 30;
let activeView = "inventory";

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem("fff-ui-theme", next);
  } catch {
    /* localStorage 不可用时忽略 */
  }
  syncThemeToggle();
}

function syncThemeToggle() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    btn.textContent = isDark ? "☀" : "☾";
  });
}

function renderEvidenceBadge(product) {
  const badge = product._evidenceBadge;
  return `<span class="chip chip-evidence ${escapeHtml(badge.className)}">${escapeHtml(badge.label)}</span>`;
}

function riskTagSeverity(tag) {
  const severity = String(tag?.severity || "").toLowerCase();
  return severity === "low" || severity === "medium" || severity === "high" ? severity : "medium";
}

function renderRiskTags(product) {
  const tags = Array.isArray(product.riskTags) ? product.riskTags : [];
  return tags
    .filter((tag) => tag && hasDisplayValue(tag.label))
    .map((tag) => {
      const severity = riskTagSeverity(tag);
      const title = hasDisplayValue(tag.value) ? text(tag.value) : text(tag.label);
      return `<span class="chip chip-risk is-${escapeHtml(severity)}" title="${escapeHtml(title)}">${escapeHtml(text(tag.label))}</span>`;
    })
    .join("");
}

function productHref(product) {
  return safeUrl(product.orderUrl || product.sourceUrl || product.finalUrl);
}

function hasDisplayValue(value) {
  if (value === undefined || value === null) return false;
  const valueText = String(value).trim();
  return valueText !== "" && valueText !== "-" && valueText !== "—";
}

function displayValue(value, fallback) {
  return hasDisplayValue(value) ? text(value) : fallback;
}

function renderSpecCell(product) {
  const lines = [];
  if (hasDisplayValue(product.hardware)) {
    lines.push(`<span class="spec-line spec-hw">${escapeHtml(text(product.hardware))}</span>`);
  }
  if (hasDisplayValue(product.bandwidth)) {
    lines.push(`<span class="spec-line spec-bw">${escapeHtml(text(product.bandwidth))}</span>`);
  }
  return lines.length > 0 ? lines.join("") : '<span class="spec-empty">规格未标明</span>';
}

function detailRowHtml(product) {
  const stock = numericStockCount(product);
  const sourceHref = safeUrl(product.sourceUrl || product.finalUrl);
  return `
    <tr class="row-detail">
      <td colspan="7">
        <div class="row-detail-inner">
          <dl class="detail-grid">
            <div><dt>产品</dt><dd>${escapeHtml(text(product.name))}</dd></div>
            <div><dt>商家</dt><dd>${escapeHtml(text(product.provider))}</dd></div>
            <div><dt>产品类别</dt><dd>${escapeHtml(categoryNames[productCategory(product)])}</dd></div>
            <div><dt>区域 / 线路</dt><dd>${escapeHtml(text(product.region))} · ${escapeHtml(text(product.route))}</dd></div>
            <div><dt>IP 类型</dt><dd>${escapeHtml(product._ipType.label)}</dd></div>
            <div><dt>硬件配置</dt><dd>${escapeHtml(displayValue(product.hardware, "配置未标明"))}</dd></div>
            <div><dt>流量 / 带宽</dt><dd>${escapeHtml(displayValue(product.bandwidth, "流量未标明"))}</dd></div>
            <div><dt>价格</dt><dd>${escapeHtml(displayValue(product.price, "价格未标明"))}</dd></div>
            <div><dt>库存</dt><dd>${stock !== null ? escapeHtml(String(stock)) : "未注明"}</dd></div>
            <div><dt>状态</dt><dd>${escapeHtml(text(product.statusLabel, statusLabels[product.status] ?? product.status))}</dd></div>
            <div><dt>证据口径</dt><dd>${escapeHtml(product._evidenceBadge.label)}</dd></div>
            <div><dt>风险标签</dt><dd class="detail-risk-tags">${renderRiskTags(product) || "—"}</dd></div>
            <div><dt>抓取时间</dt><dd>${escapeHtml(formatDateTime(product.fetchedAt))}</dd></div>
            <div><dt>来源</dt><dd><a href="${escapeHtml(sourceHref)}" target="_blank" rel="nofollow noopener">${escapeHtml(text(product.sourceUrl || product.finalUrl, "—"))}</a></dd></div>
          </dl>
          <p class="detail-evidence">${escapeHtml(text(product.evidence))}</p>
        </div>
      </td>
    </tr>
  `;
}

function priceHtml(product) {
  const q = priceQuote(product);
  if (q.amount === null) return '<span class="spec-empty">价格未标明</span>';
  return `<strong><small>${escapeHtml(q.currency || "币种待核对")}</small>${q.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong><span class="price-cycle">${escapeHtml(q.period)}${q.baseOnly ? "起" : ""}</span>${q.monthly !== null && q.months > 1 ? `<span class="price-equivalent">折合 ${escapeHtml(q.currency || "")} ${(q.monthly).toFixed(2)}/月</span>` : ""}`;
}
function renderTable(resetPage = false) {
  if (resetPage) page = 1;
  syncActiveCategory();
  document.querySelectorAll("[data-title-category]").forEach((node) => { node.textContent = categoryNames[state.activeCategory]; });
  syncTableSortIndicator();
  syncQuery();
  const all = visibleProducts();
  const pages = Math.max(1, Math.ceil(all.length / pageSize));
  page = Math.min(page, pages);
  const list = all.slice((page - 1) * pageSize, page * pageSize);
  setText("[data-page-label]", `${page} / ${pages}`);
  document.querySelectorAll("[data-page-prev]").forEach((b) => { b.disabled = page <= 1; });
  document.querySelectorAll("[data-page-next]").forEach((b) => { b.disabled = page >= pages; });
  if (list.length === 0) {
    renderEmpty(dataLoadError || "没有符合条件的套餐。试试减少筛选条件，或到厂商目录查看采集状态。");
    renderSelectedCount();
    return;
  }
  const tableBody = document.querySelector("[data-products]");
  if (tableBody) tableBody.innerHTML = list.map((product) => {
    const checked = state.selected.has(product._stableKey) ? "checked" : "";
    const isOpen = state.expanded.has(product._stableKey);
    const isActionable = product.status === "available" && product.orderUrl;
    const href = productHref(product);
    const provider = providerFor(product)?.name || product.provider;
    const main = `<tr data-key="${escapeHtml(product._stableKey)}" class="${isOpen ? "is-open" : ""}">
      <td class="cell-check"><input data-select="${escapeHtml(product._stableKey)}" type="checkbox" ${checked} aria-label="选择 ${escapeHtml(provider)} ${escapeHtml(text(product.name))} 对比" /></td>
      <td class="cell-product"><a class="prov" href="${escapeHtml(href)}" target="_blank" rel="nofollow noopener">${escapeHtml(provider)}</a><span class="prov-sub">${escapeHtml(text(product.name))}</span></td>
      <td class="cell-region"><span>${escapeHtml(text(product.region, "地区未注明"))}</span><span class="chip chip-ip ${escapeHtml(product._ipType.className)}">${escapeHtml(product._ipType.label)}</span></td>
      <td class="cell-spec">${product.route ? `<span class="route-line">${escapeHtml(product.route)}</span>` : ""}${renderSpecCell(product)}</td>
      <td class="cell-price">${priceHtml(product)}</td>
      <td class="cell-status"><span class="chip chip-status ${escapeHtml(statusClass(product.status))}">${escapeHtml(text(product.statusLabel, statusLabels[product.status]))}</span>${renderEvidenceBadge(product)}</td>
      <td><a class="link ${isActionable ? "" : "is-soft"}" href="${escapeHtml(href)}" target="_blank" rel="nofollow noopener">${isActionable ? "官网购买" : "查看官网"} ↗</a><button type="button" class="detail-button" data-detail="${escapeHtml(product._stableKey)}" aria-expanded="${isOpen}">${isOpen ? "收起详情" : "详情与来源"}</button></td>
    </tr>`;
    return isOpen ? main + detailRowHtml(product) : main;
  }).join("");
  document.querySelectorAll("[data-detail]").forEach((button) => button.addEventListener("click", () => {
    const key = button.dataset.detail;
    if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key);
    renderTable(false);
    const current = [...document.querySelectorAll("[data-detail]")].find((b) => b.dataset.detail === key);
    current?.focus?.();
  }));
  renderMobileCards(list);
  renderResultCount(all.length);
  bindRowSelection();
  renderSelectedCount();
}

function renderMobileCards(list, emptyMessage = "没有符合条件的套餐。请减少筛选条件，或查看厂商目录。") {
  const container = document.querySelector("[data-mobile-products]");
  if (!container) return;
  if (!list.length) { container.innerHTML = `<p class="empty-row">${escapeHtml(emptyMessage)}</p>`; return; }
  container.innerHTML = list.map((product) => {
    const provider = providerFor(product)?.name || product.provider;
    const checked = state.selected.has(product._stableKey) ? "checked" : "";
    return `<article class="mobile-product-card"><div class="mobile-card-head"><label><input data-select="${escapeHtml(product._stableKey)}" type="checkbox" ${checked} aria-label="选择 ${escapeHtml(provider)} ${escapeHtml(text(product.name))} 对比" /><span>${escapeHtml(provider)}</span></label><span class="chip chip-status ${escapeHtml(statusClass(product.status))}">${escapeHtml(text(product.statusLabel, statusLabels[product.status]))}</span></div>
      <h3>${escapeHtml(text(product.name))}</h3><p class="mobile-card-specs">${escapeHtml(text(product.region, "地区未注明"))} / ${escapeHtml(categoryNames[productCategory(product)])}<br>${escapeHtml(displayValue(product.hardware, "配置未注明"))}<br>${escapeHtml([product.route, product.bandwidth].filter(Boolean).join(" / "))}</p>
      <div class="mobile-card-footer"><div class="cell-price">${priceHtml(product)}</div><a class="link" href="${escapeHtml(productHref(product))}" target="_blank" rel="nofollow noopener">${product.status === "available" ? "官网购买" : "查看官网"} ↗</a></div>
      <details><summary>IP 特征与来源证据</summary><dl><div><dt>IP 特征</dt><dd>${escapeHtml(product._ipType.label)}</dd></div><div><dt>抓取时间</dt><dd>${escapeHtml(formatDateTime(product.fetchedAt))}</dd></div><div><dt>证据</dt><dd>${renderEvidenceBadge(product)}</dd></div><div><dt>提示</dt><dd>${renderRiskTags(product)}</dd></div></dl><p class="detail-evidence">${escapeHtml(text(product.evidence))}</p><a href="${escapeHtml(safeUrl(product.sourceUrl))}" target="_blank" rel="noopener nofollow">查看官方来源</a></details></article>`;
  }).join("");
}

function renderEmpty(message) {
  const tableBody = document.querySelector("[data-products]");
  if (tableBody) {
    tableBody.innerHTML = `
      <tr>
        <td class="empty-row" colspan="7">${escapeHtml(message)}</td>
      </tr>
    `;
  }
  renderMobileCards([], message);
  renderResultCount(0);
}

function renderResultCount(count) {
  const total = filterBaseProducts().length;
  document.querySelectorAll("[data-result-count]").forEach((node) => {
    node.textContent = count > pageSize ? `显示 ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, count)} / ${count} 条` : `显示 ${count} / ${total} 条`;
  });
}

function renderSelectedCount() {
  document.querySelectorAll("[data-selected-count]").forEach((node) => {
    node.textContent = String(state.selected.size);
  });
  document.querySelectorAll("[data-open-compare]").forEach((button) => {
    button.disabled = state.selected.size < 2;
  });
}

function bindRowSelection() {
  document.querySelectorAll("[data-select]").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) state.selected.add(input.dataset.select);
      else state.selected.delete(input.dataset.select);
      const escapedKey = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(input.dataset.select) : input.dataset.select.replaceAll('"', '\\"');
      document.querySelectorAll(`[data-select="${escapedKey}"]`).forEach((peer) => {
        peer.checked = input.checked;
      });
      renderSelectedCount();
    });
  });
}

function syncActiveCategory() {
  document.querySelectorAll("[data-category]").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.category === state.activeCategory);
  });
  document.querySelectorAll("[data-ip-type]").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.ipType === state.filters.ipType);
  });
}

function renderIpDist() {
  const container = document.querySelector("[data-ip-dist]");
  if (!container) return;
  const products = filterBaseProducts();
  const total = products.length || 1;
  container.innerHTML = ipTypeCategories
    .map((cat) => {
      const count = products.filter((p) => p._ipType.value === cat.value).length;
      const pct = ((count / total) * 100).toFixed(1);
      return `
        <button class="dist-row" data-ip-type="${cat.value}" type="button">
          <span class="dist-dot" style="--c:${cat.dot}"></span>
          <span class="dist-name">${cat.label}</span>
          <span class="dist-track"><span class="dist-fill" style="--c:${cat.dot};width:${pct}%"></span></span>
          <span class="dist-count">${count}</span>
          <span class="dist-pct">${pct}%</span>
        </button>
      `;
    })
    .join("");
  container.querySelectorAll("[data-ip-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.filters.ipType = btn.dataset.ipType;
      syncFilterControls();
      renderTable(true);
      document.querySelector("#products")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  syncActiveCategory();
}

function renderCounts() {
  const counts = { all: state.products.length };
  for (const category of productCategories) {
    counts[category] = state.products.filter((p) => productCategory(p) === category).length;
  }

  for (const [category, count] of Object.entries(counts)) {
    setText(`[data-count-${category}]`, count);
    if (category === "unclassified") setHidden(`[data-category="${category}"]`, count === 0);
  }

  if (state.activeCategory !== "all" && counts[state.activeCategory] === 0) {
    state.activeCategory = "all";
  }
  syncActiveCategory();
  renderIpDist();
}

function renderSummary() {
  setText("[data-sync]", state.payload ? formatDateTime(state.payload.generatedAt) : "-");
  setText(
    "[data-monitor-summary]",
    state.payload
      ? `来源 ${state.payload.sourceCount} 个，记录 ${state.payload.summary.total} 条，可订购 ${state.payload.summary.available ?? 0} 条，不可订购 ${state.payload.summary.unavailable ?? 0} 条，被阻断 ${state.payload.summary.blocked ?? 0} 条，失败 ${state.payload.summary.error ?? 0} 条。`
      : dataLoadError || "监控数据尚未加载。"
  );

  const statusNodes = document.querySelectorAll("[data-monitor-status]");
  if (!state.payload) {
    statusNodes.forEach((status) => {
      status.textContent = dataLoadError ? "本站数据加载失败" : "加载监控数据中";
      status.classList.toggle("has-warning", Boolean(dataLoadError));
    });
    setText("[data-stat-total]", "-");
    setText("[data-stat-available]", "-");
    setText("[data-stat-unavailable]", "-");
    setText("[data-stat-sources]", "-");
    setText("[data-trust-state]", dataLoadError ? "本站监控数据不可用" : "等待真实监控数据");
    setText("[data-trust-age]", "-");
    setText("[data-trust-freshness]", dataLoadError ? "当前库存未知" : "加载中");

    return;
  }

  setText("[data-stat-total]", state.products.length);
  setText("[data-stat-available]", state.products.filter((p) => p.status === "available").length);
  setText("[data-stat-unavailable]", state.payload.summary.unavailable ?? 0);
  setText("[data-stat-sources]", state.payload.sourceCount);

  const directProblems = (state.payload.summary.blocked ?? 0) + (state.payload.summary.error ?? 0);
  const snapshotCount = state.products.filter((product) => product._evidenceBadge.value === "snapshot").length;
  const unavailableCount = state.products.filter((product) => product.status === "unavailable").length;
  const hasProblems = directProblems > 0;
  statusNodes.forEach((status) => {
    status.textContent = hasProblems ? "监控有异常源" : "监控正常";
    status.classList.toggle("has-warning", hasProblems);
  });

  setText("[data-trust-state]", `已加载 ${state.products.length} 条真实记录`);
  setText("[data-trust-age]", formatRelativeAge(state.payload.generatedAt));
  setText(
    "[data-trust-freshness]",
    snapshotCount > 0
      ? `${snapshotCount} 条第三方快照需复核`
      : unavailableCount > 0
        ? `${unavailableCount} 条不可订购`
        : "官方入口可核验"
  );

}

function renderSkeleton() {
  const tableBody = document.querySelector("[data-products]");
  if (!tableBody) return;
  tableBody.innerHTML = Array.from({ length: 8 }, (_, i) => `
    <tr class="skel-row">
      <td colspan="7"><span class="skel" style="width:${58 + (i % 3) * 12}%"></span></td>
    </tr>
  `).join("");
}

function openCompare() {
  const chosen = state.products.filter((product) => state.selected.has(product._stableKey));
  const grid = document.querySelector("[data-compare-grid]");
  if (!grid) return;
  grid.innerHTML = chosen
    .map(
      (product) => `
        <article class="compare-card">
          <h3>${escapeHtml(text(product.provider))}</h3>
          <p>${escapeHtml(text(product.name))}</p>
          <dl>
            <div><dt>区域</dt><dd>${escapeHtml(text(product.region))}</dd></div>
            <div><dt>类型</dt><dd>${escapeHtml(product._ipType.label)}</dd></div>
            <div><dt>线路</dt><dd>${escapeHtml(text(product.route))}</dd></div>
            <div><dt>配置</dt><dd>${escapeHtml(displayValue(product.hardware, "配置未标明"))}</dd></div>
            <div><dt>流量</dt><dd>${escapeHtml(displayValue(product.bandwidth, "流量未标明"))}</dd></div>
            <div><dt>价格</dt><dd>${escapeHtml(displayValue(product.price, "价格未标明"))}</dd></div>
            <div><dt>状态</dt><dd>${escapeHtml(text(product.statusLabel, statusLabels[product.status] ?? product.status))}</dd></div>
            <div><dt>证据</dt><dd>${escapeHtml(product._evidenceBadge.label)}</dd></div>
            <div><dt>风险</dt><dd class="detail-risk-tags">${renderRiskTags(product) || "—"}</dd></div>
            <div><dt>抓取</dt><dd>${escapeHtml(formatDateTime(product.fetchedAt))}</dd></div>
          </dl>
          <p class="evidence">${escapeHtml(text(product.evidence))}</p>
        </article>
      `
    )
    .join("");
  document.querySelector("[data-compare-dialog]")?.showModal();
}

function countedOptions(list, valueGetter, labelGetter = valueGetter) {
  const counts = new Map();
  for (const item of list) {
    const value = valueGetter(item);
    if (!value) continue;
    const current = counts.get(value) || { value, label: labelGetter(item), count: 0 };
    current.count += 1;
    counts.set(value, current);
  }
  return [...counts.values()].sort((a, b) => text(a.label, "").localeCompare(text(b.label, ""), "zh-CN"));
}

function populateSelect(selector, allLabel, options, currentValue) {
  document.querySelectorAll(selector).forEach((select) => {
    if (!(select instanceof HTMLSelectElement)) return;
    const previous = options.some((option) => option.value === currentValue) ? currentValue : "all";
    select.innerHTML = [
      `<option value="all">${escapeHtml(allLabel)}</option>`,
      ...options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(`${option.label} (${option.count})`)}</option>`)
    ].join("");
    select.value = previous;
  });
}

function validFilterValue(key, options) {
  if (state.filters[key] !== "all" && !options.some((option) => option.value === state.filters[key])) {
    state.filters[key] = "all";
  }
  return state.filters[key];
}

function hydrateFilterOptions() {
  const regionOptions = countedOptions(state.products, (product) => product.region);
  const providerOptions = countedOptions(state.products, (product) => product.provider);
  const ipTypeOptions = countedOptions(
    state.products,
    (product) => product._ipType.value,
    (product) => product._ipType.label
  ).sort((a, b) => ipTypeOrder.indexOf(a.value) - ipTypeOrder.indexOf(b.value));
  const statusOptions = countedOptions(
    state.products,
    (product) => product.status,
    (product) => statusLabels[product.status] ?? product.statusLabel ?? product.status
  ).sort((a, b) => statusRank(a.value) - statusRank(b.value));
  const priceOptions = priceBands
    .map((band) => ({
      value: band.value,
      label: band.label,
      count: state.products.filter((product) => priceBandFor(product) === band.value).length
    }))
    .filter((band) => band.count > 0);

  populateSelect("[data-filter-region]", "全部区域", regionOptions, validFilterValue("region", regionOptions));
  populateSelect("[data-filter-provider]", "全部商家", providerOptions, validFilterValue("provider", providerOptions));
  populateSelect("[data-filter-ip-type]", "全部 IP 类型", ipTypeOptions, validFilterValue("ipType", ipTypeOptions));
  populateSelect("[data-filter-status]", "全部状态", statusOptions, validFilterValue("status", statusOptions));
  const currencyOptions = countedOptions(state.products, (p) => priceQuote(p).currency);
  populateSelect("[data-filter-currency]", "全部币种", currencyOptions, validFilterValue("currency", currencyOptions));
  populateSelect("[data-filter-price]", "全部价格", priceOptions, validFilterValue("price", priceOptions));
}

function syncFilterControls() {
  document.querySelectorAll("[data-search]").forEach((input) => {
    input.value = state.filters.search;
  });
  const selectBindings = [
    ["[data-filter-region]", state.filters.region],
    ["[data-filter-provider]", state.filters.provider],
    ["[data-filter-ip-type]", state.filters.ipType],
    ["[data-filter-status]", state.filters.status],
    ["[data-filter-price]", state.filters.price],
    ["[data-filter-currency]", state.filters.currency]
  ];
  for (const [selector, value] of selectBindings) {
    document.querySelectorAll(selector).forEach((select) => {
      if ("value" in select) select.value = value;
    });
  }
}

function resetFilters() {
  state.filters.search = "";
  state.filters.region = "all";
  state.filters.provider = "all";
  state.filters.ipType = "all";
  state.filters.status = "all";
  state.filters.price = "all";
  state.filters.currency = "all";
  syncFilterControls();
  renderTable(true);
}

const debouncedRender = debounce(() => renderTable(true), 200);

function syncTableSortIndicator() {
  document.querySelectorAll("[data-sort-col]").forEach((th) => {
    th.classList.toggle("is-active", th.dataset.sortCol === state.activeSort);
  });
}

function bindFilterControl(selector, key) {
  document.querySelectorAll(selector).forEach((control) => {
    const eventName = key === "search" ? "input" : "change";
    control.addEventListener(eventName, (event) => {
      state.filters[key] = event.target.value;
      if (key === "search") debouncedRender();
      else renderTable(true);
    });
  });
}

function bindControls() {
  document.querySelectorAll("[data-mobile-filter-toggle]").forEach((button) => button.addEventListener("click", () => {
    const expanded = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(expanded));
    button.textContent = expanded ? "收起筛选" : "展开筛选";
    document.querySelector(".filter-bar")?.classList.toggle("filters-expanded", expanded);
  }));
  document.querySelectorAll("form.filter-bar, form.directory-filters").forEach((form) => form.addEventListener("submit", (event) => event.preventDefault()));
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  document.querySelectorAll("[data-page-prev], [data-page-next]").forEach((button) => button.addEventListener("click", () => { page += button.hasAttribute("data-page-next") ? 1 : -1; renderTable(); document.querySelector("#products")?.scrollIntoView({ block: "start" }); }));
  bindDirectory({ showInventory(provider) { state.activeCategory = "all"; resetFilters(); state.filters.provider = provider.inventoryNames.find((name) => state.products.some((p) => p.provider === name)) || "all"; syncFilterControls(); showView("inventory"); renderTable(true); document.querySelector("#products")?.scrollIntoView({ block: "start" }); } });
  document.querySelectorAll("[data-category]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeCategory = button.dataset.category;
      resetFilters();
      renderIpDist();
      document.querySelector("#products")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  document.querySelectorAll("[data-sort]").forEach((sort) => {
    sort.addEventListener("change", (event) => {
      state.activeSort = event.target.value;
      syncTableSortIndicator();
      renderTable(true);
    });
  });

  document.querySelectorAll("[data-sort-col]").forEach((th) => {
    th.addEventListener("click", () => {
      state.activeSort = th.dataset.sortCol;
      document.querySelectorAll("[data-sort]").forEach((sel) => {
        if (sel instanceof HTMLSelectElement) sel.value = state.activeSort;
      });
      syncTableSortIndicator();
      renderTable(true);
    });
  });

  bindFilterControl("[data-search]", "search");
  bindFilterControl("[data-filter-region]", "region");
  bindFilterControl("[data-filter-provider]", "provider");
  bindFilterControl("[data-filter-ip-type]", "ipType");
  bindFilterControl("[data-filter-status]", "status");
  bindFilterControl("[data-filter-price]", "price");
  bindFilterControl("[data-filter-currency]", "currency");

  document.querySelectorAll("[data-filter-reset]").forEach((button) => {
    button.addEventListener("click", resetFilters);
  });
  document.querySelectorAll("[data-refresh]").forEach((button) => {
    button.addEventListener("click", () => loadMonitorData());
  });
  document.querySelectorAll("[data-open-compare]").forEach((button) => {
    button.addEventListener("click", openCompare);
  });
  document.querySelectorAll("[data-clear-compare]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selected.clear();
      renderTable(false);
    });
  });

  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const command = button.dataset.copy;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(command);
        } else {
          const textarea = document.createElement("textarea");
          textarea.value = command;
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.append(textarea);
          textarea.select();
          document.execCommand("copy");
          textarea.remove();
        }
        const original = button.textContent;
        button.textContent = "已复制";
        window.setTimeout(() => {
          button.textContent = original;
        }, 1200);
      } catch {
        button.textContent = "复制失败";
      }
    });
  });

  const toTop = document.querySelector("[data-to-top]");
  if (toTop) {
    window.addEventListener(
      "scroll",
      () => {
        toTop.classList.toggle("is-visible", window.scrollY > 500);
      },
      { passive: true }
    );
    toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    btn.addEventListener("click", toggleTheme);
  });
  syncThemeToggle();
}

async function loadMonitorData() {
  dataLoadError = "";
  if (!state.payload) {
    renderSummary();
    renderMobileCards([], "加载监控数据中…");
  }
  renderSkeleton();
  try {
    const response = await fetch(`data/products.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.payload = await response.json();
    state.records = Array.isArray(state.payload.products) ? state.payload.products : [];
    state.products = state.records.filter((p) => !p.diagnostic && !["blocked", "error"].includes(p.status)).map(normalizeProduct);
    renderDirectory(state.records, true);
    state.selected.clear();
    hydrateFilterOptions();
    syncFilterControls();
    renderCounts();
    renderSummary();
    renderTable(true);
  } catch (error) {
    dataLoadError = `本站监控数据加载失败：${error.message}。当前库存未知。`;
    state.payload = null;
    state.products = [];
    state.records = [];
    renderDirectory([], false);
    state.selected.clear();
    hydrateFilterOptions();
    renderCounts();
    renderSummary();
    renderEmpty(dataLoadError);
    renderSelectedCount();
  }
}

function showView(view) {
  activeView = view === "providers" ? "providers" : "inventory";
  setHidden("[data-inventory-view]", activeView !== "inventory");
  setHidden("[data-directory-view]", activeView !== "providers");
  setText("[data-view-title]", activeView === "providers" ? "VPS 厂商目录" : "VPS 库存与价格");
  document.querySelectorAll(".primary-nav [data-view]").forEach((button) => { button.classList.toggle("is-active", button.dataset.view === activeView); button.setAttribute("aria-current", button.dataset.view === activeView ? "page" : "false"); });
  syncQuery();
}
function syncQuery() {
  const url = new URL(window.location.href);
  for (const key of ["view", "category", "q", "region", "provider", "ipType", "status", "currency", "sort"]) url.searchParams.delete(key);
  if (activeView === "providers") url.searchParams.set("view", "providers");
  if (state.activeCategory !== "all") url.searchParams.set("category", state.activeCategory);
  for (const [key, value] of Object.entries(state.filters)) if (value && value !== "all" && key !== "price") url.searchParams.set(key === "search" ? "q" : key, value);
  if (state.activeSort !== "recommend") url.searchParams.set("sort", state.activeSort);
  window.history?.replaceState(null, "", url.href);
}
function readQuery() {
  const query = new URL(window.location.href).searchParams;
  activeView = query.get("view") === "providers" ? "providers" : "inventory";
  state.activeCategory = productCategories.includes(query.get("category")) ? query.get("category") : "all";
  state.activeSort = ["price", "stock", "updated"].includes(query.get("sort")) ? query.get("sort") : "recommend";
  for (const key of ["search", "region", "provider", "ipType", "status", "currency"]) state.filters[key] = query.get(key === "search" ? "q" : key) || (key === "search" ? "" : "all");
  document.querySelectorAll("[data-sort]").forEach((select) => { select.value = state.activeSort; });
}

readQuery();
renderSummary();
bindControls();
renderDirectory([], false);
showView(activeView);
loadMonitorData();
