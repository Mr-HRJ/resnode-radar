<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  DEFAULT_FILTERS,
  MAX_COMPARE,
  formatClockTime,
  formatDateTime,
  formatEventDelta,
  formatPriceLabel,
  fxFreshness,
  monitorFreshness,
  plain,
  providers
} from "@resnode-radar/contracts";
import { REFRESH_INTERVAL_MS } from "../../services/snapshot-client.js";
import { computeSyncProgressRatio, formatLiveClockText } from "../../utils/plan-presenters.js";

const props = defineProps({
  store: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(["open-palette", "open-saved", "open-compare"]);

const clockNow = ref(Date.now());
const capsuleStep = ref(0);
const capsuleHovered = ref(false);
const visitPopActive = ref(false);
let tickerId = null;
let lastVisitPv = null;

function isReducedMotion() {
  return Boolean(globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

watch(
  () => props.store.state.visitStats?.todayPv,
  (nextPv) => {
    const pv = Number(nextPv);
    if (!Number.isFinite(pv) || pv <= 1000) {
      lastVisitPv = Number.isFinite(pv) ? pv : null;
      visitPopActive.value = false;
      return;
    }
    if (lastVisitPv !== pv && !isReducedMotion()) {
      visitPopActive.value = true;
    } else if (isReducedMotion()) {
      visitPopActive.value = false;
    }
    lastVisitPv = pv;
  }
);

const headlineStats = computed(() => {
  const s = props.store.state;
  const payload = props.store.rawPayload.value;
  if (s.loadState !== "ready" || !payload) {
    return {
      available: "-",
      exact: "-",
      home: "-",
      blocked: "-",
      events24h: 0,
      hotEvents: []
    };
  }
  let available = 0;
  let exact = 0;
  let home = 0;
  for (const p of props.store.plans.value) {
    if (p.status === "available") {
      available += 1;
      if (p._isExactStock) exact += 1;
      if (p._classify.isResidential) home += 1;
    }
  }
  const blocked = props.store.diagnostics.value.filter(
    (d) => d.status === "blocked" || d.status === "error"
  ).length;

  const cutoff24h = props.store.nowMs.value - 24 * 3600 * 1000;
  const allEvs = props.store.events.value;
  const recent24 = allEvs.filter((e) => {
    const t = Date.parse(e.at);
    return Number.isFinite(t) && t >= cutoff24h;
  });

  const hotPool = recent24.length ? recent24 : allEvs;
  const prioritized = [...hotPool].sort((a, b) => {
    const score = (e) => {
      if (e.type === "restock") return 0;
      if (e.type === "price" && formatEventDelta(e)?.direction === "down") return 1;
      if (e.type === "price") return 2;
      return 3;
    };
    return score(a) - score(b) || (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0);
  });

  return {
    available,
    exact,
    home,
    blocked,
    events24h: recent24.length,
    hotEvents: prioritized.slice(0, 6)
  };
});

watch(
  () => headlineStats.value.hotEvents.length,
  () => {
    capsuleStep.value = 0;
  }
);

const freshness = computed(() => {
  const payload = props.store.rawPayload.value;
  return payload ? monitorFreshness(payload.generatedAt, props.store.nowMs.value) : null;
});

const fx = computed(() => {
  const payload = props.store.rawPayload.value;
  return payload ? fxFreshness(payload.exchangeRates, props.store.nowMs.value) : null;
});

const telemetryUi = computed(() => {
  const s = props.store.state;
  const fr = freshness.value;
  if (s.loadState === "loading") {
    return { dotClass: "status-dot", pillClass: "tele-pill", label: "同步快照中…", liveFresh: false };
  }
  if (s.loadState === "error") {
    return {
      dotClass: "radar-ping-dot is-danger",
      pillClass: "tele-pill is-danger",
      label: "上游数据源不可用",
      liveFresh: false
    };
  }
  if (fr?.stale) {
    return {
      dotClass: "radar-ping-dot is-warn",
      pillClass: "tele-pill is-warn",
      label: `快照偏旧 · ${fr.label}`,
      liveFresh: false
    };
  }
  if (fr) {
    return {
      dotClass: "radar-ping-dot",
      pillClass: "tele-pill",
      label: `实时快照 · ${fr.label}`,
      liveFresh: true
    };
  }
  return { dotClass: "status-dot", pillClass: "tele-pill", label: "同步快照中…", liveFresh: false };
});

const telemetryTitle = computed(() => {
  const payload = props.store.rawPayload.value;
  if (!payload?.generatedAt) return "点击重新读取已发布的最新快照";
  const fxPart = fx.value?.valid ? ` · 折算基准: ${fx.value.label}` : "";
  return `快照生成时间: ${formatDateTime(payload.generatedAt)}${fxPart} · 点击立即同步（每 5 分钟自动刷新）`;
});

const navItems = computed(() => {
  const st = headlineStats.value;
  const evLen = props.store.events.value.length;
  return [
    {
      id: "terminal",
      label: "现货选机",
      count: st.available !== "-" ? String(st.available) : "",
      countClass: ""
    },
    {
      id: "radar",
      label: "全网大盘",
      count: st.events24h > 0 ? `+${st.events24h}` : evLen ? String(evLen) : "",
      countClass: st.events24h > 0 ? "is-pulse" : ""
    },
    {
      id: "providers",
      label: "商家名录",
      count: String(providers.length),
      countClass: ""
    },
    {
      id: "guide",
      label: "避坑口径",
      count: "",
      countClass: ""
    }
  ];
});

const activeQuery = computed(() => plain(props.store.state.filters.q));
const compareCount = computed(() => props.store.state.compareKeys.length);
const themeLabel = computed(() => (props.store.state.theme === "dark" ? "☀ 亮色" : "☾ 暗色"));
const isSyncBusy = computed(
  () => props.store.state.refreshing || props.store.state.loadState === "loading"
);
const syncRatio = computed(() =>
  computeSyncProgressRatio(
    props.store.state.lastFetchAt,
    props.store.state.loadState,
    REFRESH_INTERVAL_MS,
    clockNow.value
  ).toFixed(3)
);

const liveClockStr = computed(() => formatLiveClockText(new Date(clockNow.value)));

const showVisitBadge = computed(() => {
  const vs = props.store.state.visitStats;
  return Boolean(vs && vs.todayPv > 1000);
});

function handleGoHome(event) {
  event?.preventDefault?.();
  props.store.setView("terminal");
  props.store.resetFilters();
}

function handleQuickStat(stat) {
  if (stat === "blocked") {
    props.store.setView("providers");
    props.store.patchProviders({ health: "issue" });
  } else if (stat === "home") {
    props.store.setView("terminal");
    props.store.updateFilters({ ...DEFAULT_FILTERS, track: "home", status: "available" });
  } else if (stat === "exact") {
    props.store.setView("terminal");
    props.store.updateFilters({ ...DEFAULT_FILTERS, exactOnly: true, status: "available" });
  } else {
    props.store.setView("terminal");
    props.store.updateFilters({ ...DEFAULT_FILTERS, status: "available" });
  }
}

function handleRefreshClick() {
  void props.store.refreshSnapshot({ force: true }).finally(() => {
    void props.store.refreshVisitStats(true);
  });
}

function eventBadgeInfo(ev) {
  const delta = formatEventDelta(ev);
  if (ev.type === "restock") return { cls: "tag-badge is-restock", text: "补货" };
  if (ev.type === "soldout") return { cls: "tag-badge is-soldout", text: "售罄" };
  if (delta?.direction === "down") return { cls: "tag-badge is-restock num", text: delta.label };
  return { cls: "tag-badge is-hot num", text: delta?.label || "变价" };
}

onMounted(() => {
  let tick = 0;
  tickerId = setInterval(() => {
    if (globalThis.document?.visibilityState === "hidden") return;
    clockNow.value = Date.now();
    tick += 1;
    if (tick % 3 === 0 && !capsuleHovered.value && headlineStats.value.hotEvents.length > 1) {
      capsuleStep.value = (capsuleStep.value + 1) % headlineStats.value.hotEvents.length;
    }
    if (tick % 15 === 0) {
      props.store.tickClock(Date.now());
    }
  }, 1000);
});

onBeforeUnmount(() => {
  if (tickerId) clearInterval(tickerId);
});
</script>

<template>
  <header class="cmd-header app-header" data-app-header>
    <div class="cmd-bar">
      <div class="cmd-bar-left">
        <a class="brand-link" href="./" data-action="go-home" @click="handleGoHome">
          <img class="brand-logo" :src="'./favicon.svg'" alt="" width="26" height="26" />
          <span class="brand-name">
            <span class="brand-cn">VPS雷达</span>
            <span class="brand-domain">
              <span
                class="radar-ping-dot"
                style="width: 5.5px; height: 5.5px"
                aria-hidden="true"
              ></span>
              <span>vpsld</span>
            </span>
          </span>
        </a>
        <span class="header-vsep" aria-hidden="true"></span>
        <nav class="ws-nav" aria-label="主工作区导航">
          <button
            v-for="item in navItems"
            :key="item.id"
            type="button"
            class="ws-tab"
            :class="{ 'is-active': store.state.view === item.id }"
            :data-nav-view="item.id"
            :aria-current="store.state.view === item.id ? 'page' : 'false'"
            @click="store.setView(item.id)"
          >
            <span>{{ item.label }}</span>
            <span v-if="item.count" class="ws-tab-count num" :class="item.countClass">
              {{ item.count }}
            </span>
          </button>
        </nav>
      </div>

      <div class="cmd-utils">
        <button
          type="button"
          class="cmd-search-trigger"
          :class="{ 'has-query': Boolean(activeQuery) }"
          data-action="open-palette"
          aria-label="搜索商家、地区、线路或型号 (快捷键 / 或 ⌘K)"
          @click="emit('open-palette')"
        >
          <span aria-hidden="true" style="font-size: 13px">⌕</span>
          <span class="search-label">
            {{ activeQuery ? `搜索词：${activeQuery}` : "搜商家 / 地区 / 线路 / 型号…" }}
          </span>
          <kbd class="kbd-hint">⌘K</kbd>
        </button>

        <button
          v-if="activeQuery"
          type="button"
          class="btn btn-xs btn-soft"
          data-action="clear-search"
          title="清除当前关键词过滤"
          @click="store.updateFilters({ q: '' })"
        >
          ✕ 清词
        </button>

        <button
          type="button"
          class="btn btn-sm"
          :class="{ 'btn-star is-active': store.state.savedKeys.size > 0 }"
          data-action="open-saved"
          aria-label="打开本地收藏夹"
          @click="emit('open-saved')"
        >
          <span>★</span>
          <span class="num" data-saved-count>{{ store.state.savedKeys.size }}</span>
        </button>

        <button
          v-if="compareCount > 0"
          type="button"
          class="btn btn-sm btn-soft header-compare-btn"
          data-action="open-compare"
          aria-label="打开多方案对比"
          @click="emit('open-compare')"
        >
          <span>⇄ 对比</span>
          <span class="num" data-header-compare-count>{{ compareCount }}/{{ MAX_COMPARE }}</span>
        </button>

        <button
          type="button"
          class="btn btn-sm btn-ghost"
          data-action="toggle-theme"
          aria-label="切换明暗主题"
          @click="store.toggleTheme()"
        >
          {{ themeLabel }}
        </button>
      </div>
    </div>

    <div class="telemetry-strip" aria-label="实时数据遥测与全网大盘">
      <div class="telemetry-inner">
        <div class="telemetry-left">
          <button
            type="button"
            class="tele-pill-btn"
            :class="telemetryUi.pillClass"
            data-action="refresh-snapshot"
            :disabled="store.state.refreshing"
            :title="telemetryTitle"
            @click="handleRefreshClick"
          >
            <span :class="telemetryUi.dotClass" aria-hidden="true"></span>
            <span data-telemetry-label :class="{ 'live-shimmer': telemetryUi.liveFresh }">
              {{ store.state.refreshing ? "同步快照中…" : telemetryUi.label }}
            </span>
          </button>

          <span class="live-clock-pill" title="本地实时时间与日期">
            <span class="num" data-live-clock>{{ liveClockStr }}</span>
          </span>

          <span
            v-if="showVisitBadge"
            class="tele-stat tele-stat-visits"
            data-visit-stat
            :aria-label="`今日访问 ${store.state.visitStats.todayPv} 次`"
          >
            <span class="visit-label">今日访问:</span>
            <span class="visit-num-stage">
              <strong
                class="num"
                :class="{ 'is-visit-num-pop': visitPopActive }"
                data-stat-visits
              >{{ store.state.visitStats.todayPv }}</strong>
            </span>
            <span class="visit-unit">次</span>
          </span>
        </div>

        <div class="telemetry-center">
          <div
            class="market-spotlight"
            data-live-capsule
            :data-capsule-count="headlineStats.hotEvents.length"
            @mouseenter="capsuleHovered = true"
            @mouseleave="capsuleHovered = false"
          >
            <button
              type="button"
              class="spotlight-badge"
              data-nav-view="radar"
              title="查看全网实时库存大盘与补货降价流"
              @click="store.setView('radar')"
            >
              <span class="spotlight-dot" aria-hidden="true"></span>
              <span>全网大盘</span>
            </button>

            <div v-if="headlineStats.hotEvents.length" class="live-capsule-viewport">
              <div
                class="live-capsule-track"
                data-capsule-track
                :style="{ transform: `translateY(-${capsuleStep * 24}px)` }"
              >
                <button
                  v-for="ev in headlineStats.hotEvents"
                  :key="ev.id || `${ev.productId}-${ev.at}`"
                  type="button"
                  class="live-capsule-item"
                  data-action="inspect-event"
                  :data-product-id="ev.productId || ''"
                  :title="`${ev.provider} ${ev.name} ${ev.price || ''}`"
                  @click="ev.productId ? store.openInspector(ev.productId) : store.setView('radar')"
                >
                  <span class="mono ev-time" style="color: var(--ink-muted); font-size: 10.5px">
                    {{ formatClockTime(ev.at) }}
                  </span>
                  <span :class="eventBadgeInfo(ev).cls">{{ eventBadgeInfo(ev).text }}</span>
                  <strong class="ev-name">
                    {{ plain(ev.provider) }} · {{ plain(ev.name)
                    }}{{
                      ev.type === "restock" && Number.isInteger(ev.stockCount)
                        ? ` (余${ev.stockCount})`
                        : ""
                    }}
                  </strong>
                  <span class="mono ev-price" style="color: var(--price-main); font-weight: 700">
                    {{ formatPriceLabel(ev) }}
                  </span>
                </button>
              </div>
            </div>

            <button
              v-else
              type="button"
              class="spotlight-fallback"
              data-nav-view="radar"
              @click="store.setView('radar')"
            >
              实时监控全网 {{ providers.length }} 家官方源库存与价格异动
            </button>

            <button
              type="button"
              class="spotlight-cta"
              data-nav-view="radar"
              @click="store.setView('radar')"
            >
              <span>异动榜</span>
              <strong class="num">
                {{
                  headlineStats.events24h > 0
                    ? `+${headlineStats.events24h}`
                    : store.events.value.length
                }}
              </strong>
              <span aria-hidden="true">→</span>
            </button>
          </div>
        </div>

        <div class="telemetry-right">
          <button
            type="button"
            class="tele-stat is-ok"
            data-action="quick-stat"
            data-stat="available"
            title="查看所有在售可购套餐"
            @click="handleQuickStat('available')"
          >
            <span>现货</span><strong data-stat-available>{{ headlineStats.available }}</strong>
          </button>
          <button
            type="button"
            class="tele-stat is-home"
            data-action="quick-stat"
            data-stat="home"
            title="仅看真家宽 / 双 ISP 住宅节点"
            @click="handleQuickStat('home')"
          >
            <span>真家宽</span><strong data-stat-home>{{ headlineStats.home }}</strong>
          </button>
          <button
            type="button"
            class="tele-stat"
            data-action="quick-stat"
            data-stat="exact"
            title="仅看公布精确库存数量的套餐"
            @click="handleQuickStat('exact')"
          >
            <span>精确库存</span><strong data-stat-exact>{{ headlineStats.exact }}</strong>
          </button>
          <button
            type="button"
            class="tele-stat is-danger"
            data-action="quick-stat"
            data-stat="blocked"
            title="前往商家名录查看直连受阻源"
            @click="handleQuickStat('blocked')"
          >
            <span>受阻源</span><strong data-stat-blocked>{{ headlineStats.blocked }}</strong>
          </button>
        </div>
      </div>

      <div class="header-sync-bar" aria-hidden="true">
        <span
          class="header-sync-fill"
          :class="{ 'is-syncing': isSyncBusy }"
          data-sync-progress
          :style="{ '--sync-progress': syncRatio }"
        ></span>
      </div>
    </div>
  </header>
</template>
