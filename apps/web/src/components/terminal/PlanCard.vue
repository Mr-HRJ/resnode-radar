<script setup>
import { computed } from "vue";
import { formatEventDelta, plain, safeUrl } from "@resnode-radar/contracts";
import PlanTagBadge from "../icons/PlanTagBadge.vue";
import {
  renderSpecsParts,
  roleSolidBadgeClass,
  routeChipClass
} from "../../utils/plan-presenters.js";

const props = defineProps({
  plan: {
    type: Object,
    required: true
  },
  store: {
    type: Object,
    required: true
  },
  rowIndex: {
    type: Number,
    default: 0
  }
});

const isSaved = computed(() => props.store.state.savedKeys.has(props.plan._key));
const isCompared = computed(() => props.store.state.compareKeys.includes(props.plan._key));
const isInspected = computed(() => props.store.state.inspectId === props.plan.id);
const isSoldout = computed(() => props.plan.status === "unavailable");
const sp = computed(() => renderSpecsParts(props.plan));
const orderHref = computed(() => safeUrl(props.plan.orderUrl));

const dealBadge = computed(() => {
  const tags = props.plan?._planTags || [];
  if (tags.length === 0) return null;
  const activeDeal = props.store.state.filters?.deal;
  const isFiltered = Boolean(activeDeal && activeDeal !== "all" && activeDeal !== "any");
  const chosen = isFiltered
    ? tags.find((t) => t.key === activeDeal) || props.plan._primaryPlanTag
    : props.plan._primaryPlanTag;
  if (!chosen) return null;
  const reason =
    tags.length > 1
      ? tags.map((t) => `【${t.shortLabel}】${t.reason}`).join("；")
      : chosen.reason;
  return {
    tag: { ...chosen, reason },
    isActiveFilter: isFiltered && chosen.key === activeDeal
  };
});

const hasRestockLead = computed(() => {
  if (props.plan.status !== "available") return false;
  const ev = props.plan._latestEvent;
  return Boolean(
    ev &&
      ev.type === "restock" &&
      props.store.nowMs.value - (Date.parse(ev.at) || 0) <= 72 * 3600 * 1000
  );
});

const eventSpark = computed(() => {
  const ev = props.plan._latestEvent;
  if (!ev || ev.type !== "price") return null;
  if (props.store.nowMs.value - (Date.parse(ev.at) || 0) > 72 * 3600 * 1000) return null;
  const delta = formatEventDelta(ev);
  if (delta?.direction === "down") {
    return { cls: "pill pill-ok num", title: "近 72h 降价", text: `↓ ${delta.label}` };
  }
  if (delta?.direction === "up") {
    return { cls: "pill pill-danger num", title: "近 72h 涨价", text: `↑ ${delta.label}` };
  }
  return null;
});

const regionLabel = computed(() => {
  const loc = props.plan._location;
  if (!loc || loc.isPending) return { pending: true, code: "--", label: "地区待核验", title: "" };
  const label =
    loc.sub && loc.sub !== loc.primary && !loc.sub.startsWith("+")
      ? `${loc.sub}·${loc.primary}`
      : loc.primary;
  return { pending: false, code: loc.code, label, title: loc.fullTitle };
});

const netChips = computed(() => {
  const rp = props.plan._classify.routeProfile || { chips: [] };
  return (rp.chips || []).slice(0, 3).filter((ch) => ch.label !== "国际无优化");
});

const priceDisplay = computed(() => {
  const p = props.plan._pricing;
  const isPromo =
    props.plan.status === "available" && Number.isFinite(p.cnyMonthly) && p.cnyMonthly <= 22;
  const subClass =
    p.cnyTone === "ok"
      ? "price-sub"
      : p.cnyTone === "warn"
        ? "price-sub is-warn"
        : "price-sub is-muted";
  const compactCny = p.cnyLabel.replace(/\s*\(按[^)]+分摊\)/, "");
  const cnyDisplay =
    p.cnyTone === "ok" && !compactCny.startsWith("折合")
      ? `折合 ${compactCny.replace(/^≈\s*/, "")}`
      : compactCny;
  return {
    isPromo,
    subClass,
    cnyDisplay,
    subTitle: p.formula || p.honestReason || p.cnyLabel || ""
  };
});

function handleCardClick(event) {
  if (event?.target?.closest?.("[data-stop-row]")) return;
  props.store.openInspector(props.plan.id);
}
</script>

