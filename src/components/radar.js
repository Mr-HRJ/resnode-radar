import {
  MACRO_REGIONS,
  escapeHtml,
  formatClockTime,
  formatDateTime,
  formatDayKey,
  formatEventDelta,
  macroRegionsFor,
  normalizeSearch,
  plain,
  safeUrl
} from "../domain/format.js";

const WINDOW_HOURS = {
  "24h": 24,
  "72h": 72,
  "7d": 168
};

export function renderRadarView(state, now = Date.now()) {
  if (state.loadState === "loading") {
    return `<div class="skeleton-stack"><span class="skel" style="height:28px;width:45%"></span><span class="skel" style="height:90px;width:100%"></span><span class="skel" style="height:220px;width:100%"></span></div>`;
  }
  if (state.loadState === "error") {
    return `<section class="empty-state-card is-error">
      <h2 class="empty-state-title">无法加载异动记录</h2>
      <p class="empty-state-desc">上游快照接口当前不可用（${escapeHtml(state.errorDetail?.detail || "Fetch error")}）。</p>
      <div><button type="button" class="btn btn-primary" data-action="refresh-snapshot">↻ 重试读取</button></div>
    </section>`;
  }

  const r = state.radar;
  const planById = new Map(state.plans.map((p) => [p.id, p]));
  const cutoffMs = now - (WINDOW_HOURS[r.window] || 168) * 3600 * 1000;
  const cutoff24 = now - 24 * 3600 * 1000;

  let totalAll = 0;
  let restockAll = 0;
  let restock24 = 0;
  let soldoutAll = 0;
  let soldout24 = 0;
  let priceAll = 0;
  let price24 = 0;

  for (const ev of state.events) {
    const ts = Date.parse(ev.at) || 0;
    totalAll += 1;
    if (ev.type === "restock") {
      restockAll += 1;
      if (ts >= cutoff24) restock24 += 1;
    } else if (ev.type === "soldout") {
      soldoutAll += 1;
      if (ts >= cutoff24) soldout24 += 1;
    } else if (ev.type === "price") {
      priceAll += 1;
      if (ts >= cutoff24) price24 += 1;
    }
  }

  const query = normalizeSearch(r.q);
  const filtered = state.events.filter((ev) => {
    const ts = Date.parse(ev.at) || 0;
    if (ts < cutoffMs) return false;
    if (r.type !== "all" && ev.type !== r.type) return false;
    const livePlan = planById.get(ev.productId);
    if (r.savedOnly) {
      if (!livePlan || !state.savedKeys.has(livePlan._key)) return false;
    }
    if (r.region !== "all") {
      const macros = macroRegionsFor({ region: ev.region, name: ev.name, provider: ev.provider });
      if (!macros.includes(r.region)) return false;
    }
    if (query) {
      const hay = normalizeSearch([ev.provider, ev.name, ev.region, ev.price, ev.previousPrice].map(plain).join(" "));
      if (!hay.includes(query)) return false;
    }
    return true;
  });

  // Group chronologically by day
  const groups = new Map();
  for (const ev of filtered) {
    const day = formatDayKey(ev.at);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(ev);
  }

  const tracking = state.payload?.eventTracking;
  const trackingNote = tracking
    ? `保守观测口径 · 起始 ${formatDateTime(tracking.startedAt)} · 保留 ${tracking.retentionDays} 天（上限 ${tracking.limit} 条）`
    : "仅基于连续快照唯一身份比对记录真实库存与同周期同币种价格异动";

  return `
    <div class="workspace-head">
      <div>
        <h1 class="workspace-title">市场异动雷达（Restock / Soldout / Price Tape）</h1>
        <p class="workspace-sub">${escapeHtml(trackingNote)}。新接入监控源与第三方快照永不伪造补货。</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn btn-sm" data-action="copy-share-url">🔗 分享视图</button>
      </div>
    </div>

    <div class="kpi-grid" role="group" aria-label="按异动类型快捷筛选">
      <button type="button" class="kpi-tile ${r.type === "all" ? "is-active" : ""}" data-action="set-radar-type" data-radar-type="all">
        <span class="kpi-label">7 天全部真实异动</span>
        <span class="kpi-val num">${totalAll}</span>
        <span class="kpi-sub num">近 24h 新增 ${restock24 + soldout24 + price24} 条</span>
      </button>
      <button type="button" class="kpi-tile ${r.type === "restock" ? "is-active" : ""}" data-action="set-radar-type" data-radar-type="restock">
        <span class="kpi-label" style="color:var(--ok-fg)">补货上架（Restock）</span>
        <span class="kpi-val num" style="color:var(--ok-fg)">${restockAll}</span>
        <span class="kpi-sub num">近 24h 补货 ${restock24} 次</span>
      </button>
      <button type="button" class="kpi-tile ${r.type === "soldout" ? "is-active" : ""}" data-action="set-radar-type" data-radar-type="soldout">
        <span class="kpi-label" style="color:var(--danger-fg)">售罄下架（Soldout）</span>
        <span class="kpi-val num" style="color:var(--danger-fg)">${soldoutAll}</span>
        <span class="kpi-sub num">近 24h 售罄 ${soldout24} 次</span>
      </button>
      <button type="button" class="kpi-tile ${r.type === "price" ? "is-active" : ""}" data-action="set-radar-type" data-radar-type="price">
        <span class="kpi-label" style="color:var(--accent)">同周期变价（Price）</span>
        <span class="kpi-val num">${priceAll}</span>
        <span class="kpi-sub num">近 24h 变价 ${price24} 次</span>
      </button>
    </div>

    <div class="radar-controls">
      <div class="input-wrap controls-search">
        <input type="search" class="input-field" data-radar-search value="${escapeHtml(r.q)}" placeholder="搜索异动商家、套餐或地区…" aria-label="搜索异动事件" />
      </div>
      <div class="facet-wrap" role="group" aria-label="时间窗口">
        ${[
          ["24h", "近 24h"],
          ["72h", "近 72h"],
          ["7d", "近 7 天"]
        ]
          .map(
            ([val, lbl]) => `<button type="button" class="btn btn-sm ${r.window === val ? "is-active" : ""}" data-action="set-radar-window" data-window="${val}">${lbl}</button>`
          )
          .join("")}
      </div>
      <select class="select-field" style="width:auto;min-width:128px" data-radar-select="region" aria-label="按地区筛选异动">
        ${MACRO_REGIONS.map(
          (m) => `<option value="${m.value}" ${r.region === m.value ? "selected" : ""}>${m.value === "all" ? m.label : `${m.value === "MULTI" ? "GL" : m.value === "APAC" ? "AP" : m.value} ${m.label}`}</option>`
        ).join("")}
      </select>
      <label class="btn btn-sm ${r.savedOnly ? "is-active" : ""}" style="cursor:pointer">
        <input type="checkbox" style="margin:0" data-radar-toggle="savedOnly" ${r.savedOnly ? "checked" : ""} />
        <span>仅看已收藏</span>
      </label>
      ${
        r.type !== "all" || r.window !== "7d" || r.region !== "all" || r.savedOnly || r.q
          ? `<button type="button" class="btn btn-sm btn-ghost" data-action="reset-radar">重置</button>`
          : ""
      }
      <span style="margin-left:auto;font-size:var(--text-xs);color:var(--ink-muted)" class="num">命中 ${filtered.length} 条</span>
    </div>

    ${
      filtered.length === 0
        ? `<section class="empty-state-card">
            <h2 class="empty-state-title">当前筛选条件下暂无异动事件</h2>
            <p class="empty-state-desc">可以切回「近 7 天」窗口或重置筛选查看全部已观测到的补货、售罄与变价记录。</p>
            <div><button type="button" class="btn btn-primary" data-action="reset-radar">显示全部 7 天异动</button></div>
          </section>`
        : [...groups.entries()]
            .map(
              ([day, items]) => `<section class="tape-day-group">
                <div class="tape-day-heading">
                  <span>${escapeHtml(day)}</span>
                  <span class="pill">${items.length} 条</span>
                </div>
                <div class="tape-list">
                  ${items
                    .map((ev) => {
                      const livePlan = planById.get(ev.productId);
                      const delta = formatEventDelta(ev);
                      const orderHref = safeUrl(ev.orderUrl || livePlan?.orderUrl);
                      const rowTone =
                        ev.type === "restock"
                          ? "is-restock"
                          : ev.type === "soldout"
                            ? "is-soldout"
                            : delta?.direction === "down"
                              ? "is-price-down"
                              : "is-price-up";

                      const typeBadge =
                        ev.type === "restock"
                          ? `<span class="pill pill-ok">↑ 补货上架</span>`
                          : ev.type === "soldout"
                            ? `<span class="pill pill-danger">↓ 售罄下架</span>`
                            : delta?.direction === "down"
                              ? `<span class="pill pill-ok num">↓ 降价 ${escapeHtml(delta.label)}</span>`
                              : `<span class="pill pill-danger num">↑ 涨价 ${escapeHtml(delta?.label || "")}</span>`;

                      const liveStatusHint = livePlan
                        ? livePlan.status === "available"
                          ? `<span class="pill pill-ok">当前仍可购${livePlan._isExactStock ? ` · 余${livePlan.stockCount}` : ""}</span>`
                          : livePlan.status === "unavailable"
                            ? `<span class="pill pill-neutral">当前已售罄</span>`
                            : `<span class="pill pill-neutral">当前状态未公开</span>`
                        : `<span class="pill pill-neutral">快照已下线</span>`;

                      const priceHtml =
                        ev.type === "price" && ev.previousPrice
                          ? `<span class="price-old">${escapeHtml(plain(ev.previousPrice))}</span><strong>${escapeHtml(plain(ev.price))}</strong>`
                          : `<strong>${escapeHtml(plain(ev.price) || "-")}</strong>${
                              ev.type === "restock" && Number.isInteger(ev.stockCount)
                                ? `<div style="font-size:10.5px;color:var(--ok-fg)">观测库存 ${ev.stockCount}</div>`
                                : ""
                            }`;

                      return `<div class="tape-row ${rowTone}">
                        <time class="tape-time" datetime="${escapeHtml(ev.at)}" title="${escapeHtml(formatDateTime(ev.at))}">${escapeHtml(formatClockTime(ev.at))}</time>
                        <div>${typeBadge}</div>
                        <div class="tape-main">
                          <div class="tape-title" title="${escapeHtml(plain(ev.name))}">${escapeHtml(plain(ev.name))}</div>
                          <div class="tape-meta">
                            <strong style="color:var(--ink-secondary)">${escapeHtml(plain(ev.provider))}</strong>
                            <span>·</span>
                            <span>${escapeHtml(plain(ev.region) || "地区未标明")}</span>
                            ${liveStatusHint}
                          </div>
                        </div>
                        <div class="tape-price">${priceHtml}</div>
                        <div class="row-actions">
                          ${
                            livePlan
                              ? `<button type="button" class="btn btn-xs btn-soft" data-action="inspect-plan" data-product-id="${escapeHtml(livePlan.id)}">查证据</button>`
                              : ""
                          }
                          ${
                            orderHref
                              ? `<a class="btn btn-xs" href="${escapeHtml(orderHref)}" target="_blank" rel="nofollow noopener noreferrer">官网 ↗</a>`
                              : ""
                          }
                        </div>
                      </div>`;
                    })
                    .join("")}
                </div>
              </section>`
            )
            .join("")
    }
  `;
}
