<script setup>
import { computed, nextTick } from "vue";
import {
  BANDWIDTH_OPTIONS,
  BUDGET_OPTIONS,
  CPU_OPTIONS,
  CYCLE_OPTIONS,
  DEFAULT_FILTERS,
  DISK_OPTIONS,
  MACRO_REGIONS,
  MEMORY_OPTIONS,
  OPT_OPTIONS,
  PLAN_TAG_DEFS,
  PLAN_TAG_ORDER,
  ROUTE_OPTIONS,
  SHOP_TAG_DEFS,
  SHOP_TAG_ORDER,
  SORT_OPTIONS,
  TRAFFIC_OPTIONS,
  fxFreshness,
  listActiveFilterBadges,
  normalizeSearch,
  rankProvidersByPopularity
} from "@resnode-radar/contracts";
import TagSvgIcon from "../icons/TagSvgIcon.vue";
import ShopTagBadge from "../icons/ShopTagBadge.vue";
import { shortProviderLabel } from "../../utils/plan-presenters.js";

const props = defineProps({
  store: {
    type: Object,
    required: true
  },
  facets: {
    type: Object,
    required: true
  },
  matchedCount: {
    type: Number,
    default: 0
  },
  viewportWidth: {
    type: Number,
    default: 1280
  }
});

const f = computed(() => props.store.state.filters);
const fx = computed(() => {
  const payload = props.store.rawPayload.value;
  return payload ? fxFreshness(payload.exchangeRates, props.store.nowMs.value) : { valid: true };
});
const activeBadges = computed(() => listActiveFilterBadges(f.value));

const rankedShops = computed(() =>
  rankProvidersByPopularity(props.store.plans.value, props.facets.providerCounts)
);

const collapsedShopLimit = computed(() => {
  const w = props.viewportWidth;
  return w >= 1520 ? 8 : w >= 1340 ? 7 : w >= 1140 ? 6 : 5;
});

const eligibleShops = computed(() =>
  rankedShops.value.filter(
    (s) => s.count > 0 || (s.isHot && s.total === 0) || s.provider.id === f.value.provider
  )
);

const displayedShops = computed(() => {
  const limit = collapsedShopLimit.value;
  let list = eligibleShops.value.slice(0, limit);
  if (f.value.provider !== "all" && !list.some((s) => s.provider.id === f.value.provider)) {
    const selectedItem = rankedShops.value.find((s) => s.provider.id === f.value.provider);
    if (selectedItem) {
      list = [...list.slice(0, Math.max(1, limit - 1)), selectedItem];
    }
  }
  return list;
});

const activeTagTabKey = computed(() => {
  const tab = props.store.state.shopTab || "all";
  return tab.startsWith("tag:") ? tab.slice(4) : null;
});

const tagTabCounts = computed(() => {
  const counts = new Map(SHOP_TAG_ORDER.map((k) => [k, 0]));
  for (const item of eligibleShops.value) {
    for (const t of item.shopTags || []) {
      if (counts.has(t.key)) counts.set(t.key, counts.get(t.key) + 1);
    }
  }
  return counts;
});

const matchingShops = computed(() => {
  const shopTab = props.store.state.shopTab || "all";
  const tagKey = activeTagTabKey.value;
  const shopTokens = normalizeSearch(props.store.state.shopQuery || "")
    .split(/\s+/)
    .filter(Boolean);

  return eligibleShops.value.filter((item) => {
    if (tagKey) {
      if (!(item.shopTags || []).some((t) => t.key === tagKey)) return false;
    } else if (shopTab === "home") {
      if (!(item.provider.features || []).some((ft) => /家宽|双\s*ISP/i.test(ft))) return false;
    } else if (shopTab === "cn") {
      if (!(item.provider.features || []).includes("CN优化线路")) return false;
    } else if (shopTab === "landing") {
      if (!(item.provider.features || []).some((ft) => /纯落地|性能/i.test(ft))) return false;
    }

    if (shopTokens.length === 0) return true;
    const { provider, shopTags = [] } = item;
    const tagSearchTerms = shopTags.flatMap((t) => [
      t.shortLabel,
      t.label,
      ...(t.searchAliases || [])
    ]);
    const text = normalizeSearch(
      [
        provider.id,
        provider.name,
        ...(provider.aliases || []),
        shortProviderLabel(provider.name),
        ...tagSearchTerms
      ].join(" ")
    );
    return shopTokens.every((token) => text.includes(token));
  });
});

const hasCustomBudget = computed(() => Boolean(f.value.minPrice || f.value.maxPrice));
const hasSpecFilters = computed(
  () =>
    f.value.cpu !== "all" ||
    f.value.memory !== "all" ||
    f.value.disk !== "all" ||
    f.value.bandwidth !== "all" ||
    f.value.traffic !== "all" ||
    f.value.budget !== "all" ||
    Boolean(f.value.minPrice) ||
    Boolean(f.value.maxPrice)
);

function fPillClass(isActive, isDefaultOption = false, extra = "") {
  const base = ["f-pill"];
  if (extra) base.push(extra);
  if (isActive) {
    base.push(isDefaultOption ? "is-all-default" : "is-active");
  }
  return base.join(" ");
}

function resolveShopDisplayTag(shop, preferredTagKey = null) {
  const { primaryTag = null, shopTags = [] } = shop;
  const displayTag = preferredTagKey
    ? shopTags.find((t) => t.key === preferredTagKey) || primaryTag
    : primaryTag;
  if (!displayTag) return null;
  const reason =
    shopTags.length > 1
      ? shopTags.map((t) => `【${t.shortLabel}】${t.reason}`).join("；")
      : displayTag.reason;
  return { ...displayTag, reason };
}

