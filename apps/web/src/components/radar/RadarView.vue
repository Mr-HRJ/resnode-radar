<script setup>
import { computed } from "vue";
import { ElButton, ElEmpty, ElIcon, ElInput, ElSegmented, ElSkeleton, ElSwitch } from "element-plus";
import { Refresh, RefreshLeft, Search, Share } from "@element-plus/icons-vue";
import {
  DEFAULT_FILTERS,
  MACRO_REGIONS,
  describeLocation,
  describeRouteProfile,
  formatClockTime,
  formatDateTime,
  formatDayKey,
  formatEventDelta,
  formatPriceLabel,
  macroRegionsFor,
  monitorFreshness,
  normalizeSearch,
  plain,
  safeUrl
} from "@resnode-radar/contracts";
import AnnouncementsCard from "./AnnouncementsCard.vue";
import RadarSelect from "../ui/RadarSelect.vue";
import {
  renderSpecsParts,
  routeChipClass,
  shortProviderLabel
} from "../../utils/plan-presenters.js";

const props = defineProps({
  store: {
    type: Object,
    required: true
  }
});

const WINDOW_HOURS = {
  "24h": 24,
  "72h": 72,
  "7d": 168
};

const r = computed(() => props.store.state.radar);
const planById = computed(() => new Map(props.store.plans.value.map((p) => [p.id, p])));

