import { providers } from "../../providers.js";
import { MAX_COMPARE } from "../state/store.js";
import {
  escapeHtml,
  formatClockTime,
  formatDateTime,
  formatEventDelta,
  fxFreshness,
  monitorFreshness,
  normalizeSearch,
  plain
} from "../domain/format.js";

function computeHeadlineStats(state, now = Date.now()) {
  if (state.loadState !== "ready" || !state.payload) {
    return {
      available: "-",
      exact: "-",
      home: "-",
      blocked: "-",
      events24h: 0,
      hotEvents: []
    };
  }
  let available = 0;
  let exact = 0;
  let home = 0;
  for (const p of state.plans) {
    if (p.status === "available") {
      available += 1;
      if (p._isExactStock) exact += 1;
      if (p._classify.isResidential) home += 1;
    }
  }
  const blocked = state.diagnostics.filter((d) => d.status === "blocked" || d.status === "error").length;

  const cutoff24h = now - 24 * 3600 * 1000;
  const recent24 = state.events.filter((e) => {
    const t = Date.parse(e.at);
    return Number.isFinite(t) && t >= cutoff24h;
  });

  // Prioritize restock & price drops in the live ticker pulse
  const hotPool = recent24.length ? recent24 : state.events;
  const prioritized = [...hotPool].sort((a, b) => {
    const score = (e) => {
      if (e.type === "restock") return 0;
      if (e.type === "price" && formatEventDelta(e)?.direction === "down") return 1;
      if (e.type === "price") return 2;
      return 3;
    };
    return score(a) - score(b) || (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0);
  });

  return {
    available,
    exact,
    home,
    blocked,
    events24h: recent24.length,
    hotEvents: prioritized.slice(0, 6)
  };
}

