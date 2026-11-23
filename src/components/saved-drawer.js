import { escapeHtml, plain } from "../domain/format.js";

export function renderSavedDrawer(state) {
  if (!state.savedDrawerOpen) return "";

  const planByKey = new Map(state.plans.map((p) => [p._key, p]));
  const items = [...state.savedKeys].map((key) => ({ key, plan: planByKey.get(key) || null }));

  return `
    <div class="drawer-panel" role="dialog" aria-modal="true" aria-label="本地收藏夹">
      <div class="drawer-head">
        <div>
          <h2 style="margin:0;font-size:var(--text-lg);font-weight:700">本地收藏夹（${items.length}）</h2>
          <p style="margin:4px 0 0;font-size:var(--text-xs);color:var(--ink-muted)">
            仅存于当前浏览器 <code>localStorage</code>，不会自动推送补货或变价通知。
          </p>
        </div>
        <button type="button" class="btn btn-sm btn-ghost" data-action="close-saved" aria-label="关闭收藏夹">✕</button>
      </div>
      <div class="drawer-body">
        ${
          items.length === 0
            ? `<div class="empty-state-card" style="padding:20px">
                <h3 class="empty-state-title" style="font-size:var(--text-md)">还没有收藏任何套餐</h3>
                <p class="empty-state-desc">点击任意套餐行或证据抽屉中的「★」即可将候选方案保留在此，下次打开工作台时自动同步其最新库存与参考月均价。</p>
              </div>`
            : `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
                <button type="button" class="btn btn-sm btn-soft" data-action="filter-saved-only">在主终端仅看已收藏</button>
                <button type="button" class="btn btn-xs btn-ghost" data-action="clear-saved">清空收藏</button>
              </div>
              <div style="display:flex;flex-direction:column;gap:10px">
                ${items
                  .map(({ key, plan }) => {
                    if (!plan) {
                      return `<div class="insp-card">
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                          <span class="pill pill-neutral">当前快照未包含</span>
                          <button type="button" class="btn btn-xs btn-ghost" data-action="toggle-save" data-key="${escapeHtml(key)}">移除</button>
                        </div>
                        <div style="font-size:var(--text-xs);color:var(--ink-muted);word-break:break-all">标识：<code>${escapeHtml(key)}</code></div>
                      </div>`;
                    }
                    const isCmp = state.compareKeys.includes(plan._key);
                    const stockPill =
                      plan.status === "available"
                        ? plan._isExactStock
                          ? `<span class="pill pill-ok num">余 ${plan.stockCount}</span>`
                          : plan._isSnapshot
                            ? `<span class="pill pill-warn">快照有货</span>`
                            : `<span class="pill pill-ok">可订购</span>`
                        : plan.status === "unavailable"
                          ? `<span class="pill pill-danger">售罄</span>`
                          : `<span class="pill pill-neutral">未公开</span>`;

                    return `<div class="insp-card">
                      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                        <span style="display:flex;align-items:center;gap:6px;min-width:0">
                          <span class="pill ${plan._classify.isResidential ? "pill-home" : "pill-vps"}">${plan._classify.isResidential ? "真家宽" : "机房"}</span>
                          <strong style="font-size:var(--text-xs);color:var(--ink-secondary)">${escapeHtml(plan._providerName)}</strong>
                        </span>
                        ${stockPill}
                      </div>
                      <div style="font-weight:600;font-size:var(--text-sm);line-height:1.4;overflow-wrap:anywhere">${escapeHtml(plain(plan.name))}</div>
                      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px">
                        <span class="mono" style="font-weight:700;font-size:var(--text-sm)" title="${escapeHtml(plan._pricing.originalLabel)}">${escapeHtml(plan._pricing.displayLabel)}</span>
                        <span class="mono" style="font-size:var(--text-2xs);color:${plan._pricing.cnyTone === "ok" ? "var(--ok-fg)" : "var(--warn-fg)"}">${escapeHtml(plan._pricing.cnyLabel)}</span>
                      </div>
                      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                        <button type="button" class="btn btn-xs btn-primary" data-action="inspect-plan" data-product-id="${escapeHtml(plan.id)}">查证据</button>
                        <button type="button" class="btn btn-xs ${isCmp ? "is-active" : ""}" data-action="toggle-compare" data-key="${escapeHtml(plan._key)}">${isCmp ? "已加对比" : "⇄ 对比"}</button>
                        <button type="button" class="btn btn-xs btn-ghost" style="margin-left:auto" data-action="toggle-save" data-key="${escapeHtml(plan._key)}">取消收藏</button>
                      </div>
                    </div>`;
                  })
                  .join("")}
              </div>`
        }
      </div>
    </div>
  `;
}
