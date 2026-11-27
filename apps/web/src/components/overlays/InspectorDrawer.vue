<script setup>
import { computed } from "vue";
import { ElAlert, ElButton, ElDrawer, ElIcon, ElSkeleton } from "element-plus";
import { Close, Link, Star, StarFilled, Switch } from "@element-plus/icons-vue";
import {
  RISK_EXPLANATIONS,
  featureEntries,
  formatDateTime,
  formatEventDelta,
  formatShortTime,
  monitorFreshness,
  plain,
  safeUrl
} from "@resnode-radar/contracts";
import PlanTagBadge from "../icons/PlanTagBadge.vue";

const props = defineProps({
  store: {
    type: Object,
    required: true
  },
  deferred: {
    type: Boolean,
    default: false
  }
});

const isOpen = computed(() => Boolean(props.store.state.inspectId) && !props.deferred);
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
  return "暂无法拉取最新监控快照，请重试，不会以套餐下线误导显示。";
});
const plan = computed(() => {
  const id = props.store.state.inspectId;
  if (!id) return null;
  return props.store.allRecords.value.find((r) => r.id === id) || null;
});

const isSaved = computed(() =>
  plan.value ? props.store.state.savedKeys.has(plan.value._key) : false
);
const isCompared = computed(() =>
  plan.value ? props.store.state.compareKeys.includes(plan.value._key) : false
);
const orderHref = computed(() => (plan.value ? safeUrl(plan.value.orderUrl) : ""));
const sourceHref = computed(() => (plan.value ? safeUrl(plan.value.sourceUrl) : ""));
const finalHref = computed(() => (plan.value ? safeUrl(plan.value.finalUrl) : ""));

const freshness = computed(() => {
  if (!plan.value) return { stale: false, label: "-" };
  const ts = plan.value.verification ? plan.value.verification.verifiedAt : plan.value.fetchedAt;
  return monitorFreshness(ts, props.store.nowMs.value);
});

const features = computed(() => {
  if (!plan.value) return [];
  const auditRaw = props.store.activeAudit.value?.raw;
  const merged = auditRaw ? { ...plan.value, raw: { ...plan.value.raw, ...auditRaw } } : plan.value;
  return featureEntries(merged).filter(([k, v]) => k || v).slice(0, 14);
});

const attempts = computed(() => {
  if (!plan.value) return [];
  const fromAudit = props.store.activeAudit.value?.raw?.attempts;
  const fromRaw = plan.value.raw?.attempts;
  const list = Array.isArray(fromAudit) ? fromAudit : Array.isArray(fromRaw) ? fromRaw : [];
  return list.slice(0, 8);
});

const observations = computed(() => {
  const obs = props.store.activeAudit.value?.observations;
  return Array.isArray(obs) ? obs.slice(0, 5) : [];
});

const riskTags = computed(() =>
  Array.isArray(plan.value?.riskTags) ? plan.value.riskTags.filter(Boolean) : []
);

const planTags = computed(() =>
  Array.isArray(plan.value?._planTags) ? plan.value._planTags : []
);

const relatedEvents = computed(() => {
  if (!plan.value) return [];
  const skuEvents = plan.value._events || [];
  if (skuEvents.length) return skuEvents.slice(0, 5);
  return (
    props.store.eventIndex.value?.byProvider?.get(plan.value._providerId) || []
  ).slice(0, 5);
});

const caveats = computed(() => {
  const pl = plan.value;
  if (!pl) return [];
  const list = [];
  if (pl.verification?.state === "historical") {
    list.push("本轮未取得该套餐结果，保留的历史价格与配置不代表当前库存。");
  }
  if (pl.verification?.priceKind === "reference") {
    list.push("展示的是公开参考价格，未核验当前可结算价格。");
  }
  if (pl._isSnapshot) {
    list.push("当前行来自第三方 Reader 公开快照（官方站点直连受阻），价格与库存请务必前往官方下单页复核。");
  }
  if (pl._classify.isNat) {
    list.push("该套餐含 NAT / 共享 IPv4 标记，非独享独立 IPv4。");
  }
  if (pl.evidenceLevel?.value === "official-order") {
    list.push("仅核验到官方订购入口按钮，商家页面未公布具体剩余台数。");
  }
  if (pl.collection?.pageLimitReached) {
    list.push("该商家公开目录页数超过单轮采集上限，当前列表非全量 SKU 覆盖。");
  }
  return list;
});

