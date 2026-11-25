import { escapeHtml } from "../domain/format.js";

/**
 * Bespoke vector icons for shop & product highlight badges.
 * Contains zero SVG <text> nodes so element.textContent stays strictly equal to the clean label text.
 */
export function renderTagSvg(tone) {
  switch (tone) {
    case "hot":
    case "blockbuster":
      // Multi-layer dancing flame + ember spark
      return `<svg class="tag-svg is-flame-svg" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path class="tag-flame-outer" d="M8.6 1.2C8.9 3.4 7.1 4.6 6.7 6.1C6.5 6.9 7.0 7.6 7.6 7.8C7.2 6.8 7.8 5.6 9.1 4.8C10.9 6.3 12.6 8.2 12.6 10.4C12.6 13.1 10.5 14.9 8.0 14.9C5.4 14.9 3.4 13.0 3.4 10.3C3.4 7.7 5.1 5.7 5.7 3.7C6.4 4.4 6.6 5.2 6.5 5.9C7.4 4.6 8.3 3.0 8.6 1.2Z" fill="currentColor"/>
        <path class="tag-flame-core" d="M8.1 7.9C9.3 8.8 10.1 9.9 10.1 11.1C10.1 12.4 9.2 13.4 8.0 13.4C6.8 13.4 5.9 12.5 5.9 11.2C5.9 10.1 6.7 9.1 8.1 7.9Z" fill="currentColor"/>
        <circle class="tag-flame-ember" cx="10.9" cy="3.1" r="1.05" fill="currentColor"/>
      </svg>`;

    case "scarce":
      // Live radar urgency beacon
      return `<svg class="tag-svg is-radar-svg" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle class="tag-radar-ping" cx="8" cy="8" r="5.6" stroke="currentColor" stroke-width="1.6"/>
        <circle class="tag-radar-core" cx="8" cy="8" r="3.1" fill="currentColor"/>
      </svg>`;

    case "perf":
      // High-voltage lightning bolt
      return `<svg class="tag-svg is-bolt-svg" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path class="tag-bolt-path" d="M9.3 1.4L3.6 8.8H7.7L6.7 14.6L12.4 7.2H8.3L9.3 1.4Z" fill="currentColor"/>
      </svg>`;

    case "veteran":
      // Heritage crest shield with star check
      return `<svg class="tag-svg is-shield-svg" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 1.5L13.4 3.7V7.8C13.4 11.2 11.1 13.7 8 14.7C4.9 13.7 2.6 11.2 2.6 7.8V3.7L8 1.5Z" stroke="currentColor" stroke-width="1.6" fill="currentColor" fill-opacity="0.16"/>
        <path class="tag-shield-check" d="M5.7 8.1L7.3 9.7L10.5 6.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;

    case "home":
    case "home-opt":
      // Residential roofline + live ISP signal wave
      return `<svg class="tag-svg is-home-svg" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2.3 7.6L8 2.7L13.7 7.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M4.2 6.8V13.3H11.8V6.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        <path class="tag-home-wave" d="M6.2 10.4C7.2 9.4 8.8 9.4 9.8 10.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>`;

    case "line":
      // Express direct route beam
      return `<svg class="tag-svg is-line-svg" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2.2 11.5C5.2 6.2 8.7 4.5 13.5 4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
        <path class="tag-line-arrow" d="M10.4 2.4L13.8 4.5L11.2 7.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="3.0" cy="11.6" r="1.6" fill="currentColor"/>
      </svg>`;

    case "generous":
      // Stacked high-capacity server cube
      return `<svg class="tag-svg is-cube-svg" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 2L13.6 5L8 8L2.4 5L8 2Z" fill="currentColor" fill-opacity="0.26" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
        <path d="M2.4 8.2L8 11.2L13.6 8.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        <path class="tag-cube-base" d="M2.4 11.1L8 14.1L13.6 11.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;

    case "annual":
      // 4-point sparkle star
      return `<svg class="tag-svg is-star-svg" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path class="tag-star-main" d="M8 1.5L9.7 6.3L14.5 8L9.7 9.7L8 14.5L6.3 9.7L1.5 8L6.3 6.3L8 1.5Z" fill="currentColor"/>
      </svg>`;

    case "value":
      // Cut faceted diamond
      return `<svg class="tag-svg is-gem-svg" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path class="tag-gem-body" d="M4.6 2.4H11.4L14.3 6.3L8 14.1L1.7 6.3L4.6 2.4Z" fill="currentColor" fill-opacity="0.2" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="M2.1 6.3H13.9M8 13.8L5.7 6.3L7.2 2.5M8 13.8L10.3 6.3L8.8 2.5" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/>
      </svg>`;

    case "budget":
    default:
      // Crisp angled price tag
      return `<svg class="tag-svg is-tag-svg" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2.5 8.3V3.3C2.5 2.9 2.9 2.5 3.3 2.5H8.3L13.7 7.9C14.1 8.3 14.1 8.9 13.7 9.3L9.3 13.7C8.9 14.1 8.3 14.1 7.9 13.7L2.5 8.3Z" fill="currentColor" fill-opacity="0.18" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
        <circle cx="5.6" cy="5.6" r="1.15" fill="currentColor"/>
      </svg>`;
  }
}

export function buildTagTipAttrs({ tone, title, kind, reason, hint = "" }) {
  const attrs = [
    `data-tag-tip="${escapeHtml(tone || "value")}"`,
    `data-tag-tip-title="${escapeHtml(title || "")}"`,
    `data-tag-tip-kind="${escapeHtml(kind || "客观核验依据")}"`,
    `data-tag-tip-reason="${escapeHtml(reason || "")}"`
  ];
  if (hint) attrs.push(`data-tag-tip-hint="${escapeHtml(hint)}"`);
  return attrs.join(" ");
}

export function renderShopTagBadge(tag, { compact = false, interactive = false } = {}) {
  if (!tag) return "";
  const classes = [
    "shop-tag",
    `is-${escapeHtml(tag.tone)}`,
    compact ? "is-compact" : "",
    interactive ? "is-interactive" : ""
  ]
    .filter(Boolean)
    .join(" ");

  const tipAttrs = buildTagTipAttrs({
    tone: tag.tone,
    title: tag.label,
    kind: tag.basis === "editorial" ? "店铺定位核验" : "店铺实时现货核验",
    reason: tag.reason || tag.summary || "",
    hint: interactive ? "点击筛选同标签商家" : ""
  });

  const actionAttrs = interactive
    ? `role="button" tabindex="0" data-action="filter-prov-tag" data-prov-tag="${escapeHtml(tag.key)}"`
    : "";

  return `<span class="${classes}" data-shop-tag="${escapeHtml(tag.key)}" ${tipAttrs} ${actionAttrs}>${renderTagSvg(tag.tone)}<span class="tag-txt">${escapeHtml(tag.shortLabel)}</span></span>`;
}

export function renderPlanTagBadge(
  tag,
  { compact = false, fullLabel = false, interactive = false, isActiveFilter = false } = {}
) {
  if (!tag) return "";
  const classes = [
    "plan-tag",
    `is-${escapeHtml(tag.tone)}`,
    compact ? "is-compact" : "",
    interactive ? "is-interactive" : "",
    isActiveFilter ? "is-filtered-match" : ""
  ]
    .filter(Boolean)
    .join(" ");

  const tipAttrs = buildTagTipAttrs({
    tone: tag.tone,
    title: tag.label,
    kind: "单品实测核验依据",
    reason: tag.reason || tag.summary || "",
    hint: interactive ? (isActiveFilter ? "再次点击取消该标签过滤" : "点击一键筛选同标签商品") : ""
  });

  const actionAttrs = interactive
    ? `role="button" tabindex="0" data-action="set-deal" data-deal="${escapeHtml(tag.key)}" data-stop-row`
    : "";

  const text = fullLabel ? tag.label : tag.shortLabel;
  return `<span class="${classes}" data-plan-tag="${escapeHtml(tag.key)}" ${tipAttrs} ${actionAttrs}>${renderTagSvg(tag.tone)}<span class="tag-txt">${escapeHtml(text)}</span></span>`;
}
