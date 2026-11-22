import { providers } from "../../providers.js";
import { REVIEW_DOSSIERS, providerHealth } from "../domain/catalog.js";
import { escapeHtml, normalizeSearch, plain, providerInitial, safeUrl } from "../domain/format.js";

const PROV_REGIONS = [
  ["all", "全部覆盖地区"],
  ["US", "US 美国"],
  ["CNHK", "HK 香港"],
  ["JP", "JP 日本"],
  ["CNTW", "TW 台湾"],
  ["SG", "SG 新加坡"],
  ["UK", "GB 英国"],
  ["DE", "DE 德国"],
  ["KR", "KR 韩国"],
  ["CN", "CN 中国内地"]
];

const PROV_FEATURES = [
  ["all", "全部商家定位"],
  ["家宽", "家宽 / 住宅"],
  ["CN优化线路", "CN 优化线路"],
  ["纯落地", "纯落地"],
  ["性能", "高性能"],
  ["大盘鸡", "大盘鸡 / 存储"],
  ["双 ISP", "双 ISP"]
];

export function renderProvidersView(state) {
  if (state.loadState === "loading") {
    return `<div class="skeleton-stack"><span class="skel" style="height:28px;width:45%"></span><span class="skel" style="height:260px;width:100%"></span></div>`;
  }

  const pf = state.providersFilter;
  const enriched = providers.map((p) => ({
    provider: p,
    health: providerHealth(p, state.allRecords),
    dossier: REVIEW_DOSSIERS[p.id] || null
  }));

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
  const filtered = enriched
    .filter(({ provider, health, dossier }) => {
      if (pf.health === "available" && health.available === 0) return false;
      if (pf.health === "issue" && health.state !== "blocked" && health.state !== "partial" && !health.pageLimitReached) return false;
      if (pf.health === "dossier" && !dossier) return false;
      if (pf.health === "collecting" && provider.directoryStatus !== "collecting") return false;
      if (pf.region !== "all" && !(provider.regions || []).includes(pf.region)) return false;
      if (pf.feature !== "all" && !(provider.features || []).includes(pf.feature)) return false;
      if (query) {
        const hay = normalizeSearch(
          [
            provider.id,
            provider.name,
            ...(provider.aliases || []),
            ...(provider.features || []),
            ...(provider.regions || []),
            provider.directoryStatus === "collecting" ? "目录收集中 收集中 collecting" : ""
          ].join(" ")
        );
        if (!hay.includes(query)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const rank = (x) => (x.dossier ? 0 : x.health.available > 0 ? 1 : x.health.state === "blocked" ? 2 : 3);
      return rank(a) - rank(b) || b.health.available - a.health.available || a.provider.name.localeCompare(b.provider.name, "zh-CN");
    });

  return `
    <div class="workspace-head">
      <div>
        <h1 class="workspace-title">商家目录与监控源健康看板（${providers.length} 家收录）</h1>
        <p class="workspace-sub">完整收录 MeowVPS 目录全部商家（含 ${collectingCount} 家源目录「收集中」商家）与本站官方监控源；所有诊断记录、WAF/Cloudflare 直连受阻源与目录页数触顶（<code>pageLimitReached</code>）均在此诚实披露，绝不混入可购列表。</p>
      </div>
    </div>

    <div class="kpi-grid">
      <button type="button" class="kpi-tile ${pf.health === "all" ? "is-active" : ""}" data-action="set-prov-health" data-health="all">
        <span class="kpi-label">收录与监控商家</span>
        <span class="kpi-val num">${providers.length} 家</span>
        <span class="kpi-sub">100% 绑定官方源 · 含 ${collectingCount} 家收集中</span>
      </button>
      <button type="button" class="kpi-tile ${pf.health === "available" ? "is-active" : ""}" data-action="set-prov-health" data-health="available">
        <span class="kpi-label" style="color:var(--ok-fg)">有可购库存商家</span>
        <span class="kpi-val num" style="color:var(--ok-fg)">${availableCount}</span>
        <span class="kpi-sub">含精确库存与官方下单入口</span>
      </button>
      <button type="button" class="kpi-tile ${pf.health === "issue" ? "is-active" : ""}" data-action="set-prov-health" data-health="issue">
        <span class="kpi-label" style="color:var(--danger-fg)">受阻 / 部分异常 / 触顶</span>
        <span class="kpi-val num" style="color:var(--danger-fg)">${issueCount}</span>
        <span class="kpi-sub">点击展开原始尝试证据</span>
      </button>
      <button type="button" class="kpi-tile ${pf.health === "dossier" ? "is-active" : ""}" data-action="set-prov-health" data-health="dossier">
        <span class="kpi-label" style="color:var(--warn-fg)">含深度实测档案</span>
        <span class="kpi-val num">${dossierCount}</span>
        <span class="kpi-sub">统一设计体系评测页</span>
      </button>
    </div>

    <div class="radar-controls">
      <div class="input-wrap controls-search">
        <input type="search" class="input-field" data-provider-search value="${escapeHtml(pf.q)}" placeholder="搜索商家名、别名（如 绿云 / 小秘书 / 收集中）…" aria-label="搜索商家" />
      </div>
      <select class="select-field" style="width:auto;min-width:138px" data-provider-select="region" aria-label="按商家覆盖地区筛选">
        ${PROV_REGIONS.map(([v, l]) => `<option value="${v}" ${pf.region === v ? "selected" : ""}>${l}</option>`).join("")}
      </select>
      <select class="select-field" style="width:auto;min-width:138px" data-provider-select="feature" aria-label="按商家定位筛选">
        ${PROV_FEATURES.map(([v, l]) => `<option value="${v}" ${pf.feature === v ? "selected" : ""}>${l}</option>`).join("")}
      </select>
      ${
        collectingCount > 0
          ? `<button type="button" class="btn btn-sm ${pf.health === "collecting" ? "btn-primary" : "btn-ghost"}" data-action="set-prov-health" data-health="${pf.health === "collecting" ? "all" : "collecting"}" title="筛选 MeowVPS 源目录中标注为「收集中」的商家">仅看收集中 (${collectingCount})</button>`
          : ""
      }
      ${
        pf.q || pf.region !== "all" || pf.feature !== "all" || pf.health !== "all"
          ? `<button type="button" class="btn btn-sm btn-ghost" data-action="reset-providers">重置</button>`
          : ""
      }
      <span style="margin-left:auto;font-size:var(--text-xs);color:var(--ink-muted)" class="num">展示 ${filtered.length} / ${providers.length} 家</span>
    </div>

    ${
      filtered.length === 0
        ? `<section class="empty-state-card">
            <h2 class="empty-state-title">没有匹配当前条件的商家</h2>
            <div><button type="button" class="btn btn-primary" data-action="reset-providers">重置商家筛选</button></div>
          </section>`
        : `<div class="provider-grid">
            ${filtered
              .map(({ provider, health, dossier }) => {
                const stateBadge =
                  health.state === "healthy"
                    ? `<span class="pill pill-ok">正常采集</span>`
                    : health.state === "partial"
                      ? `<span class="pill pill-warn">部分受限</span>`
                      : health.state === "blocked"
                        ? `<span class="pill pill-danger">直连受阻</span>`
                        : health.state === "soldout"
                          ? `<span class="pill pill-neutral">暂告售罄</span>`
                          : `<span class="pill pill-neutral pill-outline">状态未知</span>`;

                const sum = Math.max(1, health.available + health.unavailable + health.unknown + health.blocked + health.error);
                const pct = (n) => `${((n / sum) * 100).toFixed(1)}%`;
                const cardClass = health.state === "blocked" ? "is-blocked" : health.state === "partial" || health.pageLimitReached ? "has-issue" : "";
                const websiteHref = safeUrl(provider.website);
                const dirHref = safeUrl(provider.directorySource);
                const migrationHref = safeUrl(provider.officialEvidence);
                const aliases = (provider.aliases || []).filter((a) => a !== provider.name);

                return `<article class="provider-card ${cardClass}">
                  <div class="provider-head">
                    <div class="provider-ident">
                      <span class="provider-avatar">${escapeHtml(providerInitial(provider.name))}</span>
                      <div class="provider-name-wrap">
                        <h3 class="provider-name" title="${escapeHtml(provider.name)}">${escapeHtml(provider.name)}</h3>
                        <div class="provider-aliases">${aliases.length ? `别名：${escapeHtml(aliases.join(" / "))}` : `ID: ${escapeHtml(provider.id)}`}</div>
                      </div>
                    </div>
                    ${stateBadge}
                  </div>

                  <div class="net-stack">
                    ${(provider.features || [])
                      .map((f) => `<span class="pill ${f === "家宽" || f === "双 ISP" ? "pill-home" : f === "CN优化线路" ? "pill-vps" : ""}">${escapeHtml(f)}</span>`)
                      .join("")}
                    ${provider.directoryStatus === "collecting" ? `<span class="pill pill-neutral pill-outline" title="MeowVPS 源目录尚在收集整理中，本站已同步接入官方页面监测">目录收集中</span>` : ""}
                    ${health.pageLimitReached ? `<span class="pill pill-warn" title="公开目录页数达到单轮采集上限，非全量覆盖">目录页触顶</span>` : ""}
                    ${dossier ? `<a class="pill pill-warn" href="${escapeHtml(dossier.path)}">深度实测档案 →</a>` : ""}
                  </div>

                  <div class="health-bar" aria-label="库存状态分布">
                    ${health.available ? `<span class="health-seg-ok" style="width:${pct(health.available)}"></span>` : ""}
                    ${health.unavailable ? `<span class="health-seg-sold" style="width:${pct(health.unavailable)}"></span>` : ""}
                    ${health.unknown ? `<span class="health-seg-unk" style="width:${pct(health.unknown)}"></span>` : ""}
                    ${health.blocked + health.error ? `<span class="health-seg-blk" style="width:${pct(health.blocked + health.error)}"></span>` : ""}
                  </div>

                  <div class="health-metrics">
                    <span>可购 <strong style="color:var(--ok-fg)">${health.available}</strong></span>
                    ${health.exactCount ? `<span>精确库存 <strong>${health.exactCount}</strong></span>` : ""}
                    <span>售罄 <strong>${health.unavailable}</strong></span>
                    ${health.unknown ? `<span>未知 <strong>${health.unknown}</strong></span>` : ""}
                    ${health.blocked + health.error ? `<span style="color:var(--danger-fg)">受阻/异常 <strong>${health.blocked + health.error}</strong></span>` : ""}
                  </div>

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
                      ? `<div style="font-size:11.5px;color:var(--ink-secondary)">
                          官方品牌迁移公告：<a href="${escapeHtml(migrationHref)}" target="_blank" rel="nofollow noopener noreferrer">查看核验依据 ↗</a>
                        </div>`
                      : ""
                  }

                  <div class="provider-foot">
                    <div style="display:flex;gap:8px;align-items:center;font-size:var(--text-xs)">
                      ${websiteHref ? `<a href="${escapeHtml(websiteHref)}" target="_blank" rel="nofollow noopener noreferrer">官网 ↗</a>` : ""}
                      ${dirHref ? `<a style="color:var(--ink-muted)" href="${escapeHtml(dirHref)}" target="_blank" rel="nofollow noopener noreferrer">目录参考 ↗</a>` : ""}
                    </div>
                    <button
                      type="button"
                      class="btn btn-xs ${health.planCount > 0 ? "btn-soft" : ""}"
                      data-action="drill-provider"
                      data-provider-id="${escapeHtml(provider.id)}"
                      ${health.planCount === 0 ? "disabled" : ""}
                    >${health.planCount > 0 ? `查看 ${health.planCount} 个套餐 →` : "暂无可购/固定套餐"}</button>
                  </div>
                </article>`;
              })
              .join("")}
          </div>`
    }
  `;
}
