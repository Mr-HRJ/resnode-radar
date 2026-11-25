import { renderAnnouncements } from "./announcements.js";
import {
  renderBandwidthCell,
  renderLocationCell,
  renderRouteHierarchyCell,
  routeChipClass,
  shortProviderLabel
} from "./terminal.js";
import {
  MACRO_REGIONS,
  describeLocation,
  describeRouteProfile,
  escapeHtml,
  formatClockTime,
  formatDateTime,
  formatDayKey,
  formatEventDelta,
  formatPriceLabel,
  macroRegionsFor,
  monitorFreshness,
  normalizeSearch,
  plain,
  safeUrl
} from "../domain/format.js";

function renderEventRouteCell(ev, livePlan) {
  if (livePlan) return renderRouteHierarchyCell(livePlan);
  const nameText = plain(ev.name);
  const isRes = /家宽|家寬|住宅|residential|\bdual[- ]?isp\b|双\s*isp|雙\s*isp|\bat&t\b|\bverizon\b|\bfrontier\b|\bcomcast\b|\bhinet\b/i.test(nameText);
  const isDual = /\bdual[- ]?isp\b|双\s*isp|雙\s*isp/i.test(nameText);
  const isNat = /\bnat\b|共享\s*ip/i.test(nameText);
  const rp = describeRouteProfile(ev, { isResidential: isRes, isDualIsp: isDual, isNat });
  const hasExplicitRoute = rp.headlineTone !== "intl" || rp.chips.some((ch) => ch.label !== "国际无优化");
  if (hasExplicitRoute) {
    return `<div class="route-cell-stack" title="${escapeHtml(nameText)}">
      <div class="route-headline-row">
        <span class="route-headline is-${escapeHtml(rp.headlineTone)}">${escapeHtml(rp.headline)}</span>
      </div>
      <div class="route-chips-row">
        ${rp.chips.slice(0, 3).map((ch) => `<span class="${routeChipClass(ch.tone)}">${escapeHtml(ch.label)}</span>`).join("")}
      </div>
    </div>`;
  }
  return `<div class="route-cell-stack">
    <span class="spec-line is-missing" title="原套餐快照已下线，历史事件未单独留档回程明细">下线未留档</span>
  </div>`;
}

function renderEventBandwidthCell(ev, livePlan) {
  if (livePlan) return renderBandwidthCell(livePlan);
  const nameText = plain(ev.name);
  const explicitSpeed = nameText.match(/\b(\d+(?:\.\d+)?)\s*(Gbps|Mbps)\b/i);
  if (explicitSpeed) {
    return `<div class="bw-stack">
      <span class="bw-highlight num">${escapeHtml(`${explicitSpeed[1]} ${explicitSpeed[2]}`)}</span>
    </div>`;
  }
  return `<div class="bw-stack">
    <span class="spec-line is-missing" title="原套餐快照已下线，历史事件未单独留档带宽与流量">下线未留档</span>
  </div>`;
}

const WINDOW_HOURS = {
  "24h": 24,
  "72h": 72,
  "7d": 168
};

