<script setup>
import { computed, nextTick } from "vue";
import { ElButton, ElDialog, ElIcon, ElSwitch, ElTag } from "element-plus";
import { Close, Link } from "@element-plus/icons-vue";
import { MAX_COMPARE, plain, safeUrl } from "@resnode-radar/contracts";
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

const items = computed(() => props.store.comparedPlans.value);
const missingKeys = computed(() => {
  if (props.store.state.loadState !== "ready") return [];
  const matched = new Set(items.value.map((p) => p._key));
  return props.store.state.compareKeys.filter((k) => !matched.has(k));
});
const visible = computed(() => Boolean(props.store.state.compareOpen && items.value.length > 0 && !props.deferred));

const lowestCny = computed(() => {
  const validCnys = items.value
    .map((p) => p._pricing.cnyMonthly)
    .filter((v) => Number.isFinite(v));
  return validCnys.length >= 2 ? Math.min(...validCnys) : null;
});

const anyPlanTags = computed(() => items.value.some((p) => (p._planTags || []).length > 0));

const rowDiffMap = computed(() => {
  const list = items.value;
  const isDiff = (vals) => new Set(vals).size > 1;
  return {
    planTags: isDiff(list.map((p) => (p._planTags || []).map((t) => t.key).join(",") || "none")),
    provider: isDiff(list.map((p) => `${p._providerName} · ${p._regions.join(" / ") || "未标明"}`)),
    ipTier: isDiff(list.map((p) => `${p._classify.ipTier.value}|${p._classify.delivery}`)),
    route: isDiff(list.map((p) => plain(p.route) || p._classify.routes.join(",") || "未标明")),
    hw: isDiff(list.map((p) => `${p._specs.cpu}|${p._specs.memory}|${p._specs.disk}`)),
    bw: isDiff(list.map((p) => `${p._specs.bandwidth}|${p._specs.traffic}`)),
    origPrice: isDiff(list.map((p) => p._pricing.originalLabel)),
    cnyPrice: isDiff(list.map((p) => p._pricing.cnyLabel)),
    stock: isDiff(list.map((p) => `${p.status}|${p.stockCount}|${p.evidenceLevel?.value}`)),
    risk: isDiff(list.map((p) => (p.riskTags || []).map((r) => r.value).join(",")))
  };
});

function rowClass(hasDiff, alwaysShow = false) {
  if (!props.store.state.compareDiffOnly) return "";
  if (hasDiff) return "is-diff";
  if (alwaysShow) return "";
  return "is-same-hidden";
}

function isLowestPlan(p) {
  return (
    lowestCny.value !== null &&
    Number.isFinite(p._pricing.cnyMonthly) &&
    Math.abs(p._pricing.cnyMonthly - lowestCny.value) < 0.01
  );
}

function handleBeforeClose(done) {
  props.store.setCompareOpen(false);
  done(true);
}

function handleInspectFromCompare(productId) {
  props.store.setCompareOpen(false);
  props.store.openInspector(productId);
}

async function handleRemoveCompared(key, idx) {
  props.store.toggleCompare(key);
  await nextTick();
  if (!visible.value) return;
  const doc = globalThis.document;
  const remaining = doc?.querySelectorAll?.("[data-compare-modal] [data-action='toggle-compare']");
  if (remaining && remaining.length > 0) {
    remaining[Math.min(idx, remaining.length - 1)]?.focus?.();
  } else {
    doc?.querySelector?.("[data-compare-modal] [data-action='close-compare']")?.focus?.();
  }
}

