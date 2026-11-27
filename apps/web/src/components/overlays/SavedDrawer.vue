<script setup>
import { computed, nextTick } from "vue";
import { ElAlert, ElButton, ElDrawer, ElEmpty, ElIcon, ElSkeleton } from "element-plus";
import { Close } from "@element-plus/icons-vue";
import { plain } from "@resnode-radar/contracts";

const props = defineProps({
  store: {
    type: Object,
    required: true
  }
});

const visible = computed(() => props.store.state.savedDrawerOpen);
const hasSnapshot = computed(() => Boolean(props.store.rawPayload.value));
const isInitialLoading = computed(
  () => !hasSnapshot.value && props.store.state.loadState === "loading"
);
const isInitialError = computed(
  () => !hasSnapshot.value && props.store.state.loadState === "error"
);
const initialErrorText = computed(() => {
  const err = props.store.state.errorDetail;
  if (typeof err === "string" && err.trim()) return err.trim();
  const msg = typeof err?.message === "string" ? err.message.trim() : "";
  const detail = typeof err?.detail === "string" ? err.detail.trim() : "";
  if (msg && detail && !msg.includes(detail)) return `${msg}（${detail}）`;
  if (msg) return msg;
  if (detail) return detail;
  return "暂无法核验该收藏套餐的实时库存与报价，请重试加载。";
});

const items = computed(() => {
  const planByKey = new Map(props.store.plans.value.map((p) => [p._key, p]));
  return [...props.store.state.savedKeys].map((key) => ({
    key,
    plan: planByKey.get(key) || null
  }));
});

function handleBeforeClose(done) {
  props.store.setSavedDrawerOpen(false);
  done(true);
}

function handleFilterSavedOnly() {
  props.store.closeOverlaysForNavigation();
  props.store.setView("terminal");
  props.store.updateFilters({ savedOnly: true, status: "all" });
}

async function handleRemoveSaved(key, idx) {
  props.store.toggleSave(key);
  await nextTick();
  if (!visible.value) return;
  const doc = globalThis.document;
  const remaining = doc?.querySelectorAll?.("[data-saved-backdrop] [data-action='toggle-save']");
  if (remaining && remaining.length > 0) {
    remaining[Math.min(idx, remaining.length - 1)]?.focus?.();
  } else {
    doc?.querySelector?.("[data-saved-backdrop] [data-action='close-saved']")?.focus?.();
  }
}

async function handleClearSaved() {
  props.store.clearSaved();
  await nextTick();
  if (!visible.value) return;
  globalThis.document?.querySelector?.("[data-saved-backdrop] [data-action='close-saved']")?.focus?.();
}

function handleTrapTabKeydown(event) {
  if (event.key !== "Tab" || !visible.value) return;
  const doc = globalThis.document;
  const dialog = doc?.querySelector?.("[data-saved-backdrop] .el-drawer");
  if (!dialog) return;
  const focusables = [
    ...dialog.querySelectorAll(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
    )
  ].filter((el) => !el.disabled && !el.hidden && el.getClientRects?.().length > 0);
  if (focusables.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = doc?.activeElement;
  if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
    event.preventDefault();
    last.focus();
  }
}
</script>

