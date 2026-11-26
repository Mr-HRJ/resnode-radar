<script setup>
import { computed } from "vue";
import { plain } from "@resnode-radar/contracts";

const props = defineProps({
  store: {
    type: Object,
    required: true
  }
});

const visible = computed(() => props.store.state.savedDrawerOpen);

const items = computed(() => {
  const planByKey = new Map(props.store.plans.value.map((p) => [p._key, p]));
  return [...props.store.state.savedKeys].map((key) => ({
    key,
    plan: planByKey.get(key) || null
  }));
});

function handleBackdropClick(event) {
  if (event.target === event.currentTarget) {
    props.store.setSavedDrawerOpen(false);
  }
}

function handleFilterSavedOnly() {
  props.store.setSavedDrawerOpen(false);
  props.store.setView("terminal");
  props.store.updateFilters({ savedOnly: true, status: "all" });
}
</script>

<template>
  <div
    class="drawer-backdrop"
    :class="{ 'is-entering': visible }"
    data-saved-backdrop
    :hidden="!visible"
    @click="handleBackdropClick"
  >
    <div
      v-if="visible"
      class="drawer-panel"
      role="dialog"
      aria-modal="true"
      aria-label="本地收藏夹"
    >
      <div class="drawer-head">
        <div>
          <h2 style="margin: 0; font-size: var(--text-lg); font-weight: 700">
            本地收藏夹（{{ items.length }}）
          </h2>
          <p style="margin: 4px 0 0; font-size: var(--text-xs); color: var(--ink-muted)">
            仅存于当前浏览器 <code>localStorage</code>，不会自动推送补货或变价通知。
          </p>
        </div>
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          data-action="close-saved"
          aria-label="关闭收藏夹"
          @click="store.setSavedDrawerOpen(false)"
        >
          ✕
        </button>
      </div>

      <div class="drawer-body">
        <div v-if="items.length === 0" class="empty-state-card" style="padding: 20px">
          <h3 class="empty-state-title" style="font-size: var(--text-md)">
            还没有收藏任何套餐
          </h3>
          <p class="empty-state-desc">
            点击任意套餐行或证据抽屉中的「★」即可将候选方案保留在此，下次打开工作台时自动同步其最新库存与参考月均价。
          </p>
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
            <button
              type="button"
              class="btn btn-sm btn-soft"
              data-action="filter-saved-only"
              @click="handleFilterSavedOnly"
            >
              在主终端仅看已收藏
            </button>
            <button
              type="button"
              class="btn btn-xs btn-ghost"
              data-action="clear-saved"
              @click="store.clearSaved()"
            >
              清空收藏
            </button>
          </div>

          <div style="display: flex; flex-direction: column; gap: 10px">
            <template v-for="{ key, plan } in items" :key="key">
              <div v-if="!plan" class="insp-card">
                <div
                  style="
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 8px;
                  "
                >
                  <span class="pill pill-neutral">当前快照未包含</span>
                  <button
                    type="button"
                    class="btn btn-xs btn-ghost"
                    data-action="toggle-save"
                    :data-key="key"
                    @click="store.toggleSave(key)"
                  >
                    移除
                  </button>
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

                <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap">
                  <button
                    type="button"
                    class="btn btn-xs btn-primary"
                    data-action="inspect-plan"
                    :data-product-id="plan.id"
                    @click="
                      store.setSavedDrawerOpen(false);
                      store.openInspector(plan.id);
                    "
                  >
                    查证据
                  </button>
                  <button
                    type="button"
                    class="btn btn-xs"
                    :class="{ 'is-active': store.state.compareKeys.includes(plan._key) }"
                    data-action="toggle-compare"
                    :data-key="plan._key"
                    @click="store.toggleCompare(plan._key)"
                  >
                    {{ store.state.compareKeys.includes(plan._key) ? "已加对比" : "⇄ 对比" }}
                  </button>
                  <button
                    type="button"
                    class="btn btn-xs btn-ghost"
                    style="margin-left: auto"
                    data-action="toggle-save"
                    :data-key="plan._key"
                    @click="store.toggleSave(plan._key)"
                  >
                    取消收藏
                  </button>
                </div>
              </div>
            </template>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
