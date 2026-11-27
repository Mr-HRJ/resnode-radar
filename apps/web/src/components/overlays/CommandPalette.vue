<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { ElButton, ElDialog, ElIcon, ElInput } from "element-plus";
import { Search } from "@element-plus/icons-vue";
import {
  DEFAULT_FILTERS,
  evaluateProviderTags,
  normalizeSearch,
  plain,
  providers
} from "@resnode-radar/contracts";
import ShopTagBadge from "../icons/ShopTagBadge.vue";
import PlanTagBadge from "../icons/PlanTagBadge.vue";

const props = defineProps({
  store: {
    type: Object,
    required: true
  }
});

const inputRef = ref(null);
const visible = computed(() => props.store.state.paletteOpen);
const rawQ = computed(() => props.store.state.paletteQuery.trim());
const normQ = computed(() => normalizeSearch(rawQ.value));

let hasAutoFocusedForOpen = false;
const isComposing = ref(false);

watch(visible, (isOpen) => {
  if (isOpen) {
    hasAutoFocusedForOpen = false;
    isComposing.value = false;
  } else {
    isComposing.value = false;
  }
});

function isFocusOnActionableDialogChild() {
  const doc = globalThis.document;
  const active = doc?.activeElement;
  if (!active || active === doc.body || active === doc.documentElement) return false;
  const dialog = doc.querySelector("[data-palette-backdrop] .el-dialog");
  if (!dialog || !dialog.contains(active)) return false;
  return active !== dialog;
}

async function handleOpenAutoFocus() {
  if (!visible.value) return;
  // Wait two ticks so ElFocusTrap's single-nextTick container focus runs first, then focus the input.
  await nextTick();
  await nextTick();
  if (!visible.value || hasAutoFocusedForOpen) return;
  hasAutoFocusedForOpen = true;
  if (!isFocusOnActionableDialogChild()) {
    inputRef.value?.focus?.();
  }
}

async function handleOpenedFallback() {
  if (!visible.value) return;
  await nextTick();
  if (!visible.value) return;
  // Never steal focus if user already moved focus to an actionable element inside the dialog.
  if (hasAutoFocusedForOpen || isFocusOnActionableDialogChild()) return;
  hasAutoFocusedForOpen = true;
  inputRef.value?.focus?.();
}

const matchedProviders = computed(() => {
  if (!normQ.value) return [];
  return providers
    .filter((p) =>
      normalizeSearch([p.name, p.id, ...(p.aliases || [])].join(" ")).includes(normQ.value)
    )
    .slice(0, 5)
    .map((p) => {
      const pPlans = props.store.plans.value.filter((pl) => pl._providerId === p.id);
      const { primaryTag } = evaluateProviderTags(p, pPlans);
      return { provider: p, primaryTag };
    });
});

const matchedPlans = computed(() =>
  props.store.plans.value
    .filter((p) => {
      if (!normQ.value) return p.status === "available" && p._isExactStock;
      return p._search.includes(normQ.value);
    })
    .slice(0, 6)
);

const quickCommands = computed(() =>
  [
    {
      id: "preset-blockbuster",
      label: "口碑爆款精选（搬瓦工限量 / 头部商家经典特惠）",
      sub: "精选亮点"
    },
    {
      id: "preset-generous",
      label: "便宜量大精选（低价大流量 / 不限流量 / 高配大盘）",
      sub: "精选亮点"
    },
    { id: "preset-annual", label: "年付特惠精选（折合低月均长周期实惠款）", sub: "精选亮点" },
    {
      id: "preset-home-opt",
      label: "家宽直连精选（真家宽 / 双 ISP 叠加回国优化免中转）",
      sub: "精选亮点"
    },
    { id: "preset-scarce", label: "紧俏余量精选（实测精确余量仅剩 1–5 台）", sub: "精选亮点" },
    { id: "preset-us-home", label: "美区真家宽（排除 NAT 共享 / 仅看现货）", sub: "场景直达" },
    { id: "preset-cn2", label: "电信 CN2 GIA 优化回程（仅看现货）", sub: "场景直达" },
    { id: "go-radar", label: "进入全网大盘（实时补货 / 售罄 / 变价流）", sub: "工作区" },
    {
      id: "go-providers",
      label: `查看 ${providers.length} 家商家名录与采集健康诊断`,
      sub: "工作区"
    },
    { id: "copy-share", label: "复制当前筛选与对比状态分享链接", sub: "操作" },
    {
      id: "toggle-theme",
      label: `切换为${props.store.state.theme === "dark" ? "亮色冰透" : "深空暗夜"}主题`,
      sub: "外观"
    }
  ].filter((cmd) => !normQ.value || normalizeSearch(cmd.label).includes(normQ.value))
);

function handleBeforeClose(done) {
  props.store.setPaletteOpen(false);
  done(true);
}

function handleFilterQuery(query) {
  props.store.closeOverlaysForNavigation();
  props.store.setView("terminal");
  props.store.updateFilters({ q: query });
}

function handleInputEnter(event) {
  if (isComposing.value || event?.isComposing || event?.keyCode === 229) {
    return;
  }
  event?.preventDefault?.();
  const inputVal = event?.target?.value;
  const candidate = (typeof inputVal === "string" ? inputVal : props.store.state.paletteQuery).trim();
  if (candidate) {
    handleFilterQuery(candidate);
  }
}

