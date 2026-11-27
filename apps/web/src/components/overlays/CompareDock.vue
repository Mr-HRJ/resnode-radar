<script setup>
import { computed, nextTick } from "vue";
import { ElButton, ElIcon, ElTag } from "element-plus";
import { Close } from "@element-plus/icons-vue";
import { MAX_COMPARE, plain } from "@resnode-radar/contracts";

const props = defineProps({
  store: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(["open-compare"]);

const items = computed(() => props.store.comparedPlans.value);
const totalKeysCount = computed(() => props.store.state.compareKeys.length);
const missingKeys = computed(() => {
  if (props.store.state.loadState !== "ready") return [];
  const matched = new Set(items.value.map((p) => p._key));
  return props.store.state.compareKeys.filter((k) => !matched.has(k));
});
const hasRenderableSelection = computed(
  () => items.value.length > 0 || (totalKeysCount.value > 0 && props.store.state.loadState === "ready")
);
const visible = computed(() => hasRenderableSelection.value && !props.store.state.compareOpen);
const mobileSummaryText = computed(() => {
  if (items.value.length > 0 && missingKeys.value.length > 0) {
    return `已选 ${items.value.length} 款，${missingKeys.value.length} 款暂缺`;
  }
  if (items.value.length > 0) {
    return `已选 ${items.value.length} 款待对比`;
  }
  return `已选 ${totalKeysCount.value} 款（本轮快照暂缺）`;
});

async function handleRemoveFromDock(key) {
  const doc = globalThis.document;
  const dockBefore = doc?.querySelector?.("[data-compare-dock]");
  const hadFocusInsideDock = Boolean(dockBefore && doc?.activeElement && dockBefore.contains(doc.activeElement));
  props.store.toggleCompare(key);
  if (!hadFocusInsideDock) return;
  await nextTick();
  const active = doc?.activeElement;
  if (active && active !== doc?.body && active !== doc?.documentElement) return;
  if (visible.value) {
    const dock = doc?.querySelector?.("[data-compare-dock]");
    const visibleButtons = [
      ...(dock?.querySelectorAll?.(
        ".dock-pill-close, [data-action='open-compare'], [data-action='clear-compare']"
      ) || [])
    ].filter((el) => !el.disabled && !el.hidden && el.getClientRects?.().length > 0);
    if (visibleButtons[0]) {
      visibleButtons[0].focus();
      return;
    }
  }
  doc?.getElementById?.("main-workspace")?.focus?.();
}
</script>

<template>
  <div
    class="compare-dock"
    :class="{ 'is-entering': visible, 'has-missing': missingKeys.length > 0 }"
    data-compare-dock
    aria-label="方案对比栏"
    :hidden="!visible"
  >
    <template v-if="hasRenderableSelection">
      <div class="dock-items">
        <span class="pill pill-vps num" data-compare-badge>
          {{ totalKeysCount }}/{{ MAX_COMPARE }}
        </span>
        <span class="dock-mobile-label">
          {{ mobileSummaryText }}
        </span>
        <ElTag
          v-for="p in items"
          :key="p._key"
          class="dock-pill"
          size="small"
          disable-transitions
          :title="`${p._providerName} · ${plain(p.name)}`"
        >
          <span class="dock-pill-name">{{ plain(p.name) }}</span>
          <ElButton
            text
            circle
            size="small"
            class="dock-pill-close"
            data-action="toggle-compare"
            :data-key="p._key"
            :aria-label="`移出 ${plain(p.name)}`"
            @click="handleRemoveFromDock(p._key)"
          >
            <ElIcon :size="12" aria-hidden="true"><Close /></ElIcon>
          </ElButton>
        </ElTag>
        <ElTag
          v-for="key in missingKeys"
          :key="`missing-${key}`"
          class="dock-pill-missing"
          type="info"
          size="small"
          disable-transitions
          :title="`本轮快照暂缺 · ${key}`"
        >
          <span class="dock-pill-name">暂缺 · {{ key }}</span>
          <ElButton
            text
            circle
            size="small"
            class="dock-pill-close"
            data-action="toggle-compare"
            :data-key="key"
            :aria-label="`移出暂缺对比项 ${key}`"
            @click="handleRemoveFromDock(key)"
          >
            <ElIcon :size="12" aria-hidden="true"><Close /></ElIcon>
          </ElButton>
        </ElTag>
      </div>
      <div class="dock-actions">
        <ElButton
          class="radar-el-btn"
          size="small"
          text
          data-action="clear-compare"
          @click="store.clearCompare()"
        >
          清空
        </ElButton>
        <ElButton
          class="radar-el-btn"
          size="small"
          type="primary"
          :disabled="items.length === 0"
          data-action="open-compare"
          @click="emit('open-compare')"
        >
          横向对比 ({{ items.length }})
        </ElButton>
      </div>
    </template>
  </div>
</template>