function handleBeforeClose(done) {
  props.store.openInspector(null);
  done(true);
}

function handleTrapTabKeydown(event) {
  if (event.key !== "Tab" || !isOpen.value) return;
  const doc = globalThis.document;
  const drawer = doc?.querySelector?.("[data-inspector-backdrop] .el-drawer");
  if (!drawer) return;
  const focusables = [
    ...drawer.querySelectorAll(
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
  if (!event.shiftKey && (active === last || !drawer.contains(active))) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && (active === first || active === drawer || !drawer.contains(active))) {
    event.preventDefault();
    last.focus();
  }
}

function handleDrillProvider(providerId) {
  props.store.drillProvider(providerId);
}

function handleJumpDeal(dealKey) {
  props.store.closeOverlaysForNavigation();
  props.store.setView("terminal");
  props.store.updateFilters({ deal: dealKey, status: "available" });
}

function handleJumpRadar() {
  props.store.closeOverlaysForNavigation();
  props.store.setView("radar");
}

function eventPill(ev) {
  const delta = formatEventDelta(ev);
  if (ev.type === "restock") return { cls: "pill pill-ok", text: "补货" };
  if (ev.type === "soldout") return { cls: "pill pill-danger", text: "售罄" };
  return {
    cls: `pill ${delta?.direction === "down" ? "pill-ok" : "pill-danger"}`,
    text: `变价 ${delta?.label || ""}`
  };
}
</script>

<template>
  <div
    class="ep-overlay-host"
    data-inspector-backdrop
    :hidden="!isOpen"
    @keydown="handleTrapTabKeydown"
  >
    <ElDrawer
      v-if="isOpen"
      class="radar-el-drawer"
      direction="rtl"
      size="min(512px, 100vw)"
      :model-value="isOpen"
      :append-to-body="false"
      :show-close="false"
      :close-on-press-escape="false"
      :destroy-on-close="true"
      :before-close="handleBeforeClose"
      :title="plan ? '套餐解析证据与定价解剖' : '套餐证据抽屉'"
    >
      <template #header="{ titleId }">
        <template v-if="!plan">
          <div>
            <h2 :id="titleId" style="margin: 0; font-size: var(--text-lg); font-weight: 700">
              {{
                isInitialLoading
                  ? "正在加载套餐快照…"
                  : isInitialError
                    ? "暂无法读取套餐快照"
                    : "未找到对应套餐"
              }}
            </h2>
            <p style="margin: 4px 0 0; font-size: var(--text-xs); color: var(--ink-muted)">
              {{
                isInitialLoading
                  ? "正在同步最新监控快照并匹配该套餐的实时库存与抓取证据，请稍候。"
                  : isInitialError
                    ? "上游数据源暂时不可用，当前无法核验该套餐的最新状态与证据。"
                    : "该套餐可能已从最新监控快照中下线或变更标识。"
              }}
            </p>
          </div>
          <ElButton
            class="radar-el-btn"
            size="small"
            text
            circle
            data-action="close-inspector"
            aria-label="关闭证据抽屉"
            @click="store.openInspector(null)"
          >
            <ElIcon><Close /></ElIcon>
          </ElButton>
        </template>

        <template v-else>
          <div style="min-width: 0; flex: 1">
            <div
              style="
                display: flex;
                align-items: center;
                gap: 6px;
                flex-wrap: wrap;
                margin-bottom: 6px;
              "
            >
              <PlanTagBadge v-for="t in planTags" :key="t.key" :tag="t" focusable />
              <span
                class="pill"
                :class="plan._classify.isResidential ? 'pill-home' : 'pill-vps'"
              >
                {{ plan._classify.ipTier.label }}
              </span>
              <span v-if="plan._classify.isNat" class="pill pill-warn">NAT / 共享</span>
              <span v-else class="pill">IP 独享性未核验</span>

              <span v-if="plan.status === 'available'" class="pill pill-ok">
                {{
                  plan._isExactStock
                    ? `精确库存 ${plan.stockCount}`
                    : plain(plan.statusLabel) || "可订购"
                }}
              </span>
              <span v-else-if="plan.status === 'unavailable'" class="pill pill-danger">售罄</span>
              <span v-else class="pill pill-neutral">
                {{ plain(plan.statusLabel) || "状态未知" }}
              </span>
            </div>

            <h2
              :id="titleId"
              style="
                margin: 0;
                font-size: var(--text-lg);
                font-weight: 700;
                line-height: 1.35;
                overflow-wrap: anywhere;
              "
            >
              {{ plain(plan.name) }}
            </h2>

            <div
              style="
                margin-top: 5px;
                font-size: var(--text-xs);
                color: var(--ink-muted);
                display: flex;
                align-items: center;
                gap: 8px;
                flex-wrap: wrap;
              "
            >
              <button
                type="button"
                class="btn btn-xs btn-ghost"
                style="padding: 0 4px; height: auto; color: var(--accent)"
                data-action="drill-provider"
                :data-provider-id="plan._providerId"
                @click="handleDrillProvider(plan._providerId)"
              >
                {{ plan._providerName }}
              </button>
              <span>·</span>
              <span>{{ plan._regions.length ? plan._regions.join(" / ") : "地区待核验" }}</span>
              <a v-if="plan._dossier" class="pill pill-warn" :href="plan._dossier.path">
                实测档案 →
              </a>
            </div>
          </div>

          <ElButton
            class="radar-el-btn"
            size="small"
            text
            circle
            data-action="close-inspector"
            aria-label="关闭抽屉"
            @click="store.openInspector(null)"
          >
            <ElIcon><Close /></ElIcon>
          </ElButton>
        </template>
      </template>

      <template v-if="!plan">
        <template v-if="isInitialLoading">
          <div
            role="status"
            aria-live="polite"
            style="font-size: var(--text-xs); color: var(--ink-muted)"
          >
            正在加载最新监控快照，请稍候…
          </div>
          <ElSkeleton :rows="5" animated />
          <div>
            <ElButton
              class="radar-el-btn"
              data-action="close-inspector"
              @click="store.openInspector(null)"
            >
              返回列表
            </ElButton>
          </div>
        </template>

        <template v-else-if="isInitialError">
          <ElAlert
            type="error"
            :closable="false"
            show-icon
            class="radar-status-alert"
            title="首次快照读取失败"
            :description="initialErrorText"
          />
          <p style="font-size: var(--text-sm); color: var(--ink-secondary); margin: 0">
            请求标识：<code>{{ store.state.inspectId }}</code>
          </p>
          <div style="display: flex; gap: 8px; flex-wrap: wrap">
            <ElButton
              class="radar-el-btn"
              type="primary"
              data-action="refresh-snapshot"
              :disabled="store.state.refreshing"
              @click="store.refreshSnapshot({ force: true })"
            >
              重试加载
            </ElButton>
            <ElButton
              class="radar-el-btn"
              data-action="close-inspector"
              @click="store.openInspector(null)"
            >
              返回列表
            </ElButton>
          </div>
        </template>

        <template v-else>
          <p style="font-size: var(--text-sm); color: var(--ink-secondary); margin: 0">
            请求标识：<code>{{ store.state.inspectId }}</code>
          </p>
          <div>
            <ElButton
              class="radar-el-btn"
              type="primary"
              data-action="close-inspector"
              @click="store.openInspector(null)"
            >
              返回列表
            </ElButton>
          </div>
        </template>
      </template>

      <template v-else>
        <div class="insp-cta-row">
          <a
            v-if="orderHref"
            class="btn btn-primary"
            style="flex: 1"
            :href="orderHref"
            target="_blank"
            rel="nofollow noopener noreferrer"
          >
            前往官方订购页 ↗
          </a>
          <ElButton v-else class="radar-el-btn" style="flex: 1" disabled>
            无官方直达订购链接
          </ElButton>

          <ElButton
            class="radar-el-btn"
            :type="isSaved ? 'warning' : 'default'"
            :plain="isSaved"
            data-action="toggle-save"
            :data-key="plan._key"
            @click="store.toggleSave(plan._key)"
          >
            <ElIcon style="margin-right: 4px">
              <StarFilled v-if="isSaved" />
              <Star v-else />
            </ElIcon>
            {{ isSaved ? "已收藏" : "收藏" }}
          </ElButton>

          <ElButton
            class="radar-el-btn"
            :type="isCompared ? 'primary' : 'default'"
            :plain="isCompared"
            data-action="toggle-compare"
            :data-key="plan._key"
            @click="store.toggleCompare(plan._key)"
          >
            <ElIcon style="margin-right: 4px"><Switch /></ElIcon>
            {{ isCompared ? "已对比" : "对比" }}
          </ElButton>

          <ElButton
            class="radar-el-btn"
            data-action="copy-share-url"
            title="复制本套餐直链"
            aria-label="复制本套餐直链"
            @click="store.copyShareUrl()"
          >
            <ElIcon><Link /></ElIcon>
          </ElButton>
        </div>

        <!-- Audit refresh / shard notice -->
        <ElAlert
          v-if="store.state.auditNotice"
          class="radar-status-alert"
          type="warning"
          :closable="false"
          show-icon
          role="status"
          data-audit-notice
        >
          <template #default>
            <span>{{ store.state.auditNotice }}</span>
          </template>
        </ElAlert>

        <div v-if="caveats.length" class="alert-banner" style="padding: 10px 12px">
          <div style="display: flex; flex-direction: column; gap: 4px">
            <strong>核验提示</strong>
            <span v-for="(c, idx) in caveats" :key="idx">• {{ c }}</span>
          </div>
        </div>

        <section v-if="planTags.length" class="insp-card" data-inspector-plan-tags>
          <h3 class="insp-card-title">
            <span>商品亮点标签与核验依据（{{ planTags.length }}）</span>
            <span class="pill pill-ok">排除 NAT 核验</span>
          </h3>
          <div class="risk-audit-list">
            <div
              v-for="t in planTags"
              :key="t.key"
              class="risk-audit-item is-tag-audit-row"
            >
              <PlanTagBadge :tag="t" full-label focusable />
              <span style="color: var(--ink-secondary); line-height: 1.45; flex: 1; min-width: 0">
                {{ t.reason }}
              </span>
              <button
                type="button"
                class="btn btn-xs btn-ghost tag-audit-jump"
                data-action="jump-deal-from-inspector"
                :data-deal="t.key"
                @click="handleJumpDeal(t.key)"
              >
                同款 →
              </button>
            </div>
          </div>
        </section>

        <!-- Pricing breakdown -->
        <section class="insp-card">
          <h3 class="insp-card-title">
            <span>原始账单与汇率透明拆解</span>
            <span
              class="pill"
              :class="plan._pricing.cnyTone === 'ok' ? 'pill-ok' : 'pill-warn'"
            >
              {{ plan._pricing.quote.period }}
            </span>
          </h3>
          <div class="insp-price-hero">
            <span class="insp-price-orig num" :title="plan._pricing.originalLabel">
              {{ plan._pricing.displayLabel }}
            </span>
            <span
              class="insp-price-cny num"
              :style="{
                color: plan._pricing.cnyTone === 'ok' ? 'var(--ok-fg)' : 'var(--warn-fg)'
              }"
            >
              {{ plan._pricing.cnyLabel }}
            </span>
          </div>
          <dl class="kv-table">
            <dt>官方报价原文</dt>
            <dd class="mono">{{ plan._pricing.originalLabel }}</dd>
            <dt>识别币种</dt>
            <dd class="mono">{{ plan._pricing.quote.currency || "未明确 / 存在冲突" }}</dd>
            <dt>计费周期</dt>
            <dd>
              {{ plan._pricing.quote.period
              }}{{
                plan._pricing.quote.months ? `（按 ${plan._pricing.quote.months} 个月分摊）` : ""
              }}
            </dd>
            <dt>起步选配价</dt>
            <dd>
              <span
                v-if="plan._pricing.quote.baseOnly"
                style="color: var(--warn-fg); font-weight: 600"
              >
                是（选配项会改变最终结算价）
              </span>
              <template v-else>否</template>
            </dd>
            <dt>折算口径</dt>
            <dd class="mono">{{ plan._pricing.formula || plan._pricing.honestReason || "-" }}</dd>
          </dl>
          <p style="margin: 0; font-size: 11px; color: var(--ink-muted)">
            参考月均人民币仅用于横向比价，不构成发卡行实际结算金额，且不含增值税、通道费与续费价差。
          </p>
        </section>

        <!-- Evidence chain -->
        <section class="insp-card">
          <h3 class="insp-card-title">
            <span>原始采集证据链与风险审计</span>
            <span class="pill" :class="freshness.stale ? 'pill-warn' : 'pill-ok'">
              {{ freshness.label }}
            </span>
          </h3>
          <dl class="kv-table">
            <dt>证据等级</dt>
            <dd>
              <strong>{{ plan.evidenceLevel?.label || "未分级" }}</strong>（<code>{{
                plan.evidenceLevel?.value || "-"
              }}</code>）
            </dd>
            <dt>线路声明</dt>
            <dd>{{ plain(plan.route) || "页面未单列线路字段" }}</dd>
            <dt>解析依据</dt>
            <dd class="mono" style="font-size: 11.5px">{{ plain(plan.evidence) || "-" }}</dd>
            <dt>采集适配器</dt>
            <dd class="mono">
              {{ plan.adapter || "-" }}{{ plan.httpStatus ? ` · HTTP ${plan.httpStatus}` : "" }}
            </dd>
            <dt>采集批次</dt>
            <dd class="mono">{{ formatDateTime(plan.fetchedAt) }}</dd>
            <template v-if="plan.verification">
              <dt>最近库存核验</dt>
              <dd class="mono">
                {{
                  plan.verification.verifiedAt
                    ? formatDateTime(plan.verification.verifiedAt)
                    : "尚未核验"
                }}{{ freshness.stale ? " · 已过期" : "" }}
              </dd>
              <dt>本轮证据</dt>
              <dd>
                {{
                  plan.verification.state === "verified"
                    ? "已核验库存"
                    : plan.verification.state === "historical"
                      ? "历史资料，当前状态未知"
                      : "取得资料，库存尚未核验"
                }}
              </dd>
              <dt>价格口径</dt>
              <dd>
                {{
                  plan.verification.priceKind === "reference"
                    ? "目录参考价"
                    : plan.verification.priceKind === "historical"
                      ? "历史价格"
                      : "本轮公开报价"
                }}
              </dd>
            </template>
            <dt>公开来源页</dt>
            <dd>
              <a
                v-if="sourceHref"
                :href="sourceHref"
                target="_blank"
                rel="nofollow noopener noreferrer"
              >{{ sourceHref }} ↗</a>
              <template v-else>-</template>
            </dd>
            <template v-if="finalHref && finalHref !== sourceHref">
              <dt>最终落点</dt>
              <dd>
                <a :href="finalHref" target="_blank" rel="nofollow noopener noreferrer">
                  {{ finalHref }} ↗
                </a>
              </dd>
            </template>
          </dl>
          <div
            v-if="plan.note"
            style="
              padding: 8px 10px;
              border-radius: var(--r-xs);
              background: var(--bg-surface);
              border: 1px solid var(--border-subtle);
              font-size: var(--text-xs);
              color: var(--ink-secondary);
            "
          >
            <strong>备注原文：</strong>{{ plain(plan.note) }}
          </div>
        </section>

        <!-- Hardware & features -->
        <section class="insp-card">
          <h3 class="insp-card-title"><span>硬件与原始字段明细</span></h3>
          <dl class="kv-table">
            <dt>CPU</dt><dd class="mono">{{ plan._specs.cpu }}</dd>
            <dt>内存</dt><dd class="mono">{{ plan._specs.memory }}</dd>
            <dt>硬盘</dt><dd class="mono">{{ plan._specs.disk }}</dd>
            <dt>端口带宽</dt><dd class="mono">{{ plan._specs.bandwidth }}</dd>
            <dt>流量配额</dt><dd class="mono">{{ plan._specs.traffic }}</dd>
            <template v-for="([k, v], idx) in features" :key="idx">
              <dt>{{ k || "属性" }}</dt>
              <dd>{{ v }}</dd>
            </template>
          </dl>
        </section>

        <!-- Risk tags -->
        <section class="insp-card">
          <h3 class="insp-card-title"><span>风险标签清单（{{ riskTags.length }}）</span></h3>
          <div class="risk-audit-list">
            <template v-if="riskTags.length">
              <div
                v-for="r in riskTags"
                :key="r.value"
                class="risk-audit-item"
                :class="
                  r.severity === 'high'
                    ? 'is-high'
                    : r.severity === 'medium'
                      ? 'is-medium'
                      : ''
                "
              >
                <span
                  class="pill"
                  :class="
                    r.severity === 'high'
                      ? 'pill-danger'
                      : r.severity === 'medium'
                        ? 'pill-warn'
                        : 'pill-ok'
                  "
                  style="flex-shrink: 0"
                >
                  {{ r.label || r.value }}
                </span>
                <span style="color: var(--ink-secondary); line-height: 1.45">
                  {{ RISK_EXPLANATIONS[r.value] || "请结合官方页面条款核验。" }}
                </span>
              </div>
            </template>
            <span v-else style="font-size: var(--text-xs); color: var(--ink-muted)">
              无额外风险标签
            </span>
          </div>
        </section>

        <!-- Lazy-loaded HTTP attempts & observations -->
        <section
          v-if="store.auditLoading.value"
          class="insp-card"
          role="status"
          aria-live="polite"
          data-audit-loading
        >
          <div style="font-size: var(--text-xs); color: var(--ink-muted); margin-bottom: 8px">
            正在按需读取源站 HTTP 抓取审计分片…
          </div>
          <ElSkeleton :rows="2" animated />
        </section>

        <section v-if="attempts.length" class="insp-card" data-inspector-attempts>
          <h3 class="insp-card-title">
            <span>监控尝试记录（{{ attempts.length }} 次）</span>
          </h3>
          <ul class="attempt-list">
            <li v-for="(a, idx) in attempts" :key="idx" class="attempt-row">
              <span class="mono">
                <strong>{{ a.strategy || a.stage || "fetch" }}</strong> · HTTP
                {{ a.statusCode ?? a.httpStatus ?? "-" }} {{ a.ok ? "OK" : "FAIL" }}
              </span>
              <span style="color: var(--ink-muted)">{{ a.url || "" }}</span>
              <span v-if="a.reason || a.error" style="color: var(--danger-fg)">
                {{ a.reason || a.error }}
              </span>
            </li>
          </ul>
        </section>

        <section v-if="observations.length" class="insp-card" data-inspector-observations>
          <h3 class="insp-card-title">
            <span>近期连续巡检快照（{{ observations.length }} 轮）</span>
          </h3>
          <ul class="attempt-list">
            <li v-for="(obs, idx) in observations" :key="idx" class="attempt-row">
              <span class="mono">
                {{ formatShortTime(obs.at) }} · <strong>{{ obs.status }}</strong>
                {{ Number.isInteger(obs.stockCount) ? `(余 ${obs.stockCount})` : "" }}
              </span>
              <span v-if="obs.price" class="mono" style="color: var(--ink-secondary)">
                {{ obs.price }}
              </span>
            </li>
          </ul>
        </section>

        <!-- Related 7d events -->
        <section class="insp-card">
          <h3 class="insp-card-title">
            <span>
              {{
                (plan._events || []).length
                  ? "本套餐近 7 天观测异动"
                  : `${plan._providerName} 近期异动`
              }}
            </span>
            <button
              type="button"
              class="btn btn-xs btn-ghost"
              data-nav-view="radar"
              data-action="jump-radar-from-inspector"
              @click="handleJumpRadar()"
            >
              全部异动 →
            </button>
          </h3>
          <div
            v-if="relatedEvents.length"
            style="display: flex; flex-direction: column; gap: 6px"
          >
            <div
              v-for="ev in relatedEvents"
              :key="ev.id || `${ev.productId}-${ev.at}`"
              style="
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                font-size: var(--text-xs);
                padding: 6px 8px;
                border-radius: var(--r-xs);
                background: var(--bg-surface);
                border: 1px solid var(--border-subtle);
              "
            >
              <span style="display: flex; align-items: center; gap: 6px; min-width: 0">
                <span :class="eventPill(ev).cls">{{ eventPill(ev).text }}</span>
                <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                  {{ plain(ev.name) }}
                </span>
              </span>
              <span class="mono" style="color: var(--ink-muted); flex-shrink: 0">
                {{ formatShortTime(ev.at) }}
              </span>
            </div>
          </div>
          <span v-else style="font-size: var(--text-xs); color: var(--ink-muted)">
            近 7 天未观测到保守口径下的状态或价格变更。
          </span>
        </section>
      </template>
    </ElDrawer>
  </div>
</template>