function handleSelectProvider(providerId) {
  props.store.closeOverlaysForNavigation();
  props.store.setView("terminal");
  props.store.updateFilters({ ...DEFAULT_FILTERS, status: "all", provider: providerId });
}

function handleSelectPlan(productId) {
  props.store.setPaletteOpen(false);
  props.store.openInspector(productId);
}

function handleQuickCmd(cmd) {
  if (cmd === "copy-share") {
    props.store.setPaletteOpen(false);
    props.store.copyShareUrl();
    return;
  }
  if (cmd === "toggle-theme") {
    props.store.setPaletteOpen(false);
    props.store.toggleTheme();
    return;
  }
  props.store.closeOverlaysForNavigation();
  if (cmd === "preset-us-home") props.store.applyPreset("us-home-dedicated");
  else if (cmd === "preset-cn2") props.store.applyPreset("cn2-opt");
  else if (cmd === "preset-blockbuster") props.store.applyPreset("deal-blockbuster");
  else if (cmd === "preset-generous") props.store.applyPreset("deal-generous");
  else if (cmd === "preset-annual") props.store.applyPreset("deal-annual");
  else if (cmd === "preset-home-opt") props.store.applyPreset("deal-home-opt");
  else if (cmd === "preset-scarce") props.store.applyPreset("deal-scarce");
  else if (cmd === "go-radar") props.store.setView("radar");
  else if (cmd === "go-providers") props.store.setView("providers");
}
</script>

<template>
  <div class="ep-overlay-host" data-palette-backdrop :hidden="!visible">
    <ElDialog
      v-if="visible"
      class="radar-palette-dialog"
      width="min(640px, 92vw)"
      top="11vh"
      :model-value="visible"
      :append-to-body="false"
      :show-close="false"
      :close-on-press-escape="false"
      :destroy-on-close="true"
      :before-close="handleBeforeClose"
      title="全局快速检索"
      @open-auto-focus="handleOpenAutoFocus"
      @opened="handleOpenedFallback"
    >
      <div class="palette-input-row">
        <ElInput
          ref="inputRef"
          class="radar-el-input is-palette"
          type="search"
          clearable
          data-palette-input
          :model-value="store.state.paletteQuery"
          placeholder="输入商家、地区、线路或型号（如 搬瓦工 / 香港 / 9929 / 双ISP），回车直接过滤列表…"
          aria-label="全局快速检索"
          autocomplete="off"
          @update:model-value="store.setPaletteQuery($event)"
          @compositionstart="isComposing = true"
          @compositionend="isComposing = false"
          @keydown.enter="handleInputEnter"
        >
          <template #prefix>
            <ElIcon :size="16"><Search /></ElIcon>
          </template>
        </ElInput>
        <ElButton
          class="radar-el-btn"
          size="small"
          text
          data-action="close-palette"
          @click="store.setPaletteOpen(false)"
        >
          Esc
        </ElButton>
      </div>

      <div class="palette-results">
        <div v-if="rawQ">
          <div class="palette-group-label">列表过滤</div>
          <button
            type="button"
            class="palette-item is-focused"
            data-action="palette-filter-q"
            :data-query="rawQ"
            @click="handleFilterQuery(rawQ)"
          >
            <span>
              <strong>在选机列表中筛选包含「{{ rawQ }}」的全部方案</strong>
            </span>
            <span class="palette-item-sub">按回车直达 ↵</span>
          </button>
        </div>

        <div v-if="matchedProviders.length">
          <div class="palette-group-label">匹配商家</div>
          <button
            v-for="{ provider, primaryTag } in matchedProviders"
            :key="provider.id"
            type="button"
            class="palette-item"
            data-action="palette-provider"
            :data-provider-id="provider.id"
            @click="handleSelectProvider(provider.id)"
          >
            <span class="palette-provider-label">
              <ShopTagBadge v-if="primaryTag" :tag="primaryTag" />
              <strong>{{ provider.name }}</strong>
            </span>
            <span class="palette-item-sub">查看该商家全部方案 ↵</span>
          </button>
        </div>

        <div v-if="matchedPlans.length">
          <div class="palette-group-label">
            {{ normQ ? "匹配方案（点击直接核验详情）" : "精确库存现货" }}
          </div>
          <button
            v-for="p in matchedPlans"
            :key="p.id"
            type="button"
            class="palette-item"
            data-action="palette-plan"
            :data-product-id="p.id"
            @click="handleSelectPlan(p.id)"
          >
            <span class="palette-plan-label">
              <PlanTagBadge v-if="p._primaryPlanTag" :tag="p._primaryPlanTag" compact />
              <span
                class="pill"
                :class="p._classify.isResidential ? 'pill-home' : 'pill-vps'"
              >
                {{ p._classify.isResidential ? "家宽" : "机房" }}
              </span>
              <span class="palette-plan-title">{{ plain(p.name) }}</span>
            </span>
            <span class="palette-item-sub mono">
              {{ p._providerName }} · {{ p._pricing.displayLabel }}
            </span>
          </button>
        </div>

        <div>
          <div class="palette-group-label">快捷导航</div>
          <button
            v-for="cmd in quickCommands"
            :key="cmd.id"
            type="button"
            class="palette-item"
            data-action="palette-cmd"
            :data-cmd="cmd.id"
            @click="handleQuickCmd(cmd.id)"
          >
            <span>{{ cmd.label }}</span>
            <span class="palette-item-sub">{{ cmd.sub }}</span>
          </button>
        </div>
      </div>
    </ElDialog>
  </div>
</template>
