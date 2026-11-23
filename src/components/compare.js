import { MAX_COMPARE } from "../state/store.js";
import { escapeHtml, plain, safeUrl } from "../domain/format.js";

function resolveComparedPlans(state) {
  const byKey = new Map(state.plans.map((p) => [p._key, p]));
  return state.compareKeys.map((k) => byKey.get(k)).filter(Boolean);
}

export function renderCompareDock(state) {
  const items = resolveComparedPlans(state);
  if (items.length === 0) return "";

  return `
    <div class="dock-items">
      <span class="pill pill-vps num" data-compare-badge>${items.length}/${MAX_COMPARE}</span>
      <span class="dock-mobile-label">已选 ${items.length} 款待对比</span>
      ${items
        .map(
          (p) => `<span class="dock-pill" title="${escapeHtml(`${p._providerName} · ${plain(p.name)}`)}">
            <span>${escapeHtml(plain(p.name))}</span>
            <button type="button" data-action="toggle-compare" data-key="${escapeHtml(p._key)}" aria-label="移出 ${escapeHtml(plain(p.name))}">×</button>
          </span>`
        )
        .join("")}
    </div>
    <div class="dock-actions">
      <button type="button" class="btn btn-xs btn-ghost" data-action="clear-compare">清空</button>
      <button type="button" class="btn btn-sm btn-primary" data-action="open-compare">横向对比 (${items.length})</button>
    </div>
  `;
}

