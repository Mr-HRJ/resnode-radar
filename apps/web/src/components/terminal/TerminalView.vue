<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElButton, ElEmpty, ElIcon, ElSkeleton, ElSkeletonItem } from "element-plus";
import { Refresh } from "@element-plus/icons-vue";
import {
  computeFacetCounts,
  diagnoseZeroResults,
  listActiveFilterBadges,
  resolveProvider,
  safeUrl
} from "@resnode-radar/contracts";
import LiveTickerRibbon from "./LiveTickerRibbon.vue";
import FilterDock from "./FilterDock.vue";
import VirtualPlanTable from "./VirtualPlanTable.vue";

const props = defineProps({
  store: {
    type: Object,
    required: true
  }
});

const canvasRef = ref(null);
const viewportWidth = ref(globalThis.window?.innerWidth || 1280);
const isCanvasRefreshing = ref(false);
let resizeTimer = null;

function onWindowResize() {
  viewportWidth.value = globalThis.window?.innerWidth || 1280;
}

onMounted(() => {
  viewportWidth.value = globalThis.window?.innerWidth || 1280;
  globalThis.window?.addEventListener?.("resize", onWindowResize, { passive: true });
});

onBeforeUnmount(() => {
  globalThis.window?.removeEventListener?.("resize", onWindowResize);
  if (resizeTimer) clearTimeout(resizeTimer);
});

const matchedPlans = computed(() => props.store.filteredTerminalPlans.value);

const facets = computed(() =>
  computeFacetCounts(
    props.store.plans.value,
    props.store.state.filters,
    props.store.state.savedKeys
  )
);

const activeFilterCount = computed(
  () => listActiveFilterBadges(props.store.state.filters).length
);

const isTableMode = computed(() => {
  const winW = viewportWidth.value;
  return props.store.state.layout !== "grid" && winW > 860;
});

const pendingProviderEmpty = computed(() => {
  if (matchedPlans.value.length > 0) return null;
  const prov = resolveProvider({ providerId: props.store.state.filters.provider });
  if (!prov) return null;
  if (props.store.plans.value.some((p) => p._providerId === prov.id)) return null;
  const blocked = props.store.diagnostics.value.some(
    (p) => p._providerId === prov.id && p.status === "blocked"
  );
  return {
    provider: prov,
    blocked,
    websiteHref: safeUrl(prov.website)
  };
});

const zeroDiag = computed(() => {
  if (matchedPlans.value.length > 0 || pendingProviderEmpty.value) return null;
  return diagnoseZeroResults(
    props.store.plans.value,
    props.store.state.filters,
    props.store.state.savedKeys
  );
});

function terminalViewportTop() {
  const headerEl = globalThis.document?.querySelector?.("[data-app-header]");
  return Math.max(0, headerEl?.getBoundingClientRect?.().bottom || 0) + 8;
}

watch(
  () => [props.store.state.layout, JSON.stringify(props.store.state.filters)],
  async () => {
    if (props.store.state.loadState !== "ready") return;
    isCanvasRefreshing.value = true;
    const beforeTop = canvasRef.value?.getBoundingClientRect?.().top;
    const viewportTop = terminalViewportTop();
    await nextTick();
    if (Number.isFinite(beforeTop) && beforeTop < viewportTop) {
      const afterTop = canvasRef.value?.getBoundingClientRect?.().top;
      if (Number.isFinite(afterTop)) {
        globalThis.window?.scrollBy?.({
          top: afterTop - viewportTop,
          behavior: "instant"
        });
      }
    }
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      isCanvasRefreshing.value = false;
    }, 240);
  }
);
</script>