const marketCrossSection = computed(() => {
  let availCount = 0;
  let homeAvail = 0;
  let cnOptAvail = 0;
  let exactAvail = 0;
  const regionAvailMap = new Map();

  for (const p of props.store.plans.value) {
    if (p.status !== "available") continue;
    availCount += 1;
    if (p._classify.isResidential) homeAvail += 1;
    else if (p._classify.hasCnOpt) cnOptAvail += 1;
    if (p._isExactStock) exactAvail += 1;
    for (const mr of p._macroRegions || []) {
      if (mr !== "MULTI") regionAvailMap.set(mr, (regionAvailMap.get(mr) || 0) + 1);
    }
  }

  const topRegions = MACRO_REGIONS.filter((m) => m.value !== "all" && m.value !== "MULTI")
    .map((m) => ({ ...m, count: regionAvailMap.get(m.value) || 0 }))
    .filter((m) => m.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return { availCount, homeAvail, cnOptAvail, exactAvail, topRegions };
});

const eventSummary = computed(() => {
  const cutoff24 = props.store.nowMs.value - 24 * 3600 * 1000;
  let totalAll = 0;
  let restockAll = 0;
  let restock24 = 0;
  let soldoutAll = 0;
  let soldout24 = 0;
  let priceAll = 0;
  let price24 = 0;

  for (const ev of props.store.events.value) {
    const ts = Date.parse(ev.at) || 0;
    totalAll += 1;
    if (ev.type === "restock") {
      restockAll += 1;
      if (ts >= cutoff24) restock24 += 1;
    } else if (ev.type === "soldout") {
      soldoutAll += 1;
      if (ts >= cutoff24) soldout24 += 1;
    } else if (ev.type === "price") {
      priceAll += 1;
      if (ts >= cutoff24) price24 += 1;
    }
  }
  return {
    totalAll,
    restockAll,
    restock24,
    soldoutAll,
    soldout24,
    priceAll,
    price24,
    total24: restock24 + soldout24 + price24
  };
});

const filteredEvents = computed(() => {
  const rf = r.value;
  const cutoffMs = props.store.nowMs.value - (WINDOW_HOURS[rf.window] || 168) * 3600 * 1000;
  const query = normalizeSearch(rf.q);
  const byId = planById.value;

  return props.store.events.value.filter((ev) => {
    const ts = Date.parse(ev.at) || 0;
    if (ts < cutoffMs) return false;
    if (rf.type !== "all" && ev.type !== rf.type) return false;
    const livePlan = byId.get(ev.productId);
    if (rf.savedOnly) {
      if (!livePlan || !props.store.state.savedKeys.has(livePlan._key)) return false;
    }
    if (rf.region !== "all") {
      const macros = macroRegionsFor({
        region: ev.region,
        name: ev.name,
        provider: ev.provider
      });
      if (!macros.includes(rf.region)) return false;
    }
    if (query) {
      const hay = normalizeSearch(
        [
          ev.provider,
          ev.name,
          ev.region,
          ev.price,
          ev.previousPrice,
          livePlan?.route,
          livePlan?._classify?.routeProfile?.headline,
          livePlan?.bandwidth
        ]
          .map(plain)
          .join(" ")
      );
      if (!hay.includes(query)) return false;
    }
    return true;
  });
});

const groupedDays = computed(() => {
  const groups = new Map();
  for (const ev of filteredEvents.value) {
    const day = formatDayKey(ev.at);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(ev);
  }
  return [...groups.entries()];
});

const trackingTitle = computed(() => {
  const tracking = props.store.rawPayload.value?.eventTracking;
  return tracking
    ? `保守观测口径 · 起始 ${formatDateTime(tracking.startedAt)} · 保留 ${tracking.retentionDays} 天（上限 ${tracking.limit} 条）`
    : "仅基于连续快照唯一身份比对记录真实库存与同周期同币种价格异动";
});

function handleQuickJump(mode, region = null) {
  props.store.setView("terminal");
  if (mode === "available") {
    props.store.updateFilters({ ...DEFAULT_FILTERS, status: "available" });
  } else if (mode === "home") {
    props.store.updateFilters({ ...DEFAULT_FILTERS, track: "home", status: "available" });
  } else if (mode === "cnopt") {
    props.store.updateFilters({ ...DEFAULT_FILTERS, track: "cn-opt", status: "available" });
  } else if (mode === "exact") {
    props.store.updateFilters({ ...DEFAULT_FILTERS, exactOnly: true, status: "available" });
  } else if (mode === "region" && region) {
    props.store.updateFilters({ ...DEFAULT_FILTERS, region, status: "available" });
  }
}

function getEventLoc(ev, livePlan) {
  return (
    livePlan?._location ||
    describeLocation({ region: ev.region, name: ev.name }) || {
      code: "--",
      primary: "待核验",
      sub: "",
      isPending: true,
      fullTitle: "地区待核验"
    }
  );
}

function getEventRoute(ev, livePlan) {
  if (livePlan) {
    const rp = livePlan._classify.routeProfile || {
      headline: "国际标准互联",
      headlineTone: "intl",
      chips: []
    };
    const chips = [...(rp.chips || [])];
    if (livePlan._isSnapshot && !chips.some((ch) => ch.label === "快照")) {
      chips.push({ label: "快照", tone: "warn" });
    }
    return {
      missing: false,
      title: plain(livePlan.route) || rp.headline,
      headline: rp.headline,
      headlineTone: rp.headlineTone,
      chips: chips.slice(0, 3)
    };
  }
  const nameText = plain(ev.name);
  const isRes =
    /家宽|家寬|住宅|residential|\bdual[- ]?isp\b|双\s*isp|雙\s*isp|\bat&t\b|\bverizon\b|\bfrontier\b|\bcomcast\b|\bhinet\b/i.test(
      nameText
    );
  const isDual = /\bdual[- ]?isp\b|双\s*isp|雙\s*isp/i.test(nameText);
  const isNat = /\bnat\b|共享\s*ip/i.test(nameText);
  const rp = describeRouteProfile(ev, { isResidential: isRes, isDualIsp: isDual, isNat });
  const hasExplicitRoute =
    rp.headlineTone !== "intl" || rp.chips.some((ch) => ch.label !== "国际无优化");
  if (hasExplicitRoute) {
    return {
      missing: false,
      title: nameText,
      headline: rp.headline,
      headlineTone: rp.headlineTone,
      chips: rp.chips.slice(0, 3)
    };
  }
  return { missing: true };
}

function getEventBw(ev, livePlan) {
  if (livePlan) {
    const sp = renderSpecsParts(livePlan);
    return { live: true, sp, rawTraffic: livePlan._specs.traffic };
  }
  const nameText = plain(ev.name);
  const explicitSpeed = nameText.match(/\b(\d+(?:\.\d+)?)\s*(Gbps|Mbps)\b/i);
  if (explicitSpeed) {
    return { live: false, speed: `${explicitSpeed[1]} ${explicitSpeed[2]}` };
  }
  return { live: false, speed: null };
}

function getRowMeta(ev, livePlan) {
  const delta = formatEventDelta(ev);
  const rowTone =
    ev.type === "restock"
      ? "is-restock"
      : ev.type === "soldout"
        ? "is-soldout"
        : delta?.direction === "down"
          ? "is-price-down"
          : "is-price-up";

  const typeInfo =
    ev.type === "restock"
      ? { cls: "pill pill-ok tape-event-pill", text: "↑ 补货上架" }
      : ev.type === "soldout"
        ? { cls: "pill pill-danger tape-event-pill", text: "↓ 售罄下架" }
        : delta?.direction === "down"
          ? { cls: "pill pill-ok tape-event-pill num", text: `↓ 降价 ${delta.label}` }
          : { cls: "pill pill-danger tape-event-pill num", text: `↑ 涨价 ${delta?.label || ""}` };

  const cnyEquiv =
    livePlan &&
    livePlan._pricing?.cnyTone === "ok" &&
    plain(ev.price) === plain(livePlan.price)
      ? `折合 ${livePlan._pricing.cnyLabel.replace(/^≈\s*/, "").replace(/\s*\(按[^)]+分摊\)/, "")}`
      : "";

  return {
    delta,
    rowTone,
    typeInfo,
    cnyEquiv,
    orderHref: safeUrl(ev.orderUrl || livePlan?.orderUrl),
    ageInfo: monitorFreshness(ev.at, props.store.nowMs.value),
    isCurrentlyUnavailable: !livePlan || livePlan.status === "unavailable"
  };
}

function handleTapeRowClick(event, livePlan) {
  if (!livePlan) return;
  if (event?.target?.closest?.("[data-stop-row]")) return;
  props.store.openInspector(livePlan.id);
}

const radarWindowOptions = [
  { label: "24h", value: "24h" },
  { label: "72h", value: "72h" },
  { label: "7天", value: "7d" }
];

const radarRegionOptions = MACRO_REGIONS.map((m) => {
  if (m.value === "all") return { value: "all", label: "全部地区", text: "全部地区" };
  const code = m.value === "MULTI" ? "GL" : m.value === "APAC" ? "AP" : m.value;
  return { value: m.value, code, text: m.label, label: `${code} ${m.label}` };
});
</script>

<template>
  <div v-if="store.state.loadState === 'loading'" class="skeleton-stack">
    <ElSkeleton :rows="7" animated />
  </div>

  <section v-else-if="store.state.loadState === 'error'" class="empty-state-card is-error">
    <h2 class="empty-state-title">无法加载全网大盘与异动记录</h2>
    <p class="empty-state-desc">
      上游快照接口当前不可用（{{ store.state.errorDetail?.detail || "Fetch error" }}）。
    </p>
    <div>
      <ElButton
        class="radar-el-btn"
        type="primary"
        data-action="refresh-snapshot"
        @click="store.refreshSnapshot({ force: true })"
      >
        <ElIcon style="margin-right: 4px"><Refresh /></ElIcon>
        重试读取
      </ElButton>
    </div>
  </section>

  <template v-else>
    <section class="radar-deck" aria-label="全网实时大盘指挥台">
      <div class="radar-deck-top">
        <div class="radar-deck-brand">
          <span class="radar-scanner-dial" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 28 28" fill="none">
              <circle
                cx="14"
                cy="14"
                r="10.5"
                stroke="currentColor"
                stroke-opacity="0.24"
                stroke-width="1.4"
                style="color: var(--home-fg)"
              />
              <circle
                cx="14"
                cy="14"
                r="5.5"
                stroke="currentColor"
                stroke-opacity="0.34"
                stroke-width="1.2"
                style="color: var(--home-fg)"
              />
              <g class="radar-dial-sweep">
                <path
                  d="M14 14 L14 3.5 A10.5 10.5 0 0 1 22.8 8.2 Z"
                  fill="var(--ok-dot)"
                  fill-opacity="0.28"
                />
                <line
                  x1="14"
                  y1="14"
                  x2="21.5"
                  y2="6.5"
                  stroke="var(--ok-dot)"
                  stroke-width="1.6"
                  stroke-linecap="round"
                />
              </g>
              <circle cx="14" cy="14" r="2" fill="var(--ok-dot)" />
            </svg>
          </span>
          <h1 class="radar-deck-title" :title="trackingTitle">全网实时异动大盘</h1>
        </div>

        <div class="radar-deck-metrics" aria-label="实时现货横截面快跳">
          <button
            type="button"
            class="deck-stat-chip"
            data-action="quick-stat"
            data-stat="available"
            title="点击筛选全部在售现货"
            @click="handleQuickJump('available')"
          >
            <span>在售现货</span>
            <strong class="market-mini-val num" style="color: var(--accent)">
              {{ marketCrossSection.availCount }}
            </strong>
          </button>
          <button
            type="button"
            class="deck-stat-chip"
            data-action="quick-stat"
            data-stat="home"
            title="点击仅看真家宽 / 双ISP"
            @click="handleQuickJump('home')"
          >
            <span>真家宽</span>
            <strong class="market-mini-val num" style="color: var(--home-fg)">
              {{ marketCrossSection.homeAvail }}
            </strong>
          </button>
          <button
            type="button"
            class="deck-stat-chip"
            data-action="market-jump-cnopt"
            title="点击筛选回国优化线路"
            @click="handleQuickJump('cnopt')"
          >
            <span>CN优化</span>
            <strong class="market-mini-val num" style="color: var(--purple-fg)">
              {{ marketCrossSection.cnOptAvail }}
            </strong>
          </button>
          <button
            type="button"
            class="deck-stat-chip"
            data-action="quick-stat"
            data-stat="exact"
            title="点击仅看精确库存"
            @click="handleQuickJump('exact')"
          >
            <span>精确库存</span>
            <strong class="market-mini-val num" style="color: var(--ok-fg)">
              {{ marketCrossSection.exactAvail }}
            </strong>
          </button>
          <span class="deck-vsep" aria-hidden="true"></span>
          <div class="deck-region-pills" aria-label="热门地区现货快跳">
            <button
              v-for="reg in marketCrossSection.topRegions"
              :key="reg.value"
              type="button"
              class="deck-reg-pill"
              data-action="market-jump-region"
              :data-region="reg.value"
              :title="`前往选机查看 ${reg.label} ${reg.count} 款现货`"
              @click="handleQuickJump('region', reg.value)"
            >
              <span>{{ reg.value === "APAC" ? "AP" : reg.value }}</span>
              <strong class="num">{{ reg.count }}</strong>
            </button>
          </div>
        </div>

        <div class="radar-deck-actions">
          <div
            v-if="eventSummary.totalAll > 0"
            class="velocity-strip is-inline"
            :title="`近 7 天真实观测构成：补货 ${eventSummary.restockAll} · 变价 ${eventSummary.priceAll} · 售罄 ${eventSummary.soldoutAll}`"
          >
            <div class="velocity-bar" aria-hidden="true">
              <span
                v-if="eventSummary.restockAll"
                class="velocity-seg is-restock"
                :style="{
                  width: `${((eventSummary.restockAll / eventSummary.totalAll) * 100).toFixed(1)}%`
                }"
              ></span>
              <span
                v-if="eventSummary.priceAll"
                class="velocity-seg is-price"
                :style="{
                  width: `${((eventSummary.priceAll / eventSummary.totalAll) * 100).toFixed(1)}%`
                }"
              ></span>
              <span
                v-if="eventSummary.soldoutAll"
                class="velocity-seg is-soldout"
                :style="{
                  width: `${((eventSummary.soldoutAll / eventSummary.totalAll) * 100).toFixed(1)}%`
                }"
              ></span>
            </div>
          </div>
          <ElButton
            class="radar-el-btn"
            size="small"
            type="primary"
            plain
            data-nav-view="terminal"
            @click="store.setView('terminal')"
          >
            ← 选机
          </ElButton>
          <ElButton
            class="radar-el-btn"
            size="small"
            data-action="copy-share-url"
            @click="store.copyShareUrl()"
          >
            <ElIcon style="margin-right: 4px"><Share /></ElIcon>
            分享
          </ElButton>
        </div>
      </div>

      <div class="radar-deck-bar">
        <div class="radar-type-tabs" role="group" aria-label="按异动类型快捷筛选">
          <button
            type="button"
            class="radar-type-btn"
            :class="{ 'is-active': r.type === 'all' }"
            data-action="set-radar-type"
            data-radar-type="all"
            @click="store.patchRadar({ type: 'all' })"
          >
            <span>全部异动</span>
            <strong class="kpi-val num">{{ eventSummary.totalAll }}</strong>
            <span
              v-if="eventSummary.total24 > 0"
              class="type-24h num"
              title="近 24h 新增"
            >
              +{{ eventSummary.total24 }}
            </span>
          </button>
          <button
            type="button"
            class="radar-type-btn is-ok"
            :class="{ 'is-active': r.type === 'restock' }"
            data-action="set-radar-type"
            data-radar-type="restock"
            @click="store.patchRadar({ type: 'restock' })"
          >
            <span>↑ 补货上架</span>
            <strong class="kpi-val num">{{ eventSummary.restockAll }}</strong>
          </button>
          <button
            type="button"
            class="radar-type-btn is-danger"
            :class="{ 'is-active': r.type === 'soldout' }"
            data-action="set-radar-type"
            data-radar-type="soldout"
            @click="store.patchRadar({ type: 'soldout' })"
          >
            <span>↓ 售罄下架</span>
            <strong class="kpi-val num">{{ eventSummary.soldoutAll }}</strong>
          </button>
          <button
            type="button"
            class="radar-type-btn is-price"
            :class="{ 'is-active': r.type === 'price' }"
            data-action="set-radar-type"
            data-radar-type="price"
            @click="store.patchRadar({ type: 'price' })"
          >
            <span>⇄ 同周期变价</span>
            <strong class="kpi-val num">{{ eventSummary.priceAll }}</strong>
          </button>
        </div>

        <div class="radar-filter-cluster">
          <div class="input-wrap radar-compact-search">
            <ElInput
              class="radar-el-input"
              type="search"
              size="small"
              clearable
              data-radar-search
              :model-value="r.q"
              placeholder="搜商家 / 套餐 / 地区 / 线路…"
              aria-label="搜索异动事件"
              @update:model-value="store.patchRadar({ q: $event })"
            >
              <template #prefix>
                <ElIcon><Search /></ElIcon>
              </template>
            </ElInput>
          </div>

          <ElSegmented
            class="radar-segmented radar-window-toggle"
            size="small"
            aria-label="时间窗口"
            :model-value="r.window"
            :options="radarWindowOptions"
            @change="store.patchRadar({ window: $event })"
          >
            <template #default="{ item }">
              <span data-action="set-radar-window" :data-window="item.value">{{ item.label }}</span>
            </template>
          </ElSegmented>

          <RadarSelect
            variant="mini"
            data-radar-select="region"
            aria-label="按地区筛选异动"
            filterable
            :filtered="r.region !== 'all'"
            :model-value="r.region"
            :options="radarRegionOptions"
            @change="store.patchRadar({ region: $event })"
          />

          <label class="radar-inline-switch">
            <ElSwitch
              size="small"
              data-radar-toggle="savedOnly"
              :model-value="r.savedOnly"
              @change="store.patchRadar({ savedOnly: Boolean($event) })"
            />
            <span>★ 收藏</span>
          </label>

          <ElButton
            v-if="
              r.type !== 'all' ||
              r.window !== '7d' ||
              r.region !== 'all' ||
              r.savedOnly ||
              r.q
            "
            class="radar-el-btn"
            size="small"
            text
            data-action="reset-radar"
            @click="store.resetRadar()"
          >
            <ElIcon style="margin-right: 3px"><RefreshLeft /></ElIcon>
            重置
          </ElButton>

          <span class="radar-hit-count num">
            命中 <strong>{{ filteredEvents.length }}</strong>
          </span>
        </div>
      </div>
    </section>

    <AnnouncementsCard :feed="store.rawPayload.value?.announcements" />

    <section v-if="filteredEvents.length === 0" class="empty-state-card">
      <ElEmpty
        description="当前筛选条件下暂无异动事件，可以切回「7天」窗口或重置筛选查看全部已观测记录。"
        :image-size="76"
      >
        <ElButton
          class="radar-el-btn"
          type="primary"
          data-action="reset-radar"
          @click="store.resetRadar()"
        >
          显示全部 7 天异动
        </ElButton>
      </ElEmpty>
    </section>

    <section v-for="[day, items] in groupedDays" :key="day" class="tape-day-group">
      <div class="tape-day-heading">
        <span>{{ day }}</span>
        <span class="pill num">{{ items.length }} 条记录</span>
      </div>
      <div class="tape-list">
        <table class="radar-tape-table" :aria-label="`${day} 异动记录表`">
          <thead>
            <tr>
              <th scope="col" class="col-tape-time">观测时间</th>
              <th scope="col" class="col-tape-event">异动类型</th>
              <th scope="col" class="col-tape-plan">商家与套餐型号</th>
              <th scope="col" class="col-tape-loc">机房位置</th>
              <th scope="col" class="col-tape-net">回程线路 · 三网明细</th>
              <th scope="col" class="col-tape-bw">带宽 / 流量</th>
              <th scope="col" class="col-tape-price">异动价格</th>
              <th scope="col" class="col-tape-status">当前状态</th>
              <th scope="col" class="col-tape-act">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(ev, idx) in items"
              :key="ev.id || `${ev.productId}-${ev.at}-${idx}`"
              class="tape-row"
              :class="[
                getRowMeta(ev, planById.get(ev.productId)).rowTone,
                planById.get(ev.productId) ? 'is-clickable' : 'is-offline',
                {
                  'is-currently-unavailable': getRowMeta(ev, planById.get(ev.productId))
                    .isCurrentlyUnavailable
                }
              ]"
              :style="{ '--stagger-i': Math.min(idx, 14) }"
              :data-action="planById.get(ev.productId) ? 'inspect-plan' : undefined"
              :data-product-id="
                planById.get(ev.productId) ? planById.get(ev.productId).id : undefined
              "
              @click="handleTapeRowClick($event, planById.get(ev.productId))"
            >
              <!-- Time -->
              <td class="col-tape-time">
                <div class="tape-time-stack">
                  <time
                    class="tape-time num"
                    :datetime="ev.at"
                    :title="formatDateTime(ev.at)"
                  >
                    {{ formatClockTime(ev.at) }}
                  </time>
                  <span class="tape-age">
                    {{ getRowMeta(ev, planById.get(ev.productId)).ageInfo.label }}
                  </span>
                </div>
              </td>

              <!-- Event type -->
              <td class="col-tape-event">
                <span :class="getRowMeta(ev, planById.get(ev.productId)).typeInfo.cls">
                  {{ getRowMeta(ev, planById.get(ev.productId)).typeInfo.text }}
                </span>
              </td>

              <!-- Plan -->
              <td class="col-tape-plan">
                <div class="tape-plan-stack">
                  <div class="plan-vendor-row">
                    <strong class="provider-brand" :title="plain(ev.provider)">
                      {{
                        shortProviderLabel(
                          planById.get(ev.productId)?._providerName || ev.provider
                        )
                      }}
                    </strong>
                    <span
                      v-if="planById.get(ev.productId)?._classify?.isResidential"
                      class="net-micro-tag is-home"
                    >
                      真家宽
                    </span>
                    <span
                      v-else-if="planById.get(ev.productId)?._classify?.isNativeIp"
                      class="net-micro-tag is-native"
                    >
                      原生IP
                    </span>
                  </div>
                  <div class="tape-plan-title" :title="plain(ev.name)">
                    {{ plain(ev.name) }}
                  </div>
                </div>
              </td>

              <!-- Location -->
              <td class="col-tape-loc">
                <div
                  v-if="getEventLoc(ev, planById.get(ev.productId)).isPending"
                  class="loc-cell is-pending"
                  :title="getEventLoc(ev, planById.get(ev.productId)).fullTitle"
                >
                  <div class="loc-primary-row">
                    <span class="iso-code">--</span>
                    <span class="loc-city">待核验</span>
                  </div>
                </div>
                <div
                  v-else
                  class="loc-cell"
                  :title="getEventLoc(ev, planById.get(ev.productId)).fullTitle"
                >
                  <div class="loc-primary-row">
                    <span class="iso-code">
                      {{ getEventLoc(ev, planById.get(ev.productId)).code }}
                    </span>
                    <strong class="loc-city">
                      {{ getEventLoc(ev, planById.get(ev.productId)).primary }}
                    </strong>
                  </div>
                  <span
                    v-if="getEventLoc(ev, planById.get(ev.productId)).sub"
                    class="loc-sub"
                  >
                    {{ getEventLoc(ev, planById.get(ev.productId)).sub }}
                  </span>
                </div>
              </td>

              <!-- Route -->
              <td class="col-tape-net">
                <div
                  v-if="getEventRoute(ev, planById.get(ev.productId)).missing"
                  class="route-cell-stack"
                >
                  <span
                    class="spec-line is-missing"
                    title="原套餐快照已下线，历史事件未单独留档回程明细"
                  >
                    下线未留档
                  </span>
                </div>
                <div
                  v-else
                  class="route-cell-stack"
                  :title="getEventRoute(ev, planById.get(ev.productId)).title"
                >
                  <div class="route-headline-row">
                    <span
                      class="route-headline"
                      :class="`is-${getEventRoute(ev, planById.get(ev.productId)).headlineTone}`"
                    >
                      {{ getEventRoute(ev, planById.get(ev.productId)).headline }}
                    </span>
                  </div>
                  <div class="route-chips-row">
                    <span
                      v-for="ch in getEventRoute(ev, planById.get(ev.productId)).chips"
                      :key="ch.label"
                      :class="routeChipClass(ch.tone)"
                    >
                      {{ ch.label }}
                    </span>
                  </div>
                </div>
              </td>

              <!-- Bandwidth -->
              <td class="col-tape-bw">
                <div
                  v-if="getEventBw(ev, planById.get(ev.productId)).live"
                  class="bw-stack"
                >
                  <span
                    v-if="getEventBw(ev, planById.get(ev.productId)).sp.bw"
                    class="bw-highlight num"
                    :title="getEventBw(ev, planById.get(ev.productId)).sp.compactNet"
                  >
                    {{ getEventBw(ev, planById.get(ev.productId)).sp.bw }}
                  </span>
                  <span
                    v-else-if="getEventBw(ev, planById.get(ev.productId)).sp.fallbackNet"
                    class="spec-line"
                    :title="getEventBw(ev, planById.get(ev.productId)).sp.fallbackNet"
                  >
                    {{ getEventBw(ev, planById.get(ev.productId)).sp.fallbackNet }}
                  </span>
                  <span v-else class="spec-line is-missing">未标明</span>

                  <span
                    v-if="getEventBw(ev, planById.get(ev.productId)).sp.isUnlimited"
                    class="traffic-unlimited"
                  >
                    不限流量
                  </span>
                  <span
                    v-else-if="getEventBw(ev, planById.get(ev.productId)).sp.traffic"
                    class="spec-line is-sub num"
                    :title="getEventBw(ev, planById.get(ev.productId)).rawTraffic"
                  >
                    {{ getEventBw(ev, planById.get(ev.productId)).sp.traffic }}
                  </span>
                </div>
                <div
                  v-else-if="getEventBw(ev, planById.get(ev.productId)).speed"
                  class="bw-stack"
                >
                  <span class="bw-highlight num">
                    {{ getEventBw(ev, planById.get(ev.productId)).speed }}
                  </span>
                </div>
                <div v-else class="bw-stack">
                  <span
                    class="spec-line is-missing"
                    title="原套餐快照已下线，历史事件未单独留档带宽与流量"
                  >
                    下线未留档
                  </span>
                </div>
              </td>

              <!-- Price -->
              <td class="col-tape-price">
                <div class="tape-price-stack num">
                  <strong class="tape-price-curr" :title="plain(ev.price)">
                    {{ formatPriceLabel(ev) }}
                  </strong>
                  <span v-if="ev.type === 'price' && ev.previousPrice" class="tape-price-prev">
                    原
                    <span class="price-old num" :title="plain(ev.previousPrice)">
                      {{
                        formatPriceLabel({
                          ...ev,
                          price: ev.previousPrice,
                          priceValue: ev.previousPriceValue
                        })
                      }}
                    </span>
                  </span>
                  <span
                    v-else-if="ev.type === 'restock' && Number.isInteger(ev.stockCount)"
                    class="tape-stock-note num"
                  >
                    观测余 {{ ev.stockCount }}
                  </span>
                  <span
                    v-else-if="getRowMeta(ev, planById.get(ev.productId)).cnyEquiv"
                    class="price-sub num"
                  >
                    {{ getRowMeta(ev, planById.get(ev.productId)).cnyEquiv }}
                  </span>
                </div>
              </td>

              <!-- Current Status -->
              <td class="col-tape-status">
                <template v-if="planById.get(ev.productId)">
                  <span
                    v-if="planById.get(ev.productId).status === 'available'"
                    class="pill pill-ok tape-status-pill num"
                  >
                    <span
                      class="radar-ping-dot"
                      style="width: 6px; height: 6px"
                      aria-hidden="true"
                    ></span>
                    仍可购{{
                      planById.get(ev.productId)._isExactStock
                        ? ` · 余${planById.get(ev.productId).stockCount}`
                        : ""
                    }}
                  </span>
                  <span
                    v-else-if="planById.get(ev.productId).status === 'unavailable'"
                    class="pill pill-neutral tape-status-pill"
                  >
                    已售罄
                  </span>
                  <span v-else class="pill pill-neutral tape-status-pill">状态未公开</span>
                </template>
                <span
                  v-else
                  class="pill pill-neutral pill-outline tape-status-pill"
                  title="该套餐已从商家公开目录移除，此处保留历史异动快照"
                >
                  快照已下线
                </span>
              </td>

              <!-- Actions -->
              <td class="col-tape-act">
                <div class="row-actions" data-stop-row @click.stop>
                  <ElButton
                    v-if="planById.get(ev.productId)"
                    size="small"
                    type="primary"
                    plain
                    class="radar-el-btn"
                    data-action="inspect-plan"
                    :data-product-id="planById.get(ev.productId).id"
                    @click.stop="store.openInspector(planById.get(ev.productId).id)"
                  >
                    证据
                  </ElButton>
                  <a
                    v-if="getRowMeta(ev, planById.get(ev.productId)).orderHref"
                    class="btn-buy-cta"
                    style="height: 26px; padding: 0 9px; font-size: 11px"
                    :href="getRowMeta(ev, planById.get(ev.productId)).orderHref"
                    target="_blank"
                    rel="nofollow noopener noreferrer"
                    @click.stop
                  >
                    直达 ↗
                  </a>
                  <span v-else class="spec-line is-missing">—</span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </template>
</template>
