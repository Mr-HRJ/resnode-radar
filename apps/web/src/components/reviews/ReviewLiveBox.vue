<script setup>
import { computed } from "vue";
import {
  describePricing,
  formatDateTime,
  monitorFreshness,
  plain,
  safeUrl
} from "@resnode-radar/contracts";

const props = defineProps({
  providerId: {
    type: String,
    required: true
  },
  status: {
    type: String,
    default: "loading" // "loading" | "ready" | "error"
  },
  payload: {
    type: Object,
    default: null
  },
  errorMessage: {
    type: String,
    default: ""
  },
  nowMs: {
    type: Number,
    default: () => Date.now()
  }
});

const matched = computed(() => {
  const products = Array.isArray(props.payload?.products) ? props.payload.products : [];
  const target = String(props.providerId || "").toLowerCase();
  return products.filter(
    (p) =>
      String(p?.providerId || "").toLowerCase() === target ||
      String(p?.provider || "").toLowerCase() === target
  );
});

const freshness = computed(() =>
  monitorFreshness(props.payload?.generatedAt, props.nowMs)
);
const availableCount = computed(
  () => matched.value.filter((p) => !p.diagnostic && p.status === "available").length
);
const unavailableCount = computed(
  () => matched.value.filter((p) => !p.diagnostic && p.status === "unavailable").length
);
const diagCount = computed(() => matched.value.filter((p) => p.diagnostic).length);

const sampleRows = computed(() =>
  matched.value.slice(0, 6).map((p) => ({
    plan: p,
    pricing: describePricing(p, props.payload?.exchangeRates, props.nowMs),
    href: safeUrl(p.orderUrl)
  }))
);
</script>

<template>
  <template v-if="status === 'loading'">
    <span class="skel" style="height: 14px; width: 72%; margin-bottom: 8px"></span>
    <span class="skel" style="height: 14px; width: 92%"></span>
  </template>

  <div
    v-else-if="status === 'error'"
    class="alert-banner is-danger"
    style="padding: 10px 12px"
  >
    <span>实时快照暂不可用（{{ errorMessage || "Fetch error" }}），拒绝展示本地模拟数据。</span>
  </div>

  <div v-else-if="matched.length === 0" class="dossier-live-row">
    <strong>最新快照暂未检索到该商家记录</strong>
    <span style="color: var(--ink-muted)">
      快照时间：{{ formatDateTime(payload?.generatedAt) }}
    </span>
  </div>

  <template v-else>
    <div
      style="
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        flex-wrap: wrap;
        margin-bottom: 8px;
      "
    >
      <span class="pill" :class="freshness.stale ? 'pill-warn' : 'pill-ok'">
        {{ freshness.label }}
      </span>
      <span class="mono" style="font-size: 11px; color: var(--ink-muted)">
        可购 {{ availableCount }} · 售罄 {{ unavailableCount
        }}{{ diagCount ? ` · 诊断 ${diagCount}` : "" }}
      </span>
    </div>

    <div class="dossier-live-list">
      <div
        v-for="({ plan, pricing, href }, idx) in sampleRows"
        :key="plan.id"
        class="dossier-live-row"
        :style="{ '--stagger-i': idx }"
      >
        <div
          style="
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 6px;
          "
        >
          <strong style="overflow-wrap: anywhere">{{ plain(plan.name) }}</strong>
          <template v-if="plan.status === 'available'">
            <span v-if="plan.evidenceLevel?.value === 'snapshot'" class="pill pill-warn">
              快照有货
            </span>
            <span v-else class="pill pill-ok">
              {{ Number.isInteger(plan.stockCount) ? `余 ${plan.stockCount}` : "可订购" }}
            </span>
          </template>
          <span v-else-if="plan.status === 'unavailable'" class="pill pill-danger">售罄</span>
          <span v-else class="pill pill-neutral">
            {{ plain(plan.statusLabel) || plan.status }}
          </span>
        </div>

        <div
          style="
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 6px;
            color: var(--ink-muted);
          "
        >
          <span class="mono" :title="pricing.originalLabel">{{ pricing.displayLabel }}</span>
          <span
            class="mono"
            :style="{ color: pricing.cnyTone === 'ok' ? 'var(--ok-fg)' : 'var(--warn-fg)' }"
          >
            {{ pricing.cnyLabel }}
          </span>
        </div>

        <div
          v-if="href"
          style="display: flex; justify-content: space-between; align-items: center; margin-top: 2px"
        >
          <a
            :href="`../index.html?inspect=${encodeURIComponent(plan.id)}`"
            style="font-size: 11px"
          >
            在终端解剖证据 →
          </a>
          <a
            :href="href"
            target="_blank"
            rel="nofollow noopener noreferrer"
            style="font-size: 11px"
          >
            官网 ↗
          </a>
        </div>
      </div>
    </div>

    <div style="margin-top: 10px">
      <a
        class="btn btn-sm btn-soft"
        style="width: 100%"
        :href="`../index.html?provider=${encodeURIComponent(providerId)}&status=all`"
      >
        在选机终端查看全部 {{ matched.length }} 条记录 →
      </a>
    </div>
  </template>
</template>
