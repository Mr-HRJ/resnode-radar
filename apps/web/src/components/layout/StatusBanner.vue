<script setup>
import { computed } from "vue";
import { formatDateTime, fxFreshness, monitorFreshness } from "@resnode-radar/contracts";

const props = defineProps({
  store: {
    type: Object,
    required: true
  }
});

const warnings = computed(() => {
  const s = props.store.state;
  const payload = props.store.rawPayload.value;
  if (s.loadState !== "ready" || !payload) return [];

  const list = [];
  const freshness = monitorFreshness(payload.generatedAt, props.store.nowMs.value);
  const fx = fxFreshness(payload.exchangeRates, props.store.nowMs.value);

  if (s.errorDetail) {
    list.push(
      `后台刷新失败（${s.errorDetail.detail || s.errorDetail.message}），当前仍展示上一次已加载快照。`
    );
  }
  if (freshness.stale) {
    list.push(
      `当前快照生成于 ${formatDateTime(payload.generatedAt)}（已超过 30 分钟，采集可能已中断），库存与价格可能已发生变化，下单前请以官方页面为准。`
    );
  }
  if (!fx.valid) {
    list.push(
      fx.expired
        ? `ECB 参考汇率快照日期为 ${fx.date}，已超 7 天有效期，前端已自动暂停所有外币人民币折算，仅保留原始账单报价。`
        : "ECB 参考汇率快照缺失或异常，外币套餐已暂停人民币折算。"
    );
  }
  return list;
});

const isDanger = computed(() => Boolean(props.store.state.errorDetail));
</script>

<template>
  <div class="status-banner-wrap app-banner-slot" data-app-banner :hidden="warnings.length === 0">
    <div
      v-if="warnings.length > 0"
      class="alert-banner"
      :class="{ 'is-danger': isDanger }"
      role="status"
      data-status-banner
    >
      <div class="alert-banner-list">
        <strong>{{ isDanger ? "数据同步告警" : "数据时效与口径提醒" }}：</strong>
        <span>{{ warnings.join(" · ") }}</span>
      </div>
      <button
        type="button"
        class="btn btn-xs"
        data-action="refresh-snapshot"
        @click="store.refreshSnapshot({ force: true })"
      >
        立即重新读取
      </button>
    </div>
  </div>
</template>
