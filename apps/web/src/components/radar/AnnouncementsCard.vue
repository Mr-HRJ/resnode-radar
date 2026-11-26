<script setup>
import { computed } from "vue";
import { formatDateTime, safeUrl } from "@resnode-radar/contracts";

const props = defineProps({
  feed: {
    type: Object,
    default: null
  }
});

const STATE_LABELS = {
  pending: "待核验",
  verified: "已核验",
  blocked: "核验受阻",
  unmatched: "尚未匹配 SKU"
};

const sources = computed(() => props.feed?.sources ?? []);
const items = computed(() => (props.feed?.items ?? []).slice(0, 100));
const okCount = computed(() => sources.value.filter((s) => s.status === "ok").length);

function candidateResult(c) {
  const v = c?.verification || {};
  if (v.state === "verified") {
    return v.status === "available" ? "可下单" : "售罄";
  }
  return STATE_LABELS[v.state] || "待核验";
}
</script>

<template>
  <details
    v-if="sources.length > 0"
    class="insp-card ann-compact-bar"
    aria-label="公告与优惠线索"
  >
    <summary class="insp-card-title">
      公告与优惠线索 · {{ (feed?.items ?? []).length }} 条
      <span class="pill" :class="okCount === sources.length ? 'pill-ok' : 'pill-warn'">
        {{ okCount }}/{{ sources.length }} 来源正常 · 展开
      </span>
    </summary>

    <p class="workspace-sub">
      每 20 分钟检查。公告不代表当前有货；点击套餐查看采集核验结果。首次导入标为历史公告。
    </p>

    <details>
      <summary>订阅来源与最近检查</summary>
      <ul>
        <li v-for="s in sources" :key="s.id || s.name">
          {{ s.name }} · {{ formatDateTime(s.checkedAt) }} ·
          {{ s.status === "ok" ? "正常" : s.error || "读取失败，保留历史公告" }}
        </li>
      </ul>
    </details>

    <ol v-if="items.length">
      <li v-for="item in items" :key="item.id || `${item.source}-${item.title}`" style="margin: 14px 0">
        <strong>
          <a
            v-if="safeUrl(item.url)"
            :href="safeUrl(item.url)"
            target="_blank"
            rel="nofollow noopener noreferrer"
          >{{ item.title }} ↗</a>
          <template v-else>{{ item.title }}</template>
        </strong>

        <div class="workspace-sub">
          {{ item.source }} · {{ item.trust === "official" ? "官方公开来源" : "第三方线索" }} ·
          {{
            item.publishedAt
              ? `发布 ${formatDateTime(item.publishedAt)}`
              : `发布时间未提供 · 首次发现 ${formatDateTime(item.firstSeenAt)}`
          }}{{ item.baseline ? " · 首次导入" : "" }}
        </div>

        <ul v-if="(item.candidates ?? []).length">
          <li v-for="(c, idx) in item.candidates" :key="idx">
            <a
              v-if="safeUrl(c.url)"
              :href="safeUrl(c.url)"
              target="_blank"
              rel="nofollow noopener noreferrer"
            >{{ c.provider }} 套餐 ↗</a>
            <template v-else>{{ c.provider }}</template>
            · {{ candidateResult(c)
            }}{{ c.verification?.checkedAt ? ` · 核验 ${formatDateTime(c.verification.checkedAt)}` : "" }}
          </li>
        </ul>
        <div v-else class="workspace-sub">
          未识别到可直接核验的官方套餐链接，请查看公告原文。
        </div>
      </li>
    </ol>
    <p v-else class="workspace-sub">尚未取得有效公告；订阅异常不影响现有商品采集。</p>
  </details>
</template>
