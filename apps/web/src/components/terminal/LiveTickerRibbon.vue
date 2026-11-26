<script setup>
import { computed } from "vue";
import {
  formatClockTime,
  formatEventDelta,
  formatPriceLabel,
  plain
} from "@resnode-radar/contracts";
import { shortProviderLabel } from "../../utils/plan-presenters.js";

const props = defineProps({
  events: {
    type: Array,
    default: () => []
  },
  matchedPlans: {
    type: Array,
    default: () => []
  },
  activeFilterCount: {
    type: Number,
    default: 0
  }
});

const emit = defineEmits(["inspect", "go-radar"]);

const tickerData = computed(() => {
  if (!props.events?.length || props.matchedPlans.length === 0) return null;
  const matchedIds = new Set(props.matchedPlans.map((p) => p.id));
  const candidates = props.events.filter((ev) => {
    if (!ev.productId) return false;
    if (props.activeFilterCount > 0) return matchedIds.has(ev.productId);
    return matchedIds.has(ev.productId) || ev.type === "soldout";
  });
  if (candidates.length === 0) return null;

  const sorted = [...candidates]
    .sort((a, b) => {
      const rank = (e) => (e.type === "restock" ? 0 : e.type === "price" ? 1 : 2);
      return rank(a) - rank(b) || (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0);
    })
    .slice(0, 12);

  const repeatCount = sorted.length < 4 ? Math.ceil(4 / sorted.length) : 1;
  const cycleItems = Array.from({ length: repeatCount }, () => sorted).flat();
  const durSec = Math.max(22, Math.round(cycleItems.length * 4.2));

  return { cycleItems, durSec };
});

function chipTag(ev) {
  const delta = formatEventDelta(ev);
  if (ev.type === "restock") return { cls: "ticker-tag is-restock", text: "补货" };
  if (ev.type === "soldout") return { cls: "ticker-tag is-soldout", text: "售罄" };
  if (delta?.direction === "down") {
    return { cls: "ticker-tag is-down num", text: `↓ ${delta.label}` };
  }
  return { cls: "ticker-tag is-up num", text: `↑ ${delta?.label || "变价"}` };
}
</script>

<template>
  <div
    v-if="tickerData"
    class="live-ticker-ribbon"
    aria-label="实时库存与价格异动跑马灯"
    data-live-ribbon
  >
    <span class="live-ticker-head">
      <span class="radar-ping-dot" style="width: 6.5px; height: 6.5px" aria-hidden="true"></span>
      <span>{{ activeFilterCount > 0 ? "当前筛选异动" : "实时异动流" }}</span>
    </span>
    <div class="live-ticker-viewport">
      <div class="live-ticker-track" :style="{ '--marquee-dur': `${tickerData.durSec}s` }">
        <button
          v-for="(ev, i) in tickerData.cycleItems"
          :key="`a-${i}-${ev.id || ev.productId}`"
          type="button"
          class="live-ticker-item"
          data-action="inspect-ticker-event"
          :data-ticker-product-id="ev.productId"
          @click="emit('inspect', ev.productId)"
        >
          <span class="mono" style="color: var(--ink-faint); font-size: 10.5px">
            {{ formatClockTime(ev.at) }}
          </span>
          <span :class="chipTag(ev).cls">{{ chipTag(ev).text }}</span>
          <strong style="color: var(--ink-primary)">{{ shortProviderLabel(ev.provider) }}</strong>
          <span>
            {{ plain(ev.name)
            }}{{
              ev.type === "restock" && Number.isInteger(ev.stockCount)
                ? ` · 余${ev.stockCount}`
                : ""
            }}
          </span>
          <span class="mono num" style="color: var(--price-main); font-weight: 700">
            {{ formatPriceLabel(ev) }}
          </span>
        </button>

        <button
          v-for="(ev, i) in tickerData.cycleItems"
          :key="`b-${i}-${ev.id || ev.productId}`"
          type="button"
          class="live-ticker-item"
          data-action="inspect-ticker-event"
          :data-ticker-product-id="ev.productId"
          tabindex="-1"
          aria-hidden="true"
          @click="emit('inspect', ev.productId)"
        >
          <span class="mono" style="color: var(--ink-faint); font-size: 10.5px">
            {{ formatClockTime(ev.at) }}
          </span>
          <span :class="chipTag(ev).cls">{{ chipTag(ev).text }}</span>
          <strong style="color: var(--ink-primary)">{{ shortProviderLabel(ev.provider) }}</strong>
          <span>
            {{ plain(ev.name)
            }}{{
              ev.type === "restock" && Number.isInteger(ev.stockCount)
                ? ` · 余${ev.stockCount}`
                : ""
            }}
          </span>
          <span class="mono num" style="color: var(--price-main); font-weight: 700">
            {{ formatPriceLabel(ev) }}
          </span>
        </button>
      </div>
    </div>
    <button
      type="button"
      class="live-ticker-tail"
      data-nav-view="radar"
      @click="emit('go-radar')"
    >
      <span>全部异动</span>
      <span aria-hidden="true">→</span>
    </button>
  </div>
</template>
