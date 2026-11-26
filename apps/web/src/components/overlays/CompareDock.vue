<script setup>
import { computed } from "vue";
import { MAX_COMPARE, plain } from "@resnode-radar/contracts";

const props = defineProps({
  store: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(["open-compare"]);

const items = computed(() => props.store.comparedPlans.value);
const visible = computed(() => items.value.length > 0 && !props.store.state.compareOpen);
</script>

<template>
  <div
    class="compare-dock"
    :class="{ 'is-entering': visible }"
    data-compare-dock
    aria-label="方案对比栏"
    :hidden="!visible"
  >
    <template v-if="visible">
      <div class="dock-items">
        <span class="pill pill-vps num" data-compare-badge>
          {{ items.length }}/{{ MAX_COMPARE }}
        </span>
        <span class="dock-mobile-label">已选 {{ items.length }} 款待对比</span>
        <span
          v-for="p in items"
          :key="p._key"
          class="dock-pill"
          :title="`${p._providerName} · ${plain(p.name)}`"
        >
          <span>{{ plain(p.name) }}</span>
          <button
            type="button"
            data-action="toggle-compare"
            :data-key="p._key"
            :aria-label="`移出 ${plain(p.name)}`"
            @click="store.toggleCompare(p._key)"
          >
            ×
          </button>
        </span>
      </div>
      <div class="dock-actions">
        <button
          type="button"
          class="btn btn-xs btn-ghost"
          data-action="clear-compare"
          @click="store.clearCompare()"
        >
          清空
        </button>
        <button
          type="button"
          class="btn btn-sm btn-primary"
          data-action="open-compare"
          @click="emit('open-compare')"
        >
          横向对比 ({{ items.length }})
        </button>
      </div>
    </template>
  </div>
</template>
