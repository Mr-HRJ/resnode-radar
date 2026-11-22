import { providers } from "../../providers.js";
import {
  SORT_OPTIONS,
  computeFacetCounts,
  diagnoseZeroResults,
  listActiveFilterBadges,
  matchesFilters,
  sortProducts
} from "../domain/catalog.js";
import {
  BUDGET_OPTIONS,
  CYCLE_OPTIONS,
  MACRO_REGIONS,
  ROUTE_OPTIONS,
  escapeHtml,
  formatEventDelta,
  fxFreshness,
  plain,
  safeUrl
} from "../domain/format.js";

function renderStockEvidenceCell(plan) {
  if (plan.status === "available") {
    if (plan._isExactStock) {
      return `<div class="stock-stack">
        <span class="pill pill-ok num"><span class="status-dot is-live" aria-hidden="true"></span>余 ${plan.stockCount}</span>
        <span class="stock-sub">精确库存</span>
      </div>`;
    }
    if (plan._isSnapshot) {
      return `<div class="stock-stack">
        <span class="pill pill-warn">快照有货</span>
        <span class="stock-sub">第三方快照</span>
      </div>`;
    }
    return `<div class="stock-stack">
      <span class="pill pill-ok">可订购</span>
      <span class="stock-sub">官方入口 · 未报数</span>
    </div>`;
  }
  if (plan.status === "unavailable") {
    return `<div class="stock-stack">
      <span class="pill pill-danger">售罄</span>
      <span class="stock-sub">不可订购</span>
    </div>`;
  }
  return `<div class="stock-stack">
    <span class="pill pill-neutral pill-outline">未公开</span>
    <span class="stock-sub">需进官网核验</span>
  </div>`;
}

function renderEventSpark(plan, now = Date.now()) {
  const ev = plan._latestEvent;
  if (!ev) return "";
  const ageMs = now - (Date.parse(ev.at) || 0);
  if (ageMs > 72 * 3600 * 1000) return "";
  if (ev.type === "restock") {
    return `<span class="pill pill-ok" title="近 72h 观测到补货">↑补货</span>`;
  }
  if (ev.type === "price") {
    const delta = formatEventDelta(ev);
    if (delta?.direction === "down") {
      return `<span class="pill pill-ok num" title="近 72h 降价">↓${escapeHtml(delta.label)}</span>`;
    }
    if (delta?.direction === "up") {
      return `<span class="pill pill-danger num" title="近 72h 涨价">↑${escapeHtml(delta.label)}</span>`;
    }
  }
  return "";
}

function renderSpecsParts(plan) {
  const s = plan._specs;
  const cpuMem = [s.cpu, s.memory].filter((v) => v && v !== "未标明").join(" · ");
  const disk = s.disk && s.disk !== "未标明" ? s.disk : "";
  const fallbackHw = plain(plan.hardware);
  const hasStructuredHw = Boolean(cpuMem || disk);

  const hwPrimary = hasStructuredHw ? cpuMem || disk : fallbackHw || "";
  const hwSecondary = hasStructuredHw && cpuMem && disk ? disk : "";

  const bw = s.bandwidth && s.bandwidth !== "未标明" ? s.bandwidth : "";
  const traffic = s.traffic && s.traffic !== "未标明" ? s.traffic : "";
  const fallbackNet = plain(plan.bandwidth);
  const hasStructuredNet = Boolean(bw || traffic);

  const netPrimary = hasStructuredNet ? bw || traffic : fallbackNet || "";
  const netSecondary = hasStructuredNet && bw && traffic ? traffic : "";

  return {
    hwPrimary,
    hwSecondary,
    netPrimary,
    netSecondary,
    compactHw: [s.cpu, s.memory, s.disk].filter((v) => v && v !== "未标明").join(" · ") || fallbackHw || "配置未标明",
    compactNet: [s.bandwidth, s.traffic].filter((v) => v && v !== "未标明").join(" · ") || fallbackNet || "带宽流量未标明"
  };
}

function renderRegionSummary(plan) {
  const regions = plan._regions || [];
  if (regions.length === 0) return `<span class="region-tag"><span class="iso-code">--</span> 地区待核验</span>`;
  const primary = regions[0];
  const extra = regions.length > 1 ? ` +${regions.length - 1}` : "";
  const iso = plan._macroRegions?.[0] === "MULTI" ? "GL" : plan._macroRegions?.[0] === "APAC" ? "AP" : plan._macroRegions?.[0] || "GL";
  return `<span class="region-tag" title="${escapeHtml(regions.join(" / "))}"><span class="iso-code">${escapeHtml(iso)}</span> ${escapeHtml(primary)}${escapeHtml(extra)}</span>`;
}