export function renderRadarView(state, now = Date.now()) {
  if (state.loadState === "loading") {
    return `<div class="skeleton-stack"><span class="skel" style="height:28px;width:45%"></span><span class="skel" style="height:64px;width:100%"></span><span class="skel" style="height:320px;width:100%"></span></div>`;
  }
  if (state.loadState === "error") {
    return `<section class="empty-state-card is-error">
      <h2 class="empty-state-title">无法加载全网大盘与异动记录</h2>
      <p class="empty-state-desc">上游快照接口当前不可用（${escapeHtml(state.errorDetail?.detail || "Fetch error")}）。</p>
      <div><button type="button" class="btn btn-primary" data-action="refresh-snapshot">↻ 重试读取</button></div>
    </section>`;
  }

  const r = state.radar;
  const planById = new Map(state.plans.map((p) => [p.id, p]));
  const cutoffMs = now - (WINDOW_HOURS[r.window] || 168) * 3600 * 1000;
  const cutoff24 = now - 24 * 3600 * 1000;

  let availCount = 0;
  let homeAvail = 0;
  let cnOptAvail = 0;
  let exactAvail = 0;
  const regionAvailMap = new Map();

  for (const p of state.plans) {
    if (p.status !== "available") continue;
    availCount += 1;
    if (p._classify.isResidential) homeAvail += 1;
    else if (p._classify.hasCnOpt) cnOptAvail += 1;
    if (p._isExactStock) exactAvail += 1;
    for (const mr of p._macroRegions || []) {
      if (mr !== "MULTI") regionAvailMap.set(mr, (regionAvailMap.get(mr) || 0) + 1);
    }
  }

  const topRegions = MACRO_REGIONS.filter((m) => m.value !== "all" && m.value !== "MULTI")
    .map((m) => ({ ...m, count: regionAvailMap.get(m.value) || 0 }))
    .filter((m) => m.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

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
      const hay = normalizeSearch(
        [
          ev.provider,
          ev.name,
          ev.region,
          ev.price,
          ev.previousPrice,
          livePlan?.route,
          livePlan?._classify?.routeProfile?.headline,
          livePlan?.bandwidth
        ]
          .map(plain)
          .join(" ")
      );
      if (!hay.includes(query)) return false;
    }
    return true;
  });

  const groups = new Map();
  for (const ev of filtered) {
    const day = formatDayKey(ev.at);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(ev);
  }

  const total24 = restock24 + soldout24 + price24;
  const tracking = state.payload?.eventTracking;
  const trackingTitle = tracking
    ? `保守观测口径 · 起始 ${formatDateTime(tracking.startedAt)} · 保留 ${tracking.retentionDays} 天（上限 ${tracking.limit} 条）`
    : "仅基于连续快照唯一身份比对记录真实库存与同周期同币种价格异动";

  return `
    <section class="radar-deck" aria-label="全网实时大盘指挥台">
      <div class="radar-deck-top">
        <div class="radar-deck-brand">
          <span class="radar-scanner-dial" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 28 28" fill="none">
              <circle cx="14" cy="14" r="10.5" stroke="currentColor" stroke-opacity="0.24" stroke-width="1.4" style="color:var(--home-fg)"/>
              <circle cx="14" cy="14" r="5.5" stroke="currentColor" stroke-opacity="0.34" stroke-width="1.2" style="color:var(--home-fg)"/>
              <g class="radar-dial-sweep">
                <path d="M14 14 L14 3.5 A10.5 10.5 0 0 1 22.8 8.2 Z" fill="var(--ok-dot)" fill-opacity="0.28"/>
                <line x1="14" y1="14" x2="21.5" y2="6.5" stroke="var(--ok-dot)" stroke-width="1.6" stroke-linecap="round"/>
              </g>
              <circle cx="14" cy="14" r="2" fill="var(--ok-dot)"/>
            </svg>
          </span>
          <h1 class="radar-deck-title" title="${escapeHtml(trackingTitle)}">全网实时异动大盘</h1>
        </div>

        <div class="radar-deck-metrics" aria-label="实时现货横截面快跳">
          <button type="button" class="deck-stat-chip" data-action="quick-stat" data-stat="available" title="点击筛选全部在售现货">
            <span>在售现货</span><strong class="market-mini-val num" style="color:var(--accent)">${availCount}</strong>
          </button>
          <button type="button" class="deck-stat-chip" data-action="quick-stat" data-stat="home" title="点击仅看真家宽 / 双ISP">
            <span>真家宽</span><strong class="market-mini-val num" style="color:var(--home-fg)">${homeAvail}</strong>
          </button>
          <button type="button" class="deck-stat-chip" data-action="market-jump-cnopt" title="点击筛选回国优化线路">
            <span>CN优化</span><strong class="market-mini-val num" style="color:var(--purple-fg)">${cnOptAvail}</strong>
          </button>
          <button type="button" class="deck-stat-chip" data-action="quick-stat" data-stat="exact" title="点击仅看精确库存">
            <span>精确库存</span><strong class="market-mini-val num" style="color:var(--ok-fg)">${exactAvail}</strong>
          </button>
          <span class="deck-vsep" aria-hidden="true"></span>
          <div class="deck-region-pills" aria-label="热门地区现货快跳">
            ${topRegions
              .map(
                (reg) => `<button type="button" class="deck-reg-pill" data-action="market-jump-region" data-region="${reg.value}" title="前往选机查看 ${escapeHtml(reg.label)} ${reg.count} 款现货">
                  <span>${escapeHtml(reg.value === "APAC" ? "AP" : reg.value)}</span>
                  <strong class="num">${reg.count}</strong>
                </button>`
              )
              .join("")}
          </div>
        </div>

        <div class="radar-deck-actions">
          ${
            totalAll > 0
              ? `<div class="velocity-strip is-inline" title="近 7 天真实观测构成：补货 ${restockAll} · 变价 ${priceAll} · 售罄 ${soldoutAll}">
                  <div class="velocity-bar" aria-hidden="true">
                    ${restockAll ? `<span class="velocity-seg is-restock" style="width:${((restockAll / totalAll) * 100).toFixed(1)}%"></span>` : ""}
                    ${priceAll ? `<span class="velocity-seg is-price" style="width:${((priceAll / totalAll) * 100).toFixed(1)}%"></span>` : ""}
                    ${soldoutAll ? `<span class="velocity-seg is-soldout" style="width:${((soldoutAll / totalAll) * 100).toFixed(1)}%"></span>` : ""}
                  </div>
                </div>`
              : ""
          }
          <button type="button" class="btn btn-xs btn-soft" data-nav-view="terminal">← 选机</button>
          <button type="button" class="btn btn-xs" data-action="copy-share-url">分享</button>
        </div>
      </div>

      <div class="radar-deck-bar">
        <div class="radar-type-tabs" role="group" aria-label="按异动类型快捷筛选">
          <button type="button" class="radar-type-btn ${r.type === "all" ? "is-active" : ""}" data-action="set-radar-type" data-radar-type="all">
            <span>全部异动</span>
            <strong class="kpi-val num">${totalAll}</strong>
            ${total24 > 0 ? `<span class="type-24h num" title="近 24h 新增">+${total24}</span>` : ""}
          </button>
          <button type="button" class="radar-type-btn is-ok ${r.type === "restock" ? "is-active" : ""}" data-action="set-radar-type" data-radar-type="restock">
            <span>↑ 补货上架</span>
            <strong class="kpi-val num">${restockAll}</strong>
          </button>
          <button type="button" class="radar-type-btn is-danger ${r.type === "soldout" ? "is-active" : ""}" data-action="set-radar-type" data-radar-type="soldout">
            <span>↓ 售罄下架</span>
            <strong class="kpi-val num">${soldoutAll}</strong>
          </button>
          <button type="button" class="radar-type-btn is-price ${r.type === "price" ? "is-active" : ""}" data-action="set-radar-type" data-radar-type="price">
            <span>⇄ 同周期变价</span>
            <strong class="kpi-val num">${priceAll}</strong>
          </button>
        </div>

        <div class="radar-filter-cluster">
          <div class="input-wrap radar-compact-search">
            <input type="search" class="input-field" style="height:28px" data-radar-search value="${escapeHtml(r.q)}" placeholder="搜商家 / 套餐 / 地区 / 线路…" aria-label="搜索异动事件" />
          </div>
          <div class="view-toggle radar-window-toggle" role="group" aria-label="时间窗口">
            ${[
              ["24h", "24h"],
              ["72h", "72h"],
              ["7d", "7天"]
            ]
              .map(
                ([val, lbl]) => `<button type="button" class="view-toggle-btn ${r.window === val ? "is-active" : ""}" data-action="set-radar-window" data-window="${val}">${lbl}</button>`
              )
              .join("")}
          </div>
          <select class="select-field mini-select" style="min-width:106px" data-radar-select="region" aria-label="按地区筛选异动">
            ${MACRO_REGIONS.map(
              (m) => `<option value="${m.value}" ${r.region === m.value ? "selected" : ""}>${m.value === "all" ? "全部地区" : `${m.value === "MULTI" ? "GL" : m.value === "APAC" ? "AP" : m.value} ${m.label}`}</option>`
            ).join("")}
          </select>
          <label class="q-toggle ${r.savedOnly ? "is-on-accent" : ""}" style="cursor:pointer">
            <input type="checkbox" style="margin:0;width:12px;height:12px" data-radar-toggle="savedOnly" ${r.savedOnly ? "checked" : ""} />
            <span>★ 收藏</span>
          </label>
          ${
            r.type !== "all" || r.window !== "7d" || r.region !== "all" || r.savedOnly || r.q
              ? `<button type="button" class="btn btn-xs btn-ghost" data-action="reset-radar">重置</button>`
              : ""
          }
          <span class="radar-hit-count num">命中 <strong>${filtered.length}</strong></span>
        </div>
      </div>
    </section>

    ${renderAnnouncements(state.payload?.announcements)}

    ${
      filtered.length === 0
        ? `<section class="empty-state-card">
            <h2 class="empty-state-title">当前筛选条件下暂无异动事件</h2>
            <p class="empty-state-desc">可以切回「7天」窗口或重置筛选查看全部已观测到的补货、售罄与变价记录。</p>
            <div><button type="button" class="btn btn-primary" data-action="reset-radar">显示全部 7 天异动</button></div>
          </section>`
        : [...groups.entries()]
            .map(
              ([day, items]) => `<section class="tape-day-group">
                <div class="tape-day-heading">
                  <span>${escapeHtml(day)}</span>
                  <span class="pill num">${items.length} 条记录</span>
                </div>
                <div class="tape-list">
                  <table class="radar-tape-table" aria-label="${escapeHtml(day)} 异动记录表">
                    <thead>
                      <tr>
                        <th scope="col" class="col-tape-time">观测时间</th>
                        <th scope="col" class="col-tape-event">异动类型</th>
                        <th scope="col" class="col-tape-plan">商家与套餐型号</th>
                        <th scope="col" class="col-tape-loc">机房位置</th>
                        <th scope="col" class="col-tape-net">回程线路 · 三网明细</th>
                        <th scope="col" class="col-tape-bw">带宽 / 流量</th>
                        <th scope="col" class="col-tape-price">异动价格</th>
                        <th scope="col" class="col-tape-status">当前状态</th>
                        <th scope="col" class="col-tape-act">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${items
                        .map((ev, idx) => {
                          const livePlan = planById.get(ev.productId);
                          const delta = formatEventDelta(ev);
                          const orderHref = safeUrl(ev.orderUrl || livePlan?.orderUrl);
                          const ageInfo = monitorFreshness(ev.at, now);
                          const fallbackLoc = describeLocation({ region: ev.region, name: ev.name });
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
                              ? `<span class="pill pill-ok tape-event-pill">↑ 补货上架</span>`
                              : ev.type === "soldout"
                                ? `<span class="pill pill-danger tape-event-pill">↓ 售罄下架</span>`
                                : delta?.direction === "down"
                                  ? `<span class="pill pill-ok tape-event-pill num">↓ 降价 ${escapeHtml(delta.label)}</span>`
                                  : `<span class="pill pill-danger tape-event-pill num">↑ 涨价 ${escapeHtml(delta?.label || "")}</span>`;

                          const liveStatusHint = livePlan
                            ? livePlan.status === "available"
                              ? `<span class="pill pill-ok tape-status-pill num"><span class="radar-ping-dot" style="width:6px;height:6px" aria-hidden="true"></span>仍可购${livePlan._isExactStock ? ` · 余${livePlan.stockCount}` : ""}</span>`
                              : livePlan.status === "unavailable"
                                ? `<span class="pill pill-neutral tape-status-pill">已售罄</span>`
                                : `<span class="pill pill-neutral tape-status-pill">状态未公开</span>`
                            : `<span class="pill pill-neutral pill-outline tape-status-pill" title="该套餐已从商家公开目录移除，此处保留历史异动快照">快照已下线</span>`;

                          const cnyEquiv =
                            livePlan &&
                            livePlan._pricing?.cnyTone === "ok" &&
                            plain(ev.price) === plain(livePlan.price)
                              ? `折合 ${livePlan._pricing.cnyLabel.replace(/^≈\s*/, "").replace(/\s*\(按[^)]+分摊\)/, "")}`
                              : "";

                          const priceSubHtml =
                            ev.type === "price" && ev.previousPrice
                              ? `<span class="tape-price-prev">原 <span class="price-old num" title="${escapeHtml(plain(ev.previousPrice))}">${escapeHtml(formatPriceLabel({ ...ev, price: ev.previousPrice, priceValue: ev.previousPriceValue }))}</span></span>`
                              : ev.type === "restock" && Number.isInteger(ev.stockCount)
                                ? `<span class="tape-stock-note num">观测余 ${ev.stockCount}</span>`
                                : cnyEquiv
                                  ? `<span class="price-sub num">${escapeHtml(cnyEquiv)}</span>`
                                  : "";

                          const isCurrentlyUnavailable = !livePlan || livePlan.status === "unavailable";

                          return `<tr class="tape-row ${rowTone} ${livePlan ? "is-clickable" : "is-offline"} ${isCurrentlyUnavailable ? "is-currently-unavailable" : ""}" style="--stagger-i:${Math.min(idx, 14)}" ${livePlan ? `data-action="inspect-plan" data-product-id="${escapeHtml(livePlan.id)}"` : ""}>
                            <td class="col-tape-time">
                              <div class="tape-time-stack">
                                <time class="tape-time num" datetime="${escapeHtml(ev.at)}" title="${escapeHtml(formatDateTime(ev.at))}">${escapeHtml(formatClockTime(ev.at))}</time>
                                <span class="tape-age">${escapeHtml(ageInfo.label)}</span>
                              </div>
                            </td>
                            <td class="col-tape-event">${typeBadge}</td>
                            <td class="col-tape-plan">
                              <div class="tape-plan-stack">
                                <div class="plan-vendor-row">
                                  <strong class="provider-brand" title="${escapeHtml(plain(ev.provider))}">${escapeHtml(shortProviderLabel(livePlan?._providerName || ev.provider))}</strong>
                                  ${
                                    livePlan?._classify?.isResidential
                                      ? `<span class="net-micro-tag is-home">真家宽</span>`
                                      : livePlan?._classify?.isNativeIp
                                        ? `<span class="net-micro-tag is-native">原生IP</span>`
                                        : ""
                                  }
                                </div>
                                <div class="tape-plan-title" title="${escapeHtml(plain(ev.name))}">${escapeHtml(plain(ev.name))}</div>
                              </div>
                            </td>
                            <td class="col-tape-loc">${renderLocationCell(livePlan, fallbackLoc)}</td>
                            <td class="col-tape-net">${renderEventRouteCell(ev, livePlan)}</td>
                            <td class="col-tape-bw">${renderEventBandwidthCell(ev, livePlan)}</td>
                            <td class="col-tape-price">
                              <div class="tape-price-stack num">
                                <strong class="tape-price-curr" title="${escapeHtml(plain(ev.price))}">${escapeHtml(formatPriceLabel(ev))}</strong>
                                ${priceSubHtml}
                              </div>
                            </td>
                            <td class="col-tape-status">${liveStatusHint}</td>
                            <td class="col-tape-act">
                              <div class="row-actions" data-stop-row>
                                ${
                                  livePlan
                                    ? `<button type="button" class="btn btn-xs btn-soft" data-action="inspect-plan" data-product-id="${escapeHtml(livePlan.id)}">证据</button>`
                                    : ""
                                }
                                ${
                                  orderHref
                                    ? `<a class="btn-buy-cta" style="height:26px;padding:0 9px;font-size:11px" href="${escapeHtml(orderHref)}" target="_blank" rel="nofollow noopener noreferrer">直达 ↗</a>`
                                    : `<span class="spec-line is-missing">—</span>`
                                }
                              </div>
                            </td>
                          </tr>`;
                        })
                        .join("")}
                    </tbody>
                  </table>
                </div>
              </section>`
            )
            .join("")
    }
  `;
}
