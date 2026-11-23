import {
  SORT_OPTIONS,
  computeFacetCounts,
  diagnoseZeroResults,
  listActiveFilterBadges,
  matchesFilters,
  rankProvidersByPopularity,
  resolveProvider,
  sortProducts
} from "../domain/catalog.js";
import {
  BANDWIDTH_OPTIONS,
  BUDGET_OPTIONS,
  CPU_OPTIONS,
  CYCLE_OPTIONS,
  DISK_OPTIONS,
  MACRO_REGIONS,
  MEMORY_OPTIONS,
  OPT_OPTIONS,
  ROUTE_OPTIONS,
  TRAFFIC_OPTIONS,
  escapeHtml,
  formatClockTime,
  formatEventDelta,
  formatPriceLabel,
  fxFreshness,
  normalizeSearch,
  plain,
  safeUrl
} from "../domain/format.js";

function shortProviderLabel(name) {
  const s = plain(name);
  if (/搬瓦工/i.test(s)) return "搬瓦工";
  if (/GreenCloud/i.test(s)) return "绿云 GreenCloud";
  if (/V\.PS/i.test(s)) return "V.PS 小秘书";
  if (/RFCHOST/i.test(s)) return "RFCHOST 花卷";
  if (/SaltyFish/i.test(s)) return "咸鱼云 SaltyFish";
  if (/BestVM/i.test(s)) return "富婆 BestVM";
  if (/Neburst/i.test(s)) return "奶爸 Neburst";
  if (/YUNYOO/i.test(s)) return "云悠 YUNYOO";
  if (/ZgoCloud/i.test(s)) return "ZgoCloud";
  if (/Spartan/i.test(s)) return "斯巴达 Spartan";
  if (/Boil/i.test(s)) return "Boil 港仔";
  if (/NodeMach/i.test(s)) return "NodeMach";
  if (/BreaCloud/i.test(s)) return "破云 BreaCloud";
  if (/六六云/i.test(s)) return "六六云 666";
  if (/WePC/i.test(s)) return "WePC 车库云";
  return s.replace(/\s*[（(][^）)]*[）)]$/, "").trim() || s;
}

function fPillClass(isActive, isDefaultOption = false, extra = "") {
  const base = ["f-pill"];
  if (extra) base.push(extra);
  if (isActive) {
    base.push(isDefaultOption ? "is-all-default" : "is-active");
  }
  return base.join(" ");
}

function renderStockEvidenceCell(plan) {
  if (plan.status === "available") {
    if (plan._isExactStock) {
      const lowClass = plan.stockCount <= 5 ? " pill-low-stock" : "";
      return `<div class="stock-stack">
        <span class="pill pill-ok${lowClass} num"><span class="radar-ping-dot" style="width:6px;height:6px" aria-hidden="true"></span>余 ${plan.stockCount}</span>
        <span class="stock-sub" style="color:var(--ok-fg);font-weight:600">${plan.stockCount <= 5 ? "紧俏现货" : "精确现货"}</span>
      </div>`;
    }
    if (plan._isSnapshot) {
      return `<div class="stock-stack">
        <span class="pill pill-warn">快照有货</span>
        <span class="stock-sub">第三方快照</span>
      </div>`;
    }
    return `<div class="stock-stack">
      <span class="pill pill-ok"><span class="radar-ping-dot" style="width:6px;height:6px" aria-hidden="true"></span>可订购</span>
      <span class="stock-sub">官方入口 · 未报数</span>
    </div>`;
  }
  if (plan.status === "unavailable") {
    return `<div class="stock-stack">
      <span class="pill pill-danger">缺货售罄</span>
      <span class="stock-sub">暂不可购</span>
    </div>`;
  }
  return `<div class="stock-stack">
    <span class="pill pill-neutral pill-outline">状态未标</span>
    <span class="stock-sub">需进官网核验</span>
  </div>`;
}

function renderInlineLeadTag(plan, now = Date.now()) {
  if (plan.status !== "available") return "";
  const ev = plan._latestEvent;
  if (ev && ev.type === "restock" && now - (Date.parse(ev.at) || 0) <= 72 * 3600 * 1000) {
    return `<span class="tag-badge is-restock" title="近 72h 观测到补货上架">补货</span>`;
  }
  return "";
}

function renderEventSpark(plan, now = Date.now()) {
  const ev = plan._latestEvent;
  const badges = [];
  if (ev) {
    const ageMs = now - (Date.parse(ev.at) || 0);
    if (ageMs <= 72 * 3600 * 1000 && ev.type === "price") {
      const delta = formatEventDelta(ev);
      if (delta?.direction === "down") {
        badges.push(`<span class="pill pill-ok num" style="height:19px;padding:0 5px" title="近 72h 降价">↓ ${escapeHtml(delta.label)}</span>`);
      } else if (delta?.direction === "up") {
        badges.push(`<span class="pill pill-danger num" style="height:19px;padding:0 5px" title="近 72h 涨价">↑ ${escapeHtml(delta.label)}</span>`);
      }
    }
  }
  if (plan.status === "available" && Number.isFinite(plan._pricing.cnyMonthly) && plan._pricing.cnyMonthly <= 20) {
    badges.push(`<span class="pill pill-deal" style="height:19px;padding:0 5px" title="折合人民币月均 ≤ ￥20">特惠</span>`);
  }
  return badges.join("");
}

function compactHwToken(cpu, memory, disk) {
  const cleanParens = (str) => str.replace(/\(\s*\)|（\s*）/g, "").replace(/\s+/g, " ").trim();
  const c = cpu && cpu !== "未标明"
    ? cleanParens(
        cpu
          .replace(/\s*(?:x\s*)?v?\s*(?:cpus?|cores?)\b/gi, "C")
          .replace(/核(?:心)?/g, "C")
          .replace(/\s+/g, "")
      )
    : "";
  const m = memory && memory !== "未标明"
    ? cleanParens(
        memory
          .replace(/\s*Gi?B\b/gi, "G")
          .replace(/\s*Mi?B\b/gi, "M")
          .replace(/\s*DDR\d*(?:@[^\s)]+)?(?:\s*ECC)?/gi, "")
      )
    : "";
  const d = disk && disk !== "未标明"
    ? cleanParens(
        disk
          .replace(/\s*Gi?B\b/gi, "G")
          .replace(/\s*Ti?B\b/gi, "T")
          .replace(/\bdisk\b/gi, "")
          .replace(/高性能|固态|硬盘/g, "")
      )
    : "";
  return [c, m, d].filter(Boolean).join(" / ");
}

