<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useWindowVirtualizer } from "@tanstack/vue-virtual";
import { formatEventDelta, plain, safeUrl } from "@resnode-radar/contracts";
import PlanTagBadge from "../icons/PlanTagBadge.vue";
import PlanCard from "./PlanCard.vue";
import {
  renderSpecsParts,
  roleSolidBadgeClass,
  routeChipClass,
  shortProviderLabel
} from "../../utils/plan-presenters.js";

const MIN_CARD_WIDTH = 310;
const CARD_GAP = 12;

const props = defineProps({
  items: {
    type: Array,
    required: true
  },
  store: {
    type: Object,
    required: true
  },
  isTableMode: {
    type: Boolean,
    default: true
  },
  viewportWidth: {
    type: Number,
    default: 1280
  }
});

const containerRef = ref(null);
const scrollMargin = ref(0);
const measuredContainerWidth = ref(0);
const measuredTableRowSize = ref(58);
const measuredCardRowSize = ref(196);
let containerObserver = null;

function updateScrollMargin() {
  const el = containerRef.value;
  if (!el || typeof el.getBoundingClientRect !== "function") return;
  const rect = el.getBoundingClientRect();
  const scrollY = globalThis.window?.scrollY || 0;
  const nextMargin = Math.max(0, Math.round(rect.top + scrollY));
  if (Math.abs(nextMargin - scrollMargin.value) > 1) {
    scrollMargin.value = nextMargin;
  }
}

function syncContainerWidth() {
  const el = containerRef.value;
  if (!el) return;
  const width = Math.round(el.clientWidth || el.getBoundingClientRect?.().width || 0);
  if (width > 0 && width !== measuredContainerWidth.value) {
    measuredContainerWidth.value = width;
    updateScrollMargin();
  }
}

onMounted(() => {
  syncContainerWidth();
  updateScrollMargin();
  if (typeof globalThis.ResizeObserver === "function" && containerRef.value) {
    containerObserver = new globalThis.ResizeObserver(() => {
      syncContainerWidth();
    });
    containerObserver.observe(containerRef.value);
  }
  globalThis.window?.addEventListener?.("resize", syncContainerWidth, { passive: true });
});

onBeforeUnmount(() => {
  containerObserver?.disconnect?.();
  containerObserver = null;
  globalThis.window?.removeEventListener?.("resize", syncContainerWidth);
});

const effectiveContainerWidth = computed(() => {
  if (measuredContainerWidth.value > 0) return measuredContainerWidth.value;
  return Math.min(1528, Math.max(280, (props.viewportWidth || 1280) - 24));
});

const resolvedColumns = computed(() => {
  if (props.isTableMode) return 1;
  const w = effectiveContainerWidth.value;
  if (w < MIN_CARD_WIDTH * 2 + CARD_GAP) return 1;
  return Math.max(1, Math.floor((w + CARD_GAP) / (MIN_CARD_WIDTH + CARD_GAP)));
});

const virtualRowCount = computed(() => {
  if (props.isTableMode) return props.items.length;
  const cols = resolvedColumns.value;
  return Math.ceil(props.items.length / cols);
});

const virtualizerOptions = computed(() => ({
  count: virtualRowCount.value,
  getItemKey: (index) =>
    props.isTableMode
      ? props.items[index]?.id ?? `row-${index}`
      : `grid-${resolvedColumns.value}-${index}`,
  estimateSize: () => (props.isTableMode ? measuredTableRowSize.value : measuredCardRowSize.value),
  overscan: props.isTableMode ? 8 : 4,
  scrollMargin: scrollMargin.value,
  initialRect: { width: 1280, height: 896 },
  shouldAdjustScrollPositionOnItemSizeChange: (item, _delta, instance) =>
    instance.scrollDirection !== "backward" && item.end <= instance.getScrollOffset(),
  measureElement: (element, entry, instance) => {
    const boxSize = entry?.borderBoxSize?.[0]?.blockSize;
    const rectHeight =
      typeof boxSize === "number" && boxSize > 0
        ? boxSize
        : element?.getBoundingClientRect?.().height || 0;
    if (rectHeight > 0) {
      const rounded = Math.ceil(rectHeight);
      if (props.isTableMode) {
        if (measuredTableRowSize.value === 58) measuredTableRowSize.value = rounded;
      } else if (measuredCardRowSize.value === 196) {
        measuredCardRowSize.value = rounded;
      }
      return rounded;
    }
    return instance.options.estimateSize(instance.indexFromElement(element));
  }
}));