async function handleRemoveMissing(key, idx) {
  props.store.toggleCompare(key);
  await nextTick();
  if (!visible.value) return;
  const doc = globalThis.document;
  const remainingMissing = doc?.querySelectorAll?.(
    "[data-compare-modal] [data-action='remove-missing-compare']"
  );
  if (remainingMissing && remainingMissing.length > 0) {
    remainingMissing[Math.min(idx, remainingMissing.length - 1)]?.focus?.();
    return;
  }
  const firstCompared = doc?.querySelector?.("[data-compare-modal] [data-action='toggle-compare']");
  if (firstCompared) {
    firstCompared.focus();
    return;
  }
  doc?.querySelector?.("[data-compare-modal] [data-action='close-compare']")?.focus?.();
}

function handleTrapTabKeydown(event) {
  if (event.key !== "Tab" || !visible.value) return;
  const doc = globalThis.document;
  const dialog = doc?.querySelector?.("[data-compare-modal] .el-dialog");
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
    data-compare-modal
    :hidden="!visible"
    @keydown="handleTrapTabKeydown"
  >
    <ElDialog
      v-if="visible"
      class="radar-el-dialog"
      width="min(1120px, 94vw)"
      top="6vh"
      :model-value="visible"
      :append-to-body="false"
      :show-close="false"
      :close-on-press-escape="false"
      :destroy-on-close="true"
      :before-close="handleBeforeClose"
      title="多方案关键指标横向对比"
    >
      <template #header="{ titleId }">
        <div
          style="
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 12px;
            flex-wrap: wrap;
          "
        >
          <div>
            <h2 :id="titleId" style="margin: 0; font-size: var(--text-lg); font-weight: 700">
              多方案关键指标横向对比（{{ items.length }}/{{ MAX_COMPARE }}）
            </h2>
            <p style="margin: 3px 0 0; font-size: var(--text-xs); color: var(--ink-muted)">
              保留原币种账单与证据等级；仅对明码固定周期且汇率在 7 天有效期内的方案标注参考月均最低项。
            </p>
          </div>

          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap">
            <label class="radar-inline-switch">
              <ElSwitch
                size="small"
                data-action="toggle-compare-diff"
                :model-value="store.state.compareDiffOnly"
                @change="store.toggleCompareDiffOnly()"
              />
              <span>仅高亮差异项</span>
            </label>
            <ElButton
              class="radar-el-btn"
              size="small"
              type="primary"
              plain
              data-action="copy-share-url"
              @click="store.copyShareUrl()"
            >
              <ElIcon style="margin-right: 4px"><Link /></ElIcon>
              复制对比链接
            </ElButton>
            <ElButton
              class="radar-el-btn"
              size="small"
              text
              circle
              data-action="close-compare"
              aria-label="关闭对比工作台"
              @click="store.setCompareOpen(false)"
            >
              <ElIcon><Close /></ElIcon>
            </ElButton>
          </div>
        </div>
      </template>

      <div v-if="missingKeys.length > 0" class="compare-missing-strip" data-compare-missing-strip>
        <span class="compare-missing-label">
          另有 {{ missingKeys.length }} 款所选套餐本轮快照暂缺（可单独移出以释放名额）：
        </span>
        <div class="compare-missing-tags">
          <ElTag
            v-for="(key, mIdx) in missingKeys"
            :key="`modal-missing-${key}`"
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
              data-action="remove-missing-compare"
              :data-key="key"
              :aria-label="`移出暂缺对比项 ${key}`"
              @click="handleRemoveMissing(key, mIdx)"
            >
              <ElIcon :size="12" aria-hidden="true"><Close /></ElIcon>
            </ElButton>
          </ElTag>
        </div>
      </div>

      <table class="compare-table">
          <thead>
            <tr>
              <th class="cmp-metric-col">对比维度</th>
              <th v-for="(p, idx) in items" :key="p._key">
                <div
                  style="
                    display: flex;
                    align-items: flex-start;
                    justify-content: space-between;
                    gap: 6px;
                  "
                >
                  <span
                    style="
                      font-weight: 700;
                      font-size: var(--text-sm);
                      line-height: 1.35;
                      overflow-wrap: anywhere;
                    "
                  >
                    {{ plain(p.name) }}
                  </span>
                  <ElButton
                    size="small"
                    text
                    class="radar-el-btn"
                    data-action="toggle-compare"
                    :data-key="p._key"
                    :aria-label="`移出对比：${plain(p.name)}`"
                    @click="handleRemoveCompared(p._key, idx)"
                  >
                    ×
                  </ElButton>
                </div>
              </th>
            </tr>
          </thead>

          <tbody>
            <!-- Plan highlight tags -->
            <tr v-if="anyPlanTags" :class="rowClass(rowDiffMap.planTags)">
              <td class="cmp-metric-col">商品亮点标签</td>
              <td v-for="p in items" :key="p._key">
                <div
                  v-if="(p._planTags || []).length"
                  style="display: flex; gap: 4px; flex-wrap: wrap"
                >
                  <PlanTagBadge v-for="t in p._planTags" :key="t.key" :tag="t" focusable />
                </div>
                <span v-else style="color: var(--ink-muted)">常规款</span>
              </td>
            </tr>

            <!-- Provider & region -->
            <tr :class="rowClass(rowDiffMap.provider)">
              <td class="cmp-metric-col">商家与地区</td>
              <td v-for="p in items" :key="p._key">
                <strong>{{ p._providerName }}</strong>
                <div
                  style="
                    color: var(--ink-muted);
                    margin-top: 2px;
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                  "
                >
                  <span class="iso-code">
                    {{ p._macroRegions?.[0] === "MULTI" ? "GL" : p._macroRegions?.[0] || "--" }}
                  </span>
                  <span>{{ p._regions.join(" / ") || "地区待核验" }}</span>
                </div>
              </td>
            </tr>

            <!-- IP Tier -->
            <tr :class="rowClass(rowDiffMap.ipTier)">
              <td class="cmp-metric-col">本质与 IP 层级</td>
              <td v-for="p in items" :key="p._key">
                <div style="display: flex; gap: 4px; flex-wrap: wrap">
                  <span
                    class="pill"
                    :class="p._classify.isResidential ? 'pill-home' : 'pill-vps'"
                  >
                    {{ p._classify.ipTier.label }}
                  </span>
                  <span v-if="p._classify.isNat" class="pill pill-warn">NAT/共享</span>
                  <span v-else class="pill">IP 独享性未核验</span>
                </div>
              </td>
            </tr>

            <!-- Route -->
            <tr :class="rowClass(rowDiffMap.route)">
              <td class="cmp-metric-col">回程与线路</td>
              <td v-for="p in items" :key="p._key">
                <div>{{ plain(p.route) || "页面未单列" }}</div>
                <div
                  v-if="p._classify.routes.length"
                  style="display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px"
                >
                  <span v-for="rt in p._classify.routes" :key="rt" class="pill">{{ rt }}</span>
                </div>
              </td>
            </tr>

            <!-- Hardware -->
            <tr :class="rowClass(rowDiffMap.hw)">
              <td class="cmp-metric-col">CPU / 内存 / 硬盘</td>
              <td v-for="p in items" :key="p._key">
                <div class="mono">{{ p._specs.cpu }}</div>
                <div class="mono" style="color: var(--ink-secondary)">
                  {{ p._specs.memory }} · {{ p._specs.disk }}
                </div>
              </td>
            </tr>

            <!-- Bandwidth -->
            <tr :class="rowClass(rowDiffMap.bw)">
              <td class="cmp-metric-col">带宽与流量</td>
              <td v-for="p in items" :key="p._key">
                <div class="mono">{{ p._specs.bandwidth }}</div>
                <div class="mono" style="color: var(--ink-secondary)">{{ p._specs.traffic }}</div>
              </td>
            </tr>

            <!-- Original quote -->
            <tr :class="rowClass(rowDiffMap.origPrice)">
              <td class="cmp-metric-col">原始账单报价</td>
              <td v-for="p in items" :key="p._key">
                <div
                  class="mono"
                  style="font-weight: 700; font-size: var(--text-base)"
                  :title="p._pricing.originalLabel"
                >
                  {{ p._pricing.displayLabel }}
                </div>
                <div style="color: var(--ink-muted); margin-top: 2px">
                  周期：{{ p._pricing.quote.period }}
                </div>
              </td>
            </tr>

            <!-- CNY reference -->
            <tr :class="rowClass(rowDiffMap.cnyPrice)">
              <td class="cmp-metric-col">参考月均 (CNY)</td>
              <td v-for="p in items" :key="p._key">
                <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap">
                  <span
                    class="mono"
                    :style="{
                      fontWeight: 700,
                      color: p._pricing.cnyTone === 'ok' ? 'var(--ok-fg)' : 'var(--warn-fg)'
                    }"
                  >
                    {{ p._pricing.cnyLabel }}
                  </span>
                  <span v-if="isLowestPlan(p)" class="pill pill-ok">最低</span>
                </div>
              </td>
            </tr>

            <!-- Stock & evidence -->
            <tr :class="rowClass(rowDiffMap.stock)">
              <td class="cmp-metric-col">库存与证据等级</td>
              <td v-for="p in items" :key="p._key">
                <div style="display: flex; flex-direction: column; gap: 4px; align-items: flex-start">
                  <span
                    class="pill"
                    :class="
                      p.status === 'available'
                        ? p._isSnapshot
                          ? 'pill-warn'
                          : 'pill-ok'
                        : p.status === 'unavailable'
                          ? 'pill-danger'
                          : 'pill-neutral'
                    "
                  >
                    {{
                      p._isExactStock
                        ? `精确库存 ${p.stockCount}`
                        : plain(p.statusLabel) || p.status
                    }}
                  </span>
                  <span
                    v-if="
                      p.evidenceLevel?.label &&
                      p.evidenceLevel.label !==
                        (p._isExactStock
                          ? `精确库存 ${p.stockCount}`
                          : plain(p.statusLabel) || p.status)
                    "
                    style="color: var(--ink-muted)"
                  >
                    {{ p.evidenceLevel.label }}
                  </span>
                </div>
              </td>
            </tr>

            <!-- Risk audit -->
            <tr :class="rowClass(rowDiffMap.risk)">
              <td class="cmp-metric-col">风险审计</td>
              <td v-for="p in items" :key="p._key">
                <div
                  v-if="Array.isArray(p.riskTags) && p.riskTags.length"
                  style="display: flex; gap: 4px; flex-wrap: wrap"
                >
                  <span
                    v-for="t in p.riskTags"
                    :key="t.value"
                    class="pill"
                    :class="
                      t.severity === 'high'
                        ? 'pill-danger'
                        : t.severity === 'medium'
                          ? 'pill-warn'
                          : 'pill-ok'
                    "
                  >
                    {{ t.label }}
                  </span>
                </div>
                <span v-else style="color: var(--ink-muted)">无</span>
              </td>
            </tr>

            <!-- Order actions -->
            <tr :class="rowClass(false, true)">
              <td class="cmp-metric-col">官方直达</td>
              <td v-for="p in items" :key="p._key">
                <div style="display: flex; gap: 6px; flex-wrap: wrap">
                  <a
                    v-if="safeUrl(p.orderUrl)"
                    class="btn btn-xs btn-primary"
                    :href="safeUrl(p.orderUrl)"
                    target="_blank"
                    rel="nofollow noopener noreferrer"
                  >
                    去官网下单 ↗
                  </a>
                  <ElButton
                    size="small"
                    class="radar-el-btn"
                    data-action="inspect-from-compare"
                    :data-product-id="p.id"
                    @click="handleInspectFromCompare(p.id)"
                  >
                    证据详情
                  </ElButton>
                </div>
              </td>
            </tr>
        </tbody>
      </table>
    </ElDialog>
  </div>
</template>