function renderSpecsParts(plan) {
  const s = plan._specs;
  const fullHw = [s.cpu, s.memory, s.disk].filter((v) => v && v !== "未标明").join(" / ");
  const shortHw = compactHwToken(s.cpu, s.memory, s.disk);
  const fallbackHw = plain(plan.hardware);

  const hwChipText = shortHw || fallbackHw || "";

  const bw = s.bandwidth && s.bandwidth !== "未标明" ? s.bandwidth : "";
  const traffic = s.traffic && s.traffic !== "未标明" ? s.traffic : "";
  const fallbackNet = plain(plan.bandwidth);
  const hasStructuredNet = Boolean(bw || traffic);

  return {
    hwChipText,
    fullHw: fullHw || fallbackHw || "配置未标明",
    bw,
    traffic,
    isUnlimited: plan._numSpecs?.unlimitedTraffic || traffic === "不限流量",
    fallbackNet: !hasStructuredNet ? fallbackNet : "",
    compactHw: fullHw || fallbackHw || "配置未标明",
    compactNet: [bw, traffic].filter(Boolean).join(" · ") || fallbackNet || "带宽流量未标明"
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

function routePillClass(r) {
  if (r === "CN2") return "pill pill-route-cn2";
  if (r === "9929") return "pill pill-route-9929";
  if (r === "CMIN2") return "pill pill-route-cmin2";
  if (r === "4837") return "pill pill-route-4837";
  if (r === "软银" || r === "IIJ" || r === "HiNet") return "pill pill-route-jp";
  return "pill pill-route-bgp";
}

function roleSolidBadgeClass(tone) {
  if (tone === "home") return "badge-solid badge-solid-home";
  if (tone === "opt") return "badge-solid badge-solid-opt";
  if (tone === "native") return "badge-solid badge-solid-native";
  return "badge-solid badge-solid-landing";
}

function renderNetworkBadges(plan) {
  const c = plan._classify;
  const badges = [];
  badges.push(`<span class="${roleSolidBadgeClass(c.ipTier.tone)}">${escapeHtml(c.ipTier.label)}</span>`);
  if (c.routes.length > 0) {
    for (const r of c.routes.slice(0, 3)) {
      const prefix = r === "CN2" ? "电:CN2" : r === "9929" ? "联:9929" : r === "CMIN2" ? "移:CMIN2" : r === "4837" ? "联:4837" : r;
      badges.push(`<span class="${routePillClass(r)}">${escapeHtml(prefix)}</span>`);
    }
  } else {
    const rawRoute = plain(plan.route);
    if (rawRoute && !/以所选机房为准|默认|未知|待核验/i.test(rawRoute)) {
      badges.push(`<span class="pill pill-route-bgp route-pill" title="${escapeHtml(rawRoute)}">${escapeHtml(rawRoute)}</span>`);
    }
  }
  if (c.isNat) {
    badges.push(`<span class="pill pill-warn" title="NAT 共享 IPv4 / 动态端口">NAT共享</span>`);
  } else if (plan._isSnapshot) {
    badges.push(`<span class="pill pill-warn" title="第三方 Reader 公开快照">快照</span>`);
  }
  return badges.join("");
}

function renderPriceStack(plan, align = "right") {
  const p = plan._pricing;
  const isPromo = plan.status === "available" && Number.isFinite(p.cnyMonthly) && p.cnyMonthly <= 22;
  const subClass =
    p.cnyTone === "ok"
      ? "price-sub"
      : p.cnyTone === "warn"
        ? "price-sub is-warn"
        : "price-sub is-muted";
  const cnyDisplay = p.cnyTone === "ok" && !p.cnyLabel.startsWith("折合") ? `折合 ${p.cnyLabel.replace(/^≈\s*/, "")}` : p.cnyLabel;
  return `<div class="${align === "right" ? "price-stack" : "plan-card-price"}">
    <span class="price-primary ${isPromo ? "is-promo price-promo-pulse" : ""} num" title="${escapeHtml(p.originalLabel)}">${escapeHtml(p.displayLabel)}</span>
    <span class="${subClass} num" title="${escapeHtml(p.formula || p.honestReason || "")}">${escapeHtml(cnyDisplay)}</span>
  </div>`;
}

function renderTableRow(plan, state, now, idx = 0) {
  const isSaved = state.savedKeys.has(plan._key);
  const isCompared = state.compareKeys.includes(plan._key);
  const isInspected = state.inspectId === plan.id;
  const isSoldout = plan.status === "unavailable";
  const sp = renderSpecsParts(plan);
  const orderHref = safeUrl(plan.orderUrl);
  const leadTag = renderInlineLeadTag(plan, now);

  return `
    <tr class="${isInspected ? "is-inspected" : ""} ${isSoldout ? "is-soldout" : ""} ${plan._classify.isResidential ? "is-home-row" : ""}" style="--stagger-i:${Math.min(idx, 14)}" data-action="inspect-plan" data-product-id="${escapeHtml(plan.id)}">
      <td class="col-plan">
        <div class="plan-cell">
          <div class="plan-title-row">
            ${leadTag}
            <span class="plan-title" title="${escapeHtml(plain(plan.name))}">${escapeHtml(plain(plan.name))}</span>
          </div>
          <div class="plan-meta-row">
            <span class="provider-tag">${escapeHtml(plan._providerName)}</span>
            <span class="meta-sep">·</span>
            ${renderRegionSummary(plan)}
            ${renderEventSpark(plan, now)}
          </div>
        </div>
      </td>
      <td class="col-net">
        <div class="net-stack">${renderNetworkBadges(plan)}</div>
      </td>
      <td class="col-hw">
        ${
          sp.hwChipText
            ? `<span class="hw-chip" title="${escapeHtml(sp.fullHw)}">${escapeHtml(sp.hwChipText)}</span>`
            : `<span class="spec-line is-missing">配置未标明</span>`
        }
      </td>
      <td class="col-bw">
        <div class="spec-stack">
          ${
            sp.bw
              ? `<span class="bw-highlight" title="${escapeHtml(sp.compactNet)}">${escapeHtml(sp.bw)}</span>`
              : sp.fallbackNet
                ? `<span class="spec-line" title="${escapeHtml(sp.fallbackNet)}">${escapeHtml(sp.fallbackNet)}</span>`
                : `<span class="spec-line is-missing">未标明</span>`
          }
          ${
            sp.isUnlimited
              ? `<span class="traffic-unlimited">不限流量</span>`
              : sp.traffic
                ? `<span class="spec-line is-sub">${escapeHtml(sp.traffic)}</span>`
                : ""
          }
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
              ? `<a class="btn-buy-cta" href="${escapeHtml(orderHref)}" target="_blank" rel="nofollow noopener noreferrer" aria-label="直达官方订购页">直达 ↗</a>`
              : `<button type="button" class="btn btn-xs" data-action="inspect-plan" data-product-id="${escapeHtml(plan.id)}">详情</button>`
          }
        </div>
      </td>
    </tr>
  `;
}

function renderPlanCard(plan, state, now, idx = 0) {
  const isSaved = state.savedKeys.has(plan._key);
  const isCompared = state.compareKeys.includes(plan._key);
  const isInspected = state.inspectId === plan.id;
  const isSoldout = plan.status === "unavailable";
  const sp = renderSpecsParts(plan);
  const orderHref = safeUrl(plan.orderUrl);
  const leadTag = renderInlineLeadTag(plan, now);

  return `
    <article class="plan-card ${plan._classify.isResidential ? "is-home" : ""} ${isInspected ? "is-inspected" : ""} ${isSoldout ? "is-soldout" : ""}" style="--stagger-i:${Math.min(idx, 14)}" data-action="inspect-plan" data-product-id="${escapeHtml(plan.id)}">
      <div class="plan-card-top">
        <div class="plan-card-vendor">
          ${leadTag}
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
        <span title="${escapeHtml(sp.compactHw)}">配置：${escapeHtml(sp.compactHw)}</span>
        <span title="${escapeHtml(sp.compactNet)}">网络：${escapeHtml(sp.compactNet)}</span>
      </div>

      <div class="plan-card-foot">
        ${renderPriceStack(plan, "left")}
        <div class="row-actions" data-stop-row>
          <button type="button" class="btn btn-sm btn-star ${isSaved ? "is-active" : ""}" data-action="toggle-save" data-key="${escapeHtml(plan._key)}" aria-label="${isSaved ? "取消收藏" : "收藏"}" aria-pressed="${isSaved}">★</button>
          <button type="button" class="btn btn-sm ${isCompared ? "is-active" : ""}" data-action="toggle-compare" data-key="${escapeHtml(plan._key)}" aria-label="${isCompared ? "移出对比" : "加入对比"}" aria-pressed="${isCompared}">⇄</button>
          ${
            orderHref
              ? `<a class="btn-buy-cta" style="height:30px;padding:0 12px" href="${escapeHtml(orderHref)}" target="_blank" rel="nofollow noopener noreferrer">直达购买 ↗</a>`
              : `<button type="button" class="btn btn-sm" data-action="inspect-plan" data-product-id="${escapeHtml(plan.id)}">证据</button>`
          }
        </div>
      </div>
    </article>
  `;
}

function renderShopChoice({ provider, count, total }, selectedId, compact = false) {
  const active = selectedId === provider.id;
  return `<button type="button"
    class="${compact ? fPillClass(active, false, "shop-shortcut") : `shop-choice${active ? " is-active" : ""}`}"
    data-action="set-provider" data-provider="${escapeHtml(provider.id)}" aria-pressed="${active}"
    title="${escapeHtml(provider.name)} · ${total === 0 ? "尚无可核验套餐，库存待确认" : `${count} 款匹配套餐`}">
    <span class="shop-choice-name">${escapeHtml(shortProviderLabel(provider.name))}</span>
    <span class="shop-choice-count ${total === 0 ? "is-pending" : "num"}">${total === 0 ? "待核验" : count}</span>
  </button>`;
}

function renderTopFacetMatrixCard(state, facets, matchedCount, visibleCount, now) {
  const f = state.filters;
  const fx = state.payload ? fxFreshness(state.payload.exchangeRates, now) : { valid: true };
  const activeBadges = listActiveFilterBadges(f);
  const rankedShops = rankProvidersByPopularity(state.plans, facets.providerCounts);
  const COLLAPSED_SHOP_LIMIT = 8;

  // Missing collection data must not make priority brands disappear or imply sold out.
  const eligibleShops = rankedShops.filter((s) => s.count > 0 || (s.isHot && s.total === 0) || s.provider.id === f.provider);
  let displayedShops = eligibleShops.slice(0, COLLAPSED_SHOP_LIMIT);
  if (f.provider !== "all" && !displayedShops.some((s) => s.provider.id === f.provider)) {
    const selectedItem = rankedShops.find((s) => s.provider.id === f.provider);
    if (selectedItem) displayedShops = [...displayedShops, selectedItem];
  }

  const shopTokens = normalizeSearch(state.shopQuery || "").split(/\s+/).filter(Boolean);
  const matchingShops = eligibleShops.filter(({ provider }) => {
    const text = normalizeSearch([provider.id, provider.name, ...(provider.aliases || []), shortProviderLabel(provider.name)].join(" "));
    return shopTokens.every((token) => text.includes(token));
  });
  const totalShopCount = eligibleShops.length;
  const hasCustomBudget = Boolean(f.minPrice || f.maxPrice);
  const hasSpecFilters =
    f.cpu !== "all" ||
    f.memory !== "all" ||
    f.disk !== "all" ||
    f.bandwidth !== "all" ||
    f.traffic !== "all" ||
    f.budget !== "all" ||
    Boolean(f.minPrice) ||
    Boolean(f.maxPrice);

  return `
    <section class="filter-dock" aria-label="多维直选配置与筛选工作台" data-filter-dock>
      <!-- Priority brands with honest collection status, followed by matching shops. -->
      <div class="facet-matrix-row">
        <div class="facet-row-label" title="人工编排的常用商家顺序；数字为匹配套餐数，不代表热度">常用商家</div>
        <div class="facet-row-options" data-shops-row>
          <button type="button" class="${fPillClass(f.provider === "all", true)}" data-action="set-provider" data-provider="all">
            <span>全部品牌</span>
          </button>
          ${displayedShops.map((shop) => renderShopChoice(shop, f.provider, true)).join("")}
        </div>
        <div class="facet-row-extra">
          <button type="button" class="expand-btn" data-action="toggle-shops-expand" aria-expanded="${state.shopsExpanded}" aria-controls="shop-picker">
            <span>${state.shopsExpanded ? "收起店铺 ▴" : `更多商家 (${totalShopCount}) ▾`}</span>
          </button>
        </div>
      </div>

      <section class="shop-picker" id="shop-picker" data-shop-picker aria-label="商家选择面板" ${state.shopsExpanded ? "" : "hidden"}>
        ${state.shopsExpanded ? `
          <div class="shop-picker-head">
            <div class="shop-picker-heading">
              <strong>全部商家</strong>
              <span aria-live="polite">${matchingShops.length} 家 · 数字为匹配套餐数</span>
            </div>
            <input type="search" class="input-field shop-picker-search" data-shop-search value="${escapeHtml(state.shopQuery)}" placeholder="搜索商家名称或别名" aria-label="查找商家" />
          </div>
          ${matchingShops.length ? `<div class="shop-picker-grid" role="group" aria-label="匹配商家">
            ${matchingShops.map((shop) => renderShopChoice(shop, f.provider)).join("")}
          </div>` : `<div class="shop-picker-empty">
            <span>没有找到匹配的商家</span>
            <button type="button" class="btn btn-xs btn-ghost" data-action="clear-shop-search">清空搜索</button>
          </div>`}
        ` : ""}
      </section>

      <!-- Row 2: 地区下拉 + 节点用途定位 + 原生/优化属性 -->
      <div class="facet-matrix-row is-centered">
        <div class="facet-row-label">区域定位</div>
        <div class="facet-row-options">
          <select class="select-field region-dropdown ${f.region !== "all" ? "is-filtered" : ""}" data-filter-select="region" aria-label="按所在地区筛选">
            ${MACRO_REGIONS.map((r) => {
              const cnt = facets.regions.get(r.value) || 0;
              const code = r.value === "MULTI" ? "GL" : r.value === "APAC" ? "AP" : r.value;
              const lbl = r.value === "all" ? "全部地区" : `${code} · ${r.label} (${cnt})`;
              return `<option value="${r.value}" ${f.region === r.value ? "selected" : ""}>${escapeHtml(lbl)}</option>`;
            }).join("")}
          </select>

          <div class="facet-pill-cluster" role="group" aria-label="节点本质与用途">
            <button type="button" class="${fPillClass(f.track === "all", true)}" data-action="set-track" data-track="all">
              <span>全部定位</span><span class="f-cnt num">${facets.tracks.all}</span>
            </button>
            <button type="button" class="${fPillClass(f.track === "home", false, "is-home")}" data-action="set-track" data-track="home">
              <span>真家宽 / 双ISP</span><span class="f-cnt num">${facets.tracks.home}</span>
            </button>
            <button type="button" class="${fPillClass(f.track === "cn-opt", false)}" data-action="set-track" data-track="cn-opt">
              <span>CN优化直连</span><span class="f-cnt num">${facets.tracks["cn-opt"]}</span>
            </button>
            <button type="button" class="${fPillClass(f.track === "landing", false)}" data-action="set-track" data-track="landing">
              <span>国际纯落地</span><span class="f-cnt num">${facets.tracks.landing}</span>
            </button>
            <button type="button" class="${fPillClass(f.track === "vps", false)}" data-action="set-track" data-track="vps">
              <span>机房VPS</span><span class="f-cnt num">${facets.tracks.vps}</span>
            </button>
          </div>

          <div class="facet-pill-cluster is-subtle-sep" role="group" aria-label="原生与优化细分">
            <button type="button" class="${fPillClass(f.opt === "native", false)}" data-action="set-opt" data-opt="native">原生 / 双ISP</button>
            <button type="button" class="${fPillClass(f.opt === "opt", false)}" data-action="set-opt" data-opt="opt">有回国优化</button>
            <button type="button" class="${fPillClass(f.opt === "intl", false)}" data-action="set-opt" data-opt="intl">无优化直连</button>
          </div>
        </div>
      </div>

      <!-- Row 3: 骨干线路直选 -->
      <div class="facet-matrix-row is-centered">
        <div class="facet-row-label">骨干线路</div>
        <div class="facet-row-options">
          ${ROUTE_OPTIONS.map((r) => {
            const cnt = facets.routes.get(r.value) || 0;
            const isAll = r.value === "all";
            return `<button type="button" class="${fPillClass(f.route === r.value, isAll)}" data-action="set-route" data-route="${r.value}">
              <span>${isAll ? "全部线路" : r.label}</span>
              ${!isAll ? `<span class="f-cnt num">${cnt}</span>` : ""}
            </button>`;
          }).join("")}
        </div>
        <div class="facet-row-extra">
          <button type="button" class="expand-btn ${hasSpecFilters ? "has-active" : ""}" data-action="toggle-specs-expand" aria-expanded="${state.specsExpanded}">
            <span>${state.specsExpanded ? "收起硬件预算 ▴" : "硬件与预算 ▾"}</span>
          </button>
        </div>
      </div>

      ${
        state.specsExpanded
          ? `
            <!-- Responsive hardware and budget groups. -->
            <div class="spec-matrix-grid" data-specs-panel>
              <div class="spec-cell" role="group" aria-label="月均人民币预算区间">
                <span class="spec-cell-label">月均预算</span>
                <div class="spec-cell-opts budget-controls">
                  <select class="select-field mini-select budget-select ${f.budget !== "all" || hasCustomBudget ? "is-filtered" : ""}" data-filter-select="budget" aria-label="月均预算档位">
                    ${hasCustomBudget ? `<option value="custom" selected disabled>自定义金额</option>` : ""}
                    ${BUDGET_OPTIONS.map((b) => `<option value="${b.value}" ${f.budget === b.value && !hasCustomBudget ? "selected" : ""}>${b.value === "all" ? "不限" : b.label}</option>`).join("")}
                  </select>
                  <div class="price-range-box ${f.minPrice || f.maxPrice ? "is-active" : ""}" title="${!fx.valid ? "ECB 汇率超 7 天，外币套餐已停算 CNY" : "输入自定义人民币月均最低与最高价"}">
                    <span class="range-currency">￥</span>
                    <input type="number" min="0" step="1" class="price-range-input" data-price-min value="${escapeHtml(f.minPrice)}" placeholder="最低" aria-label="最低月均人民币" />
                    <span class="range-sep">-</span>
                    <input type="number" min="0" step="1" class="price-range-input" data-price-max value="${escapeHtml(f.maxPrice)}" placeholder="最高" aria-label="最高月均人民币" />
                  </div>
                </div>
              </div>

              <div class="spec-cell" role="group" aria-label="月流量配额">
                <span class="spec-cell-label">月度流量</span>
                <div class="spec-cell-opts">
                  ${TRAFFIC_OPTIONS.map(
                    (o) => `<button type="button" class="${fPillClass(f.traffic === o.value, o.value === "all")}" data-action="set-spec" data-spec-key="traffic" data-spec-val="${o.value}">${o.label.replace(/^♾\s*/, "")}</button>`
                  ).join("")}
                </div>
              </div>

              <div class="spec-cell" role="group" aria-label="端口带宽">
                <span class="spec-cell-label">端口带宽</span>
                <div class="spec-cell-opts">
                  ${BANDWIDTH_OPTIONS.map(
                    (o) => `<button type="button" class="${fPillClass(f.bandwidth === o.value, o.value === "all")}" data-action="set-spec" data-spec-key="bandwidth" data-spec-val="${o.value}">${o.label}</button>`
                  ).join("")}
                </div>
              </div>

              <div class="spec-cell" role="group" aria-label="CPU核数">
                <span class="spec-cell-label">CPU 核数</span>
                <div class="spec-cell-opts">
                  ${CPU_OPTIONS.map(
                    (o) => `<button type="button" class="${fPillClass(f.cpu === o.value, o.value === "all")}" data-action="set-spec" data-spec-key="cpu" data-spec-val="${o.value}">${o.label}</button>`
                  ).join("")}
                </div>
              </div>

              <div class="spec-cell" role="group" aria-label="内存大小">
                <span class="spec-cell-label">内存大小</span>
                <div class="spec-cell-opts">
                  ${MEMORY_OPTIONS.map(
                    (o) => `<button type="button" class="${fPillClass(f.memory === o.value, o.value === "all")}" data-action="set-spec" data-spec-key="memory" data-spec-val="${o.value}">${o.label}</button>`
                  ).join("")}
                </div>
              </div>

              <div class="spec-cell" role="group" aria-label="硬盘容量">
                <span class="spec-cell-label">硬盘容量</span>
                <div class="spec-cell-opts">
                  ${DISK_OPTIONS.map(
                    (o) => `<button type="button" class="${fPillClass(f.disk === o.value, o.value === "all")}" data-action="set-spec" data-spec-key="disk" data-spec-val="${o.value}">${o.label}</button>`
                  ).join("")}
                </div>
              </div>
            </div>
          `
          : ""
      }

      ${
        f.track === "home"
          ? `<div class="dock-track-note">
              <span><strong>真家宽 / 双 ISP 严格隔离已开启：</strong>自动剔除普通数据中心宣称“原生 IP”的机器，仅展示真实住宅宽带与双 ISP 宿主方案。</span>
              <button type="button" class="btn btn-xs btn-ghost" style="color:inherit" data-action="set-track" data-track="all">切回全部定位</button>
            </div>`
          : ""
      }

      <!-- Footer Row: 品质过滤开关 + 周期/库存状态 + 结果数与排序 -->
      <div class="dock-row-secondary">
        <div class="quick-toggles">
          <button type="button" class="q-toggle ${f.status === "available" ? "is-on" : ""}" data-action="toggle-quick-available" aria-pressed="${f.status === "available"}">
            <span class="q-dot ${f.status === "available" ? "is-live" : ""}"></span>
            <span>仅看现货</span>
          </button>
          <button type="button" class="q-toggle ${f.exactOnly ? "is-on-accent" : ""}" data-action="toggle-quick-exact" aria-pressed="${f.exactOnly}">
            <span>精确库存</span>
          </button>
          <button type="button" class="q-toggle ${f.noNat ? "is-on-accent" : ""}" data-action="toggle-quick-nonat" aria-pressed="${f.noNat}">
            <span>排除 NAT</span>
          </button>
          <button type="button" class="q-toggle ${f.noSnapshot ? "is-on-accent" : ""}" data-action="toggle-quick-nosnap" aria-pressed="${f.noSnapshot}">
            <span>排除快照</span>
          </button>
          <button type="button" class="q-toggle ${f.savedOnly ? "is-on-accent" : ""}" data-action="toggle-quick-saved" aria-pressed="${f.savedOnly}">
            <span>★ 收藏 (${state.savedKeys.size})</span>
          </button>

          <select class="select-field mini-select" data-filter-select="cycle" aria-label="按计费周期筛选">
            ${CYCLE_OPTIONS.map((c) => `<option value="${c.value}" ${f.cycle === c.value ? "selected" : ""}>${c.label}</option>`).join("")}
          </select>

          <select class="select-field mini-select" data-filter-select="status" aria-label="库存状态细项">
            <option value="available" ${f.status === "available" ? "selected" : ""}>状态: 在售现货</option>
            <option value="all" ${f.status === "all" ? "selected" : ""}>状态: 含缺货全部</option>
            <option value="unavailable" ${f.status === "unavailable" ? "selected" : ""}>状态: 仅看缺货</option>
            <option value="unknown" ${f.status === "unknown" ? "selected" : ""}>状态: 库存未公开</option>
          </select>

          ${
            activeBadges.length > 0
              ? `<button type="button" class="btn btn-xs btn-soft" data-action="reset-filters">↺ 重置已选 (${activeBadges.length})</button>`
              : ""
          }
        </div>

        <div class="toolbar-right">
          <div class="result-summary">
            共匹配 <strong>${matchedCount}</strong> 款${matchedCount > visibleCount ? `<span style="color:var(--ink-muted)">（展示前 ${visibleCount}）</span>` : ""}
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
          <button type="button" class="btn btn-sm" data-action="copy-share-url" title="复制带当前筛选与对比状态的 URL">分享</button>
        </div>
      </div>
    </section>
  `;
}

function renderMobileFilterSheet(state, facets, matchedCount, now) {
  const f = state.filters;
  const fx = state.payload ? fxFreshness(state.payload.exchangeRates, now) : { valid: true };
  const rankedShops = rankProvidersByPopularity(state.plans, facets.providerCounts);
  const mobileShops = rankedShops.filter((s) => s.count > 0 || (s.isHot && s.total === 0) || s.provider.id === f.provider);

  return `
    <aside class="mobile-filter-sheet ${state.mobileRailOpen ? "is-mobile-open" : ""}" aria-label="移动端全维筛选抽屉" data-mobile-filter-sheet>
      <div class="mobile-rail-header">
        <strong style="font-size:var(--text-base)">全维配置筛选（匹配 ${matchedCount} 款）</strong>
        <button type="button" class="btn btn-sm btn-ghost" data-action="close-mobile-rail" aria-label="关闭筛选抽屉">✕</button>
      </div>

      <div class="rail-section">
        <div class="rail-heading"><span>常用商家与地区</span></div>
        <select class="select-field" data-filter-select="provider" aria-label="按店铺筛选">
          <option value="all" ${f.provider === "all" ? "selected" : ""}>全部品牌（常用商家优先）</option>
          ${mobileShops
            .map(
              ({ provider, count, total, isHot }) =>
                `<option value="${escapeHtml(provider.id)}" ${f.provider === provider.id ? "selected" : ""}>${isHot ? "★ " : ""}${escapeHtml(provider.name)} (${total === 0 ? "待核验" : count})</option>`
            )
            .join("")}
        </select>
        <select class="select-field" data-filter-select="region" aria-label="按地区筛选">
          ${MACRO_REGIONS.map((r) => {
            const cnt = facets.regions.get(r.value) || 0;
            const code = r.value === "MULTI" ? "GL" : r.value === "APAC" ? "AP" : r.value;
            return `<option value="${r.value}" ${f.region === r.value ? "selected" : ""}>${r.value === "all" ? "全部地区" : `${code} ${r.label} (${cnt})`}</option>`;
          }).join("")}
        </select>
      </div>

      <div class="rail-section">
        <div class="rail-heading"><span>用途定位与线路</span></div>
        <div class="facet-wrap">
          <button type="button" class="${fPillClass(f.track === "all", true)}" data-action="set-track" data-track="all">全部 (${facets.tracks.all})</button>
          <button type="button" class="${fPillClass(f.track === "home", false, "is-home")}" data-action="set-track" data-track="home">真家宽 (${facets.tracks.home})</button>
          <button type="button" class="${fPillClass(f.track === "cn-opt", false)}" data-action="set-track" data-track="cn-opt">CN优化 (${facets.tracks["cn-opt"]})</button>
          <button type="button" class="${fPillClass(f.track === "landing", false)}" data-action="set-track" data-track="landing">纯落地 (${facets.tracks.landing})</button>
        </div>
        <div class="facet-wrap">
          ${OPT_OPTIONS.map((o) => `<button type="button" class="${fPillClass(f.opt === o.value, o.value === "all")}" data-action="set-opt" data-opt="${o.value}">${o.label}</button>`).join("")}
        </div>
        <div class="facet-wrap">
          ${ROUTE_OPTIONS.map((r) => `<button type="button" class="${fPillClass(f.route === r.value, r.value === "all")}" data-action="set-route" data-route="${r.value}">${r.label}</button>`).join("")}
        </div>
      </div>

      <div class="rail-section">
        <div class="rail-heading">
          <span>月均预算 · 流量 · 带宽</span>
          ${!fx.valid ? `<span style="color:var(--warn-fg);font-size:10px">外币停算</span>` : ""}
        </div>
        <div class="facet-wrap">
          ${BUDGET_OPTIONS.map((b) => `<button type="button" class="${fPillClass(f.budget === b.value && !f.minPrice && !f.maxPrice, b.value === "all")}" data-action="set-budget" data-budget="${b.value}">${b.label}</button>`).join("")}
        </div>
        <div class="price-range-box" style="align-self:flex-start">
          <span class="range-currency">自定义 ￥</span>
          <input type="number" min="0" step="1" class="price-range-input" data-price-min value="${escapeHtml(f.minPrice)}" placeholder="最低" aria-label="最低月均人民币" />
          <span class="range-sep">-</span>
          <input type="number" min="0" step="1" class="price-range-input" data-price-max value="${escapeHtml(f.maxPrice)}" placeholder="最高" aria-label="最高月均人民币" />
        </div>
        <div class="facet-wrap">${TRAFFIC_OPTIONS.map((o) => `<button type="button" class="${fPillClass(f.traffic === o.value, o.value === "all")}" data-action="set-spec" data-spec-key="traffic" data-spec-val="${o.value}">${o.value === "all" ? "流量不限" : o.label.replace(/^♾\s*/, "")}</button>`).join("")}</div>
        <div class="facet-wrap">${BANDWIDTH_OPTIONS.map((o) => `<button type="button" class="${fPillClass(f.bandwidth === o.value, o.value === "all")}" data-action="set-spec" data-spec-key="bandwidth" data-spec-val="${o.value}">${o.value === "all" ? "带宽不限" : o.label}</button>`).join("")}</div>
      </div>

      <div class="rail-section">
        <div class="rail-heading"><span>CPU · 内存 · 硬盘</span></div>
        <div class="facet-wrap">${CPU_OPTIONS.map((o) => `<button type="button" class="${fPillClass(f.cpu === o.value, o.value === "all")}" data-action="set-spec" data-spec-key="cpu" data-spec-val="${o.value}">${o.value === "all" ? "CPU不限" : o.label}</button>`).join("")}</div>
        <div class="facet-wrap">${MEMORY_OPTIONS.map((o) => `<button type="button" class="${fPillClass(f.memory === o.value, o.value === "all")}" data-action="set-spec" data-spec-key="memory" data-spec-val="${o.value}">${o.value === "all" ? "内存不限" : o.label}</button>`).join("")}</div>
        <div class="facet-wrap">${DISK_OPTIONS.map((o) => `<button type="button" class="${fPillClass(f.disk === o.value, o.value === "all")}" data-action="set-spec" data-spec-key="disk" data-spec-val="${o.value}">${o.value === "all" ? "硬盘不限" : o.label}</button>`).join("")}</div>
      </div>

      <div class="rail-section">
        <div class="rail-heading"><span>排序与现货红线</span></div>
        <select class="select-field" data-filter-select="sort" aria-label="排序方式">
          ${SORT_OPTIONS.map((opt) => `<option value="${opt.value}" ${f.sort === opt.value ? "selected" : ""}>${opt.label}</option>`).join("")}
        </select>
        <div class="check-list">
          <label class="check-row"><span class="check-row-left"><input type="checkbox" data-filter-toggle="availableOnly" ${f.status === "available" ? "checked" : ""} /><span>仅看在售现货</span></span></label>
          <label class="check-row"><span class="check-row-left"><input type="checkbox" data-filter-toggle="exactOnly" ${f.exactOnly ? "checked" : ""} /><span>仅看精确库存数字</span></span></label>
          <label class="check-row"><span class="check-row-left"><input type="checkbox" data-filter-toggle="noNat" ${f.noNat ? "checked" : ""} /><span>排除 NAT / 共享 IP</span></span></label>
          <label class="check-row"><span class="check-row-left"><input type="checkbox" data-filter-toggle="noSnapshot" ${f.noSnapshot ? "checked" : ""} /><span>排除第三方快照</span></span></label>
        </div>
      </div>

      <div class="mobile-rail-footer">
        <button type="button" class="btn" data-action="reset-filters" style="flex:0 0 auto">重置</button>
        <button type="button" class="btn btn-primary" data-action="close-mobile-rail" style="flex:1">查看 ${matchedCount} 款匹配方案</button>
      </div>
    </aside>
  `;
}

function renderSkeleton() {
  return `
    <div class="skeleton-stack" data-skeleton-grid aria-busy="true" aria-label="正在加载实时监控快照">
      <div style="display:flex;gap:8px;flex-wrap:wrap;padding-bottom:10px;border-bottom:1px solid var(--border-subtle)">
        <span class="skel" style="height:26px;width:90px"></span>
        <span class="skel" style="height:26px;width:110px"></span>
        <span class="skel" style="height:26px;width:110px"></span>
        <span class="skel" style="height:26px;width:110px"></span>
        <span class="skel" style="height:26px;width:110px"></span>
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
        根据 VPS雷达 (vpsld) 数据诚实性原则，当上游 <code>data/products.json</code> 不可达时绝不回退或编造任何本地假库存。
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn btn-primary" data-action="refresh-snapshot">↻ 重试读取快照</button>
        <button type="button" class="btn" data-nav-view="guide">查看数据口径说明</button>
      </div>
    </section>
  `;
}

function renderZeroResults(state) {
  const { plans, filters, savedKeys, diagnostics } = state;
  const provider = resolveProvider({ providerId: filters.provider });
  if (provider && !plans.some((p) => p._providerId === provider.id)) {
    const blocked = diagnostics.some((p) => p._providerId === provider.id && p.status === "blocked");
    return `<section class="empty-state-card" data-zero-results>
      <span class="pill pill-warn">库存待核验</span>
      <h2 class="empty-state-title">暂未取得 ${escapeHtml(provider.name)} 的可核验套餐</h2>
      <p class="empty-state-desc">${blocked ? "官方页面访问受限，暂时无法确认库存。" : "当前快照尚无该商家的套餐数据。"}这不代表商家售罄，请前往官网确认。</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <a class="btn btn-primary" href="${escapeHtml(safeUrl(provider.website))}" target="_blank" rel="noopener noreferrer">前往官网核验 ↗</a>
        <a class="btn" href="?view=providers&provQ=${encodeURIComponent(provider.name)}">查看商家监控状态</a>
        <button type="button" class="btn" data-action="reset-filters">查看其他商家</button>
      </div>
    </section>`;
  }
  const diag = diagnoseZeroResults(plans, filters, savedKeys);
  return `
    <section class="empty-state-card" data-zero-results>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="pill pill-warn">0 匹配结果</span>
        <span style="font-size:var(--text-xs);color:var(--ink-muted)">当前生效 ${diag.activeCount} 项筛选条件存在互斥</span>
      </div>
      <h2 class="empty-state-title">当前配置组合下暂无匹配套餐</h2>
      <p class="empty-state-desc">
        系统已自动定位冲突条件，点击下方任意按钮即可一键放宽对应维度：
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
          : `<p class="empty-state-desc">当前多维配置约束叠加过严，建议直接重置筛选条件重新选择。</p>`
      }
      <div>
        <button type="button" class="btn btn-primary" data-action="reset-filters">重置全部筛选条件</button>
      </div>
    </section>
  `;
}

function renderLiveTickerRibbon(state, matched, activeCount) {
  if (!state.events?.length || matched.length === 0) return "";
  const matchedIds = new Set(matched.map((p) => p.id));
  const candidates = state.events.filter((ev) => {
    if (!ev.productId) return false;
    if (activeCount > 0) return matchedIds.has(ev.productId);
    return matchedIds.has(ev.productId) || ev.type === "soldout";
  });
  if (candidates.length === 0) return "";

  const sorted = [...candidates]
    .sort((a, b) => {
      const rank = (e) => (e.type === "restock" ? 0 : e.type === "price" ? 1 : 2);
      return rank(a) - rank(b) || (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0);
    })
    .slice(0, 12);

  const renderChip = (ev, clone = false) => {
    const delta = formatEventDelta(ev);
    const tag =
      ev.type === "restock"
        ? `<span class="ticker-tag is-restock">补货</span>`
        : ev.type === "soldout"
          ? `<span class="ticker-tag is-soldout">售罄</span>`
          : delta?.direction === "down"
            ? `<span class="ticker-tag is-down num">↓ ${escapeHtml(delta.label)}</span>`
            : `<span class="ticker-tag is-up num">↑ ${escapeHtml(delta?.label || "变价")}</span>`;
    const stockTxt = ev.type === "restock" && Number.isInteger(ev.stockCount) ? ` · 余${ev.stockCount}` : "";
    return `<button type="button" class="live-ticker-item" data-action="inspect-ticker-event" data-ticker-product-id="${escapeHtml(ev.productId)}" ${clone ? 'tabindex="-1" aria-hidden="true"' : ""}>
      <span class="mono" style="color:var(--ink-faint);font-size:10.5px">${escapeHtml(formatClockTime(ev.at))}</span>
      ${tag}
      <strong style="color:var(--ink-primary)">${escapeHtml(shortProviderLabel(ev.provider))}</strong>
      <span>${escapeHtml(plain(ev.name))}${escapeHtml(stockTxt)}</span>
      <span class="mono num" style="color:var(--price-main);font-weight:700">${escapeHtml(formatPriceLabel(ev))}</span>
    </button>`;
  };

  // Ensure enough items in one cycle so wide desktops scroll seamlessly without gaps
  const repeatCount = sorted.length < 4 ? Math.ceil(4 / sorted.length) : 1;
  const cycleItems = Array.from({ length: repeatCount }, () => sorted).flat();
  const durSec = Math.max(22, Math.round(cycleItems.length * 4.2));

  return `
    <div class="live-ticker-ribbon" aria-label="实时库存与价格异动跑马灯" data-live-ribbon>
      <span class="live-ticker-head">
        <span class="radar-ping-dot" style="width:6.5px;height:6.5px" aria-hidden="true"></span>
        <span>${activeCount > 0 ? "当前筛选异动" : "实时异动流"}</span>
      </span>
      <div class="live-ticker-viewport">
        <div class="live-ticker-track" style="--marquee-dur:${durSec}s">
          ${cycleItems.map((ev) => renderChip(ev, false)).join("")}
          ${cycleItems.map((ev) => renderChip(ev, true)).join("")}
        </div>
      </div>
      <button type="button" class="live-ticker-tail" data-nav-view="radar">
        <span>全部异动</span>
        <span aria-hidden="true">→</span>
      </button>
    </div>
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
      <div class="mobile-quick-row">
        <button type="button" class="btn btn-sm ${activeCount ? "btn-primary" : "btn-soft"}" data-action="open-mobile-rail">
          <span>配置筛选</span>${activeCount ? `<span class="num">(${activeCount})</span>` : ""}
        </button>
        <button type="button" class="btn btn-sm ${state.filters.track === "all" ? "is-active" : ""}" data-action="set-track" data-track="all">全部 <span class="num">${facets.tracks.all}</span></button>
        <button type="button" class="btn btn-sm ${state.filters.track === "home" ? "is-active" : ""}" data-action="set-track" data-track="home">真家宽 <span class="num">${facets.tracks.home}</span></button>
        <button type="button" class="btn btn-sm ${state.filters.track === "cn-opt" ? "is-active" : ""}" data-action="set-track" data-track="cn-opt">CN优化 <span class="num">${facets.tracks["cn-opt"]}</span></button>
        <button type="button" class="btn btn-sm ${state.filters.track === "landing" ? "is-active" : ""}" data-action="set-track" data-track="landing">纯落地 <span class="num">${facets.tracks.landing}</span></button>
      </div>
    </div>
  `;

  const priceSorted = state.filters.sort === "cny-asc" || state.filters.sort === "cny-desc";
  const priceArrow = state.filters.sort === "cny-asc" ? "↑" : state.filters.sort === "cny-desc" ? "↓" : "↕";
  const stockSorted = state.filters.sort === "stock-desc";
  const stockArrow = stockSorted ? "↓" : "↕";

  let bodyHtml = "";
  if (matched.length === 0) {
    bodyHtml = renderZeroResults(state);
  } else if (state.layout === "grid") {
    bodyHtml = `<div class="plan-grid" data-plan-grid>${visible.map((p, idx) => renderPlanCard(p, state, now, idx)).join("")}</div>`;
  } else {
    bodyHtml = `
      <div class="table-shell">
        <table class="terminal-table" aria-label="实时库存套餐列表">
          <thead>
            <tr>
              <th class="col-plan">套餐型号 / 商家 / 地区</th>
              <th class="col-net">节点定位与线路</th>
              <th class="col-hw">硬件规格</th>
              <th class="col-bw">带宽 / 流量</th>
              <th class="col-price col-num">
                <button type="button" class="th-sort-btn ${priceSorted ? "is-sorted" : ""}" data-action="sort-col" data-sort-col="price">
                  <span>价格 / 折合月均</span><span class="mono">${priceArrow}</span>
                </button>
              </th>
              <th class="col-stock">
                <button type="button" class="th-sort-btn ${stockSorted ? "is-sorted" : ""}" data-action="sort-col" data-sort-col="stock">
                  <span>实时库存</span><span class="mono">${stockArrow}</span>
                </button>
              </th>
              <th class="col-act col-num">操作</th>
            </tr>
          </thead>
          <tbody>
            ${visible.map((p, idx) => renderTableRow(p, state, now, idx)).join("")}
          </tbody>
        </table>
      </div>
      <div class="mobile-cards-list" aria-label="移动端套餐卡片列表">
        ${visible.map((p, idx) => renderPlanCard(p, state, now, idx)).join("")}
      </div>
    `;
  }

  const pagerHtml =
    matched.length > visible.length
      ? `<div class="pager-bar">
          <span>当前展示 1–${visible.length} / 共 ${matched.length} 款方案${state.filters.sort === "recommended" ? "（常用商家优先，各商家套餐交替展示）" : ""}</span>
          <div style="display:flex;gap:8px">
            <button type="button" class="btn btn-sm btn-soft" data-action="load-more">加载更多 (+60)</button>
            <button type="button" class="btn btn-sm btn-ghost" data-action="load-all">展开全部 (${matched.length})</button>
          </div>
        </div>`
      : matched.length > 0
        ? `<div class="pager-bar">
            <span>已展示全部 ${matched.length} 款匹配方案 · 诊断型/受阻源共 ${state.diagnostics.length} 条已独立收纳于「商家名录」</span>
            <button type="button" class="btn btn-xs btn-ghost" data-nav-view="providers">查看受阻源诊断 →</button>
          </div>`
        : "";

  return `
    <div class="terminal-shell">
      ${renderLiveTickerRibbon(state, matched, activeCount)}
      ${mobileQuickBar}
      ${renderTopFacetMatrixCard(state, facets, matched.length, visible.length, now)}
      ${renderMobileFilterSheet(state, facets, matched.length, now)}
      <div class="terminal-canvas" data-terminal-canvas>
        ${bodyHtml}
        ${pagerHtml}
      </div>
    </div>
  `;
}
