import { state } from "./state.js";
import { setText, setHidden, countUp, refreshClock, debounce, formatDateTime, formatRelativeAge, text, escapeHtml, safeUrl } from "./util.js";
import { statusLabels, categoryNames, productCategories, productCategory, ipTypeCategories, ipTypeOrder, priceBands, statusClass, statusRank, normalizeProduct, priceBandFor, numericStockCount } from "./product.js";
import { filterBaseProducts, visibleProducts } from "./filter.js";

let dataLoadError = "";

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
      <td colspan="11">
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

function renderTable(animate = false) {
  syncActiveCategory();
  document.querySelectorAll("[data-title-category]").forEach((node) => {
    node.textContent = categoryNames[state.activeCategory];
  });
  syncTableSortIndicator();
  const list = visibleProducts();
  if (list.length === 0) {
    renderEmpty(dataLoadError || "没有符合当前筛选条件的真实监控记录。");
    renderSelectedCount();
    return;
  }

  const tableBody = document.querySelector("[data-products]");
  if (tableBody) {
    tableBody.innerHTML = list
      .map((product) => {
        const checked = state.selected.has(product._stableKey) ? "checked" : "";
        const isOpen = state.expanded.has(product._stableKey);
        const isActionable = product.status === "available" && product.orderUrl;
        const href = productHref(product);
        const actionText = isActionable ? "直达购买" : "查看源";
        const ipType = product._ipType;
        const main = `
          <tr data-key="${escapeHtml(product._stableKey)}" class="${isOpen ? "is-open" : ""}">
            <td class="cell-check"><span class="cell-compare-bar"></span><input data-select="${escapeHtml(product._stableKey)}" type="checkbox" ${checked} aria-label="选择 ${escapeHtml(text(product.provider))} ${escapeHtml(text(product.name))} 对比" /></td>
            <td class="cell-rec">${product.recommended ? '<span class="rec">推荐</span>' : '<span class="dash">—</span>'}</td>
            <td class="cell-product">
              <a class="prov" href="${escapeHtml(href)}" target="_blank" rel="nofollow sponsored noopener">${escapeHtml(text(product.provider))}</a>
              <span class="prov-sub">${escapeHtml(text(product.name))}</span>
              <span class="prov-sub">${escapeHtml(categoryNames[productCategory(product)])}</span>
            </td>
            <td>${escapeHtml(text(product.region))}</td>
            <td class="cell-note">${escapeHtml(text(product.note || product.evidence))}</td>
            <td><span class="chip chip-ip ${escapeHtml(ipType.className)}">${escapeHtml(ipType.label)}</span></td>
            <td>${escapeHtml(text(product.route))}</td>
            <td class="cell-spec">${renderSpecCell(product)}</td>
            <td class="cell-price"><strong>${escapeHtml(displayValue(product.price, "价格未标明"))}</strong></td>
            <td class="cell-status">
              <span class="chip chip-status ${escapeHtml(statusClass(product.status))}">${escapeHtml(text(product.statusLabel, statusLabels[product.status] ?? product.status))}</span>
              ${renderEvidenceBadge(product)}
              ${renderRiskTags(product)}
            </td>
            <td><a class="link ${isActionable ? "" : "is-soft"}" href="${escapeHtml(href)}" target="_blank" rel="nofollow sponsored noopener">${actionText}</a></td>
          </tr>
        `;
        return isOpen ? main + detailRowHtml(product) : main;
      })
      .join("");

    tableBody.querySelectorAll("tr:not(.row-detail)").forEach((tr, i) => {
      if (animate) {
        tr.style.animation = "fadeUp 0.34s cubic-bezier(.4,0,.2,1) both";
        tr.style.animationDelay = `${Math.min(i, 14) * 16}ms`;
      } else {
        tr.style.animation = "none";
      }
    });
  }
  renderMobileCards(list);
  renderResultCount(list.length);
  bindRowSelection();
  renderSelectedCount();
}

function toggleRow(tr) {
  const key = tr.dataset.key;
  if (!key) return;
  const product = state.products.find((item) => item._stableKey === key);
  if (!product) return;
  if (state.expanded.has(key)) {
    state.expanded.delete(key);
    tr.classList.remove("is-open");
    const next = tr.nextElementSibling;
    if (next && next.classList.contains("row-detail")) next.remove();
  } else {
    state.expanded.add(key);
    tr.classList.add("is-open");
    tr.insertAdjacentHTML("afterend", detailRowHtml(product));
  }
}

