import { providers } from "../../providers.js";
import { renderPlanTagBadge, renderShopTagBadge } from "./tag-icons.js";
import {
  REVIEW_DOSSIERS,
  SHOP_TAG_DEFS,
  SHOP_TAG_ORDER,
  evaluateProviderTags,
  providerBaseWeight,
  providerHealth
} from "../domain/catalog.js";
import { escapeHtml, formatCny, normalizeSearch, plain, providerInitial, safeUrl } from "../domain/format.js";

const PROV_QUICK_REGIONS = [
  ["all", "全部地区"],
  ["US", "US 美国"],
  ["CNHK", "HK 香港"],
  ["JP", "JP 日本"],
  ["CNTW", "TW 台湾"],
  ["SG", "SG 新加坡"],
  ["UK", "GB 英国"],
  ["DE", "DE 德国"],
  ["KR", "KR 韩国"]
];

const PROV_FEATURES = [
  ["all", "全部主营定位"],
  ["家宽", "家宽 / 住宅"],
  ["双 ISP", "双 ISP"],
  ["CN优化线路", "CN 优化线路"],
  ["纯落地", "纯落地"],
  ["性能", "高性能"],
  ["大盘鸡", "大盘鸡 / 存储"]
];

const PROV_SORTS = [
  ["recommended", "排序: 常用推荐优先"],
  ["avail-desc", "排序: 在售现货最多"],
  ["exact-desc", "排序: 精确库存最多"],
  ["price-asc", "排序: 最低月均从低到高"],
  ["name-asc", "排序: 品牌名称 A–Z"]
];

function formatProvRegionCode(code) {
  if (code === "CNHK") return "HK";
  if (code === "CNTW") return "TW";
  if (code === "UK") return "GB";
  if (code === "other") return "其他";
  return code;
}

function smartBrandMonogram(provider) {
  const idUpper = String(provider.id || "").toUpperCase();
  if (/^[A-Z0-9]{2,3}$/.test(idUpper)) return idUpper;
  const parenMatch = String(provider.name || "").match(/[（(]([A-Za-z0-9]{2,4})[）)]/);
  if (parenMatch) return parenMatch[1].toUpperCase();
  const init = providerInitial(provider.name);
  if (/[\u4e00-\u9fff]/.test(init)) return [...init][0];
  return init;
}

function computeProviderPriceFloor(health) {
  const availPlans = (health.plans || []).filter((p) => p.status === "available");
  if (availPlans.length === 0) return { minCny: Infinity, label: "" };

  let bestCnyPlan = null;
  for (const p of availPlans) {
    const cny = p._pricing?.cnyMonthly;
    if (Number.isFinite(cny) && (!bestCnyPlan || cny < bestCnyPlan._pricing.cnyMonthly)) {
      bestCnyPlan = p;
    }
  }
  if (bestCnyPlan) {
    return {
      minCny: bestCnyPlan._pricing.cnyMonthly,
      label: `${formatCny(bestCnyPlan._pricing.cnyMonthly)}/月起`
    };
  }
  const firstWithPrice = availPlans.find((p) => p._pricing?.displayLabel && p._pricing.displayLabel !== "未公开报价");
  return {
    minCny: Infinity,
    label: firstWithPrice ? `${firstWithPrice._pricing.displayLabel}` : ""
  };
}