function renderNetworkBadges(plan) {
  const c = plan._classify;
  const badges = [];
  badges.push(
    `<span class="pill ${c.isResidential ? "pill-home" : "pill-vps"}">${escapeHtml(c.ipTier.label)}</span>`
  );
  if (c.routes.length > 0) {
    for (const r of c.routes.slice(0, 2)) {
      badges.push(`<span class="pill">${escapeHtml(r)}</span>`);
    }
  } else {
    const rawRoute = plain(plan.route);
    if (rawRoute && !/以所选机房为准|默认|未知|待核验/i.test(rawRoute)) {
      badges.push(`<span class="pill route-pill" title="${escapeHtml(rawRoute)}">${escapeHtml(rawRoute)}</span>`);
    }
  }
  if (c.isNat) {
    badges.push(`<span class="pill pill-warn" title="NAT 共享 IPv4 / 动态端口">NAT/共享</span>`);
  } else if (plan._isSnapshot) {
    badges.push(`<span class="pill pill-warn" title="第三方 Reader 公开快照">快照</span>`);
  }
  return badges.join("");
}

function renderPriceStack(plan, align = "right") {
  const p = plan._pricing;
  const subClass =
    p.cnyTone === "ok"
      ? "price-sub"
      : p.cnyTone === "warn"
        ? "price-sub is-warn"
        : "price-sub is-muted";
  return `<div class="${align === "right" ? "price-stack" : "plan-card-price"}">
    <span class="price-primary num">${escapeHtml(p.originalLabel)}</span>
    <span class="${subClass} num" title="${escapeHtml(p.formula || p.honestReason || "")}">${escapeHtml(p.cnyLabel)}</span>
  </div>`;
}

function renderTableRow(plan, state, now) {
  const isSaved = state.savedKeys.has(plan._key);
  const isCompared = state.compareKeys.includes(plan._key);
  const isInspected = state.inspectId === plan.id;
  const sp = renderSpecsParts(plan);
  const orderHref = safeUrl(plan.orderUrl);

  return `
    <tr class="${isInspected ? "is-inspected" : ""}" data-action="inspect-plan" data-product-id="${escapeHtml(plan.id)}">
      <td class="col-plan">
        <div class="plan-cell ${plan._classify.isResidential ? "is-home" : ""}">
          <div class="plan-title" title="${escapeHtml(plain(plan.name))}">${escapeHtml(plain(plan.name))}</div>
          <div class="plan-meta-row">
            <span class="provider-tag">${escapeHtml(plan._providerName)}</span>
            <span>·</span>
            ${renderRegionSummary(plan)}
            ${renderEventSpark(plan, now)}
          </div>
        </div>
      </td>
      <td class="col-net">
        <div class="net-stack">${renderNetworkBadges(plan)}</div>
      </td>
      <td class="col-hw">
        <div class="spec-stack">
          ${
            sp.hwPrimary
              ? `<span class="spec-line" title="${escapeHtml(sp.compactHw)}">${escapeHtml(sp.hwPrimary)}</span>`
              : `<span class="spec-line is-missing">配置未标明</span>`
          }
          ${sp.hwSecondary ? `<span class="spec-line is-sub" title="${escapeHtml(sp.hwSecondary)}">${escapeHtml(sp.hwSecondary)}</span>` : ""}
        </div>
      </td>
      <td class="col-bw">
        <div class="spec-stack">
          ${
            sp.netPrimary
              ? `<span class="spec-line" title="${escapeHtml(sp.compactNet)}">${escapeHtml(sp.netPrimary)}</span>`
              : `<span class="spec-line is-missing">未标明</span>`
          }
          ${sp.netSecondary ? `<span class="spec-line is-sub" title="${escapeHtml(sp.netSecondary)}">${escapeHtml(sp.netSecondary)}</span>` : ""}
        </div>
      </td>
      <td class="col-price">${renderPriceStack(plan, "right")}</td>
      <td class="col-stock">${renderStockEvidenceCell(plan)}</td>
      <td class="col-act">
        <div class="row-actions" data-stop-row>
          <button type="button" class="btn btn-icon btn-xs btn-star ${isSaved ? "is-active" : ""}" data-action="toggle-save" data-key="${escapeHtml(plan._key)}" aria-label="${isSaved ? "取消收藏" : "收藏套餐"}" aria-pressed="${isSaved}" title="${isSaved ? "取消收藏" : "收藏"}">★</button>
          <button type="button" class="btn btn-icon btn-xs ${isCompared ? "is-active" : ""}" data-action="toggle-compare" data-key="${escapeHtml(plan._key)}" aria-label="${isCompared ? "移出对比" : "加入对比"}" aria-pressed="${isCompared}" title="${isCompared ? "移出对比" : "加入对比"}">⇄</button>
          ${
            orderHref
              ? `<a class="btn btn-icon btn-xs" href="${escapeHtml(orderHref)}" target="_blank" rel="nofollow noopener noreferrer" aria-label="前往官方订购页" title="直达官方下单 ↗">↗</a>`
              : `<button type="button" class="btn btn-icon btn-xs" data-action="inspect-plan" data-product-id="${escapeHtml(plan.id)}" aria-label="查看证据详情" title="查看证据详情">···</button>`
          }
        </div>
      </td>
    </tr>
  `;
}