<template>
  <!-- Loading skeleton -->
  <div v-if="store.state.loadState === 'loading'" class="terminal-shell">
    <div
      class="skeleton-stack"
      data-skeleton-grid
      aria-busy="true"
      aria-label="正在加载实时监控快照"
    >
      <ElSkeleton animated :loading="true">
        <template #template>
          <div
            style="
              display: flex;
              gap: 8px;
              flex-wrap: wrap;
              padding-bottom: 10px;
              border-bottom: 1px solid var(--border-subtle);
            "
          >
            <ElSkeletonItem variant="button" style="height: 26px; width: 90px" />
            <ElSkeletonItem variant="button" style="height: 26px; width: 110px" />
            <ElSkeletonItem variant="button" style="height: 26px; width: 110px" />
            <ElSkeletonItem variant="button" style="height: 26px; width: 110px" />
            <ElSkeletonItem variant="button" style="height: 26px; width: 110px" />
          </div>
          <div v-for="n in 8" :key="n" class="skeleton-row">
            <div style="display: flex; flex-direction: column; gap: 6px">
              <ElSkeletonItem variant="text" style="height: 14px; width: 72%" />
              <ElSkeletonItem variant="text" style="height: 11px; width: 46%" />
            </div>
            <ElSkeletonItem variant="text" style="height: 20px; width: 78%" />
            <ElSkeletonItem variant="text" style="height: 14px; width: 85%" />
            <ElSkeletonItem variant="text" style="height: 16px; width: 62%; margin-left: auto" />
            <ElSkeletonItem variant="button" style="height: 22px; width: 64px" />
          </div>
        </template>
      </ElSkeleton>
    </div>
  </div>

  <!-- Honest error degradation -->
  <section
    v-else-if="store.state.loadState === 'error'"
    class="empty-state-card is-error"
    data-error-panel
    role="alert"
  >
    <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
      <span class="pill pill-danger">诚实降级 · 拒绝模拟数据</span>
      <span v-if="store.state.errorDetail?.status" class="pill pill-danger mono">
        HTTP {{ store.state.errorDetail.status }}
      </span>
    </div>
    <h2 class="empty-state-title">
      {{ store.state.errorDetail?.message || "库存快照加载失败" }}
    </h2>
    <p class="empty-state-desc">
      错误详情：<code class="mono">{{ store.state.errorDetail?.detail || "Unknown fetch failure" }}</code>。
      根据 VPS雷达 (vpsld) 数据诚实性原则，当上游 <code>data/products.json</code> 不可达时绝不回退或编造任何本地假库存。
    </p>
    <div style="display: flex; gap: 8px; flex-wrap: wrap">
      <ElButton
        class="radar-el-btn"
        type="primary"
        data-action="refresh-snapshot"
        @click="store.refreshSnapshot({ force: true })"
      >
        <ElIcon style="margin-right: 4px"><Refresh /></ElIcon>
        重试读取快照
      </ElButton>
      <ElButton
        class="radar-el-btn"
        data-nav-view="guide"
        @click="store.setView('guide')"
      >
        查看数据口径说明
      </ElButton>
    </div>
  </section>

  <!-- Ready Terminal Workbench -->
  <div v-else class="terminal-shell">
    <LiveTickerRibbon
      :events="store.events.value"
      :matched-plans="matchedPlans"
      :active-filter-count="activeFilterCount"
      @inspect="store.openInspector($event)"
      @go-radar="store.setView('radar')"
    />

    <FilterDock
      :store="store"
      :facets="facets"
      :matched-count="matchedPlans.length"
      :viewport-width="viewportWidth"
    />

    <div
      ref="canvasRef"
      class="terminal-canvas"
      :class="{ 'is-refreshing': isCanvasRefreshing }"
      data-terminal-canvas
    >
      <!-- Pending provider empty state -->
      <section
        v-if="pendingProviderEmpty"
        class="empty-state-card"
        data-zero-results
      >
        <ElEmpty :image-size="72">
          <template #description>
            <div style="display: flex; flex-direction: column; align-items: center; gap: 8px">
              <span class="pill pill-warn">库存待核验</span>
              <h2 class="empty-state-title" style="margin: 0">
                暂未取得 {{ pendingProviderEmpty.provider.name }} 的可核验套餐
              </h2>
              <p class="empty-state-desc" style="margin: 0">
                {{
                  pendingProviderEmpty.blocked
                    ? "官方页面访问受限，暂时无法确认库存。"
                    : "当前快照尚无该商家的套餐数据。"
                }}这不代表商家售罄，请前往官网确认。
              </p>
            </div>
          </template>
          <div style="display: flex; gap: 8px; flex-wrap: wrap; justify-content: center">
            <a
              v-if="pendingProviderEmpty.websiteHref"
              class="btn btn-primary"
              :href="pendingProviderEmpty.websiteHref"
              target="_blank"
              rel="noopener noreferrer"
            >
              前往官网核验 ↗
            </a>
            <ElButton
              class="radar-el-btn"
              @click="
                store.setView('providers');
                store.patchProviders({ q: pendingProviderEmpty.provider.name });
              "
            >
              查看商家监控状态
            </ElButton>
            <ElButton
              class="radar-el-btn"
              data-action="reset-filters"
              @click="store.resetFilters()"
            >
              查看其他商家
            </ElButton>
          </div>
        </ElEmpty>
      </section>

      <!-- Zero results with conflict relaxation -->
      <section
        v-else-if="zeroDiag"
        class="empty-state-card"
        data-zero-results
      >
        <ElEmpty :image-size="72">
          <template #description>
            <div style="display: flex; flex-direction: column; align-items: center; gap: 8px">
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: center">
                <span class="pill pill-warn">0 匹配结果</span>
                <span style="font-size: var(--text-xs); color: var(--ink-muted)">
                  当前生效 {{ zeroDiag.activeCount }} 项筛选条件存在互斥
                </span>
              </div>
              <h2 class="empty-state-title" style="margin: 0">当前配置组合下暂无匹配套餐</h2>
              <p class="empty-state-desc" style="margin: 0">
                {{
                  zeroDiag.suggestions.length
                    ? "系统已自动定位冲突条件，点击下方任意按钮即可一键放宽对应维度："
                    : "当前多维配置约束叠加过严，建议直接重置筛选条件重新选择。"
                }}
              </p>
            </div>
          </template>
          <div style="display: flex; flex-direction: column; align-items: center; gap: 12px; width: 100%">
            <div v-if="zeroDiag.suggestions.length" class="relax-list" style="width: 100%; text-align: left">
              <div
                v-for="(s, idx) in zeroDiag.suggestions"
                :key="idx"
                class="relax-item"
              >
                <span>
                  <strong>建议 {{ idx + 1 }}：</strong>{{ s.label }}
                  <span class="relax-count num"> → 可找回 {{ s.recoveredCount }} 个套餐</span>
                </span>
                <ElButton
                  class="radar-el-btn"
                  size="small"
                  type="primary"
                  plain
                  data-action="apply-relaxation"
                  :data-relax-patch="JSON.stringify(s.patch)"
                  @click="store.updateFilters(s.patch)"
                >
                  一键松绑
                </ElButton>
              </div>
            </div>
            <div>
              <ElButton
                class="radar-el-btn"
                type="primary"
                data-action="reset-filters"
                @click="store.resetFilters()"
              >
                重置全部筛选条件
              </ElButton>
            </div>
          </div>
        </ElEmpty>
      </section>

      <!-- Virtualized Table / Grid -->
      <template v-else>
        <VirtualPlanTable
          :items="matchedPlans"
          :store="store"
          :is-table-mode="isTableMode"
          :viewport-width="viewportWidth"
        />

        <div class="pager-bar">
          <span>
            共 {{ matchedPlans.length }} 款匹配方案 · 连续滚动浏览全部 · 诊断型/受阻源共
            {{ store.diagnostics.value.length }} 条已独立收纳于「商家名录」
          </span>
          <button
            type="button"
            class="btn btn-xs btn-ghost"
            data-nav-view="providers"
            @click="store.setView('providers')"
          >
            查看受阻源诊断 →
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