const rowVirtualizer = useWindowVirtualizer(virtualizerOptions);

function bindMeasureRef(el) {
  rowVirtualizer.value.measureElement(el);
}

watch(
  () => [
    props.isTableMode,
    resolvedColumns.value,
    measuredContainerWidth.value,
    props.items.length,
    props.store.state.specsExpanded,
    props.store.state.shopsExpanded
  ],
  async () => {
    await nextTick();
    updateScrollMargin();
    rowVirtualizer.value.measure();
  }
);

const virtualRows = computed(() => rowVirtualizer.value.getVirtualItems());
const totalSize = computed(() => rowVirtualizer.value.getTotalSize());

const paddingTop = computed(() => {
  const rows = virtualRows.value;
  if (!rows.length) return 0;
  return Math.max(0, rows[0].start - scrollMargin.value);
});

const paddingBottom = computed(() => {
  const rows = virtualRows.value;
  if (!rows.length) return 0;
  const lastEnd = rows[rows.length - 1].end - scrollMargin.value;
  return Math.max(0, totalSize.value - lastEnd);
});

const priceSorted = computed(
  () =>
    props.store.state.filters.sort === "cny-asc" ||
    props.store.state.filters.sort === "cny-desc"
);
const priceArrow = computed(() =>
  props.store.state.filters.sort === "cny-asc"
    ? "↑"
    : props.store.state.filters.sort === "cny-desc"
      ? "↓"
      : "↕"
);
const stockSorted = computed(() => props.store.state.filters.sort === "stock-desc");
const stockArrow = computed(() => (stockSorted.value ? "↓" : "↕"));

function handleSortCol(col) {
  const cur = props.store.state.filters.sort;
  if (col === "price") {
    props.store.updateFilters({ sort: cur === "cny-asc" ? "cny-desc" : "cny-asc" });
  } else if (col === "stock") {
    props.store.updateFilters({ sort: cur === "stock-desc" ? "recommended" : "stock-desc" });
  }
}

function resolveDealBadge(plan) {
  const tags = plan?._planTags || [];
  if (tags.length === 0) return null;
  const activeDeal = props.store.state.filters?.deal;
  const isFiltered = Boolean(activeDeal && activeDeal !== "all" && activeDeal !== "any");
  const chosen = isFiltered
    ? tags.find((t) => t.key === activeDeal) || plan._primaryPlanTag
    : plan._primaryPlanTag;
  if (!chosen) return null;
  const reason =
    tags.length > 1
      ? tags.map((t) => `【${t.shortLabel}】${t.reason}`).join("；")
      : chosen.reason;
  return {
    tag: { ...chosen, reason },
    isActiveFilter: isFiltered && chosen.key === activeDeal
  };
}

function hasRestockLead(plan) {
  if (plan.status !== "available") return false;
  const ev = plan._latestEvent;
  return Boolean(
    ev &&
      ev.type === "restock" &&
      props.store.nowMs.value - (Date.parse(ev.at) || 0) <= 72 * 3600 * 1000
  );
}

function getEventSpark(plan) {
  const ev = plan._latestEvent;
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
}

function getRouteChips(plan) {
  const rp = plan._classify.routeProfile || { chips: [] };
  const chips = [...(rp.chips || [])];
  if (plan._isSnapshot && !chips.some((ch) => ch.label === "快照")) {
    chips.push({ label: "快照", tone: "warn" });
  }
  return chips.slice(0, 3);
}

function getPriceMeta(plan) {
  const p = plan._pricing;
  const isPromo =
    plan.status === "available" && Number.isFinite(p.cnyMonthly) && p.cnyMonthly <= 22;
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
}

function handleRowClick(event, planId) {
  if (event?.target?.closest?.("[data-stop-row]")) return;
  props.store.openInspector(planId);
}

function cardsForVirtualRow(rowIndex) {
  const cols = resolvedColumns.value;
  const start = rowIndex * cols;
  return props.items.slice(start, start + cols).map((plan, offset) => ({
    plan,
    flatIndex: start + offset
  }));
}
</script>