function renderPlanCard(plan, state, now) {
  const isSaved = state.savedKeys.has(plan._key);
  const isCompared = state.compareKeys.includes(plan._key);
  const isInspected = state.inspectId === plan.id;
  const sp = renderSpecsParts(plan);
  const orderHref = safeUrl(plan.orderUrl);

  return `
    <article class="plan-card ${plan._classify.isResidential ? "is-home" : ""} ${isInspected ? "is-inspected" : ""}" data-action="inspect-plan" data-product-id="${escapeHtml(plan.id)}">
      <div class="plan-card-top">
        <div class="plan-card-vendor">
          <strong>${escapeHtml(plan._providerName)}</strong>
          <span>·</span>
          ${renderRegionSummary(plan)}
        </div>
        ${renderStockEvidenceCell(plan)}
      </div>

      <div class="plan-title" title="${escapeHtml(plain(plan.name))}">${escapeHtml(plain(plan.name))}</div>

      <div class="net-stack">
        ${renderNetworkBadges(plan)}
        ${renderEventSpark(plan, now)}
      </div>

      <div class="plan-card-specs">
        <span title="${escapeHtml(sp.compactHw)}">⚙ ${escapeHtml(sp.compactHw)}</span>
        <span title="${escapeHtml(sp.compactNet)}">⇄ ${escapeHtml(sp.compactNet)}</span>
      </div>

      <div class="plan-card-foot">
        ${renderPriceStack(plan, "left")}
        <div class="row-actions" data-stop-row>
          <button type="button" class="btn btn-sm btn-star ${isSaved ? "is-active" : ""}" data-action="toggle-save" data-key="${escapeHtml(plan._key)}" aria-label="${isSaved ? "取消收藏" : "收藏"}" aria-pressed="${isSaved}">★</button>
          <button type="button" class="btn btn-sm ${isCompared ? "is-active" : ""}" data-action="toggle-compare" data-key="${escapeHtml(plan._key)}" aria-label="${isCompared ? "移出对比" : "加入对比"}" aria-pressed="${isCompared}">⇄</button>
          ${
            orderHref
              ? `<a class="btn btn-sm btn-soft" href="${escapeHtml(orderHref)}" target="_blank" rel="nofollow noopener noreferrer">下单 ↗</a>`
              : `<button type="button" class="btn btn-sm" data-action="inspect-plan" data-product-id="${escapeHtml(plan.id)}">证据</button>`
          }
        </div>
      </div>
    </article>
  `;
}

function countAdvancedActive(f) {
  let n = 0;
  if (f.status !== "available" && f.status !== "all") n += 1;
  if (f.cycle !== "all") n += 1;
  if (f.noSnapshot) n += 1;
  if (f.fixedPriceOnly) n += 1;
  if (f.savedOnly) n += 1;
  return n;
}