export function renderCompareModal(state) {
  if (!state.compareOpen) return "";
  const items = resolveComparedPlans(state);
  if (items.length === 0) return "";

  const validCnys = items.map((p) => p._pricing.cnyMonthly).filter((v) => Number.isFinite(v));
  const lowestCny = validCnys.length >= 2 ? Math.min(...validCnys) : null;

  const rows = [
    {
      label: "商家与地区",
      values: items.map((p) => `${p._providerName} · ${p._regions.join(" / ") || "未标明"}`),
      render: (p) => {
        const iso = p._macroRegions?.[0] === "MULTI" ? "GL" : p._macroRegions?.[0] || "--";
        return `<strong>${escapeHtml(p._providerName)}</strong><div style="color:var(--ink-muted);margin-top:2px;display:inline-flex;align-items:center;gap:4px"><span class="iso-code">${escapeHtml(iso)}</span><span>${escapeHtml(p._regions.join(" / ") || "地区待核验")}</span></div>`;
      }
    },
    {
      label: "本质与 IP 层级",
      values: items.map((p) => `${p._classify.ipTier.value}|${p._classify.delivery}`),
      render: (p) => `<div style="display:flex;gap:4px;flex-wrap:wrap">
        <span class="pill ${p._classify.isResidential ? "pill-home" : "pill-vps"}">${escapeHtml(p._classify.ipTier.label)}</span>
        ${p._classify.isNat ? `<span class="pill pill-warn">NAT/共享</span>` : `<span class="pill">IP 独享性未核验</span>`}
      </div>`
    },
    {
      label: "回程与线路",
      values: items.map((p) => plain(p.route) || p._classify.routes.join(",") || "未标明"),
      render: (p) => `<div>${escapeHtml(plain(p.route) || "页面未单列")}</div>${
        p._classify.routes.length
          ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">${p._classify.routes.map((r) => `<span class="pill">${escapeHtml(r)}</span>`).join("")}</div>`
          : ""
      }`
    },
    {
      label: "CPU / 内存 / 硬盘",
      values: items.map((p) => `${p._specs.cpu}|${p._specs.memory}|${p._specs.disk}`),
      render: (p) => `<div class="mono">${escapeHtml(p._specs.cpu)}</div><div class="mono" style="color:var(--ink-secondary)">${escapeHtml(p._specs.memory)} · ${escapeHtml(p._specs.disk)}</div>`
    },
    {
      label: "带宽与流量",
      values: items.map((p) => `${p._specs.bandwidth}|${p._specs.traffic}`),
      render: (p) => `<div class="mono">${escapeHtml(p._specs.bandwidth)}</div><div class="mono" style="color:var(--ink-secondary)">${escapeHtml(p._specs.traffic)}</div>`
    },
    {
      label: "原始账单报价",
      values: items.map((p) => p._pricing.originalLabel),
      render: (p) => `<div class="mono" style="font-weight:700;font-size:var(--text-base)" title="${escapeHtml(p._pricing.originalLabel)}">${escapeHtml(p._pricing.displayLabel)}</div><div style="color:var(--ink-muted);margin-top:2px">周期：${escapeHtml(p._pricing.quote.period)}</div>`
    },
    {
      label: "参考月均 (CNY)",
      values: items.map((p) => p._pricing.cnyLabel),
      render: (p) => {
        const isLowest = lowestCny !== null && Number.isFinite(p._pricing.cnyMonthly) && Math.abs(p._pricing.cnyMonthly - lowestCny) < 0.01;
        return `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span class="mono" style="font-weight:700;color:${p._pricing.cnyTone === "ok" ? "var(--ok-fg)" : "var(--warn-fg)"}">${escapeHtml(p._pricing.cnyLabel)}</span>
          ${isLowest ? `<span class="pill pill-ok">最低</span>` : ""}
        </div>`;
      }
    },
    {
      label: "库存与证据等级",
      values: items.map((p) => `${p.status}|${p.stockCount}|${p.evidenceLevel?.value}`),
      render: (p) => {
        const primary = p._isExactStock ? `精确库存 ${p.stockCount}` : plain(p.statusLabel) || p.status;
        const evidenceLabel = p.evidenceLevel?.label || "";
        const showSub = evidenceLabel && evidenceLabel !== primary;
        return `<div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start">
          <span class="pill ${p.status === "available" ? (p._isSnapshot ? "pill-warn" : "pill-ok") : p.status === "unavailable" ? "pill-danger" : "pill-neutral"}">${escapeHtml(primary)}</span>
          ${showSub ? `<span style="color:var(--ink-muted)">${escapeHtml(evidenceLabel)}</span>` : ""}
        </div>`;
      }
    },
    {
      label: "风险审计",
      values: items.map((p) => (p.riskTags || []).map((r) => r.value).join(",")),
      render: (p) => {
        const tags = Array.isArray(p.riskTags) ? p.riskTags : [];
        return tags.length
          ? `<div style="display:flex;gap:4px;flex-wrap:wrap">${tags
              .map(
                (t) => `<span class="pill ${t.severity === "high" ? "pill-danger" : t.severity === "medium" ? "pill-warn" : "pill-ok"}">${escapeHtml(t.label)}</span>`
              )
              .join("")}</div>`
          : `<span style="color:var(--ink-muted)">无</span>`;
      }
    },
    {
      label: "官方直达",
      values: items.map((p) => p.orderUrl || ""),
      alwaysShow: true,
      render: (p) => {
        const href = safeUrl(p.orderUrl);
        return `<div style="display:flex;gap:6px;flex-wrap:wrap">
          ${href ? `<a class="btn btn-xs btn-primary" href="${escapeHtml(href)}" target="_blank" rel="nofollow noopener noreferrer">去官网下单 ↗</a>` : ""}
          <button type="button" class="btn btn-xs" data-action="inspect-from-compare" data-product-id="${escapeHtml(p.id)}">证据详情</button>
        </div>`;
      }
    }
  ];

  return `
    <div class="modal-shell" role="dialog" aria-modal="true" aria-label="多方案关键指标横向对比">
      <div class="modal-head">
        <div>
          <h2 style="margin:0;font-size:var(--text-lg);font-weight:700">多方案关键指标横向对比（${items.length}/${MAX_COMPARE}）</h2>
          <p style="margin:3px 0 0;font-size:var(--text-xs);color:var(--ink-muted)">保留原币种账单与证据等级；仅对明码固定周期且汇率在 7 天有效期内的方案标注参考月均最低项。</p>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <label class="btn btn-sm ${state.compareDiffOnly ? "is-active" : ""}" style="cursor:pointer">
            <input type="checkbox" style="margin:0" data-action="toggle-compare-diff" ${state.compareDiffOnly ? "checked" : ""} />
            <span>仅高亮差异项</span>
          </label>
          <button type="button" class="btn btn-sm btn-soft" data-action="copy-share-url">🔗 复制对比链接</button>
          <button type="button" class="btn btn-sm btn-ghost" data-action="close-compare" aria-label="关闭对比工作台">✕</button>
        </div>
      </div>
      <div class="modal-body">
        <table class="compare-table">
          <thead>
            <tr>
              <th class="cmp-metric-col">对比维度</th>
              ${items
                .map(
                  (p) => `<th>
                    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px">
                      <span style="font-weight:700;font-size:var(--text-sm);line-height:1.35;overflow-wrap:anywhere">${escapeHtml(plain(p.name))}</span>
                      <button type="button" class="btn btn-xs btn-ghost" data-action="toggle-compare" data-key="${escapeHtml(p._key)}" aria-label="移出对比">×</button>
                    </div>
                  </th>`
                )
                .join("")}
            </tr>
          </thead>
          <tbody>
            ${rows
              .map((row) => {
                const hasDiff = new Set(row.values).size > 1;
                const rowClass = state.compareDiffOnly
                  ? hasDiff || row.alwaysShow
                    ? hasDiff
                      ? "is-diff"
                      : ""
                    : "is-same-hidden"
                  : "";
                return `<tr class="${rowClass}">
                  <td class="cmp-metric-col">${row.label}</td>
                  ${items.map((p) => `<td>${row.render(p)}</td>`).join("")}
                </tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}