export function formatLiveClockText(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

export function renderHeader(state, now = Date.now()) {
  const stats = computeHeadlineStats(state, now);
  const freshness = state.payload ? monitorFreshness(state.payload.generatedAt, now) : null;
  const fx = state.payload ? fxFreshness(state.payload.exchangeRates, now) : null;

  let teleDotClass = "status-dot";
  let teleLabel = "同步快照中…";
  let telePillClass = "tele-pill";
  let isLiveFresh = false;

  if (state.loadState === "loading") {
    teleLabel = "同步快照中…";
  } else if (state.loadState === "error") {
    teleDotClass = "radar-ping-dot is-danger";
    telePillClass = "tele-pill is-danger";
    teleLabel = "上游数据源不可用";
  } else if (freshness?.stale) {
    teleDotClass = "radar-ping-dot is-warn";
    telePillClass = "tele-pill is-warn";
    teleLabel = `快照偏旧 · ${freshness.label}`;
  } else if (freshness) {
    teleDotClass = "radar-ping-dot";
    teleLabel = `实时快照 · ${freshness.label}`;
    isLiveFresh = true;
  }

  const fxPillClass = !fx
    ? "tele-pill"
    : fx.valid
      ? "tele-pill"
      : "tele-pill is-warn";
  const fxText = state.loadState === "loading"
    ? "汇率加载中"
    : !fx
      ? "汇率不可用"
      : fx.valid
        ? fx.label
        : fx.expired
          ? `汇率超7天 (${fx.date})`
          : fx.label;

  const navItems = [
    {
      id: "terminal",
      label: "现货选机",
      count: stats.available !== "-" ? String(stats.available) : "",
      countClass: ""
    },
    {
      id: "radar",
      label: "全网大盘",
      count: stats.events24h > 0 ? `+${stats.events24h}` : state.events.length ? String(state.events.length) : "",
      countClass: stats.events24h > 0 ? "is-pulse" : ""
    },
    {
      id: "providers",
      label: "商家名录",
      count: String(providers.length),
      countClass: ""
    },
    {
      id: "guide",
      label: "避坑口径",
      count: "",
      countClass: ""
    }
  ];

  const capsuleItemsHtml = stats.hotEvents
    .map((ev) => {
      const delta = formatEventDelta(ev);
      const timeStr = formatClockTime(ev.at);
      const badge =
        ev.type === "restock"
          ? `<span class="tag-badge is-restock">补货</span>`
          : ev.type === "soldout"
            ? `<span class="tag-badge is-soldout">售罄</span>`
            : delta?.direction === "down"
              ? `<span class="tag-badge is-restock num">${escapeHtml(delta.label)}</span>`
              : `<span class="tag-badge is-hot num">${escapeHtml(delta?.label || "变价")}</span>`;
      const stockHint = ev.type === "restock" && Number.isInteger(ev.stockCount) ? ` (余${ev.stockCount})` : "";
      return `<button type="button" class="live-capsule-item" data-action="inspect-event" data-product-id="${escapeHtml(ev.productId || "")}" title="${escapeHtml(`${ev.provider} ${ev.name} ${ev.price || ""}`)}">
        <span class="mono ev-time" style="color:var(--ink-muted);font-size:10.5px">${escapeHtml(timeStr)}</span>
        ${badge}
        <strong class="ev-name">${escapeHtml(plain(ev.provider))} · ${escapeHtml(plain(ev.name))}${escapeHtml(stockHint)}</strong>
        <span class="mono ev-price" style="color:var(--price-main);font-weight:700">${escapeHtml(plain(ev.price || ""))}</span>
      </button>`;
    })
    .join("");

  const compareCount = state.compareKeys.length;
  const themeLabel = state.theme === "dark" ? "☀ 亮色" : "☾ 暗色";
  const activeQuery = plain(state.filters.q);

  return `
    <div class="cmd-bar">
      <div class="cmd-bar-left">
        <a class="brand-link" href="./" data-action="go-home">
          <img class="brand-logo" src="favicon.svg" alt="" width="26" height="26" />
          <span class="brand-name">
            <span class="brand-cn">VPS雷达</span>
            <span class="brand-domain">
              <span class="radar-ping-dot" style="width:5.5px;height:5.5px" aria-hidden="true"></span>
              <span>vpsld</span>
            </span>
          </span>
        </a>
        <span class="header-vsep" aria-hidden="true"></span>
        <nav class="ws-nav" aria-label="主工作区导航">
          ${navItems
            .map(
              (item) => `<button type="button" class="ws-tab ${state.view === item.id ? "is-active" : ""}" data-nav-view="${item.id}" aria-current="${state.view === item.id ? "page" : "false"}">
              <span>${item.label}</span>
              ${item.count ? `<span class="ws-tab-count num ${item.countClass}">${escapeHtml(item.count)}</span>` : ""}
            </button>`
            )
            .join("")}
        </nav>
      </div>

      <div class="cmd-utils">
        <button type="button" class="cmd-search-trigger ${activeQuery ? "has-query" : ""}" data-action="open-palette" aria-label="搜索商家、地区、线路或型号 (快捷键 / 或 ⌘K)">
          <span aria-hidden="true" style="font-size:13px">⌕</span>
          <span class="search-label">${activeQuery ? `搜索词：${escapeHtml(activeQuery)}` : "搜商家 / 地区 / 线路 / 型号…"}</span>
          <kbd class="kbd-hint">⌘K</kbd>
        </button>
        ${
          activeQuery
            ? `<button type="button" class="btn btn-xs btn-soft" data-action="clear-search" title="清除当前关键词过滤">✕ 清词</button>`
            : ""
        }
        <button type="button" class="btn btn-sm ${state.savedKeys.size ? "btn-star is-active" : ""}" data-action="open-saved" aria-label="打开本地收藏夹">
          <span>★</span>
          <span class="num" data-saved-count>${state.savedKeys.size}</span>
        </button>
        ${
          compareCount > 0
            ? `<button type="button" class="btn btn-sm btn-soft header-compare-btn" data-action="open-compare" aria-label="打开多方案对比">
                <span>⇄ 对比</span>
                <span class="num" data-header-compare-count>${compareCount}/${MAX_COMPARE}</span>
              </button>`
            : ""
        }
        <button type="button" class="btn btn-sm btn-ghost" data-action="toggle-theme" aria-label="切换明暗主题">${themeLabel}</button>
      </div>
    </div>

    <div class="telemetry-strip" aria-label="实时数据遥测与全网大盘">
      <div class="telemetry-inner">
        <div class="telemetry-left">
          <span class="${telePillClass}" title="${escapeHtml(state.payload?.generatedAt ? `快照生成时间: ${formatDateTime(state.payload.generatedAt)}` : "等待快照响应")}">
            <span class="${teleDotClass}" aria-hidden="true"></span>
            <span data-telemetry-label class="${isLiveFresh ? "live-shimmer" : ""}">${escapeHtml(teleLabel)}</span>
          </span>
          <span class="live-clock-pill" title="本地实时时间">
            <span class="num" data-live-clock>${formatLiveClockText(new Date(now))}</span>
          </span>
          <button type="button" class="btn btn-xs btn-ghost" data-action="refresh-snapshot" ${state.refreshing ? "disabled" : ""} title="重新读取已发布的最新快照（不触发后端抓取）">
            ${state.refreshing ? "读取中…" : "↻ 刷新"}
          </button>
          <span class="${fxPillClass} tele-fx-chip" data-fx-pill title="参考人民币折算基于欧洲央行（ECB）每日参考汇率">${escapeHtml(fxText)}</span>
        </div>

        <div class="telemetry-center">
          <div class="market-spotlight" data-live-capsule data-capsule-count="${stats.hotEvents.length}">
            <button type="button" class="spotlight-badge" data-nav-view="radar" title="查看全网实时库存大盘与补货降价流">
              <span class="spotlight-dot" aria-hidden="true"></span>
              <span>全网大盘</span>
            </button>
            ${
              stats.hotEvents.length
                ? `<div class="live-capsule-viewport">
                    <div class="live-capsule-track" data-capsule-track>
                      ${capsuleItemsHtml}
                    </div>
                  </div>`
                : `<button type="button" class="spotlight-fallback" data-nav-view="radar">
                    实时监控全网 ${providers.length} 家官方源库存与价格异动
                  </button>`
            }
            <button type="button" class="spotlight-cta" data-nav-view="radar">
              <span>异动榜</span>
              <strong class="num">${stats.events24h > 0 ? `+${stats.events24h}` : state.events.length}</strong>
              <span aria-hidden="true">→</span>
            </button>
          </div>
        </div>

        <div class="telemetry-right">
          <button type="button" class="tele-stat is-ok" data-action="quick-stat" data-stat="available" title="查看所有在售可购套餐">
            <span>现货</span><strong data-stat-available>${stats.available}</strong>
          </button>
          <button type="button" class="tele-stat is-home" data-action="quick-stat" data-stat="home" title="仅看真家宽 / 双 ISP 住宅节点">
            <span>真家宽</span><strong data-stat-home>${stats.home}</strong>
          </button>
          <button type="button" class="tele-stat" data-action="quick-stat" data-stat="exact" title="仅看公布精确库存数量的套餐">
            <span>精确库存</span><strong data-stat-exact>${stats.exact}</strong>
          </button>
          <button type="button" class="tele-stat is-danger" data-action="quick-stat" data-stat="blocked" title="前往商家名录查看直连受阻源">
            <span>受阻源</span><strong data-stat-blocked>${stats.blocked}</strong>
          </button>
        </div>
      </div>
    </div>
  `;
}

export function renderStatusBanner(state, now = Date.now()) {
  if (state.loadState !== "ready" || !state.payload) return "";
  const warnings = [];
  const freshness = monitorFreshness(state.payload.generatedAt, now);
  const fx = fxFreshness(state.payload.exchangeRates, now);

  if (state.errorDetail) {
    warnings.push(`后台刷新失败（${state.errorDetail.detail || state.errorDetail.message}），当前仍展示上一次已加载快照。`);
  }
  if (freshness.stale) {
    warnings.push(`当前快照生成于 ${formatDateTime(state.payload.generatedAt)}（已超过 30 分钟，采集可能已中断），库存与价格可能已发生变化，下单前请以官方页面为准。`);
  }
  if (!fx.valid) {
    warnings.push(
      fx.expired
        ? `ECB 参考汇率快照日期为 ${fx.date}，已超 7 天有效期，前端已自动暂停所有外币人民币折算，仅保留原始账单报价。`
        : `ECB 参考汇率快照缺失或异常，外币套餐已暂停人民币折算。`
    );
  }

  if (warnings.length === 0) return "";
  const isDanger = Boolean(state.errorDetail);

  return `
    <div class="alert-banner ${isDanger ? "is-danger" : ""}" role="status" data-status-banner>
      <div class="alert-banner-list">
        <strong>${isDanger ? "数据同步告警" : "数据时效与口径提醒"}：</strong>
        <span>${warnings.map(escapeHtml).join(" · ")}</span>
      </div>
      <button type="button" class="btn btn-xs" data-action="refresh-snapshot">立即重新读取</button>
    </div>
  `;
}

export function renderCommandPalette(state) {
  if (!state.paletteOpen) return "";
  const rawQ = state.paletteQuery.trim();
  const q = normalizeSearch(rawQ);

  const matchedProviders = providers
    .filter((p) => {
      if (!q) return false;
      return normalizeSearch([p.name, p.id, ...(p.aliases || [])].join(" ")).includes(q);
    })
    .slice(0, 5);

  const matchedPlans = state.plans
    .filter((p) => {
      if (!q) return p.status === "available" && p._isExactStock;
      return p._search.includes(q);
    })
    .slice(0, 6);

  const quickCommands = [
    { id: "preset-us-home", label: "美区真家宽（排除 NAT 共享 / 仅看现货）", sub: "场景直达" },
    { id: "preset-cn2", label: "电信 CN2 GIA 优化回程（仅看现货）", sub: "场景直达" },
    { id: "go-radar", label: "进入全网大盘（实时补货 / 售罄 / 变价流）", sub: "工作区" },
    { id: "go-providers", label: `查看 ${providers.length} 家商家名录与采集健康诊断`, sub: "工作区" },
    { id: "copy-share", label: "复制当前筛选与对比状态分享链接", sub: "操作" },
    { id: "toggle-theme", label: `切换为${state.theme === "dark" ? "亮色冰透" : "深空暗夜"}主题`, sub: "外观" }
  ].filter((cmd) => !q || normalizeSearch(cmd.label).includes(q));

  return `
    <div class="palette-shell" role="dialog" aria-modal="true" aria-label="全局快速检索">
      <div class="palette-input-row">
        <span aria-hidden="true" style="color:var(--ink-muted)">⌕</span>
        <input
          type="search"
          class="palette-input"
          data-palette-input
          value="${escapeHtml(state.paletteQuery)}"
          placeholder="输入商家、地区、线路或型号（如 搬瓦工 / 香港 / 9929 / 双ISP），回车直接过滤列表…"
          autocomplete="off"
        />
        <button type="button" class="btn btn-xs btn-ghost" data-action="close-palette">Esc</button>
      </div>
      <div class="palette-results">
        ${
          rawQ
            ? `<div>
                <div class="palette-group-label">列表过滤</div>
                <button type="button" class="palette-item is-focused" data-action="palette-filter-q" data-query="${escapeHtml(rawQ)}">
                  <span><strong>在选机列表中筛选包含「${escapeHtml(rawQ)}」的全部方案</strong></span>
                  <span class="palette-item-sub">按回车直达 ↵</span>
                </button>
              </div>`
            : ""
        }
        ${
          matchedProviders.length
            ? `<div>
                <div class="palette-group-label">匹配商家</div>
                ${matchedProviders
                  .map(
                    (p) => `<button type="button" class="palette-item" data-action="palette-provider" data-provider-id="${escapeHtml(p.id)}">
                      <span><strong>${escapeHtml(p.name)}</strong></span>
                      <span class="palette-item-sub">查看该商家全部方案 ↵</span>
                    </button>`
                  )
                  .join("")}
              </div>`
            : ""
        }
        ${
          matchedPlans.length
            ? `<div>
                <div class="palette-group-label">${q ? "匹配方案（点击直接核验详情）" : "精确库存热门现货"}</div>
                ${matchedPlans
                  .map(
                    (p) => `<button type="button" class="palette-item" data-action="palette-plan" data-product-id="${escapeHtml(p.id)}">
                      <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                        <span class="pill ${p._classify.isResidential ? "pill-home" : "pill-vps"}" style="margin-right:6px">${p._classify.isResidential ? "家宽" : "机房"}</span>
                        ${escapeHtml(plain(p.name))}
                      </span>
                      <span class="palette-item-sub mono">${escapeHtml(p._providerName)} · ${escapeHtml(p._pricing.originalLabel)}</span>
                    </button>`
                  )
                  .join("")}
              </div>`
            : ""
        }
        <div>
          <div class="palette-group-label">快捷导航</div>
          ${quickCommands
            .map(
              (cmd) => `<button type="button" class="palette-item" data-action="palette-cmd" data-cmd="${cmd.id}">
                <span>${escapeHtml(cmd.label)}</span>
                <span class="palette-item-sub">${escapeHtml(cmd.sub)}</span>
              </button>`
            )
            .join("")}
        </div>
      </div>
    </div>
  `;
}