function renderTopFilterDock(state, facets, matchedCount, visibleCount, now) {
  const f = state.filters;
  const fx = state.payload ? fxFreshness(state.payload.exchangeRates, now) : { valid: true };
  const activeBadges = listActiveFilterBadges(f).filter(
    (b) => !["exactOnly", "noNat"].includes(b.key) && !(b.key === "status" && f.status === "all")
  );
  const advCount = countAdvancedActive(f);

  const sortedProviders = [...providers].sort((a, b) => {
    const ca = facets.providerCounts.get(a.id) || 0;
    const cb = facets.providerCounts.get(b.id) || 0;
    return cb - ca || a.name.localeCompare(b.name, "zh-CN");
  });

  const advPopover = state.advancedOpen
    ? `<div class="adv-popover" role="dialog" aria-label="高级筛选与快捷预设" data-adv-popover>
        <div class="adv-group">
          <div class="rail-heading"><span>一键场景预设</span></div>
          <div class="preset-strip">
            <button type="button" class="preset-chip" data-action="apply-preset" data-preset="us-home-dedicated">美区家宽（排除 NAT 标记）</button>
            <button type="button" class="preset-chip" data-action="apply-preset" data-preset="cn2-opt">CN2 GIA 优化</button>
            <button type="button" class="preset-chip" data-action="apply-preset" data-preset="budget-monthly">≤¥60 明码月付</button>
            <button type="button" class="preset-chip" data-action="apply-preset" data-preset="exact-stock">仅精确库存</button>
          </div>
        </div>

        <div class="adv-group">
          <div class="rail-heading"><span>库存状态细项</span></div>
          <select class="select-field" data-filter-select="status" aria-label="详细库存状态筛选">
            <option value="available" ${f.status === "available" ? "selected" : ""}>仅看可购 (available)</option>
            <option value="all" ${f.status === "all" ? "selected" : ""}>全部状态（含售罄与未公开）</option>
            <option value="unavailable" ${f.status === "unavailable" ? "selected" : ""}>仅看售罄 (unavailable)</option>
            <option value="unknown" ${f.status === "unknown" ? "selected" : ""}>仅看库存未公开 (unknown)</option>
          </select>
        </div>

        <div class="adv-group">
          <div class="rail-heading"><span>计费周期</span></div>
          <div class="facet-wrap">
            ${CYCLE_OPTIONS.map(
              (c) => `<button type="button" class="facet-btn ${f.cycle === c.value ? "is-active" : ""}" data-action="set-cycle" data-cycle="${c.value}">
                <span class="facet-btn-label">${c.label}</span>
              </button>`
            ).join("")}
          </div>
        </div>

        <div class="adv-group">
          <div class="rail-heading"><span>风险与证据过滤</span></div>
          <div class="check-list">
            <label class="check-row">
              <span class="check-row-left">
                <input type="checkbox" data-filter-toggle="noSnapshot" ${f.noSnapshot ? "checked" : ""} />
                <span>排除第三方快照（如 Cloudflare 回退源）</span>
              </span>
            </label>
            <label class="check-row">
              <span class="check-row-left">
                <input type="checkbox" data-filter-toggle="fixedPriceOnly" ${f.fixedPriceOnly ? "checked" : ""} />
                <span>排除起步选配价与周期未明套餐</span>
              </span>
            </label>
            <label class="check-row">
              <span class="check-row-left">
                <input type="checkbox" data-filter-toggle="savedOnly" ${f.savedOnly ? "checked" : ""} />
                <span>仅看本地收藏夹</span>
              </span>
              <span class="check-row-count num">${state.savedKeys.size}</span>
            </label>
          </div>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;padding-top:6px;border-top:1px solid var(--border-subtle)">
          <button type="button" class="btn btn-xs btn-ghost" data-action="reset-filters">重置全部条件</button>
          <button type="button" class="btn btn-xs btn-primary" data-action="close-advanced">完成</button>
        </div>
      </div>`
    : "";

  return `
    <section class="filter-dock" aria-label="顶置筛选与排序工作台" data-filter-dock>
      <div class="dock-row-primary">
        <div class="track-seg-inline" role="group" aria-label="按节点本质隔离筛选">
          <button type="button" class="track-inline-btn ${f.track === "all" ? "is-active" : ""}" data-track="all" data-action="set-track">
            <span>全部</span><span class="track-num num">${facets.tracks.all}</span>
          </button>
          <button type="button" class="track-inline-btn ${f.track === "home" ? "is-active" : ""}" data-track="home" data-action="set-track">
            <span>真家宽</span><span class="track-num num">${facets.tracks.home}</span>
          </button>
          <button type="button" class="track-inline-btn ${f.track === "vps" ? "is-active" : ""}" data-track="vps" data-action="set-track">
            <span>机房优化</span><span class="track-num num">${facets.tracks.vps}</span>
          </button>
        </div>

        <div class="input-wrap dock-search">
          <input
            type="search"
            class="input-field ${f.q ? "has-clear" : ""}"
            data-terminal-search
            value="${escapeHtml(f.q)}"
            placeholder="筛选关键词（商家/套餐/线路/配置）…"
            aria-label="筛选套餐关键词"
          />
          ${f.q ? `<button type="button" class="input-clear-btn" data-action="clear-search" aria-label="清空搜索">×</button>` : ""}
        </div>

        <select class="select-field dock-select ${f.region !== "all" ? "is-filtered" : ""}" data-filter-select="region" aria-label="按地区筛选">
          ${MACRO_REGIONS.map((r) => {
            const cnt = facets.regions.get(r.value) || 0;
            const code = r.value === "MULTI" ? "GL" : r.value === "APAC" ? "AP" : r.value;
            const lbl = r.value === "all" ? "地区：全部" : `${code} ${r.label} (${cnt})`;
            return `<option value="${r.value}" ${f.region === r.value ? "selected" : ""}>${escapeHtml(lbl)}</option>`;
          }).join("")}
        </select>

        <select class="select-field dock-select ${f.route !== "all" ? "is-filtered" : ""}" data-filter-select="route" aria-label="按回程线路筛选">
          ${ROUTE_OPTIONS.map((r) => {
            const cnt = facets.routes.get(r.value) || 0;
            const lbl = r.value === "all" ? "线路：全部" : `${r.label} (${cnt})`;
            return `<option value="${r.value}" ${f.route === r.value ? "selected" : ""}>${escapeHtml(lbl)}</option>`;
          }).join("")}
        </select>

        <select class="select-field dock-select ${f.budget !== "all" ? "is-filtered" : ""}" data-filter-select="budget" aria-label="按月均人民币预算筛选" title="${!fx.valid ? "ECB 汇率已超 7 天，外币套餐已停算 CNY" : "按参考月均人民币筛选"}">
          ${BUDGET_OPTIONS.map((b) => {
            const lbl = b.value === "all" ? (fx.valid ? "预算：不限" : "预算：外币停算") : b.label;
            return `<option value="${b.value}" ${f.budget === b.value ? "selected" : ""}>${escapeHtml(lbl)}</option>`;
          }).join("")}
        </select>

        <select class="select-field dock-select ${f.provider !== "all" ? "is-filtered" : ""}" data-filter-select="provider" aria-label="按商家筛选">
          <option value="all" ${f.provider === "all" ? "selected" : ""}>商家：全部 (${providers.length})</option>
          ${sortedProviders
            .map((p) => {
              const cnt = facets.providerCounts.get(p.id) || 0;
              return `<option value="${escapeHtml(p.id)}" ${f.provider === p.id ? "selected" : ""}>${escapeHtml(p.name)} (${cnt})</option>`;
            })
            .join("")}
        </select>

        <div class="adv-wrap">
          <button type="button" class="btn btn-sm ${state.advancedOpen || advCount > 0 ? "btn-soft" : ""}" data-action="toggle-advanced" aria-expanded="${state.advancedOpen}">
            <span>⚙ 更多</span>
            ${advCount > 0 ? `<span class="num">(${advCount})</span>` : ""}
          </button>
          ${advPopover}
        </div>
      </div>

      ${
        f.track === "home"
          ? `<div class="dock-track-note">
              <span><strong>真家宽 / 双 ISP 隔离生效：</strong>已剔除所有普通机房宣称“原生 IP”的套餐，仅保留住宅宽带与双 ISP 节点。</span>
              <button type="button" class="btn btn-xs btn-ghost" style="color:inherit" data-action="set-track" data-track="all">查看全部赛道</button>
            </div>`
          : ""
      }

      <div class="dock-row-secondary">
        <div class="quick-toggles">
          <button type="button" class="q-toggle ${f.status === "available" ? "is-on" : ""}" data-action="toggle-quick-available" aria-pressed="${f.status === "available"}">
            <span>${f.status === "available" ? "✓" : "○"} 仅看可购</span>
          </button>
          <button type="button" class="q-toggle ${f.exactOnly ? "is-on-accent" : ""}" data-action="toggle-quick-exact" aria-pressed="${f.exactOnly}">
            <span>精确库存</span>
          </button>
          <button type="button" class="q-toggle ${f.noNat ? "is-on-accent" : ""}" data-action="toggle-quick-nonat" aria-pressed="${f.noNat}">
            <span>排除 NAT</span>
          </button>
          <span class="dock-vdiv" aria-hidden="true"></span>
          ${
            activeBadges.length > 0
              ? `<div class="active-chips-bar">
                  ${activeBadges
                    .map(
                      (b) => `<span class="filter-chip">
                        <span>${escapeHtml(b.label)}</span>
                        <button type="button" data-action="remove-filter" data-filter-key="${escapeHtml(b.key)}" aria-label="移除 ${escapeHtml(b.label)}">×</button>
                      </span>`
                    )
                    .join("")}
                  <button type="button" class="btn btn-xs btn-ghost" data-action="reset-filters">重置</button>
                </div>`
              : `<div class="preset-strip" aria-label="高频选机预设">
                  <button type="button" class="preset-chip" data-action="apply-preset" data-preset="us-home-dedicated">美区家宽（排除 NAT 标记）</button>
                  <button type="button" class="preset-chip" data-action="apply-preset" data-preset="cn2-opt">CN2 GIA</button>
                  <button type="button" class="preset-chip" data-action="apply-preset" data-preset="budget-monthly">≤¥60 月付</button>
                </div>`
          }
        </div>

        <div class="toolbar-right">
          <div class="result-summary">
            匹配 <strong>${matchedCount}</strong> 个${matchedCount > visibleCount ? `<span style="color:var(--ink-muted)">（前 ${visibleCount}）</span>` : ""}
          </div>
          <select class="select-field sort-select" data-filter-select="sort" aria-label="排序方式">
            ${SORT_OPTIONS.map(
              (opt) => `<option value="${opt.value}" ${f.sort === opt.value ? "selected" : ""}>${opt.label}</option>`
            ).join("")}
          </select>
          <div class="view-toggle" role="group" aria-label="桌面视图切换">
            <button type="button" class="view-toggle-btn ${state.layout === "table" ? "is-active" : ""}" data-action="set-layout" data-layout="table">列表</button>
            <button type="button" class="view-toggle-btn ${state.layout === "grid" ? "is-active" : ""}" data-action="set-layout" data-layout="grid">卡片</button>
          </div>
          <button type="button" class="btn btn-sm" data-action="copy-share-url" title="复制带当前筛选与对比状态的 URL">🔗 分享</button>
        </div>
      </div>
    </section>
  `;
}