function formatShopTooltip(shop) {
  const { provider, count, total, shopTags = [] } = shop;
  const parts = [
    provider.name,
    total === 0 ? "尚无可核验套餐，库存待确认" : `${count} 款匹配套餐`
  ];
  if (shopTags.length > 0) {
    parts.push(shopTags.map((t) => `${t.label}：${t.reason}`).join("；"));
  }
  return parts.join(" · ");
}

async function handleSelectProvider(providerId) {
  const cur = f.value.provider;
  props.store.updateFilters({
    provider: providerId !== "all" && cur === providerId ? "all" : providerId
  });
  if (props.store.state.shopsExpanded) {
    props.store.toggleShopsExpanded();
    await nextTick();
    globalThis.document?.querySelector?.("[data-action='toggle-shops-expand']")?.focus?.();
  }
}

async function handleToggleShops() {
  props.store.toggleShopsExpanded();
  await nextTick();
  const sel = props.store.state.shopsExpanded
    ? "[data-shop-search]"
    : "[data-action='toggle-shops-expand']";
  globalThis.document?.querySelector?.(sel)?.focus?.();
}

async function handleClearShopSearch() {
  props.store.setShopQuery("");
  await nextTick();
  globalThis.document?.querySelector?.("[data-shop-search]")?.focus?.();
}

function toggleValueFilter(key, val) {
  if (!Object.hasOwn(DEFAULT_FILTERS, key)) return;
  const cur = f.value[key];
  props.store.updateFilters({ [key]: val !== "all" && cur === val ? "all" : val });
}

function handleBudgetPill(val) {
  const cur = f.value.budget;
  const next =
    val !== "all" && cur === val && !f.value.minPrice && !f.value.maxPrice ? "all" : val;
  props.store.updateFilters({ budget: next, minPrice: "", maxPrice: "" });
}
</script>