function renderMobileCards(list, emptyMessage = "没有符合当前筛选条件的真实监控记录。") {
  const container = document.querySelector("[data-mobile-products]");
  if (!container) return;
  if (list.length === 0) {
    container.innerHTML = `<p class="empty-row">${escapeHtml(emptyMessage)}</p>`;
    return;
  }
  container.innerHTML = list
    .map((product) => {
      const checked = state.selected.has(product._stableKey) ? "checked" : "";
      const isActionable = product.status === "available" && product.orderUrl;
      const href = productHref(product);
      const actionText = isActionable ? "直达购买" : "查看源";
      return `
        <article class="mobile-product-card">
          <div class="mobile-card-head">
            <label>
              <input data-select="${escapeHtml(product._stableKey)}" type="checkbox" ${checked} aria-label="选择 ${escapeHtml(text(product.provider))} ${escapeHtml(text(product.name))} 对比" />
              <span>${escapeHtml(text(product.provider))}</span>
            </label>
            ${product.recommended ? '<span class="rec">推荐</span>' : ""}
          </div>
          <h3>${escapeHtml(text(product.name))}</h3>
          <p>${escapeHtml(text(product.note || product.evidence))}</p>
          <dl>
            <div><dt>区域</dt><dd>${escapeHtml(text(product.region))}</dd></div>
            <div><dt>产品类别</dt><dd>${escapeHtml(categoryNames[productCategory(product)])}</dd></div>
            <div><dt>IP 特征</dt><dd><span class="chip chip-ip ${escapeHtml(product._ipType.className)}">${escapeHtml(product._ipType.label)}</span></dd></div>
            <div><dt>线路</dt><dd>${escapeHtml(text(product.route))}</dd></div>
            <div><dt>配置</dt><dd>${escapeHtml(displayValue(product.hardware, "配置未标明"))}</dd></div>
            <div><dt>流量</dt><dd>${escapeHtml(displayValue(product.bandwidth, "流量未标明"))}</dd></div>
            <div><dt>价格</dt><dd><strong>${escapeHtml(displayValue(product.price, "价格未标明"))}</strong></dd></div>
            <div><dt>状态</dt><dd><span class="chip chip-status ${escapeHtml(statusClass(product.status))}">${escapeHtml(text(product.statusLabel, statusLabels[product.status] ?? product.status))}</span></dd></div>
            <div><dt>证据</dt><dd>${renderEvidenceBadge(product)}</dd></div>
            <div><dt>风险</dt><dd class="detail-risk-tags">${renderRiskTags(product) || "—"}</dd></div>
          </dl>
          <a class="link ${isActionable ? "" : "is-soft"}" href="${escapeHtml(href)}" target="_blank" rel="nofollow sponsored noopener">${actionText}</a>
        </article>
      `;
    })
    .join("");
}

function renderEmpty(message) {
  const tableBody = document.querySelector("[data-products]");
  if (tableBody) {
    tableBody.innerHTML = `
      <tr>
        <td class="empty-row" colspan="11">${escapeHtml(message)}</td>
      </tr>
    `;
  }
  renderMobileCards([], message);
  renderResultCount(0);
}

function renderResultCount(count) {
  const total = filterBaseProducts().length;
  document.querySelectorAll("[data-result-count]").forEach((node) => {
    node.textContent = `显示 ${count} / ${total} 条`;
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
    renderRing();
    return;
  }

  countUp(document.querySelector("[data-stat-total]"), state.payload.summary.total);
  countUp(document.querySelector("[data-stat-available]"), state.payload.summary.available ?? 0);
  countUp(document.querySelector("[data-stat-unavailable]"), state.payload.summary.unavailable ?? 0);
  countUp(document.querySelector("[data-stat-sources]"), state.payload.sourceCount);

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
  renderRing();
}

function renderRing() {
  const ring = document.querySelector("[data-ring]");
  const pctEl = document.querySelector("[data-ring-pct]");
  if (!ring || !pctEl) return;
  const C = 2 * Math.PI * 52;
  if (!state.payload) {
    ring.style.strokeDashoffset = String(C);
    pctEl.textContent = "-";
    return;
  }
  const total = state.payload.summary.total || 1;
  const avail = state.payload.summary.available ?? 0;
  const pct = avail / total;
  ring.style.strokeDashoffset = String(C * (1 - pct));
  pctEl.textContent = `${Math.round(pct * 100)}%`;
}

function renderSkeleton() {
  const tableBody = document.querySelector("[data-products]");
  if (!tableBody) return;
  tableBody.innerHTML = Array.from({ length: 8 }, (_, i) => `
    <tr class="skel-row">
      <td colspan="11"><span class="skel" style="width:${58 + (i % 3) * 12}%"></span></td>
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
    ["[data-filter-price]", state.filters.price]
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
  syncFilterControls();
  renderTable(true);
}

const debouncedRender = debounce(() => renderTable(false), 200);

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
      else renderTable(false);
    });
  });
}

function bindControls() {
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

  const tableBody = document.querySelector("[data-products]");
  tableBody?.addEventListener("click", (event) => {
    const tr = event.target.closest("tr");
    if (!tr || !tableBody.contains(tr) || tr.classList.contains("row-detail")) return;
    if (event.target.closest("input, a, button")) return;
    toggleRow(tr);
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
  refreshClock();
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
    state.products = Array.isArray(state.payload.products) ? state.payload.products.map(normalizeProduct) : [];
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
    state.selected.clear();
    hydrateFilterOptions();
    renderCounts();
    renderSummary();
    renderEmpty(dataLoadError);
    renderSelectedCount();
  }
}

refreshClock();
renderSummary();
bindControls();
loadMonitorData();
setInterval(refreshClock, 1000);