<template>
  <div
    class="ep-overlay-host"
    data-saved-backdrop
    :hidden="!visible"
    @keydown="handleTrapTabKeydown"
  >
    <ElDrawer
      v-if="visible"
      class="radar-el-drawer"
      direction="rtl"
      size="min(460px, 100vw)"
      :model-value="visible"
      :append-to-body="false"
      :show-close="false"
      :close-on-press-escape="false"
      :destroy-on-close="true"
      :before-close="handleBeforeClose"
      title="本地收藏夹"
    >
      <template #header="{ titleId }">
        <div>
          <h2 :id="titleId" style="margin: 0; font-size: var(--text-lg); font-weight: 700">
            本地收藏夹（{{ items.length }}）
          </h2>
          <p style="margin: 4px 0 0; font-size: var(--text-xs); color: var(--ink-muted)">
            仅存于当前浏览器 <code>localStorage</code>，不会自动推送补货或变价通知。
          </p>
        </div>
        <ElButton
          class="radar-el-btn"
          size="small"
          text
          circle
          data-action="close-saved"
          aria-label="关闭收藏夹"
          @click="store.setSavedDrawerOpen(false)"
        >
          <ElIcon><Close /></ElIcon>
        </ElButton>
      </template>

      <div v-if="items.length === 0" class="empty-state-card" style="padding: 20px">
        <ElEmpty
          description="还没有收藏任何套餐，点击任意套餐行或详情抽屉中的「收藏」即可保留在此。"
          :image-size="76"
        />
      </div>

      <template v-else>
        <div
          style="
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            flex-wrap: wrap;
          "
        >
          <ElButton
            class="radar-el-btn"
            size="small"
            type="primary"
            plain
            data-action="filter-saved-only"
            @click="handleFilterSavedOnly"
          >
            在主终端仅看已收藏
          </ElButton>
          <ElButton
            class="radar-el-btn"
            size="small"
            text
            data-action="clear-saved"
            @click="handleClearSaved()"
          >
            清空收藏
          </ElButton>
        </div>

          <div style="display: flex; flex-direction: column; gap: 10px">
            <template v-for="({ key, plan }, idx) in items" :key="key">
              <div v-if="!plan" class="insp-card">
                <div
                  style="
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 8px;
                  "
                >
                  <span v-if="isInitialLoading" class="pill pill-vps">正在加载快照…</span>
                  <span v-else-if="isInitialError" class="pill pill-danger">快照读取失败</span>
                  <span v-else class="pill pill-neutral">当前快照未包含</span>
                  <ElButton
                    size="small"
                    text
                    class="radar-el-btn"
                    data-action="toggle-save"
                    :data-key="key"
                    :aria-label="`移除收藏 ${key}`"
                    @click="handleRemoveSaved(key, idx)"
                  >
                    移除
                  </ElButton>
                </div>
                <div
                  style="
                    font-size: var(--text-xs);
                    color: var(--ink-muted);
                    word-break: break-all;
                  "
                >
                  标识：<code>{{ key }}</code>
                </div>
                <template v-if="isInitialLoading">
                  <div
                    role="status"
                    aria-live="polite"
                    style="font-size: var(--text-xs); color: var(--ink-muted)"
                  >
                    正在同步最新监控快照并匹配收藏套餐…
                  </div>
                  <ElSkeleton :rows="2" animated />
                </template>
                <template v-else-if="isInitialError">
                  <ElAlert
                    type="error"
                    :closable="false"
                    show-icon
                    class="radar-status-alert"
                    title="首份快照暂不可用"
                    :description="initialErrorText"
                  />
                  <div>
                    <ElButton
                      size="small"
                      type="primary"
                      plain
                      class="radar-el-btn"
                      data-action="refresh-snapshot"
                      :disabled="store.state.refreshing"
                      @click="store.refreshSnapshot({ force: true })"
                    >
                      重试加载
                    </ElButton>
                  </div>
                </template>
              </div>

              <div v-else class="insp-card">
                <div
                  style="
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 8px;
                  "
                >
                  <span style="display: flex; align-items: center; gap: 6px; min-width: 0">
                    <span
                      class="pill"
                      :class="plan._classify.isResidential ? 'pill-home' : 'pill-vps'"
                    >
                      {{ plan._classify.isResidential ? "真家宽" : "机房" }}
                    </span>
                    <strong style="font-size: var(--text-xs); color: var(--ink-secondary)">
                      {{ plan._providerName }}
                    </strong>
                  </span>

                  <template v-if="plan.status === 'available'">
                    <span v-if="plan._isExactStock" class="pill pill-ok num">
                      余 {{ plan.stockCount }}
                    </span>
                    <span v-else-if="plan._isSnapshot" class="pill pill-warn">快照有货</span>
                    <span v-else class="pill pill-ok">可订购</span>
                  </template>
                  <span v-else-if="plan.status === 'unavailable'" class="pill pill-danger">
                    售罄
                  </span>
                  <span v-else class="pill pill-neutral">未公开</span>
                </div>

                <div
                  style="
                    font-weight: 600;
                    font-size: var(--text-sm);
                    line-height: 1.4;
                    overflow-wrap: anywhere;
                  "
                >
                  {{ plain(plan.name) }}
                </div>

                <div
                  style="
                    display: flex;
                    align-items: baseline;
                    justify-content: space-between;
                    gap: 8px;
                  "
                >
                  <span
                    class="mono"
                    style="font-weight: 700; font-size: var(--text-sm)"
                    :title="plan._pricing.originalLabel"
                  >
                    {{ plan._pricing.displayLabel }}
                  </span>
                  <span
                    class="mono"
                    :style="{
                      fontSize: 'var(--text-2xs)',
                      color: plan._pricing.cnyTone === 'ok' ? 'var(--ok-fg)' : 'var(--warn-fg)'
                    }"
                  >
                    {{ plan._pricing.cnyLabel }}
                  </span>
                </div>

                <div class="row-actions" style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap">
                  <ElButton
                    size="small"
                    type="primary"
                    class="radar-el-btn"
                    data-action="inspect-plan"
                    :data-product-id="plan.id"
                    @click="
                      store.setSavedDrawerOpen(false);
                      store.openInspector(plan.id);
                    "
                  >
                    查证据
                  </ElButton>
                  <ElButton
                    size="small"
                    :type="store.state.compareKeys.includes(plan._key) ? 'primary' : 'default'"
                    :plain="store.state.compareKeys.includes(plan._key)"
                    class="radar-el-btn"
                    :class="{ 'is-active': store.state.compareKeys.includes(plan._key) }"
                    data-action="toggle-compare"
                    :data-key="plan._key"
                    :aria-pressed="String(store.state.compareKeys.includes(plan._key))"
                    @click="store.toggleCompare(plan._key)"
                  >
                    {{ store.state.compareKeys.includes(plan._key) ? "已加对比" : "⇄ 对比" }}
                  </ElButton>
                  <ElButton
                    size="small"
                    text
                    class="radar-el-btn"
                    style="margin-left: auto"
                    data-action="toggle-save"
                    :data-key="plan._key"
                    @click="handleRemoveSaved(plan._key, idx)"
                  >
                    取消收藏
                  </ElButton>
                </div>
              </div>
            </template>
          </div>
        </template>
      </ElDrawer>
  </div>
</template>
