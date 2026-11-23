import { escapeHtml, formatDateTime, safeUrl } from "../domain/format.js";

export function renderAnnouncements(feed) {
  if (!feed?.sources?.length) return "";
  const items = feed.items ?? [];
  const ok = feed.sources.filter((s) => s.status === "ok").length;
  const labels = { pending: "待核验", verified: "已核验", blocked: "核验受阻", unmatched: "尚未匹配 SKU" };
  return `<section class="insp-card" aria-label="公告与优惠线索">
    <h2 class="insp-card-title">公告与优惠线索 <span class="pill ${ok === feed.sources.length ? "pill-ok" : "pill-warn"}">${ok}/${feed.sources.length} 来源正常</span></h2>
    <p class="workspace-sub">每 20 分钟检查。公告不代表当前有货；点击套餐查看采集核验结果。首次导入标为历史公告。</p>
    <details><summary>订阅来源与最近检查</summary><ul>${feed.sources.map((s) => `<li>${escapeHtml(s.name)} · ${escapeHtml(formatDateTime(s.checkedAt))} · ${s.status === "ok" ? "正常" : escapeHtml(s.error || "读取失败，保留历史公告")}</li>`).join("")}</ul></details>
    ${items.length ? `<ol>${items.slice(0, 30).map((item) => {
      const href = safeUrl(item.url);
      return `<li style="margin:14px 0"><strong>${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="nofollow noopener noreferrer">${escapeHtml(item.title)} ↗</a>` : escapeHtml(item.title)}</strong>
        <div class="workspace-sub">${escapeHtml(item.source)} · ${item.trust === "official" ? "官方公开来源" : "第三方线索"} · ${item.publishedAt ? `发布 ${escapeHtml(formatDateTime(item.publishedAt))}` : `发布时间未提供 · 首次发现 ${escapeHtml(formatDateTime(item.firstSeenAt))}`}${item.baseline ? " · 首次导入" : ""}</div>
        ${(item.candidates ?? []).length ? `<ul>${item.candidates.map((c) => {
          const url = safeUrl(c.url), v = c.verification || {};
          const result = v.state === "verified" ? v.status === "available" ? "可下单" : "售罄" : labels[v.state] || "待核验";
          return `<li>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="nofollow noopener noreferrer">${escapeHtml(c.provider)} 套餐 ↗</a>` : escapeHtml(c.provider)} · ${escapeHtml(result)}${v.checkedAt ? ` · 核验 ${escapeHtml(formatDateTime(v.checkedAt))}` : ""}</li>`;
        }).join("")}</ul>` : `<div class="workspace-sub">未识别到可直接核验的官方套餐链接，请查看公告原文。</div>`}
      </li>`;
    }).join("")}</ol>` : `<p class="workspace-sub">尚未取得有效公告；订阅异常不影响现有商品采集。</p>`}
  </section>`;
}
