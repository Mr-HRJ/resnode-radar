import { describePricing, escapeHtml, formatDateTime, monitorFreshness, plain, safeUrl } from "./domain/format.js";
import { applyTheme, loadTheme } from "./state/store.js";

export async function mountReviewDossier(endpoint = "../data/products.json") {
  const doc = globalThis.document;
  let theme = applyTheme(loadTheme());

  const themeBtn = doc.querySelector("[data-action='toggle-theme']");
  const updateThemeBtn = () => {
    if (themeBtn) themeBtn.textContent = theme === "dark" ? "☀ 亮色" : "☾ 暗色";
  };
  updateThemeBtn();

  const onClick = (event) => {
    const btn = event.target?.closest?.("[data-action='toggle-theme']");
    if (!btn) return;
    theme = applyTheme(theme === "dark" ? "light" : "dark");
    updateThemeBtn();
  };
  doc.addEventListener("click", onClick);

  const box = doc.querySelector("[data-review-live-box]");
  if (!box) return { dispose: () => doc.removeEventListener("click", onClick) };

  const providerId = box.getAttribute("data-provider-id") || "";
  try {
    const res = await fetch(`${endpoint}?t=${Date.now()}`, {
      cache: "no-store",
      headers: { accept: "application/json" }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    const products = Array.isArray(payload?.products) ? payload.products : [];
    const matched = products.filter(
      (p) =>
        String(p?.providerId || "").toLowerCase() === providerId.toLowerCase() ||
        String(p?.provider || "").toLowerCase() === providerId.toLowerCase()
    );
    const freshness = monitorFreshness(payload?.generatedAt);
    const available = matched.filter((p) => !p.diagnostic && p.status === "available");
    const unavailable = matched.filter((p) => !p.diagnostic && p.status === "unavailable");
    const diagnostics = matched.filter((p) => p.diagnostic);

    if (matched.length === 0) {
      box.innerHTML = `<div class="dossier-live-row">
        <strong>最新快照暂未检索到该商家记录</strong>
        <span style="color:var(--ink-muted)">快照时间：${escapeHtml(formatDateTime(payload?.generatedAt))}</span>
      </div>`;
    } else {
      box.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;margin-bottom:8px">
          <span class="pill ${freshness.stale ? "pill-warn" : "pill-ok"}">${escapeHtml(freshness.label)}</span>
          <span class="mono" style="font-size:11px;color:var(--ink-muted)">可购 ${available.length} · 售罄 ${unavailable.length}${diagnostics.length ? ` · 诊断 ${diagnostics.length}` : ""}</span>
        </div>
        <div class="dossier-live-list">
          ${matched
            .slice(0, 6)
            .map((p) => {
              const pr = describePricing(p, payload.exchangeRates);
              const href = safeUrl(p.orderUrl);
              const pill =
                p.status === "available"
                  ? p.evidenceLevel?.value === "snapshot"
                    ? `<span class="pill pill-warn">快照有货</span>`
                    : `<span class="pill pill-ok">${Number.isInteger(p.stockCount) ? `余 ${p.stockCount}` : "可订购"}</span>`
                  : p.status === "unavailable"
                    ? `<span class="pill pill-danger">售罄</span>`
                    : `<span class="pill pill-neutral">${escapeHtml(plain(p.statusLabel) || p.status)}</span>`;

              return `<div class="dossier-live-row">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
                  <strong style="overflow-wrap:anywhere">${escapeHtml(plain(p.name))}</strong>
                  ${pill}
                </div>
                <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;color:var(--ink-muted)">
                  <span class="mono">${escapeHtml(pr.originalLabel)}</span>
                  <span class="mono" style="color:${pr.cnyTone === "ok" ? "var(--ok-fg)" : "var(--warn-fg)"}">${escapeHtml(pr.cnyLabel)}</span>
                </div>
                ${
                  href
                    ? `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px">
                        <a href="../index.html?inspect=${encodeURIComponent(p.id)}" style="font-size:11px">在终端解剖证据 →</a>
                        <a href="${escapeHtml(href)}" target="_blank" rel="nofollow noopener noreferrer" style="font-size:11px">官网 ↗</a>
                      </div>`
                    : ""
                }
              </div>`;
            })
            .join("")}
        </div>
        <div style="margin-top:10px">
          <a class="btn btn-sm btn-soft" style="width:100%" href="../index.html?provider=${encodeURIComponent(providerId)}&status=all">在选机终端查看全部 ${matched.length} 条记录 →</a>
        </div>
      `;
    }
  } catch (err) {
    box.innerHTML = `<div class="alert-banner is-danger" style="padding:10px 12px">
      <span>实时快照暂不可用（${escapeHtml(err instanceof Error ? err.message : "Fetch error")}），拒绝展示本地模拟数据。</span>
    </div>`;
  }

  return { dispose: () => doc.removeEventListener("click", onClick) };
}