<template>
  <article
    class="plan-card"
    :class="{
      'is-home': plan._classify.isResidential,
      'is-inspected': isInspected,
      'is-soldout': isSoldout
    }"
    :style="{ '--stagger-i': Math.min(rowIndex, 14) }"
    data-action="inspect-plan"
    :data-product-id="plan.id"
    @click="handleCardClick"
  >
    <div class="plan-card-top">
      <div class="plan-card-vendor">
        <PlanTagBadge
          v-if="dealBadge"
          :tag="dealBadge.tag"
          interactive
          :is-active-filter="dealBadge.isActiveFilter"
          @select="store.toggleDealFilter($event)"
        />
        <span v-if="hasRestockLead" class="tag-badge is-restock" title="近 72h 观测到补货上架">
          补货
        </span>
        <strong>{{ plan._providerName }}</strong>
        <span>·</span>
        <span
          class="region-tag"
          :title="regionLabel.pending ? undefined : regionLabel.title"
        >
          <span class="iso-code">{{ regionLabel.code }}</span>
          {{ regionLabel.label }}
        </span>
      </div>

      <div class="stock-stack">
        <template v-if="plan.status === 'available'">
          <template v-if="plan._isExactStock">
            <span
              class="pill pill-ok num"
              :class="{ 'pill-low-stock': plan.stockCount <= 5 }"
            >
              <span
                class="radar-ping-dot"
                style="width: 6px; height: 6px"
                aria-hidden="true"
              ></span>
              余 {{ plan.stockCount }}
            </span>
            <span class="stock-sub" style="color: var(--ok-fg); font-weight: 600">
              {{ plan.stockCount <= 5 ? "紧俏现货" : "精确现货" }}
            </span>
          </template>
          <template v-else-if="plan._isSnapshot">
            <span class="pill pill-warn">快照有货</span>
            <span class="stock-sub">第三方快照</span>
          </template>
          <template v-else>
            <span class="pill pill-ok">
              <span
                class="radar-ping-dot"
                style="width: 6px; height: 6px"
                aria-hidden="true"
              ></span>
              可订购
            </span>
            <span class="stock-sub">官方入口 · 未报数</span>
          </template>
        </template>
        <template v-else-if="plan.status === 'unavailable'">
          <span class="pill pill-danger">缺货售罄</span>
          <span class="stock-sub">暂不可购</span>
        </template>
        <template v-else>
          <span class="pill pill-neutral pill-outline">状态未标</span>
          <span class="stock-sub">需进官网核验</span>
        </template>
      </div>
    </div>

    <div class="plan-title" :title="plain(plan.name)">{{ plain(plan.name) }}</div>

    <div class="net-stack">
      <span :class="roleSolidBadgeClass(plan._classify.ipTier.tone)">
        {{ plan._classify.ipTier.label }}
      </span>
      <span
        v-if="plan._classify.routeProfile?.headline"
        class="pill"
        :class="
          plan._classify.routeProfile.headlineTone?.startsWith('opt')
            ? 'pill-vps'
            : plan._classify.routeProfile.headlineTone === 'home'
              ? 'pill-home'
              : 'pill-neutral'
        "
      >
        {{ plan._classify.routeProfile.headline }}
      </span>
      <span
        v-for="ch in netChips"
        :key="ch.label"
        :class="routeChipClass(ch.tone)"
      >
        {{ ch.label }}
      </span>
      <span
        v-if="plan._isSnapshot"
        class="net-micro-tag is-warn"
        title="第三方 Reader 公开快照"
      >
        快照
      </span>
      <span
        v-if="eventSpark"
        :class="eventSpark.cls"
        style="height: 19px; padding: 0 5px"
        :title="eventSpark.title"
      >
        {{ eventSpark.text }}
      </span>
    </div>

    <div class="plan-card-specs">
      <span :title="sp.compactHw">配置：{{ sp.compactHw }}</span>
      <span :title="sp.compactNet">网络：{{ sp.compactNet }}</span>
    </div>

    <div class="plan-card-foot">
      <div class="plan-card-price">
        <span
          class="price-primary num"
          :class="{ 'is-promo price-promo-pulse': priceDisplay.isPromo }"
          :title="plan._pricing.originalLabel"
        >
          {{ plan._pricing.displayLabel }}
        </span>
        <span class="num" :class="priceDisplay.subClass" :title="priceDisplay.subTitle">
          {{ priceDisplay.cnyDisplay }}
        </span>
      </div>

      <div class="row-actions" data-stop-row @click.stop>
        <button
          type="button"
          class="btn btn-sm btn-star"
          :class="{ 'is-active': isSaved }"
          data-action="toggle-save"
          :data-key="plan._key"
          :aria-label="isSaved ? '取消收藏' : '收藏'"
          :aria-pressed="String(isSaved)"
          @click.stop="store.toggleSave(plan._key)"
        >
          ★
        </button>
        <button
          type="button"
          class="btn btn-sm"
          :class="{ 'is-active': isCompared }"
          data-action="toggle-compare"
          :data-key="plan._key"
          :aria-label="isCompared ? '移出对比' : '加入对比'"
          :aria-pressed="String(isCompared)"
          @click.stop="store.toggleCompare(plan._key)"
        >
          ⇄
        </button>
        <a
          v-if="orderHref"
          class="btn-buy-cta"
          style="height: 30px; padding: 0 12px"
          :href="orderHref"
          target="_blank"
          rel="nofollow noopener noreferrer"
          @click.stop
        >
          直达购买 ↗
        </a>
        <button
          v-else
          type="button"
          class="btn btn-sm"
          data-action="inspect-plan"
          :data-product-id="plan.id"
          @click.stop="store.openInspector(plan.id)"
        >
          证据
        </button>
      </div>
    </div>
  </article>
</template>