function renderMobileFilterSheet(state, facets, matchedCount, now) {
  const f = state.filters;
  const fx = state.payload ? fxFreshness(state.payload.exchangeRates, now) : { valid: true };
  const sortedProviders = [...providers].sort((a, b) => {
    const ca = facets.providerCounts.get(a.id) || 0;
    const cb = facets.providerCounts.get(b.id) || 0;
    return cb - ca || a.name.localeCompare(b.name, "zh-CN");
  });

  return `
    <aside class="mobile-filter-sheet ${state.mobileRailOpen ? "is-mobile-open" : ""}" aria-label="移动端筛选抽屉" data-mobile-filter-sheet>
      <div class="mobile-rail-header">
        <strong style="font-size:var(--text-base)">筛选与排序（当前匹配 ${matchedCount}）</strong>
        <button type="button" class="btn btn-sm btn-ghost" data-action="close-mobile-rail" aria-label="关闭筛选抽屉">✕</button>
      </div>

      <div class="rail-section">
        <div class="rail-heading"><span>节点本质赛道</span></div>
        <div class="track-seg" role="group" aria-label="按节点本质筛选">
          <button type="button" class="track-btn ${f.track === "all" ? "is-active" : ""}" data-track="all" data-action="set-track">
            <span>全部</span><span class="track-num num">${facets.tracks.all}</span>
          </button>
          <button type="button" class="track-btn ${f.track === "home" ? "is-active" : ""}" data-track="home" data-action="set-track">
            <span>真家宽</span><span class="track-num num">${facets.tracks.home}</span>
          </button>
          <button type="button" class="track-btn ${f.track === "vps" ? "is-active" : ""}" data-track="vps" data-action="set-track">
            <span>机房优化</span><span class="track-num num">${facets.tracks.vps}</span>
          </button>
        </div>
      </div>

      <div class="rail-section">
        <div class="rail-heading"><span>排序与库存红线</span></div>
        <select class="select-field" data-filter-select="sort" aria-label="排序方式">
          ${SORT_OPTIONS.map(
            (opt) => `<option value="${opt.value}" ${f.sort === opt.value ? "selected" : ""}>${opt.label}</option>`
          ).join("")}
        </select>
        <div class="check-list">
          <label class="check-row"><span class="check-row-left"><input type="checkbox" data-filter-toggle="availableOnly" ${f.status === "available" ? "checked" : ""} /><span>仅看当前可购</span></span></label>
          <label class="check-row"><span class="check-row-left"><input type="checkbox" data-filter-toggle="exactOnly" ${f.exactOnly ? "checked" : ""} /><span>仅看精确库存数字</span></span></label>
          <label class="check-row"><span class="check-row-left"><input type="checkbox" data-filter-toggle="noNat" ${f.noNat ? "checked" : ""} /><span>排除 NAT / 共享 IP</span></span></label>
          <label class="check-row"><span class="check-row-left"><input type="checkbox" data-filter-toggle="noSnapshot" ${f.noSnapshot ? "checked" : ""} /><span>排除第三方快照</span></span></label>
          <label class="check-row"><span class="check-row-left"><input type="checkbox" data-filter-toggle="fixedPriceOnly" ${f.fixedPriceOnly ? "checked" : ""} /><span>排除起步价 / 周期未明</span></span></label>
          <label class="check-row"><span class="check-row-left"><input type="checkbox" data-filter-toggle="savedOnly" ${f.savedOnly ? "checked" : ""} /><span>仅看本地收藏</span></span><span class="check-row-count num">${state.savedKeys.size}</span></label>
        </div>
      </div>

      <div class="rail-section">
        <div class="rail-heading"><span>地区</span></div>
        <div class="facet-grid-2">
          ${MACRO_REGIONS.filter((r) => r.value !== "all")
            .map((r) => {
              const cnt = facets.regions.get(r.value) || 0;
              const active = f.region === r.value;
              const code = r.value === "MULTI" ? "GL" : r.value === "APAC" ? "AP" : r.value;
              return `<button type="button" class="facet-btn ${active ? "is-active" : ""} ${cnt === 0 && !active ? "is-zero" : ""}" data-action="set-region" data-region="${r.value}">
                <span class="facet-btn-label" style="display:inline-flex;align-items:center;gap:5px"><span class="iso-code">${code}</span>${r.label}</span>
                <span class="facet-btn-cnt num">${cnt}</span>
              </button>`;
            })
            .join("")}
        </div>
      </div>

      <div class="rail-section">
        <div class="rail-heading"><span>回程线路</span></div>
        <div class="facet-wrap">
          ${ROUTE_OPTIONS.filter((r) => r.value !== "all")
            .map((r) => {
              const cnt = facets.routes.get(r.value) || 0;
              const active = f.route === r.value;
              return `<button type="button" class="facet-btn ${active ? "is-active" : ""} ${cnt === 0 && !active ? "is-zero" : ""}" data-action="set-route" data-route="${r.value}">
                <span class="facet-btn-label">${r.label}</span><span class="facet-btn-cnt num">${cnt}</span>
              </button>`;
            })
            .join("")}
        </div>
      </div>

      <div class="rail-section">
        <div class="rail-heading">
          <span>月均预算与计费周期</span>
          ${!fx.valid ? `<span style="color:var(--warn-fg);font-size:10px;text-transform:none">外币停算</span>` : ""}
        </div>
        <div class="facet-wrap">
          ${BUDGET_OPTIONS.map(
            (b) => `<button type="button" class="facet-btn ${f.budget === b.value ? "is-active" : ""}" data-action="set-budget" data-budget="${b.value}"><span class="facet-btn-label num">${b.label}</span></button>`
          ).join("")}
        </div>
        <div class="facet-wrap">
          ${CYCLE_OPTIONS.map(
            (c) => `<button type="button" class="facet-btn ${f.cycle === c.value ? "is-active" : ""}" data-action="set-cycle" data-cycle="${c.value}"><span class="facet-btn-label">${c.label}</span></button>`
          ).join("")}
        </div>
        <select class="select-field" data-filter-select="provider" aria-label="按商家筛选">
          <option value="all" ${f.provider === "all" ? "selected" : ""}>全部商家（${providers.length} 家收录）</option>
          ${sortedProviders
            .map((p) => `<option value="${escapeHtml(p.id)}" ${f.provider === p.id ? "selected" : ""}>${escapeHtml(p.name)} (${facets.providerCounts.get(p.id) || 0})</option>`)
            .join("")}
        </select>
      </div>

      <div class="mobile-rail-footer">
        <button type="button" class="btn" data-action="reset-filters" style="flex:0 0 auto">重置</button>
        <button type="button" class="btn btn-primary" data-action="close-mobile-rail" style="flex:1">查看 ${matchedCount} 个匹配套餐</button>
      </div>
    </aside>
  `;
}