<template>
  <div ref="containerRef">
    <!-- Desktop 8-column virtualized table -->
    <div v-if="isTableMode" class="table-shell">
      <table
        class="terminal-table"
        aria-label="实时库存套餐列表"
        :aria-rowcount="items.length + 1"
      >
        <thead>
          <tr>
            <th class="col-plan">定位 / 商家与型号</th>
            <th class="col-loc">机房位置</th>
            <th class="col-net">回程线路 · 三网明细</th>
            <th class="col-hw">核心配置</th>
            <th class="col-bw">带宽 / 流量</th>
            <th class="col-price col-num">
              <button
                type="button"
                class="th-sort-btn"
                :class="{ 'is-sorted': priceSorted }"
                data-action="sort-col"
                data-sort-col="price"
                @click="handleSortCol('price')"
              >
                <span>价格 / 折合月均</span><span class="mono">{{ priceArrow }}</span>
              </button>
            </th>
            <th class="col-stock">
              <button
                type="button"
                class="th-sort-btn"
                :class="{ 'is-sorted': stockSorted }"
                data-action="sort-col"
                data-sort-col="stock"
                @click="handleSortCol('stock')"
              >
                <span>实时库存</span><span class="mono">{{ stockArrow }}</span>
              </button>
            </th>
            <th class="col-act col-num">操作</th>
          </tr>
        </thead>

        <tbody>
          <tr v-if="paddingTop > 0" aria-hidden="true" class="virtual-spacer-row">
            <td colspan="8" :style="{ height: `${paddingTop}px`, padding: 0, border: 0 }"></td>
          </tr>

          <tr
            v-for="vRow in virtualRows"
            :key="items[vRow.index].id"
            :ref="bindMeasureRef"
            :data-index="vRow.index"
            :aria-rowindex="vRow.index + 2"
            :class="{
              'is-inspected': store.state.inspectId === items[vRow.index].id,
              'is-soldout': items[vRow.index].status === 'unavailable',
              'is-home-row': items[vRow.index]._classify.isResidential
            }"
            :style="{ '--stagger-i': Math.min(vRow.index, 14) }"
            data-action="inspect-plan"
            :data-product-id="items[vRow.index].id"
            @click="handleRowClick($event, items[vRow.index].id)"
          >
            <!-- Col 1: Plan & vendor -->
            <td class="col-plan">
              <div class="plan-cell-split">
                <span
                  :class="[
                    roleSolidBadgeClass(items[vRow.index]._classify.ipTier.tone),
                    'role-pill-fixed'
                  ]"
                >
                  {{ items[vRow.index]._classify.ipTier.label }}
                </span>
                <div class="plan-main-stack">
                  <div class="plan-vendor-row">
                    <PlanTagBadge
                      v-if="resolveDealBadge(items[vRow.index])"
                      :tag="resolveDealBadge(items[vRow.index]).tag"
                      interactive
                      :is-active-filter="resolveDealBadge(items[vRow.index]).isActiveFilter"
                      @select="store.toggleDealFilter($event)"
                    />
                    <strong
                      class="provider-brand"
                      :title="items[vRow.index]._providerName"
                    >
                      {{ shortProviderLabel(items[vRow.index]._providerName) }}
                    </strong>
                    <span
                      v-if="hasRestockLead(items[vRow.index])"
                      class="tag-badge is-restock"
                      title="近 72h 观测到补货上架"
                    >
                      补货
                    </span>
                    <span
                      v-if="getEventSpark(items[vRow.index])"
                      :class="getEventSpark(items[vRow.index]).cls"
                      style="height: 19px; padding: 0 5px"
                      :title="getEventSpark(items[vRow.index]).title"
                    >
                      {{ getEventSpark(items[vRow.index]).text }}
                    </span>
                  </div>
                  <div class="plan-title" :title="plain(items[vRow.index].name)">
                    {{ plain(items[vRow.index].name) }}
                  </div>
                </div>
              </div>
            </td>

            <!-- Col 2: Location -->
            <td class="col-loc">
              <div
                v-if="items[vRow.index]._location?.isPending"
                class="loc-cell is-pending"
                :title="items[vRow.index]._location?.fullTitle || '地区待核验'"
              >
                <div class="loc-primary-row">
                  <span class="iso-code">--</span>
                  <span class="loc-city">待核验</span>
                </div>
              </div>
              <div
                v-else
                class="loc-cell"
                :title="items[vRow.index]._location.fullTitle"
              >
                <div class="loc-primary-row">
                  <span class="iso-code">{{ items[vRow.index]._location.code }}</span>
                  <strong class="loc-city">{{ items[vRow.index]._location.primary }}</strong>
                </div>
                <span v-if="items[vRow.index]._location.sub" class="loc-sub">
                  {{ items[vRow.index]._location.sub }}
                </span>
              </div>
            </td>

            <!-- Col 3: Route hierarchy -->
            <td class="col-net">
              <div
                class="route-cell-stack"
                :title="
                  plain(items[vRow.index].route) ||
                  items[vRow.index]._classify.routeProfile?.headline ||
                  '国际标准互联'
                "
              >
                <div class="route-headline-row">
                  <span
                    class="route-headline"
                    :class="`is-${items[vRow.index]._classify.routeProfile?.headlineTone || 'intl'}`"
                  >
                    {{ items[vRow.index]._classify.routeProfile?.headline || "国际标准互联" }}
                  </span>
                </div>
                <div class="route-chips-row">
                  <span
                    v-for="ch in getRouteChips(items[vRow.index])"
                    :key="ch.label"
                    :class="routeChipClass(ch.tone)"
                  >
                    {{ ch.label }}
                  </span>
                </div>
              </div>
            </td>

            <!-- Col 4: Hardware -->
            <td class="col-hw">
              <div class="hw-stack">
                <span
                  v-if="renderSpecsParts(items[vRow.index]).hwChipText"
                  class="hw-chip num"
                  :title="renderSpecsParts(items[vRow.index]).fullHw"
                >
                  {{ renderSpecsParts(items[vRow.index]).hwChipText }}
                </span>
                <span v-else class="spec-line is-missing">未标明</span>
                <span
                  v-if="renderSpecsParts(items[vRow.index]).hwSub"
                  class="hw-sub"
                  :title="renderSpecsParts(items[vRow.index]).fullHw"
                >
                  {{ renderSpecsParts(items[vRow.index]).hwSub }}
                </span>
              </div>
            </td>

            <!-- Col 5: Bandwidth & Traffic -->
            <td class="col-bw">
              <div class="bw-stack">
                <span
                  v-if="renderSpecsParts(items[vRow.index]).bw"
                  class="bw-highlight num"
                  :title="renderSpecsParts(items[vRow.index]).compactNet"
                >
                  {{ renderSpecsParts(items[vRow.index]).bw }}
                </span>
                <span
                  v-else-if="renderSpecsParts(items[vRow.index]).fallbackNet"
                  class="spec-line"
                  :title="renderSpecsParts(items[vRow.index]).fallbackNet"
                >
                  {{ renderSpecsParts(items[vRow.index]).fallbackNet }}
                </span>
                <span v-else class="spec-line is-missing">未标明</span>

                <span
                  v-if="renderSpecsParts(items[vRow.index]).isUnlimited"
                  class="traffic-unlimited"
                >
                  不限流量
                </span>
                <span
                  v-else-if="renderSpecsParts(items[vRow.index]).traffic"
                  class="spec-line is-sub num"
                  :title="items[vRow.index]._specs.traffic"
                >
                  {{ renderSpecsParts(items[vRow.index]).traffic }}
                </span>
              </div>
            </td>

            <!-- Col 6: Price -->
            <td class="col-price">
              <div class="price-stack">
                <span
                  class="price-primary num"
                  :class="{
                    'is-promo price-promo-pulse': getPriceMeta(items[vRow.index]).isPromo
                  }"
                  :title="items[vRow.index]._pricing.originalLabel"
                >
                  {{ items[vRow.index]._pricing.displayLabel }}
                </span>
                <span
                  class="num"
                  :class="getPriceMeta(items[vRow.index]).subClass"
                  :title="getPriceMeta(items[vRow.index]).subTitle"
                >
                  {{ getPriceMeta(items[vRow.index]).cnyDisplay }}
                </span>
              </div>
            </td>

            <!-- Col 7: Stock evidence -->
            <td class="col-stock">
              <div class="stock-stack">
                <template v-if="items[vRow.index].status === 'available'">
                  <template v-if="items[vRow.index]._isExactStock">
                    <span
                      class="pill pill-ok num"
                      :class="{ 'pill-low-stock': items[vRow.index].stockCount <= 5 }"
                    >
                      <span
                        class="radar-ping-dot"
                        style="width: 6px; height: 6px"
                        aria-hidden="true"
                      ></span>
                      余 {{ items[vRow.index].stockCount }}
                    </span>
                    <span class="stock-sub" style="color: var(--ok-fg); font-weight: 600">
                      {{ items[vRow.index].stockCount <= 5 ? "紧俏现货" : "精确现货" }}
                    </span>
                  </template>
                  <template v-else-if="items[vRow.index]._isSnapshot">
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
                <template v-else-if="items[vRow.index].status === 'unavailable'">
                  <span class="pill pill-danger">缺货售罄</span>
                  <span class="stock-sub">暂不可购</span>
                </template>
                <template v-else>
                  <span class="pill pill-neutral pill-outline">状态未标</span>
                  <span class="stock-sub">需进官网核验</span>
                </template>
              </div>
            </td>

            <!-- Col 8: Actions -->
            <td class="col-act">
              <div class="row-actions" data-stop-row @click.stop>
                <button
                  type="button"
                  class="btn btn-icon btn-xs btn-star"
                  :class="{
                    'is-active': store.state.savedKeys.has(items[vRow.index]._key)
                  }"
                  data-action="toggle-save"
                  :data-key="items[vRow.index]._key"
                  :aria-label="
                    store.state.savedKeys.has(items[vRow.index]._key) ? '取消收藏' : '收藏套餐'
                  "
                  :aria-pressed="
                    String(store.state.savedKeys.has(items[vRow.index]._key))
                  "
                  :title="
                    store.state.savedKeys.has(items[vRow.index]._key) ? '取消收藏' : '收藏'
                  "
                  @click.stop="store.toggleSave(items[vRow.index]._key)"
                >
                  ★
                </button>
                <button
                  type="button"
                  class="btn btn-icon btn-xs"
                  :class="{
                    'is-active': store.state.compareKeys.includes(items[vRow.index]._key)
                  }"
                  data-action="toggle-compare"
                  :data-key="items[vRow.index]._key"
                  :aria-label="
                    store.state.compareKeys.includes(items[vRow.index]._key)
                      ? '移出对比'
                      : '加入对比'
                  "
                  :aria-pressed="
                    String(store.state.compareKeys.includes(items[vRow.index]._key))
                  "
                  :title="
                    store.state.compareKeys.includes(items[vRow.index]._key)
                      ? '移出对比'
                      : '加入对比'
                  "
                  @click.stop="store.toggleCompare(items[vRow.index]._key)"
                >
                  ⇄
                </button>
                <a
                  v-if="safeUrl(items[vRow.index].orderUrl)"
                  class="btn-buy-cta"
                  :href="safeUrl(items[vRow.index].orderUrl)"
                  target="_blank"
                  rel="nofollow noopener noreferrer"
                  aria-label="直达官方订购页"
                  @click.stop
                >
                  直达 ↗
                </a>
                <button
                  v-else
                  type="button"
                  class="btn btn-xs"
                  data-action="inspect-plan"
                  :data-product-id="items[vRow.index].id"
                  @click.stop="store.openInspector(items[vRow.index].id)"
                >
                  详情
                </button>
              </div>
            </td>
          </tr>

          <tr v-if="paddingBottom > 0" aria-hidden="true" class="virtual-spacer-row">
            <td
              colspan="8"
              :style="{ height: `${paddingBottom}px`, padding: 0, border: 0 }"
            ></td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Card grid virtualized mode (mobile & desktop grid toggle) -->
    <div v-else class="virtual-card-list" data-plan-grid :data-virtual-cols="resolvedColumns">
      <div v-if="paddingTop > 0" aria-hidden="true" :style="{ height: `${paddingTop}px` }"></div>
      <div
        v-for="vRow in virtualRows"
        :key="`grid-row-${resolvedColumns}-${vRow.index}`"
        :ref="bindMeasureRef"
        :data-index="vRow.index"
        class="virtual-card-row"
      >
        <div
          class="plan-grid virtual-card-block"
          :style="{ '--virtual-columns': resolvedColumns }"
        >
          <PlanCard
            v-for="entry in cardsForVirtualRow(vRow.index)"
            :key="entry.plan.id"
            :plan="entry.plan"
            :store="store"
            :row-index="entry.flatIndex"
          />
        </div>
      </div>
      <div
        v-if="paddingBottom > 0"
        aria-hidden="true"
        :style="{ height: `${paddingBottom}px` }"
      ></div>
    </div>
  </div>
</template>