export function renderProvidersView(state) {
  if (state.loadState === "loading") {
    return `<div class="skeleton-stack"><span class="skel" style="height:28px;width:45%"></span><span class="skel" style="height:260px;width:100%"></span></div>`;
  }
  if (state.loadState === "error") {
    return `<section class="empty-state-card is-error">
      <h2 class="empty-state-title">无法加载商家库存与监控状态</h2>
      <p class="empty-state-desc">上游快照接口当前不可用（${escapeHtml(state.errorDetail?.detail || "Fetch error")}），暂时无法判断商家的套餐与库存。</p>
      <div><button type="button" class="btn btn-primary" data-action="refresh-snapshot">↻ 重试读取</button></div>
    </section>`;
  }

  const pf = state.providersFilter;
  const sortMode = state.providersSort || "recommended";
  const enriched = providers.map((p) => {
    const health = providerHealth(p, state.allRecords);
    const priceFloor = computeProviderPriceFloor(health);
    const tagInfo = evaluateProviderTags(p, health.plans);
    return {
      provider: p,
      health,
      priceFloor,
      tagInfo,
      dossier: REVIEW_DOSSIERS[p.id] || null
    };
  });

  let availableCount = 0;
  let issueCount = 0;
  let dossierCount = 0;
  let collectingCount = 0;

  for (const item of enriched) {
    if (item.health.available > 0) availableCount += 1;
    if (["blocked", "partial"].includes(item.health.state) || item.health.pageLimitReached) issueCount += 1;
    if (item.dossier) dossierCount += 1;
    if (item.provider.directoryStatus === "collecting") collectingCount += 1;
  }

  const query = normalizeSearch(pf.q);
  const tagCounts = new Map(SHOP_TAG_ORDER.map((k) => [k, 0]));
  for (const item of enriched) {
    for (const t of item.tagInfo.tags) {
      if (tagCounts.has(t.key)) tagCounts.set(t.key, tagCounts.get(t.key) + 1);
    }
  }

  const filtered = enriched
    .filter(({ provider, health, tagInfo, dossier }) => {
      if (pf.health === "available" && health.available === 0) return false;
      if (pf.health === "issue" && health.state !== "blocked" && health.state !== "partial" && !health.pageLimitReached) return false;
      if (pf.health === "dossier" && !dossier) return false;
      if (pf.health === "collecting" && provider.directoryStatus !== "collecting") return false;
      if (pf.region !== "all" && !(provider.regions || []).includes(pf.region)) return false;
      if (pf.feature !== "all" && !(provider.features || []).includes(pf.feature)) return false;
      if (pf.tag && pf.tag !== "all" && !tagInfo.tags.some((t) => t.key === pf.tag)) return false;
      if (query) {
        const tagTerms = tagInfo.tags.flatMap((t) => [t.shortLabel, t.label, ...(t.searchAliases || [])]);
        const hay = normalizeSearch(
          [
            provider.id,
            provider.name,
            ...(provider.aliases || []),
            ...(provider.features || []),
            ...(provider.regions || []),
            ...tagTerms,
            provider.directoryStatus === "collecting" ? "目录收集中 收集中 collecting" : ""
          ].join(" ")
        );
        if (!hay.includes(query)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (sortMode === "avail-desc") {
        return b.health.available - a.health.available || providerBaseWeight(b.provider.id) - providerBaseWeight(a.provider.id);
      }
      if (sortMode === "exact-desc") {
        return b.health.exactCount - a.health.exactCount || b.health.available - a.health.available;
      }
      if (sortMode === "price-asc") {
        return a.priceFloor.minCny - b.priceFloor.minCny || b.health.available - a.health.available;
      }
      if (sortMode === "name-asc") {
        return a.provider.name.localeCompare(b.provider.name, "zh-CN");
      }
      return (
        Number(b.health.currentPlanCount > 0) - Number(a.health.currentPlanCount > 0) ||
        providerBaseWeight(b.provider.id) - providerBaseWeight(a.provider.id) ||
        Number(b.health.available > 0) - Number(a.health.available > 0) ||
        a.provider.name.localeCompare(b.provider.name, "zh-CN")
      );
    });

  return `
    <section class="prov-deck" aria-label="商家名录与健康度筛选工作台">
      <div class="prov-deck-top">
        <div class="prov-deck-heading">
          <h1 class="radar-deck-title">商家目录与监控源健康（${providers.length} 家）</h1>
          <span class="prov-deck-sub">绑定官方源 · 诚实披露 WAF 受阻与 <code>pageLimitReached</code> 诊断</span>
        </div>

        <div class="prov-kpi-pills" role="group" aria-label="按采集健康度筛选">
          <button type="button" class="radar-type-btn ${pf.health === "all" ? "is-active" : ""}" data-action="set-prov-health" data-health="all">
            <span>全部收录</span>
            <strong class="kpi-val num">${providers.length}</strong>
          </button>
          <button type="button" class="radar-type-btn is-ok ${pf.health === "available" ? "is-active" : ""}" data-action="set-prov-health" data-health="available">
            <span>● 有现货商家</span>
            <strong class="kpi-val num">${availableCount}</strong>
          </button>
          <button type="button" class="radar-type-btn is-danger ${pf.health === "issue" ? "is-active" : ""}" data-action="set-prov-health" data-health="issue">
            <span>⚠ 受阻 / 异常</span>
            <strong class="kpi-val num">${issueCount}</strong>
          </button>
          <button type="button" class="radar-type-btn ${pf.health === "dossier" ? "is-active" : ""}" data-action="set-prov-health" data-health="dossier">
            <span>★ 实测档案</span>
            <strong class="kpi-val num">${dossierCount}</strong>
          </button>
          ${
            collectingCount > 0
              ? `<button type="button" class="radar-type-btn ${pf.health === "collecting" ? "is-active" : ""}" data-action="set-prov-health" data-health="${pf.health === "collecting" ? "all" : "collecting"}" title="筛选 MeowVPS 源目录中标注为「收集中」的商家">
                  <span>仅看收集中 (${collectingCount})</span>
                </button>`
              : ""
          }
        </div>
      </div>

      <div class="prov-deck-bar">
        <div class="prov-region-pills" role="group" aria-label="按覆盖地区一键筛选">
          ${PROV_QUICK_REGIONS.map(
            ([val, lbl]) =>
              `<button type="button" class="f-pill ${pf.region === val ? (val === "all" ? "is-all-default" : "is-active") : ""}" data-action="set-prov-region" data-prov-region="${val}">${lbl}</button>`
          ).join("")}
        </div>

        <div class="radar-filter-cluster">
          <div class="input-wrap" style="width:208px">
            <input type="search" class="input-field" style="height:28px" data-provider-search value="${escapeHtml(pf.q)}" placeholder="搜商家、别名或标签（热门 / 低价）…" aria-label="搜索商家" />
          </div>
          <select class="select-field mini-select" data-provider-select="tag" aria-label="按商家标签筛选">
            <option value="all" ${(pf.tag || "all") === "all" ? "selected" : ""}>全部商家标签</option>
            ${SHOP_TAG_ORDER.map((k) => {
              const def = SHOP_TAG_DEFS[k];
              return `<option value="${k}" ${pf.tag === k ? "selected" : ""}>${escapeHtml(def.label)} (${tagCounts.get(k) || 0})</option>`;
            }).join("")}
          </select>
          <select class="select-field mini-select" data-provider-select="feature" aria-label="按商家定位筛选">
            ${PROV_FEATURES.map(([v, l]) => `<option value="${v}" ${pf.feature === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
          <select class="select-field mini-select" data-provider-sort aria-label="商家排序方式">
            ${PROV_SORTS.map(([v, l]) => `<option value="${v}" ${sortMode === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
          ${
            pf.q || pf.region !== "all" || pf.feature !== "all" || (pf.tag && pf.tag !== "all") || pf.health !== "all" || sortMode !== "recommended"
              ? `<button type="button" class="btn btn-xs btn-ghost" data-action="reset-providers">重置</button>`
              : ""
          }
          <span class="radar-hit-count num"><strong>${filtered.length}</strong> / ${providers.length} 家</span>
        </div>
      </div>
    </section>

    ${
      filtered.length === 0
        ? `<section class="empty-state-card">
            <h2 class="empty-state-title">没有匹配当前条件的商家</h2>
            <div><button type="button" class="btn btn-primary" data-action="reset-providers">重置商家筛选</button></div>
          </section>`
        : `<div class="provider-grid">
            ${filtered
              .map(({ provider, health, priceFloor, tagInfo, dossier }, idx) => {
                const stateBadge =
                  health.state === "healthy"
                    ? `<span class="pill pill-ok">● 正常采集</span>`
                    : health.state === "partial"
                      ? `<span class="pill pill-warn">◐ 部分受限</span>`
                      : health.state === "blocked"
                        ? `<span class="pill pill-danger">✕ 直连受阻</span>`
                        : health.state === "soldout"
                          ? `<span class="pill pill-neutral">○ 暂告售罄</span>`
                          : `<span class="pill pill-neutral pill-outline">? 状态待核</span>`;

                const sum = Math.max(1, health.available + health.unavailable + health.unknown + health.blocked + health.error);
                const pct = (n) => `${((n / sum) * 100).toFixed(1)}%`;
                const cardClass = health.state === "blocked" ? "is-blocked" : health.state === "partial" || health.pageLimitReached ? "has-issue" : "";
                const avatarClass = health.available > 0 ? "is-healthy" : health.state === "blocked" ? "is-blocked" : "";
                const websiteHref = safeUrl(provider.website);
                const dirHref = safeUrl(provider.directorySource);
                const migrationHref = safeUrl(provider.officialEvidence);
                const aliases = (provider.aliases || []).filter((a) => a !== provider.name);
                const regionCodes = (provider.regions || []).filter((r) => r !== "other").slice(0, 6);
                const hasOtherRegion = (provider.regions || []).includes("other") || (provider.regions || []).length > 6;

                const planTagRank = (p) => {
                  const k = p._primaryPlanTag?.key;
                  if (k === "blockbuster") return 0;
                  if (k === "generous") return 1;
                  if (k === "home-opt") return 2;
                  if (k === "annual") return 3;
                  if (k === "perf") return 4;
                  if (k === "value") return 5;
                  if (k === "scarce") return 6;
                  if (k === "budget") return 7;
                  return 8;
                };
                const sampleAvailPlans = (health.plans || [])
                  .filter((p) => p.status === "available")
                  .sort((a, b) => planTagRank(a) - planTagRank(b) || (a._pricing?.cnyMonthly ?? Infinity) - (b._pricing?.cnyMonthly ?? Infinity))
                  .slice(0, 2);

                return `<article class="provider-card ${cardClass}" data-provider-id="${escapeHtml(provider.id)}" style="--stagger-i:${Math.min(idx, 14)}">
                  <div class="provider-head">
                    <div class="provider-ident">
                      <span class="provider-avatar ${avatarClass}">${escapeHtml(smartBrandMonogram(provider))}</span>
                      <div class="provider-name-wrap">
                        <div class="provider-title-row">
                          ${tagInfo.tags.map((t) => renderShopTagBadge(t, { interactive: true })).join("")}
                          <h3 class="provider-name" title="${escapeHtml(provider.name)}">${escapeHtml(provider.name)}</h3>
                        </div>
                        <div class="provider-aliases">${aliases.length ? `别名：${escapeHtml(aliases.join(" / "))}` : `ID: ${escapeHtml(provider.id)}`}</div>
                      </div>
                    </div>
                    ${stateBadge}
                  </div>

                  <div class="prov-tag-matrix">
                    ${(provider.features || [])
                      .map((f) => `<span class="net-micro-tag ${f === "家宽" || f === "双 ISP" ? "is-home" : f === "CN优化线路" ? "is-9929" : "is-bgp"}">${escapeHtml(f)}</span>`)
                      .join("")}
                    ${regionCodes.map((rc) => `<span class="iso-code">${escapeHtml(formatProvRegionCode(rc))}</span>`).join("")}
                    ${hasOtherRegion ? `<span class="iso-code">+多国</span>` : ""}
                    ${provider.directoryStatus === "collecting" ? `<span class="net-micro-tag is-muted" title="MeowVPS 源目录尚在收集整理中，本站已同步接入官方页面监测">目录收集中</span>` : ""}
                    ${health.pageLimitReached ? `<span class="net-micro-tag is-warn" title="公开目录页数达到单轮采集上限，非全量覆盖">目录页触顶</span>` : ""}
                    ${dossier ? `<a class="net-micro-tag is-warn" style="text-decoration:none" href="${escapeHtml(dossier.path)}">实测档案 →</a>` : ""}
                  </div>

                  <div class="prov-health-block">
                    <div class="health-bar" aria-label="库存状态分布">
                      ${health.available ? `<span class="health-seg-ok" style="width:${pct(health.available)}"></span>` : ""}
                      ${health.unavailable ? `<span class="health-seg-sold" style="width:${pct(health.unavailable)}"></span>` : ""}
                      ${health.unknown ? `<span class="health-seg-unk" style="width:${pct(health.unknown)}"></span>` : ""}
                      ${health.blocked + health.error ? `<span class="health-seg-blk" style="width:${pct(health.blocked + health.error)}"></span>` : ""}
                    </div>

                    <div class="health-metrics">
                      <span>现货 <strong style="color:var(--ok-fg)">${health.available}</strong></span>
                      ${health.exactCount ? `<span>精确 <strong style="color:var(--ok-fg)">${health.exactCount}</strong></span>` : ""}
                      <span>售罄 <strong>${health.unavailable}</strong></span>
                      ${health.unknown ? `<span>未明 <strong>${health.unknown}</strong></span>` : ""}
                      ${health.blocked + health.error ? `<span style="color:var(--danger-fg)">受阻 <strong>${health.blocked + health.error}</strong></span>` : ""}
                      ${priceFloor.label ? `<span class="prov-price-floor num" title="当前在售套餐最低参考价">${escapeHtml(priceFloor.label)}</span>` : ""}
                    </div>
                  </div>

                  ${
                    sampleAvailPlans.length > 0
                      ? `<div class="prov-sample-list" aria-label="该商家当前可购代表方案">
                          ${sampleAvailPlans
                            .map((sp) => {
                              const pt = sp._primaryPlanTag;
                              return `<button type="button" class="prov-sample-item" data-action="inspect-plan" data-product-id="${escapeHtml(sp.id)}">
                                <span class="prov-sample-lead">
                                  ${pt ? renderPlanTagBadge(pt, { compact: true }) : ""}
                                  <span class="prov-sample-name">${escapeHtml(plain(sp.name))}</span>
                                </span>
                                <span class="prov-sample-price mono num">${escapeHtml(sp._pricing?.displayLabel || "")}</span>
                              </button>`;
                            })
                            .join("")}
                        </div>`
                      : health.diagnostics.length === 0
                        ? `<div class="prov-idle-note">
                            ${
                              health.planCount > 0
                                ? `当前快照暂未检出可购现货（共收录 ${health.planCount} 款套餐，可点下方查看或前往官网核对）`
                                : provider.directoryStatus === "collecting"
                                  ? "源目录收集中，已绑定官方站点持续巡检，可直达官网查阅最新方案"
                                  : "当前公开页面未提供固定周期公开目录，请直接访问官网查阅"
                            }
                          </div>`
                        : ""
                  }

                  ${
                    health.diagnostics.length
                      ? `<details class="diag-box ${health.available > 0 ? "is-warn" : ""}">
                          <summary>查看采集诊断证据（${health.diagnostics.length} 条）</summary>
                          <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px">
                            ${health.diagnostics
                              .map((d) => {
                                const attempts = Array.isArray(d.raw?.attempts) ? d.raw.attempts : [];
                                return `<div style="padding:6px 8px;border-radius:var(--r-xs);background:var(--bg-surface);color:var(--ink-secondary)">
                                  <div class="mono" style="font-weight:600;color:var(--ink-primary)">${escapeHtml(plain(d.statusLabel || d.status))} ${d.httpStatus ? `· HTTP ${d.httpStatus}` : ""}</div>
                                  <div style="margin-top:2px;overflow-wrap:anywhere">${escapeHtml(plain(d.evidence || d.error || "无详细说明"))}</div>
                                  ${
                                    attempts.length
                                      ? `<div class="mono" style="margin-top:4px;font-size:10.5px;color:var(--ink-muted)">已尝试 ${attempts.length} 次公开抓取：${attempts
                                          .slice(0, 3)
                                          .map((a) => escapeHtml(`${a.statusCode ?? a.httpStatus ?? "ERR"} ${a.url || ""}`))
                                          .join(" | ")}</div>`
                                      : ""
                                  }
                                </div>`;
                              })
                              .join("")}
                          </div>
                        </details>`
                      : ""
                  }

                  ${
                    migrationHref
                      ? `<div style="font-size:11px;color:var(--ink-secondary)">
                          官方迁移公告：<a href="${escapeHtml(migrationHref)}" target="_blank" rel="nofollow noopener noreferrer">查看依据 ↗</a>
                        </div>`
                      : ""
                  }

                  <div class="provider-foot">
                    <div style="display:flex;gap:10px;align-items:center;font-size:var(--text-xs)">
                      ${websiteHref ? `<a href="${escapeHtml(websiteHref)}" target="_blank" rel="nofollow noopener noreferrer">官网 ↗</a>` : ""}
                      ${dirHref ? `<a style="color:var(--ink-muted)" href="${escapeHtml(dirHref)}" target="_blank" rel="nofollow noopener noreferrer">目录 ↗</a>` : ""}
                    </div>
                    <button
                      type="button"
                      class="btn btn-xs ${health.available > 0 ? "btn-primary" : health.planCount > 0 ? "btn-soft" : ""}"
                      data-action="drill-provider"
                      data-provider-id="${escapeHtml(provider.id)}"
                      ${health.planCount === 0 ? "disabled" : ""}
                    >${health.planCount > 0 ? `筛选 ${health.planCount} 款套餐 →` : "暂无固定套餐"}</button>
                  </div>
                </article>`;
              })
              .join("")}
          </div>`
    }
  `;
}
