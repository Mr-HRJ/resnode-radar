import { RISK_EXPLANATIONS } from "../domain/catalog.js";
import {
  escapeHtml,
  featureEntries,
  formatDateTime,
  formatEventDelta,
  formatShortTime,
  monitorFreshness,
  plain,
  safeUrl
} from "../domain/format.js";

export function renderInspectorDrawer(state, now = Date.now()) {
  if (!state.inspectId) return "";
  const plan = state.allRecords.find((r) => r.id === state.inspectId);
  if (!plan) {
    return `
      <div class="drawer-panel" role="dialog" aria-modal="true" aria-label="套餐证据抽屉">
        <div class="drawer-head">
          <div>
            <h2 style="margin:0;font-size:var(--text-lg);font-weight:700">未找到对应套餐</h2>
            <p style="margin:4px 0 0;font-size:var(--text-xs);color:var(--ink-muted)">该套餐可能已从最新监控快照中下线或变更标识。</p>
          </div>
          <button type="button" class="btn btn-sm btn-ghost" data-action="close-inspector" aria-label="关闭证据抽屉">✕</button>
        </div>
        <div class="drawer-body">
          <p style="font-size:var(--text-sm);color:var(--ink-secondary)">请求标识：<code>${escapeHtml(state.inspectId)}</code></p>
          <button type="button" class="btn btn-primary" data-action="close-inspector">返回列表</button>
        </div>
      </div>
    `;
  }

  const isSaved = state.savedKeys.has(plan._key);
  const isCompared = state.compareKeys.includes(plan._key);
  const orderHref = safeUrl(plan.orderUrl);
  const sourceHref = safeUrl(plan.sourceUrl);
  const finalHref = safeUrl(plan.finalUrl);
  const freshness = monitorFreshness(plan.verification ? plan.verification.verifiedAt : plan.fetchedAt, now);
  const p = plan._pricing;
  const features = featureEntries(plan).filter(([k, v]) => k || v);
  const attempts = Array.isArray(plan.raw?.attempts) ? plan.raw.attempts : [];
  const riskTags = Array.isArray(plan.riskTags) ? plan.riskTags.filter(Boolean) : [];
  const skuEvents = plan._events || [];
  const relatedEvents = skuEvents.length ? skuEvents : (state.eventIndex?.byProvider?.get(plan._providerId) || []).slice(0, 5);

  const caveats = [];
  if (plan.verification?.state === "historical") caveats.push("本轮未取得该套餐结果，保留的历史价格与配置不代表当前库存。");
  if (plan.verification?.priceKind === "reference") caveats.push("展示的是公开参考价格，未核验当前可结算价格。");
  if (plan._isSnapshot) caveats.push("当前行来自第三方 Reader 公开快照（官方站点直连受阻），价格与库存请务必前往官方下单页复核。");
  if (plan._classify.isNat) caveats.push("该套餐含 NAT / 共享 IPv4 标记，非独享独立 IPv4。");
  if (plan.evidenceLevel?.value === "official-order") caveats.push("仅核验到官方订购入口按钮，商家页面未公布具体剩余台数。");
  if (plan.collection?.pageLimitReached) caveats.push("该商家公开目录页数超过单轮采集上限，当前列表非全量 SKU 覆盖。");

  return `
    <div class="drawer-panel" role="dialog" aria-modal="true" aria-label="套餐解析证据与定价解剖">
      <div class="drawer-head">
        <div style="min-width:0">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px">
            <span class="pill ${plan._classify.isResidential ? "pill-home" : "pill-vps"}">${escapeHtml(plan._classify.ipTier.label)}</span>
            ${plan._classify.isNat ? `<span class="pill pill-warn">NAT / 共享</span>` : `<span class="pill">IP 独享性未核验</span>`}
            ${
              plan.status === "available"
                ? `<span class="pill pill-ok">${plan._isExactStock ? `精确库存 ${plan.stockCount}` : escapeHtml(plain(plan.statusLabel) || "可订购")}</span>`
                : plan.status === "unavailable"
                  ? `<span class="pill pill-danger">售罄</span>`
                  : `<span class="pill pill-neutral">${escapeHtml(plain(plan.statusLabel) || "状态未知")}</span>`
            }
          </div>
          <h2 style="margin:0;font-size:var(--text-lg);font-weight:700;line-height:1.35;overflow-wrap:anywhere">${escapeHtml(plain(plan.name))}</h2>
          <div style="margin-top:5px;font-size:var(--text-xs);color:var(--ink-muted);display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn btn-xs btn-ghost" style="padding:0 4px;height:auto;color:var(--accent)" data-action="drill-provider" data-provider-id="${escapeHtml(plan._providerId)}">${escapeHtml(plan._providerName)}</button>
            <span>·</span>
            <span>${escapeHtml(plan._regions.length ? plan._regions.join(" / ") : "地区待核验")}</span>
            ${plan._dossier ? `<a class="pill pill-warn" href="${escapeHtml(plan._dossier.path)}">实测档案 →</a>` : ""}
          </div>
        </div>
        <button type="button" class="btn btn-sm btn-ghost" data-action="close-inspector" aria-label="关闭抽屉">✕</button>
      </div>

      <div class="drawer-body">
        <div class="insp-cta-row">
          ${
            orderHref
              ? `<a class="btn btn-primary" style="flex:1" href="${escapeHtml(orderHref)}" target="_blank" rel="nofollow noopener noreferrer">前往官方订购页 ↗</a>`
              : `<button type="button" class="btn" style="flex:1" disabled>无官方直达订购链接</button>`
          }
          <button type="button" class="btn btn-star ${isSaved ? "is-active" : ""}" data-action="toggle-save" data-key="${escapeHtml(plan._key)}">${isSaved ? "★ 已收藏" : "☆ 收藏"}</button>
          <button type="button" class="btn ${isCompared ? "is-active" : ""}" data-action="toggle-compare" data-key="${escapeHtml(plan._key)}">${isCompared ? "⇄ 已对比" : "⇄ 对比"}</button>
          <button type="button" class="btn btn-icon" data-action="copy-share-url" title="复制本套餐直链" aria-label="复制本套餐直链">🔗</button>
        </div>

        ${
          caveats.length
            ? `<div class="alert-banner" style="padding:10px 12px">
                <div style="display:flex;flex-direction:column;gap:4px">
                  <strong>核验提示</strong>
                  ${caveats.map((c) => `<span>• ${escapeHtml(c)}</span>`).join("")}
                </div>
              </div>`
            : ""
        }

        <section class="insp-card">
          <h3 class="insp-card-title">
            <span>原始账单与汇率透明拆解</span>
            <span class="pill ${p.cnyTone === "ok" ? "pill-ok" : "pill-warn"}">${escapeHtml(p.quote.period)}</span>
          </h3>
          <div class="insp-price-hero">
            <span class="insp-price-orig num" title="${escapeHtml(p.originalLabel)}">${escapeHtml(p.displayLabel)}</span>
            <span class="insp-price-cny num" style="color:${p.cnyTone === "ok" ? "var(--ok-fg)" : "var(--warn-fg)"}">${escapeHtml(p.cnyLabel)}</span>
          </div>
          <dl class="kv-table">
            <dt>官方报价原文</dt>
            <dd class="mono">${escapeHtml(p.originalLabel)}</dd>
            <dt>识别币种</dt>
            <dd class="mono">${escapeHtml(p.quote.currency || "未明确 / 存在冲突")}</dd>
            <dt>计费周期</dt>
            <dd>${escapeHtml(p.quote.period)}${p.quote.months ? `（按 ${p.quote.months} 个月分摊）` : ""}</dd>
            <dt>起步选配价</dt>
            <dd>${p.quote.baseOnly ? `<span style="color:var(--warn-fg);font-weight:600">是（选配项会改变最终结算价）</span>` : "否"}</dd>
            <dt>折算口径</dt>
            <dd class="mono">${escapeHtml(p.formula || p.honestReason || "-")}</dd>
          </dl>
          <p style="margin:0;font-size:11px;color:var(--ink-muted)">
            参考月均人民币仅用于横向比价，不构成发卡行实际结算金额，且不含增值税、通道费与续费价差。
          </p>
        </section>

        <section class="insp-card">
          <h3 class="insp-card-title">
            <span>原始采集证据链与风险审计</span>
            <span class="pill ${freshness.stale ? "pill-warn" : "pill-ok"}">${escapeHtml(freshness.label)}</span>
          </h3>
          <dl class="kv-table">
            <dt>证据等级</dt>
            <dd><strong>${escapeHtml(plan.evidenceLevel?.label || "未分级")}</strong>（<code>${escapeHtml(plan.evidenceLevel?.value || "-")}</code>）</dd>
            <dt>线路声明</dt>
            <dd>${escapeHtml(plain(plan.route) || "页面未单列线路字段")}</dd>
            <dt>解析依据</dt>
            <dd class="mono" style="font-size:11.5px">${escapeHtml(plain(plan.evidence) || "-")}</dd>
            <dt>采集适配器</dt>
            <dd class="mono">${escapeHtml(plan.adapter || "-")} ${plan.httpStatus ? `· HTTP ${escapeHtml(plan.httpStatus)}` : ""}</dd>
            <dt>采集批次</dt>
            <dd class="mono">${escapeHtml(formatDateTime(plan.fetchedAt))}</dd>
            ${plan.verification ? `<dt>最近库存核验</dt><dd class="mono">${plan.verification.verifiedAt ? escapeHtml(formatDateTime(plan.verification.verifiedAt)) : "尚未核验"}${freshness.stale ? " · 已过期" : ""}</dd>
            <dt>本轮证据</dt><dd>${plan.verification.state === "verified" ? "已核验库存" : plan.verification.state === "historical" ? "历史资料，当前状态未知" : "取得资料，库存尚未核验"}</dd>
            <dt>价格口径</dt><dd>${plan.verification.priceKind === "reference" ? "目录参考价" : plan.verification.priceKind === "historical" ? "历史价格" : "本轮公开报价"}</dd>` : ""}
            <dt>公开来源页</dt>
            <dd>${sourceHref ? `<a href="${escapeHtml(sourceHref)}" target="_blank" rel="nofollow noopener noreferrer">${escapeHtml(sourceHref)} ↗</a>` : "-"}</dd>
            ${
              finalHref && finalHref !== sourceHref
                ? `<dt>最终落点</dt><dd><a href="${escapeHtml(finalHref)}" target="_blank" rel="nofollow noopener noreferrer">${escapeHtml(finalHref)} ↗</a></dd>`
                : ""
            }
          </dl>
          ${
            plan.note
              ? `<div style="padding:8px 10px;border-radius:var(--r-xs);background:var(--bg-surface);border:1px solid var(--border-subtle);font-size:var(--text-xs);color:var(--ink-secondary)">
                  <strong>备注原文：</strong>${escapeHtml(plain(plan.note))}
                </div>`
              : ""
          }
        </section>

        <section class="insp-card">
          <h3 class="insp-card-title"><span>硬件与原始字段明细</span></h3>
          <dl class="kv-table">
            <dt>CPU</dt><dd class="mono">${escapeHtml(plan._specs.cpu)}</dd>
            <dt>内存</dt><dd class="mono">${escapeHtml(plan._specs.memory)}</dd>
            <dt>硬盘</dt><dd class="mono">${escapeHtml(plan._specs.disk)}</dd>
            <dt>端口带宽</dt><dd class="mono">${escapeHtml(plan._specs.bandwidth)}</dd>
            <dt>流量配额</dt><dd class="mono">${escapeHtml(plan._specs.traffic)}</dd>
            ${features
              .slice(0, 14)
              .map(([k, v]) => `<dt>${escapeHtml(k || "属性")}</dt><dd>${escapeHtml(v)}</dd>`)
              .join("")}
          </dl>
        </section>

        <section class="insp-card">
          <h3 class="insp-card-title"><span>风险标签清单（${riskTags.length}）</span></h3>
          <div class="risk-audit-list">
            ${
              riskTags.length
                ? riskTags
                    .map((r) => {
                      const sev = r.severity === "high" ? "is-high" : r.severity === "medium" ? "is-medium" : "";
                      const pill = r.severity === "high" ? "pill-danger" : r.severity === "medium" ? "pill-warn" : "pill-ok";
                      return `<div class="risk-audit-item ${sev}">
                        <span class="pill ${pill}" style="flex-shrink:0">${escapeHtml(r.label || r.value)}</span>
                        <span style="color:var(--ink-secondary);line-height:1.45">${escapeHtml(RISK_EXPLANATIONS[r.value] || "请结合官方页面条款核验。")}</span>
                      </div>`;
                    })
                    .join("")
                : `<span style="font-size:var(--text-xs);color:var(--ink-muted)">无额外风险标签</span>`
            }
          </div>
        </section>

        ${
          attempts.length
            ? `<section class="insp-card">
                <h3 class="insp-card-title"><span>监控尝试记录（${attempts.length} 次）</span></h3>
                <ul class="attempt-list">
                  ${attempts
                    .slice(0, 8)
                    .map(
                      (a) => `<li class="attempt-row">
                        <span class="mono"><strong>${escapeHtml(a.strategy || a.stage || "fetch")}</strong> · HTTP ${escapeHtml(a.statusCode ?? a.httpStatus ?? "-")} ${a.ok ? "OK" : "FAIL"}</span>
                        <span style="color:var(--ink-muted)">${escapeHtml(a.url || "")}</span>
                        ${a.reason || a.error ? `<span style="color:var(--danger-fg)">${escapeHtml(a.reason || a.error)}</span>` : ""}
                      </li>`
                    )
                    .join("")}
                </ul>
              </section>`
            : ""
        }

        <section class="insp-card">
          <h3 class="insp-card-title">
            <span>${skuEvents.length ? "本套餐近 7 天观测异动" : `${escapeHtml(plan._providerName)} 近期异动`}</span>
            <button type="button" class="btn btn-xs btn-ghost" data-nav-view="radar">全部异动 →</button>
          </h3>
          ${
            relatedEvents.length
              ? `<div style="display:flex;flex-direction:column;gap:6px">
                  ${relatedEvents
                    .slice(0, 5)
                    .map((ev) => {
                      const delta = formatEventDelta(ev);
                      const pill =
                        ev.type === "restock"
                          ? `<span class="pill pill-ok">补货</span>`
                          : ev.type === "soldout"
                            ? `<span class="pill pill-danger">售罄</span>`
                            : `<span class="pill ${delta?.direction === "down" ? "pill-ok" : "pill-danger"}">变价 ${escapeHtml(delta?.label || "")}</span>`;
                      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:var(--text-xs);padding:6px 8px;border-radius:var(--r-xs);background:var(--bg-surface);border:1px solid var(--border-subtle)">
                        <span style="display:flex;align-items:center;gap:6px;min-width:0">
                          ${pill}
                          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(plain(ev.name))}</span>
                        </span>
                        <span class="mono" style="color:var(--ink-muted);flex-shrink:0">${escapeHtml(formatShortTime(ev.at))}</span>
                      </div>`;
                    })
                    .join("")}
                </div>`
              : `<span style="font-size:var(--text-xs);color:var(--ink-muted)">近 7 天未观测到保守口径下的状态或价格变更。</span>`
          }
        </section>
      </div>
    </div>
  `;
}