<template>
  <!-- Mobile quick bar -->
  <div class="mobile-quick-bar" aria-label="移动端快捷筛选">
    <div class="mobile-quick-row">
      <button
        type="button"
        class="btn btn-sm"
        :class="activeBadges.length ? 'btn-primary' : 'btn-soft'"
        data-action="open-mobile-rail"
        @click="store.setMobileRailOpen(true)"
      >
        <span>配置筛选</span>
        <span v-if="activeBadges.length" class="num">({{ activeBadges.length }})</span>
      </button>
      <button
        type="button"
        class="btn btn-sm"
        :class="{ 'is-active': f.track === 'all' }"
        data-action="set-track"
        data-track="all"
        @click="store.updateFilters({ track: 'all' })"
      >
        全部 <span class="num">{{ facets.tracks.all }}</span>
      </button>
      <button
        type="button"
        class="btn btn-sm"
        :class="{ 'is-active': f.track === 'home' }"
        data-action="set-track"
        data-track="home"
        @click="store.updateFilters({ track: 'home' })"
      >
        真家宽 <span class="num">{{ facets.tracks.home }}</span>
      </button>
      <button
        type="button"
        class="btn btn-sm"
        :class="{ 'is-active': f.track === 'cn-opt' }"
        data-action="set-track"
        data-track="cn-opt"
        @click="store.updateFilters({ track: 'cn-opt' })"
      >
        CN优化 <span class="num">{{ facets.tracks["cn-opt"] }}</span>
      </button>
      <button
        type="button"
        class="btn btn-sm"
        :class="{ 'is-active': f.track === 'landing' }"
        data-action="set-track"
        data-track="landing"
        @click="store.updateFilters({ track: 'landing' })"
      >
        纯落地 <span class="num">{{ facets.tracks.landing }}</span>
      </button>
    </div>
  </div>

  <!-- Desktop multi-dimensional Filter Dock -->
  <section class="filter-dock" aria-label="多维直选配置与筛选工作台" data-filter-dock>
    <div class="facet-matrix-row is-centered">
      <div
        class="facet-row-label"
        title="有采集结果的商家优先，暂无结果的商家排在最后；数字为匹配套餐数，标签基于真实品牌定位与实时现货核验"
      >
        常用商家
      </div>
      <div class="facet-row-options shops-row-full" data-shops-row>
        <button
          type="button"
          :class="fPillClass(f.provider === 'all', true, 'shop-all-btn')"
          data-action="set-provider"
          data-provider="all"
          @click="handleSelectProvider('all')"
        >
          <span>全部品牌</span>
        </button>

        <button
          v-for="shop in displayedShops"
          :key="shop.provider.id"
          type="button"
          :class="
            fPillClass(
              f.provider === shop.provider.id,
              false,
              `shop-shortcut${
                resolveShopDisplayTag(shop)
                  ? ` has-tag is-tag-${resolveShopDisplayTag(shop).tone}`
                  : ''
              }`
            )
          "
          data-action="set-provider"
          :data-provider="shop.provider.id"
          :aria-pressed="String(f.provider === shop.provider.id)"
          :title="resolveShopDisplayTag(shop) ? undefined : formatShopTooltip(shop)"
          @click="handleSelectProvider(shop.provider.id)"
        >
          <span class="shop-choice-lead">
            <ShopTagBadge :tag="resolveShopDisplayTag(shop)" compact />
            <span class="shop-choice-name">{{ shortProviderLabel(shop.provider.name) }}</span>
          </span>
          <span class="shop-choice-count" :class="shop.total === 0 ? 'is-pending' : 'num'">
            {{ shop.total === 0 ? "待核验" : shop.count }}
          </span>
        </button>
      </div>
      <div class="facet-row-extra">
        <button
          type="button"
          class="expand-btn"
          :class="{ 'has-active': store.state.shopsExpanded }"
          data-action="toggle-shops-expand"
          :aria-expanded="String(store.state.shopsExpanded)"
          aria-controls="shop-picker"
          @click="handleToggleShops"
        >
          <span>
            {{ store.state.shopsExpanded ? "收起店铺 ▴" : `全部 ${eligibleShops.length} 家 ▾` }}
          </span>
        </button>
      </div>
    </div>

    <section
      class="shop-picker"
      id="shop-picker"
      data-shop-picker
      aria-label="商家选择面板"
      :hidden="!store.state.shopsExpanded"
    >
      <template v-if="store.state.shopsExpanded">
        <div class="shop-picker-head">
          <div class="shop-picker-tabs" role="group" aria-label="按商家标签与主营方向筛选">
            <button
              type="button"
              class="f-pill"
              :class="{ 'is-active': store.state.shopTab === 'all' }"
              data-action="set-shop-tab"
              data-shop-tab="all"
              @click="store.setShopTab('all')"
            >
              全部 ({{ eligibleShops.length }})
            </button>
            <span class="shop-tabs-sep" aria-hidden="true"></span>
            <button
              v-for="key in SHOP_TAG_ORDER"
              :key="key"
              type="button"
              class="f-pill shop-tab-tag"
              :class="[
                `is-${SHOP_TAG_DEFS[key].tone}`,
                { 'is-active': store.state.shopTab === `tag:${key}` }
              ]"
              data-action="set-shop-tab"
              :data-shop-tab="`tag:${key}`"
              :data-tag-tip="SHOP_TAG_DEFS[key].tone"
              :data-tag-tip-title="SHOP_TAG_DEFS[key].label"
              data-tag-tip-kind="店铺标签筛选口径"
              :data-tag-tip-reason="SHOP_TAG_DEFS[key].summary"
              :data-tag-tip-hint="
                store.state.shopTab === `tag:${key}`
                  ? '再次点击或选全部恢复'
                  : '点击仅看该标签商家'
              "
              @click="
                store.setShopTab(store.state.shopTab === `tag:${key}` ? 'all' : `tag:${key}`)
              "
            >
              <TagSvgIcon :tone="SHOP_TAG_DEFS[key].tone" />
              <span>{{ SHOP_TAG_DEFS[key].label }}</span>
              <span class="f-cnt num">{{ tagTabCounts.get(key) || 0 }}</span>
            </button>
            <span class="shop-tabs-sep" aria-hidden="true"></span>
            <button
              v-for="[val, lbl] in [
                ['home', '含家宽'],
                ['cn', '含优化'],
                ['landing', '含落地']
              ]"
              :key="val"
              type="button"
              class="f-pill is-scope-pill"
              :class="{ 'is-active': store.state.shopTab === val }"
              data-action="set-shop-tab"
              :data-shop-tab="val"
              @click="store.setShopTab(val)"
            >
              {{ lbl }}
            </button>
          </div>

          <input
            type="search"
            class="input-field shop-picker-search"
            data-shop-search
            :value="store.state.shopQuery"
            placeholder="搜商家或标签（热门/老牌/家宽/性价比）"
            aria-label="查找商家"
            @input="store.setShopQuery($event.target.value)"
          />
        </div>

        <template v-if="matchingShops.length">
          <div class="shop-picker-scroll-wrap">
            <div class="shop-picker-grid" role="group" aria-label="匹配商家">
              <button
                v-for="shop in matchingShops"
                :key="shop.provider.id"
                type="button"
                class="shop-choice"
                :class="[
                  { 'is-active': f.provider === shop.provider.id },
                  resolveShopDisplayTag(shop, activeTagTabKey)
                    ? `has-tag is-tag-${resolveShopDisplayTag(shop, activeTagTabKey).tone}`
                    : ''
                ]"
                data-action="set-provider"
                :data-provider="shop.provider.id"
                :aria-pressed="String(f.provider === shop.provider.id)"
                :title="
                  resolveShopDisplayTag(shop, activeTagTabKey)
                    ? undefined
                    : formatShopTooltip(shop)
                "
                @click="handleSelectProvider(shop.provider.id)"
              >
                <span class="shop-choice-lead">
                  <ShopTagBadge :tag="resolveShopDisplayTag(shop, activeTagTabKey)" />
                  <span class="shop-choice-name">{{ shortProviderLabel(shop.provider.name) }}</span>
                </span>
                <span class="shop-choice-count" :class="shop.total === 0 ? 'is-pending' : 'num'">
                  {{ shop.total === 0 ? "待核验" : shop.count }}
                </span>
              </button>
            </div>
          </div>
          <div class="shop-picker-foot">
            <span>
              7 维店铺标签：「热门」「老牌」按真实品牌资历核定；「家宽」「优线」「高配」「性价比」「低价」按实时非 NAT 现货占比与单价核验（悬停标签即看实测依据，当前匹配 {{ matchingShops.length }} 家）。
            </span>
            <button
              type="button"
              class="btn btn-xs btn-ghost"
              data-action="toggle-shops-expand"
              @click="handleToggleShops"
            >
              收起店铺面板 ▴
            </button>
          </div>
        </template>
        <div v-else class="shop-picker-empty">
          <span>没有找到匹配的商家</span>
          <button
            v-if="store.state.shopQuery"
            type="button"
            class="btn btn-xs btn-ghost"
            data-action="clear-shop-search"
            @click="handleClearShopSearch"
          >
            清空搜索
          </button>
          <button
            v-if="store.state.shopTab !== 'all'"
            type="button"
            class="btn btn-xs btn-ghost"
            data-action="set-shop-tab"
            data-shop-tab="all"
            @click="store.setShopTab('all')"
          >
            切回全部可售
          </button>
        </div>
      </template>
    </section>

    <!-- Row 2: 地区下拉 + 节点用途定位 + 原生/优化属性 -->
    <div class="facet-matrix-row is-centered">
      <div class="facet-row-label">区域定位</div>
      <div class="facet-row-options">
        <select
          class="select-field region-dropdown"
          :class="{ 'is-filtered': f.region !== 'all' }"
          data-filter-select="region"
          aria-label="按所在地区筛选"
          :value="f.region"
          @change="store.updateFilters({ region: $event.target.value })"
        >
          <option v-for="r in MACRO_REGIONS" :key="r.value" :value="r.value">
            {{
              r.value === "all"
                ? "全部地区"
                : `${r.value === "MULTI" ? "GL" : r.value === "APAC" ? "AP" : r.value} · ${r.label} (${facets.regions.get(r.value) || 0})`
            }}
          </option>
        </select>

        <div class="facet-pill-cluster" role="group" aria-label="节点本质与用途">
          <button
            type="button"
            :class="fPillClass(f.track === 'all', true)"
            data-action="set-track"
            data-track="all"
            @click="store.updateFilters({ track: 'all' })"
          >
            <span>全部定位</span><span class="f-cnt num">{{ facets.tracks.all }}</span>
          </button>
          <button
            type="button"
            :class="fPillClass(f.track === 'home', false, 'is-home')"
            data-action="set-track"
            data-track="home"
            @click="store.updateFilters({ track: 'home' })"
          >
            <span>真家宽 / 双ISP</span><span class="f-cnt num">{{ facets.tracks.home }}</span>
          </button>
          <button
            type="button"
            :class="fPillClass(f.track === 'cn-opt', false)"
            data-action="set-track"
            data-track="cn-opt"
            @click="store.updateFilters({ track: 'cn-opt' })"
          >
            <span>CN优化直连</span><span class="f-cnt num">{{ facets.tracks["cn-opt"] }}</span>
          </button>
          <button
            type="button"
            :class="fPillClass(f.track === 'landing', false)"
            data-action="set-track"
            data-track="landing"
            @click="store.updateFilters({ track: 'landing' })"
          >
            <span>国际纯落地</span><span class="f-cnt num">{{ facets.tracks.landing }}</span>
          </button>
          <button
            type="button"
            :class="fPillClass(f.track === 'vps', false)"
            data-action="set-track"
            data-track="vps"
            @click="store.updateFilters({ track: 'vps' })"
          >
            <span>机房VPS</span><span class="f-cnt num">{{ facets.tracks.vps }}</span>
          </button>
        </div>

        <div class="facet-pill-cluster is-subtle-sep" role="group" aria-label="原生与优化细分">
          <button
            v-for="[val, lbl] in [
              ['3net', '三网优化'],
              ['2net', '双网+优化'],
              ['native', '原生 / 双ISP'],
              ['opt', '有回国优化'],
              ['intl', '无优化直连']
            ]"
            :key="val"
            type="button"
            :class="fPillClass(f.opt === val, false)"
            data-action="set-opt"
            :data-opt="val"
            @click="toggleValueFilter('opt', val)"
          >
            {{ lbl }}
          </button>
        </div>
      </div>
    </div>

    <!-- Row 3: 骨干线路直选 -->
    <div class="facet-matrix-row is-centered">
      <div class="facet-row-label">骨干线路</div>
      <div class="facet-row-options">
        <button
          v-for="r in ROUTE_OPTIONS"
          :key="r.value"
          type="button"
          :class="fPillClass(f.route === r.value, r.value === 'all')"
          data-action="set-route"
          :data-route="r.value"
          @click="toggleValueFilter('route', r.value)"
        >
          <span>{{ r.value === "all" ? "全部线路" : r.label }}</span>
          <span v-if="r.value !== 'all'" class="f-cnt num">
            {{ facets.routes.get(r.value) || 0 }}
          </span>
        </button>
      </div>
      <div class="facet-row-extra">
        <button
          type="button"
          class="expand-btn"
          :class="{ 'has-active': hasSpecFilters }"
          data-action="toggle-specs-expand"
          :aria-expanded="String(store.state.specsExpanded)"
          @click="store.toggleSpecsExpanded()"
        >
          <span>{{ store.state.specsExpanded ? "收起硬件预算 ▴" : "硬件与预算 ▾" }}</span>
        </button>
      </div>
    </div>

    <!-- Row 4: 商品亮点标签 -->
    <div class="facet-matrix-row is-centered is-deal-row">
      <div
        class="facet-row-label"
        title="基于非 NAT 在售现货的真实配置、线路、年付单价、精确余量与限量型号核验，自动排除 NAT 共享端口"
      >
        精选亮点
      </div>
      <div class="facet-row-options" role="group" aria-label="按商品亮点标签筛选">
        <button
          type="button"
          :class="fPillClass((f.deal || 'all') === 'all', true)"
          data-action="set-deal"
          data-deal="all"
          @click="store.toggleDealFilter('all')"
        >
          <span>全部商品</span>
        </button>
        <button
          v-for="key in PLAN_TAG_ORDER"
          :key="key"
          type="button"
          :class="fPillClass(f.deal === key, false, `deal-pill is-${PLAN_TAG_DEFS[key].tone}`)"
          data-action="set-deal"
          :data-deal="key"
          :data-tag-tip="PLAN_TAG_DEFS[key].tone"
          :data-tag-tip-title="PLAN_TAG_DEFS[key].label"
          data-tag-tip-kind="商品亮点筛选口径"
          :data-tag-tip-reason="PLAN_TAG_DEFS[key].summary"
          :data-tag-tip-hint="
            f.deal === key ? '再次点击恢复全部商品' : '点击筛选符合该标准的现货'
          "
          @click="store.toggleDealFilter(key)"
        >
          <TagSvgIcon :tone="PLAN_TAG_DEFS[key].tone" />
          <span>{{ PLAN_TAG_DEFS[key].label }}</span>
          <span class="f-cnt num">{{ facets.deals?.get(key) || 0 }}</span>
        </button>
        <span class="deal-row-hint">悬停看核验依据 · 点击行内标签可速筛</span>
      </div>
    </div>

    <!-- Collapsible hardware & budget panel -->
    <div v-if="store.state.specsExpanded" class="spec-matrix-grid is-unfurling" data-specs-panel>
      <div class="spec-cell" role="group" aria-label="月均人民币预算区间">
        <span class="spec-cell-label">月均预算</span>
        <div class="spec-cell-opts budget-controls">
          <select
            class="select-field mini-select budget-select"
            :class="{ 'is-filtered': f.budget !== 'all' || hasCustomBudget }"
            data-filter-select="budget"
            aria-label="月均预算档位"
            :value="hasCustomBudget ? 'custom' : f.budget"
            @change="
              store.updateFilters({
                budget: $event.target.value,
                minPrice: '',
                maxPrice: ''
              })
            "
          >
            <option v-if="hasCustomBudget" value="custom" disabled>自定义金额</option>
            <option v-for="b in BUDGET_OPTIONS" :key="b.value" :value="b.value">
              {{ b.value === "all" ? "不限" : b.label }}
            </option>
          </select>
          <div
            class="price-range-box"
            :class="{ 'is-active': Boolean(f.minPrice || f.maxPrice) }"
            :title="
              !fx.valid
                ? 'ECB 汇率超 7 天，外币套餐已停算 CNY'
                : '输入自定义人民币月均最低与最高价'
            "
          >
            <span class="range-currency">￥</span>
            <input
              type="number"
              min="0"
              step="1"
              class="price-range-input"
              data-price-min
              :value="f.minPrice"
              placeholder="最低"
              aria-label="最低月均人民币"
              @input="store.updateFilters({ minPrice: $event.target.value, budget: 'all' })"
            />
            <span class="range-sep">-</span>
            <input
              type="number"
              min="0"
              step="1"
              class="price-range-input"
              data-price-max
              :value="f.maxPrice"
              placeholder="最高"
              aria-label="最高月均人民币"
              @input="store.updateFilters({ maxPrice: $event.target.value, budget: 'all' })"
            />
          </div>
        </div>
      </div>

      <div class="spec-cell" role="group" aria-label="月流量配额">
        <span class="spec-cell-label">月度流量</span>
        <div class="spec-cell-opts">
          <button
            v-for="o in TRAFFIC_OPTIONS"
            :key="o.value"
            type="button"
            :class="fPillClass(f.traffic === o.value, o.value === 'all')"
            data-action="set-spec"
            data-spec-key="traffic"
            :data-spec-val="o.value"
            @click="toggleValueFilter('traffic', o.value)"
          >
            {{ o.label.replace(/^♾\s*/, "") }}
          </button>
        </div>
      </div>

      <div class="spec-cell" role="group" aria-label="端口带宽">
        <span class="spec-cell-label">端口带宽</span>
        <div class="spec-cell-opts">
          <button
            v-for="o in BANDWIDTH_OPTIONS"
            :key="o.value"
            type="button"
            :class="fPillClass(f.bandwidth === o.value, o.value === 'all')"
            data-action="set-spec"
            data-spec-key="bandwidth"
            :data-spec-val="o.value"
            @click="toggleValueFilter('bandwidth', o.value)"
          >
            {{ o.label }}
          </button>
        </div>
      </div>

      <div class="spec-cell" role="group" aria-label="CPU核数">
        <span class="spec-cell-label">CPU 核数</span>
        <div class="spec-cell-opts">
          <button
            v-for="o in CPU_OPTIONS"
            :key="o.value"
            type="button"
            :class="fPillClass(f.cpu === o.value, o.value === 'all')"
            data-action="set-spec"
            data-spec-key="cpu"
            :data-spec-val="o.value"
            @click="toggleValueFilter('cpu', o.value)"
          >
            {{ o.label }}
          </button>
        </div>
      </div>

      <div class="spec-cell" role="group" aria-label="内存大小">
        <span class="spec-cell-label">内存大小</span>
        <div class="spec-cell-opts">
          <button
            v-for="o in MEMORY_OPTIONS"
            :key="o.value"
            type="button"
            :class="fPillClass(f.memory === o.value, o.value === 'all')"
            data-action="set-spec"
            data-spec-key="memory"
            :data-spec-val="o.value"
            @click="toggleValueFilter('memory', o.value)"
          >
            {{ o.label }}
          </button>
        </div>
      </div>

      <div class="spec-cell" role="group" aria-label="硬盘容量">
        <span class="spec-cell-label">硬盘容量</span>
        <div class="spec-cell-opts">
          <button
            v-for="o in DISK_OPTIONS"
            :key="o.value"
            type="button"
            :class="fPillClass(f.disk === o.value, o.value === 'all')"
            data-action="set-spec"
            data-spec-key="disk"
            :data-spec-val="o.value"
            @click="toggleValueFilter('disk', o.value)"
          >
            {{ o.label }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="f.track === 'home'" class="dock-track-note">
      <span>
        <strong>真家宽 / 双 ISP 严格隔离已开启：</strong>
        自动剔除普通数据中心宣称“原生 IP”的机器，仅展示真实住宅宽带与双 ISP 宿主方案。
      </span>
      <button
        type="button"
        class="btn btn-xs btn-ghost"
        style="color: inherit"
        data-action="set-track"
        data-track="all"
        @click="store.updateFilters({ track: 'all' })"
      >
        切回全部定位
      </button>
    </div>

    <!-- Secondary toolbar -->
    <div class="dock-row-secondary">
      <div class="quick-toggles">
        <button
          type="button"
          class="q-toggle"
          :class="{ 'is-on': f.status === 'available' }"
          data-action="toggle-quick-available"
          :aria-pressed="String(f.status === 'available')"
          @click="store.updateFilters({ status: f.status === 'available' ? 'all' : 'available' })"
        >
          <span class="q-dot" :class="{ 'is-live': f.status === 'available' }"></span>
          <span>仅看现货</span>
        </button>

        <button
          type="button"
          class="q-toggle"
          :class="{ 'is-on-accent': f.exactOnly }"
          data-action="toggle-quick-exact"
          :aria-pressed="String(f.exactOnly)"
          @click="store.updateFilters({ exactOnly: !f.exactOnly })"
        >
          <span>精确库存</span>
        </button>

        <button
          type="button"
          class="q-toggle"
          :class="{ 'is-on-accent': f.noNat }"
          data-action="toggle-quick-nonat"
          :aria-pressed="String(f.noNat)"
          @click="store.updateFilters({ noNat: !f.noNat })"
        >
          <span>排除 NAT</span>
        </button>

        <button
          type="button"
          class="q-toggle"
          :class="{ 'is-on-accent': f.noSnapshot }"
          data-action="toggle-quick-nosnap"
          :aria-pressed="String(f.noSnapshot)"
          @click="store.updateFilters({ noSnapshot: !f.noSnapshot })"
        >
          <span>排除快照</span>
        </button>

        <button
          type="button"
          class="q-toggle"
          :class="{ 'is-on-accent': f.savedOnly }"
          data-action="toggle-quick-saved"
          :aria-pressed="String(f.savedOnly)"
          @click="store.updateFilters({ savedOnly: !f.savedOnly })"
        >
          <span data-terminal-saved-count>★ 收藏 ({{ store.state.savedKeys.size }})</span>
        </button>

        <select
          class="select-field mini-select"
          data-filter-select="cycle"
          aria-label="按计费周期筛选"
          :value="f.cycle"
          @change="store.updateFilters({ cycle: $event.target.value })"
        >
          <option v-for="c in CYCLE_OPTIONS" :key="c.value" :value="c.value">{{ c.label }}</option>
        </select>

        <select
          class="select-field mini-select"
          data-filter-select="status"
          aria-label="库存状态细项"
          :value="f.status"
          @change="store.updateFilters({ status: $event.target.value })"
        >
          <option value="available">状态: 在售现货</option>
          <option value="all">状态: 含缺货全部</option>
          <option value="unavailable">状态: 仅看缺货</option>
          <option value="unknown">状态: 库存未公开</option>
        </select>

        <button
          v-if="activeBadges.length > 0"
          type="button"
          class="btn btn-xs btn-soft"
          data-action="reset-filters"
          @click="store.resetFilters()"
        >
          ↺ 重置已选 ({{ activeBadges.length }})
        </button>
      </div>

      <div class="toolbar-right">
        <div class="result-summary">
          共匹配 <strong>{{ matchedCount }}</strong> 款
        </div>
        <select
          class="select-field sort-select"
          data-filter-select="sort"
          aria-label="排序方式"
          :value="f.sort"
          @change="store.updateFilters({ sort: $event.target.value })"
        >
          <option v-for="opt in SORT_OPTIONS" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>

        <div class="view-toggle layout-view-toggle" role="group" aria-label="桌面视图切换">
          <button
            type="button"
            class="view-toggle-btn"
            :class="{ 'is-active': store.state.layout === 'table' }"
            data-action="set-layout"
            data-layout="table"
            @click="store.setLayout('table')"
          >
            列表
          </button>
          <button
            type="button"
            class="view-toggle-btn"
            :class="{ 'is-active': store.state.layout === 'grid' }"
            data-action="set-layout"
            data-layout="grid"
            @click="store.setLayout('grid')"
          >
            卡片
          </button>
        </div>

        <button
          type="button"
          class="btn btn-sm"
          data-action="copy-share-url"
          title="复制带当前筛选与对比状态的 URL"
          @click="store.copyShareUrl()"
        >
          分享
        </button>
      </div>
    </div>
  </section>

  <!-- Mobile full-dimension filter drawer -->
  <aside
    class="mobile-filter-sheet"
    :class="{ 'is-mobile-open': store.state.mobileRailOpen }"
    aria-label="移动端全维筛选抽屉"
    data-mobile-filter-sheet
  >
    <div class="mobile-rail-header">
      <strong style="font-size: var(--text-base)">全维配置筛选（匹配 {{ matchedCount }} 款）</strong>
      <button
        type="button"
        class="btn btn-sm btn-ghost"
        data-action="close-mobile-rail"
        aria-label="关闭筛选抽屉"
        @click="store.setMobileRailOpen(false)"
      >
        ✕
      </button>
    </div>

    <div class="rail-section">
      <div class="rail-heading"><span>常用商家与地区</span></div>
      <select
        class="select-field"
        data-filter-select="provider"
        aria-label="按店铺筛选"
        :value="f.provider"
        @change="store.updateFilters({ provider: $event.target.value })"
      >
        <option value="all">全部品牌（常用商家优先）</option>
        <option v-for="s in eligibleShops" :key="s.provider.id" :value="s.provider.id">
          {{ s.primaryTag ? `[${s.primaryTag.shortLabel}] ` : "" }}{{ s.provider.name }} ({{
            s.total === 0 ? "待核验" : s.count
          }})
        </option>
      </select>

      <select
        class="select-field"
        data-filter-select="region"
        aria-label="按地区筛选"
        :value="f.region"
        @change="store.updateFilters({ region: $event.target.value })"
      >
        <option v-for="r in MACRO_REGIONS" :key="r.value" :value="r.value">
          {{
            r.value === "all"
              ? "全部地区"
              : `${r.value === "MULTI" ? "GL" : r.value === "APAC" ? "AP" : r.value} ${r.label} (${facets.regions.get(r.value) || 0})`
          }}
        </option>
      </select>
    </div>

    <div class="rail-section">
      <div class="rail-heading"><span>精选亮点标签</span></div>
      <div class="facet-wrap">
        <button
          type="button"
          :class="fPillClass((f.deal || 'all') === 'all', true)"
          data-action="set-deal"
          data-deal="all"
          @click="store.toggleDealFilter('all')"
        >
          全部商品
        </button>
        <button
          v-for="key in PLAN_TAG_ORDER"
          :key="key"
          type="button"
          :class="fPillClass(f.deal === key, false, `deal-pill is-${PLAN_TAG_DEFS[key].tone}`)"
          data-action="set-deal"
          :data-deal="key"
          @click="store.toggleDealFilter(key)"
        >
          <TagSvgIcon :tone="PLAN_TAG_DEFS[key].tone" />
          <span>{{ PLAN_TAG_DEFS[key].label }} ({{ facets.deals?.get(key) || 0 }})</span>
        </button>
      </div>
    </div>

    <div class="rail-section">
      <div class="rail-heading"><span>用途定位与线路</span></div>
      <div class="facet-wrap">
        <button
          type="button"
          :class="fPillClass(f.track === 'all', true)"
          data-action="set-track"
          data-track="all"
          @click="store.updateFilters({ track: 'all' })"
        >
          全部 ({{ facets.tracks.all }})
        </button>
        <button
          type="button"
          :class="fPillClass(f.track === 'home', false, 'is-home')"
          data-action="set-track"
          data-track="home"
          @click="store.updateFilters({ track: 'home' })"
        >
          真家宽 ({{ facets.tracks.home }})
        </button>
        <button
          type="button"
          :class="fPillClass(f.track === 'cn-opt', false)"
          data-action="set-track"
          data-track="cn-opt"
          @click="store.updateFilters({ track: 'cn-opt' })"
        >
          CN优化 ({{ facets.tracks["cn-opt"] }})
        </button>
        <button
          type="button"
          :class="fPillClass(f.track === 'landing', false)"
          data-action="set-track"
          data-track="landing"
          @click="store.updateFilters({ track: 'landing' })"
        >
          纯落地 ({{ facets.tracks.landing }})
        </button>
      </div>
      <div class="facet-wrap">
        <button
          v-for="o in OPT_OPTIONS"
          :key="o.value"
          type="button"
          :class="fPillClass(f.opt === o.value, o.value === 'all')"
          data-action="set-opt"
          :data-opt="o.value"
          @click="toggleValueFilter('opt', o.value)"
        >
          {{ o.label }}
        </button>
      </div>
      <div class="facet-wrap">
        <button
          v-for="r in ROUTE_OPTIONS"
          :key="r.value"
          type="button"
          :class="fPillClass(f.route === r.value, r.value === 'all')"
          data-action="set-route"
          :data-route="r.value"
          @click="toggleValueFilter('route', r.value)"
        >
          {{ r.label }}
        </button>
      </div>
    </div>

    <div class="rail-section">
      <div class="rail-heading">
        <span>月均预算 · 流量 · 带宽</span>
        <span v-if="!fx.valid" style="color: var(--warn-fg); font-size: 10px">外币停算</span>
      </div>
      <div class="facet-wrap">
        <button
          v-for="b in BUDGET_OPTIONS"
          :key="b.value"
          type="button"
          :class="fPillClass(f.budget === b.value && !f.minPrice && !f.maxPrice, b.value === 'all')"
          data-action="set-budget"
          :data-budget="b.value"
          @click="handleBudgetPill(b.value)"
        >
          {{ b.label }}
        </button>
      </div>
      <div class="price-range-box" style="align-self: flex-start">
        <span class="range-currency">自定义 ￥</span>
        <input
          type="number"
          min="0"
          step="1"
          class="price-range-input"
          data-price-min
          :value="f.minPrice"
          placeholder="最低"
          aria-label="最低月均人民币"
          @input="store.updateFilters({ minPrice: $event.target.value, budget: 'all' })"
        />
        <span class="range-sep">-</span>
        <input
          type="number"
          min="0"
          step="1"
          class="price-range-input"
          data-price-max
          :value="f.maxPrice"
          placeholder="最高"
          aria-label="最高月均人民币"
          @input="store.updateFilters({ maxPrice: $event.target.value, budget: 'all' })"
        />
      </div>
      <div class="facet-wrap">
        <button
          v-for="o in TRAFFIC_OPTIONS"
          :key="o.value"
          type="button"
          :class="fPillClass(f.traffic === o.value, o.value === 'all')"
          data-action="set-spec"
          data-spec-key="traffic"
          :data-spec-val="o.value"
          @click="toggleValueFilter('traffic', o.value)"
        >
          {{ o.value === "all" ? "流量不限" : o.label.replace(/^♾\s*/, "") }}
        </button>
      </div>
      <div class="facet-wrap">
        <button
          v-for="o in BANDWIDTH_OPTIONS"
          :key="o.value"
          type="button"
          :class="fPillClass(f.bandwidth === o.value, o.value === 'all')"
          data-action="set-spec"
          data-spec-key="bandwidth"
          :data-spec-val="o.value"
          @click="toggleValueFilter('bandwidth', o.value)"
        >
          {{ o.value === "all" ? "带宽不限" : o.label }}
        </button>
      </div>
    </div>

    <div class="rail-section">
      <div class="rail-heading"><span>CPU · 内存 · 硬盘</span></div>
      <div class="facet-wrap">
        <button
          v-for="o in CPU_OPTIONS"
          :key="o.value"
          type="button"
          :class="fPillClass(f.cpu === o.value, o.value === 'all')"
          data-action="set-spec"
          data-spec-key="cpu"
          :data-spec-val="o.value"
          @click="toggleValueFilter('cpu', o.value)"
        >
          {{ o.value === "all" ? "CPU不限" : o.label }}
        </button>
      </div>
      <div class="facet-wrap">
        <button
          v-for="o in MEMORY_OPTIONS"
          :key="o.value"
          type="button"
          :class="fPillClass(f.memory === o.value, o.value === 'all')"
          data-action="set-spec"
          data-spec-key="memory"
          :data-spec-val="o.value"
          @click="toggleValueFilter('memory', o.value)"
        >
          {{ o.value === "all" ? "内存不限" : o.label }}
        </button>
      </div>
      <div class="facet-wrap">
        <button
          v-for="o in DISK_OPTIONS"
          :key="o.value"
          type="button"
          :class="fPillClass(f.disk === o.value, o.value === 'all')"
          data-action="set-spec"
          data-spec-key="disk"
          :data-spec-val="o.value"
          @click="toggleValueFilter('disk', o.value)"
        >
          {{ o.value === "all" ? "硬盘不限" : o.label }}
        </button>
      </div>
    </div>

    <div class="rail-section">
      <div class="rail-heading"><span>排序与现货红线</span></div>
      <select
        class="select-field"
        data-filter-select="sort"
        aria-label="排序方式"
        :value="f.sort"
        @change="store.updateFilters({ sort: $event.target.value })"
      >
        <option v-for="opt in SORT_OPTIONS" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </option>
      </select>
      <div class="check-list">
        <label class="check-row">
          <span class="check-row-left">
            <input
              type="checkbox"
              data-filter-toggle="availableOnly"
              :checked="f.status === 'available'"
              @change="
                store.updateFilters({ status: $event.target.checked ? 'available' : 'all' })
              "
            />
            <span>仅看在售现货</span>
          </span>
        </label>
        <label class="check-row">
          <span class="check-row-left">
            <input
              type="checkbox"
              data-filter-toggle="exactOnly"
              :checked="f.exactOnly"
              @change="store.updateFilters({ exactOnly: $event.target.checked })"
            />
            <span>仅看精确库存数字</span>
          </span>
        </label>
        <label class="check-row">
          <span class="check-row-left">
            <input
              type="checkbox"
              data-filter-toggle="noNat"
              :checked="f.noNat"
              @change="store.updateFilters({ noNat: $event.target.checked })"
            />
            <span>排除 NAT / 共享 IP</span>
          </span>
        </label>
        <label class="check-row">
          <span class="check-row-left">
            <input
              type="checkbox"
              data-filter-toggle="noSnapshot"
              :checked="f.noSnapshot"
              @change="store.updateFilters({ noSnapshot: $event.target.checked })"
            />
            <span>排除第三方快照</span>
          </span>
        </label>
      </div>
    </div>

    <div class="mobile-rail-footer">
      <button
        type="button"
        class="btn"
        data-action="reset-filters"
        style="flex: 0 0 auto"
        @click="store.resetFilters()"
      >
        重置
      </button>
      <button
        type="button"
        class="btn btn-primary"
        data-action="close-mobile-rail"
        style="flex: 1"
        @click="store.setMobileRailOpen(false)"
      >
        查看 {{ matchedCount }} 款匹配方案
      </button>
    </div>
  </aside>
</template>