function renderSkeleton() {
  return `
    <div class="skeleton-stack" data-skeleton-grid aria-busy="true" aria-label="正在加载实时监控快照">
      <div style="display:flex;gap:10px;padding-bottom:8px;border-bottom:1px solid var(--border-subtle)">
        <span class="skel" style="height:32px;width:220px"></span>
        <span class="skel" style="height:32px;flex:1"></span>
        <span class="skel" style="height:32px;width:120px"></span>
        <span class="skel" style="height:32px;width:120px"></span>
      </div>
      ${Array.from({ length: 8 })
        .map(
          () => `<div class="skeleton-row">
          <div style="display:flex;flex-direction:column;gap:6px">
            <span class="skel" style="height:14px;width:72%"></span>
            <span class="skel" style="height:11px;width:46%"></span>
          </div>
          <span class="skel" style="height:20px;width:78%"></span>
          <span class="skel" style="height:14px;width:85%"></span>
          <span class="skel" style="height:16px;width:62%;margin-left:auto"></span>
          <span class="skel" style="height:22px;width:64px"></span>
        </div>`
        )
        .join("")}
    </div>
  `;
}

function renderErrorPanel(errorDetail) {
  return `
    <section class="empty-state-card is-error" data-error-panel role="alert">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="pill pill-danger">诚实降级 · 拒绝模拟数据</span>
        ${errorDetail?.status ? `<span class="pill pill-danger mono">HTTP ${escapeHtml(errorDetail.status)}</span>` : ""}
      </div>
      <h2 class="empty-state-title">${escapeHtml(errorDetail?.message || "库存快照加载失败")}</h2>
      <p class="empty-state-desc">
        错误详情：<code class="mono">${escapeHtml(errorDetail?.detail || "Unknown fetch failure")}</code>。
        根据本站数据诚实性原则，当上游 <code>data/products.json</code> 不可达时绝不回退或编造任何本地假库存。
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn btn-primary" data-action="refresh-snapshot">↻ 重试读取快照</button>
        <button type="button" class="btn" data-nav-view="guide">查看数据口径说明</button>
      </div>
    </section>
  `;
}

function renderZeroResults(plans, filters, savedKeys) {
  const diag = diagnoseZeroResults(plans, filters, savedKeys);
  return `
    <section class="empty-state-card" data-zero-results>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="pill pill-warn">0 匹配结果</span>
        <span style="font-size:var(--text-xs);color:var(--ink-muted)">当前生效 ${diag.activeCount} 项筛选条件存在互斥</span>
      </div>
      <h2 class="empty-state-title">当前组合下没有符合条件的套餐</h2>
      <p class="empty-state-desc">
        系统已对当前生效条件进行反事实冲突归因。您可以一键松绑以下单一条件以立即恢复匹配结果：
      </p>
      ${
        diag.suggestions.length
          ? `<div class="relax-list">
              ${diag.suggestions
                .map(
                  (s, idx) => `<div class="relax-item">
                    <span>
                      <strong>建议 ${idx + 1}：</strong>${escapeHtml(s.label)}
                      <span class="relax-count num"> → 可找回 ${s.recoveredCount} 个套餐</span>
                    </span>
                    <button
                      type="button"
                      class="btn btn-xs btn-soft"
                      data-action="apply-relaxation"
                      data-relax-patch="${escapeHtml(JSON.stringify(s.patch))}"
                    >一键松绑</button>
                  </div>`
                )
                .join("")}
            </div>`
          : `<p class="empty-state-desc">当前搜索词与多维约束叠加过严，建议直接重置筛选条件重新检索。</p>`
      }
      <div>
        <button type="button" class="btn btn-primary" data-action="reset-filters">重置全部筛选条件</button>
      </div>
    </section>
  `;
}

export function renderTerminalView(state, now = Date.now()) {
  if (state.loadState === "loading") {
    return `<div class="terminal-shell">${renderSkeleton()}</div>`;
  }

  if (state.loadState === "error") {
    return renderErrorPanel(state.errorDetail);
  }

  const matched = sortProducts(
    state.plans.filter((p) => matchesFilters(p, state.filters, state.savedKeys)),
    state.filters.sort
  );
  const visible = matched.slice(0, state.pageLimit);
  const facets = computeFacetCounts(state.plans, state.filters, state.savedKeys);
  const activeCount = listActiveFilterBadges(state.filters).length;

  const mobileQuickBar = `
    <div class="mobile-quick-bar" aria-label="移动端快捷筛选">
      <div class="input-wrap">
        <input
          type="search"
          class="input-field ${state.filters.q ? "has-clear" : ""}"
          data-terminal-search
          value="${escapeHtml(state.filters.q)}"
          placeholder="搜索套餐、商家、地区、线路…"
          aria-label="搜索套餐"
        />
        ${state.filters.q ? `<button type="button" class="input-clear-btn" data-action="clear-search" aria-label="清空搜索">×</button>` : ""}
      </div>
      <div class="mobile-quick-row">
        <button type="button" class="btn btn-sm ${activeCount ? "btn-soft" : ""}" data-action="open-mobile-rail">
          <span>⚙ 筛选</span>${activeCount ? `<span class="num">(${activeCount})</span>` : ""}
        </button>
        <button type="button" class="btn btn-sm ${state.filters.track === "all" ? "is-active" : ""}" data-action="set-track" data-track="all">全部 <span class="num">${facets.tracks.all}</span></button>
        <button type="button" class="btn btn-sm ${state.filters.track === "home" ? "is-active" : ""}" data-action="set-track" data-track="home">真家宽 <span class="num">${facets.tracks.home}</span></button>
        <button type="button" class="btn btn-sm ${state.filters.track === "vps" ? "is-active" : ""}" data-action="set-track" data-track="vps">机房 <span class="num">${facets.tracks.vps}</span></button>
        <button type="button" class="btn btn-sm ${state.filters.exactOnly ? "is-active" : ""}" data-action="toggle-quick-exact">精确库存</button>
      </div>
    </div>
  `;

  const priceSorted = state.filters.sort === "cny-asc" || state.filters.sort === "cny-desc";
  const priceArrow = state.filters.sort === "cny-asc" ? "↑" : state.filters.sort === "cny-desc" ? "↓" : "↕";
  const stockSorted = state.filters.sort === "stock-desc";
  const stockArrow = stockSorted ? "↓" : "↕";

  let bodyHtml = "";
  if (matched.length === 0) {
    bodyHtml = renderZeroResults(state.plans, state.filters, state.savedKeys);
  } else if (state.layout === "grid") {
    bodyHtml = `<div class="plan-grid" data-plan-grid>${visible.map((p) => renderPlanCard(p, state, now)).join("")}</div>`;
  } else {
    bodyHtml = `
      <div class="table-shell">
        <table class="terminal-table" aria-label="实时库存套餐列表">
          <thead>
            <tr>
              <th class="col-plan">套餐 / 商家 / 地域</th>
              <th class="col-net">本质与线路</th>
              <th class="col-hw">硬件配置</th>
              <th class="col-bw">带宽与流量</th>
              <th class="col-price col-num">
                <button type="button" class="th-sort-btn ${priceSorted ? "is-sorted" : ""}" data-action="sort-col" data-sort-col="price">
                  <span>原价 / 参考月均</span><span class="mono">${priceArrow}</span>
                </button>
              </th>
              <th class="col-stock">
                <button type="button" class="th-sort-btn ${stockSorted ? "is-sorted" : ""}" data-action="sort-col" data-sort-col="stock">
                  <span>库存与证据</span><span class="mono">${stockArrow}</span>
                </button>
              </th>
              <th class="col-act col-num">操作</th>
            </tr>
          </thead>
          <tbody>
            ${visible.map((p) => renderTableRow(p, state, now)).join("")}
          </tbody>
        </table>
      </div>
      <div class="mobile-cards-list" aria-label="移动端套餐卡片列表">
        ${visible.map((p) => renderPlanCard(p, state, now)).join("")}
      </div>
    `;
  }

  const pagerHtml =
    matched.length > visible.length
      ? `<div class="pager-bar">
          <span>当前展示 1–${visible.length} / 共 ${matched.length} 条（诊断与受阻源记录已自动隔离至「商家与源」）</span>
          <div style="display:flex;gap:8px">
            <button type="button" class="btn btn-sm" data-action="load-more">加载更多 (+60)</button>
            <button type="button" class="btn btn-sm btn-ghost" data-action="load-all">展开全部 (${matched.length})</button>
          </div>
        </div>`
      : matched.length > 0
        ? `<div class="pager-bar">
            <span>已展示全部 ${matched.length} 条匹配套餐 · 诊断型/受阻源共 ${state.diagnostics.length} 条已独立收纳于「商家与源」</span>
            <button type="button" class="btn btn-xs btn-ghost" data-nav-view="providers">查看受阻源诊断 →</button>
          </div>`
        : "";

  return `
    <div class="terminal-shell">
      ${mobileQuickBar}
      ${renderTopFilterDock(state, facets, matched.length, visible.length, now)}
      ${renderMobileFilterSheet(state, facets, matched.length, now)}
      <div class="terminal-canvas">
        ${bodyHtml}
        ${pagerHtml}
      </div>
    </div>
  `;
}
