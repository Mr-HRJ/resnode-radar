<script setup>
import { computed } from "vue";
import {
  REVIEW_DOSSIERS,
  SHOP_TAG_DEFS,
  SHOP_TAG_ORDER,
  evaluateProviderTags,
  formatCny,
  normalizeSearch,
  plain,
  providerBaseWeight,
  providerHealth,
  providers,
  safeUrl
} from "@resnode-radar/contracts";
import ShopTagBadge from "../icons/ShopTagBadge.vue";
import PlanTagBadge from "../icons/PlanTagBadge.vue";
import { smartBrandMonogram } from "../../utils/plan-presenters.js";

const props = defineProps({
  store: {
    type: Object,
    required: true
  }
});

const PROV_QUICK_REGIONS = [
  ["all", "全部地区"],
  ["US", "US 美国"],
  ["CNHK", "HK 香港"],
  ["JP", "JP 日本"],
  ["CNTW", "TW 台湾"],
  ["SG", "SG 新加坡"],
  ["UK", "GB 英国"],
  ["DE", "DE 德国"],
  ["KR", "KR 韩国"]
];

const PROV_FEATURES = [
  ["all", "全部主营定位"],
  ["家宽", "家宽 / 住宅"],
  ["双 ISP", "双 ISP"],
  ["CN优化线路", "CN 优化线路"],
  ["纯落地", "纯落地"],
  ["性能", "高性能"],
  ["大盘鸡", "大盘鸡 / 存储"]
];

const PROV_SORTS = [
  ["recommended", "排序: 常用推荐优先"],
  ["avail-desc", "排序: 在售现货最多"],
  ["exact-desc", "排序: 精确库存最多"],
  ["price-asc", "排序: 最低月均从低到高"],
  ["name-asc", "排序: 品牌名称 A–Z"]
];

function formatProvRegionCode(code) {
  if (code === "CNHK") return "HK";
  if (code === "CNTW") return "TW";
  if (code === "UK") return "GB";
  if (code === "other") return "其他";
  return code;
}

function computeProviderPriceFloor(health) {
  const availPlans = (health.plans || []).filter((p) => p.status === "available");
  if (availPlans.length === 0) return { minCny: Infinity, label: "" };

  let bestCnyPlan = null;
  for (const p of availPlans) {
    const cny = p._pricing?.cnyMonthly;
    if (Number.isFinite(cny) && (!bestCnyPlan || cny < bestCnyPlan._pricing.cnyMonthly)) {
      bestCnyPlan = p;
    }
  }
  if (bestCnyPlan) {
    return {
      minCny: bestCnyPlan._pricing.cnyMonthly,
      label: `${formatCny(bestCnyPlan._pricing.cnyMonthly)}/月起`
    };
  }
  const firstWithPrice = availPlans.find(
    (p) => p._pricing?.displayLabel && p._pricing.displayLabel !== "未公开报价"
  );
  return {
    minCny: Infinity,
    label: firstWithPrice ? `${firstWithPrice._pricing.displayLabel}` : ""
  };
}

const pf = computed(() => props.store.state.providersFilter);
const sortMode = computed(() => props.store.state.providersSort || "recommended");

const enriched = computed(() =>
  providers.map((p) => {
    const health = providerHealth(p, props.store.allRecords.value);
    const priceFloor = computeProviderPriceFloor(health);
    const tagInfo = evaluateProviderTags(p, health.plans);
    return {
      provider: p,
      health,
      priceFloor,
      tagInfo,
      dossier: REVIEW_DOSSIERS[p.id] || null
    };
  })
);

const summaryKpis = computed(() => {
  let availableCount = 0;
  let issueCount = 0;
  let dossierCount = 0;
  let collectingCount = 0;
  const tagCounts = new Map(SHOP_TAG_ORDER.map((k) => [k, 0]));

  for (const item of enriched.value) {
    if (item.health.available > 0) availableCount += 1;
    if (["blocked", "partial"].includes(item.health.state) || item.health.pageLimitReached) {
      issueCount += 1;
    }
    if (item.dossier) dossierCount += 1;
    if (item.provider.directoryStatus === "collecting") collectingCount += 1;
    for (const t of item.tagInfo.tags) {
      if (tagCounts.has(t.key)) tagCounts.set(t.key, tagCounts.get(t.key) + 1);
    }
  }

  return { availableCount, issueCount, dossierCount, collectingCount, tagCounts };
});

const filteredProviders = computed(() => {
  const f = pf.value;
  const sort = sortMode.value;
  const query = normalizeSearch(f.q);

  return enriched.value
    .filter(({ provider, health, tagInfo, dossier }) => {
      if (f.health === "available" && health.available === 0) return false;
      if (
        f.health === "issue" &&
        health.state !== "blocked" &&
        health.state !== "partial" &&
        !health.pageLimitReached
      ) {
        return false;
      }
      if (f.health === "dossier" && !dossier) return false;
      if (f.health === "collecting" && provider.directoryStatus !== "collecting") return false;
      if (f.region !== "all" && !(provider.regions || []).includes(f.region)) return false;
      if (f.feature !== "all" && !(provider.features || []).includes(f.feature)) return false;
      if (f.tag && f.tag !== "all" && !tagInfo.tags.some((t) => t.key === f.tag)) return false;
      if (query) {
        const tagTerms = tagInfo.tags.flatMap((t) => [
          t.shortLabel,
          t.label,
          ...(t.searchAliases || [])
        ]);
        const hay = normalizeSearch(
          [
            provider.id,
            provider.name,
            ...(provider.aliases || []),
            ...(provider.features || []),
            ...(provider.regions || []),
            ...tagTerms,
            provider.directoryStatus === "collecting" ? "目录收集中 收集中 collecting" : ""
          ].join(" ")
        );
        if (!hay.includes(query)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (sort === "avail-desc") {
        return (
          b.health.available - a.health.available ||
          providerBaseWeight(b.provider.id) - providerBaseWeight(a.provider.id)
        );
      }
      if (sort === "exact-desc") {
        return b.health.exactCount - a.health.exactCount || b.health.available - a.health.available;
      }
      if (sort === "price-asc") {
        return a.priceFloor.minCny - b.priceFloor.minCny || b.health.available - a.health.available;
      }
      if (sort === "name-asc") {
        return a.provider.name.localeCompare(b.provider.name, "zh-CN");
      }
      return (
        Number(b.health.currentPlanCount > 0) - Number(a.health.currentPlanCount > 0) ||
        providerBaseWeight(b.provider.id) - providerBaseWeight(a.provider.id) ||
        Number(b.health.available > 0) - Number(a.health.available > 0) ||
        a.provider.name.localeCompare(b.provider.name, "zh-CN")
      );
    });
});

function planTagRank(p) {
  const k = p._primaryPlanTag?.key;
  if (k === "blockbuster") return 0;
  if (k === "generous") return 1;
  if (k === "home-opt") return 2;
  if (k === "annual") return 3;
  if (k === "perf") return 4;
  if (k === "value") return 5;
  if (k === "scarce") return 6;
  if (k === "budget") return 7;
  return 8;
}

function getSampleAvailPlans(health) {
  return (health.plans || [])
    .filter((p) => p.status === "available")
    .sort(
      (a, b) =>
        planTagRank(a) - planTagRank(b) ||
        (a._pricing?.cnyMonthly ?? Infinity) - (b._pricing?.cnyMonthly ?? Infinity)
    )
    .slice(0, 2);
}

function healthPct(health, count) {
  const sum = Math.max(
    1,
    health.available + health.unavailable + health.unknown + health.blocked + health.error
  );
  return `${((count / sum) * 100).toFixed(1)}%`;
}

function toggleRegionFilter(val) {
  const cur = pf.value.region;
  props.store.patchProviders({ region: val !== "all" && cur === val ? "all" : val });
}
</script>

<template>
  <div v-if="store.state.loadState === 'loading'" class="skeleton-stack">
    <span class="skel" style="height: 28px; width: 45%"></span>
    <span class="skel" style="height: 260px; width: 100%"></span>
  </div>

  <section v-else-if="store.state.loadState === 'error'" class="empty-state-card is-error">
    <h2 class="empty-state-title">无法加载商家库存与监控状态</h2>
    <p class="empty-state-desc">
      上游快照接口当前不可用（{{ store.state.errorDetail?.detail || "Fetch error" }}），暂时无法判断商家的套餐与库存。
    </p>
    <div>
      <button
        type="button"
        class="btn btn-primary"
        data-action="refresh-snapshot"
        @click="store.refreshSnapshot({ force: true })"
      >
        ↻ 重试读取
      </button>
    </div>
  </section>

  <template v-else>
    <section class="prov-deck" aria-label="商家名录与健康度筛选工作台">
      <div class="prov-deck-top">
        <div class="prov-deck-heading">
          <h1 class="radar-deck-title">商家目录与监控源健康（{{ providers.length }} 家）</h1>
          <span class="prov-deck-sub">
            绑定官方源 · 诚实披露 WAF 受阻与 <code>pageLimitReached</code> 诊断
          </span>
        </div>

        <div class="prov-kpi-pills" role="group" aria-label="按采集健康度筛选">
          <button
            type="button"
            class="radar-type-btn"
            :class="{ 'is-active': pf.health === 'all' }"
            data-action="set-prov-health"
            data-health="all"
            @click="store.patchProviders({ health: 'all' })"
          >
            <span>全部收录</span>
            <strong class="kpi-val num">{{ providers.length }}</strong>
          </button>
          <button
            type="button"
            class="radar-type-btn is-ok"
            :class="{ 'is-active': pf.health === 'available' }"
            data-action="set-prov-health"
            data-health="available"
            @click="store.patchProviders({ health: 'available' })"
          >
            <span>● 有现货商家</span>
            <strong class="kpi-val num">{{ summaryKpis.availableCount }}</strong>
          </button>
          <button
            type="button"
            class="radar-type-btn is-danger"
            :class="{ 'is-active': pf.health === 'issue' }"
            data-action="set-prov-health"
            data-health="issue"
            @click="store.patchProviders({ health: 'issue' })"
          >
            <span>⚠ 受阻 / 异常</span>
            <strong class="kpi-val num">{{ summaryKpis.issueCount }}</strong>
          </button>
          <button
            type="button"
            class="radar-type-btn"
            :class="{ 'is-active': pf.health === 'dossier' }"
            data-action="set-prov-health"
            data-health="dossier"
            @click="store.patchProviders({ health: 'dossier' })"
          >
            <span>★ 实测档案</span>
            <strong class="kpi-val num">{{ summaryKpis.dossierCount }}</strong>
          </button>
          <button
            v-if="summaryKpis.collectingCount > 0"
            type="button"
            class="radar-type-btn"
            :class="{ 'is-active': pf.health === 'collecting' }"
            data-action="set-prov-health"
            :data-health="pf.health === 'collecting' ? 'all' : 'collecting'"
            title="筛选 MeowVPS 源目录中标注为「收集中」的商家"
            @click="
              store.patchProviders({
                health: pf.health === 'collecting' ? 'all' : 'collecting'
              })
            "
          >
            <span>仅看收集中 ({{ summaryKpis.collectingCount }})</span>
          </button>
        </div>
      </div>

      <div class="prov-deck-bar">
        <div class="prov-region-pills" role="group" aria-label="按覆盖地区一键筛选">
          <button
            v-for="[val, lbl] in PROV_QUICK_REGIONS"
            :key="val"
            type="button"
            class="f-pill"
            :class="
              pf.region === val ? (val === 'all' ? 'is-all-default' : 'is-active') : ''
            "
            data-action="set-prov-region"
            :data-prov-region="val"
            @click="toggleRegionFilter(val)"
          >
            {{ lbl }}
          </button>
        </div>

        <div class="radar-filter-cluster">
          <div class="input-wrap" style="width: 208px">
            <input
              type="search"
              class="input-field"
              style="height: 28px"
              data-provider-search
              :value="pf.q"
              placeholder="搜商家、别名或标签（热门 / 低价）…"
              aria-label="搜索商家"
              @input="store.patchProviders({ q: $event.target.value })"
            />
          </div>

          <select
            class="select-field mini-select"
            data-provider-select="tag"
            aria-label="按商家标签筛选"
            :value="pf.tag || 'all'"
            @change="store.patchProviders({ tag: $event.target.value })"
          >
            <option value="all">全部商家标签</option>
            <option v-for="k in SHOP_TAG_ORDER" :key="k" :value="k">
              {{ SHOP_TAG_DEFS[k].label }} ({{ summaryKpis.tagCounts.get(k) || 0 }})
            </option>
          </select>

          <select
            class="select-field mini-select"
            data-provider-select="feature"
            aria-label="按商家定位筛选"
            :value="pf.feature"
            @change="store.patchProviders({ feature: $event.target.value })"
          >
            <option v-for="[v, l] in PROV_FEATURES" :key="v" :value="v">{{ l }}</option>
          </select>

          <select
            class="select-field mini-select"
            data-provider-sort
            aria-label="商家排序方式"
            :value="sortMode"
            @change="store.setProvidersSort($event.target.value)"
          >
            <option v-for="[v, l] in PROV_SORTS" :key="v" :value="v">{{ l }}</option>
          </select>

          <button
            v-if="
              pf.q ||
              pf.region !== 'all' ||
              pf.feature !== 'all' ||
              (pf.tag && pf.tag !== 'all') ||
              pf.health !== 'all' ||
              sortMode !== 'recommended'
            "
            type="button"
            class="btn btn-xs btn-ghost"
            data-action="reset-providers"
            @click="store.resetProviders()"
          >
            重置
          </button>

          <span class="radar-hit-count num">
            <strong>{{ filteredProviders.length }}</strong> / {{ providers.length }} 家
          </span>
        </div>
      </div>
    </section>

    <section v-if="filteredProviders.length === 0" class="empty-state-card">
      <h2 class="empty-state-title">没有匹配当前条件的商家</h2>
      <div>
        <button
          type="button"
          class="btn btn-primary"
          data-action="reset-providers"
          @click="store.resetProviders()"
        >
          重置商家筛选
        </button>
      </div>
    </section>

    <div v-else class="provider-grid">
      <article
        v-for="({ provider, health, priceFloor, tagInfo, dossier }, idx) in filteredProviders"
        :key="provider.id"
        class="provider-card"
        :class="{
          'is-blocked': health.state === 'blocked',
          'has-issue': health.state === 'partial' || health.pageLimitReached
        }"
        :data-provider-id="provider.id"
        :style="{ '--stagger-i': Math.min(idx, 14) }"
      >
        <div class="provider-head">
          <div class="provider-ident">
            <span
              class="provider-avatar"
              :class="{
                'is-healthy': health.available > 0,
                'is-blocked': health.state === 'blocked'
              }"
            >
              {{ smartBrandMonogram(provider) }}
            </span>
            <div class="provider-name-wrap">
              <div class="provider-title-row">
                <ShopTagBadge
                  v-for="t in tagInfo.tags"
                  :key="t.key"
                  :tag="t"
                  interactive
                  @select="store.filterByProviderTag($event)"
                />
                <h3 class="provider-name" :title="provider.name">{{ provider.name }}</h3>
              </div>
              <div class="provider-aliases">
                {{
                  (provider.aliases || []).filter((a) => a !== provider.name).length
                    ? `别名：${(provider.aliases || []).filter((a) => a !== provider.name).join(" / ")}`
                    : `ID: ${provider.id}`
                }}
              </div>
            </div>
          </div>

          <span v-if="health.state === 'healthy'" class="pill pill-ok">● 正常采集</span>
          <span v-else-if="health.state === 'partial'" class="pill pill-warn">◐ 部分受限</span>
          <span v-else-if="health.state === 'blocked'" class="pill pill-danger">✕ 直连受阻</span>
          <span v-else-if="health.state === 'soldout'" class="pill pill-neutral">○ 暂告售罄</span>
          <span v-else class="pill pill-neutral pill-outline">? 状态待核</span>
        </div>

        <div class="prov-tag-matrix">
          <span
            v-for="feat in provider.features || []"
            :key="feat"
            class="net-micro-tag"
            :class="
              feat === '家宽' || feat === '双 ISP'
                ? 'is-home'
                : feat === 'CN优化线路'
                  ? 'is-9929'
                  : 'is-bgp'
            "
          >
            {{ feat }}
          </span>
          <span
            v-for="rc in (provider.regions || []).filter((r) => r !== 'other').slice(0, 6)"
            :key="rc"
            class="iso-code"
          >
            {{ formatProvRegionCode(rc) }}
          </span>
          <span
            v-if="(provider.regions || []).includes('other') || (provider.regions || []).length > 6"
            class="iso-code"
          >
            +多国
          </span>
          <span
            v-if="provider.directoryStatus === 'collecting'"
            class="net-micro-tag is-muted"
            title="MeowVPS 源目录尚在收集整理中，本站已同步接入官方页面监测"
          >
            目录收集中
          </span>
          <span
            v-if="health.pageLimitReached"
            class="net-micro-tag is-warn"
            title="公开目录页数达到单轮采集上限，非全量覆盖"
          >
            目录页触顶
          </span>
          <a
            v-if="dossier"
            class="net-micro-tag is-warn"
            style="text-decoration: none"
            :href="dossier.path"
          >
            实测档案 →
          </a>
        </div>

        <div class="prov-health-block">
          <div class="health-bar" aria-label="库存状态分布">
            <span
              v-if="health.available"
              class="health-seg-ok"
              :style="{ width: healthPct(health, health.available) }"
            ></span>
            <span
              v-if="health.unavailable"
              class="health-seg-sold"
              :style="{ width: healthPct(health, health.unavailable) }"
            ></span>
            <span
              v-if="health.unknown"
              class="health-seg-unk"
              :style="{ width: healthPct(health, health.unknown) }"
            ></span>
            <span
              v-if="health.blocked + health.error"
              class="health-seg-blk"
              :style="{ width: healthPct(health, health.blocked + health.error) }"
            ></span>
          </div>

          <div class="health-metrics">
            <span>
              现货 <strong style="color: var(--ok-fg)">{{ health.available }}</strong>
            </span>
            <span v-if="health.exactCount">
              精确 <strong style="color: var(--ok-fg)">{{ health.exactCount }}</strong>
            </span>
            <span>
              售罄 <strong>{{ health.unavailable }}</strong>
            </span>
            <span v-if="health.unknown">
              未明 <strong>{{ health.unknown }}</strong>
            </span>
            <span v-if="health.blocked + health.error" style="color: var(--danger-fg)">
              受阻 <strong>{{ health.blocked + health.error }}</strong>
            </span>
            <span
              v-if="priceFloor.label"
              class="prov-price-floor num"
              title="当前在售套餐最低参考价"
            >
              {{ priceFloor.label }}
            </span>
          </div>
        </div>

        <div
          v-if="getSampleAvailPlans(health).length > 0"
          class="prov-sample-list"
          aria-label="该商家当前可购代表方案"
        >
          <button
            v-for="sp in getSampleAvailPlans(health)"
            :key="sp.id"
            type="button"
            class="prov-sample-item"
            data-action="inspect-plan"
            :data-product-id="sp.id"
            @click="store.openInspector(sp.id)"
          >
            <span class="prov-sample-lead">
              <PlanTagBadge v-if="sp._primaryPlanTag" :tag="sp._primaryPlanTag" compact />
              <span class="prov-sample-name">{{ plain(sp.name) }}</span>
            </span>
            <span class="prov-sample-price mono num">{{ sp._pricing?.displayLabel || "" }}</span>
          </button>
        </div>
        <div v-else-if="health.diagnostics.length === 0" class="prov-idle-note">
          {{
            health.planCount > 0
              ? `当前快照暂未检出可购现货（共收录 ${health.planCount} 款套餐，可点下方查看或前往官网核对）`
              : provider.directoryStatus === "collecting"
                ? "源目录收集中，已绑定官方站点持续巡检，可直达官网查阅最新方案"
                : "当前公开页面未提供固定周期公开目录，请直接访问官网查阅"
          }}
        </div>

        <details
          v-if="health.diagnostics.length"
          class="diag-box"
          :class="{ 'is-warn': health.available > 0 }"
        >
          <summary>查看采集诊断证据（{{ health.diagnostics.length }} 条）</summary>
          <div style="margin-top: 8px; display: flex; flex-direction: column; gap: 6px">
            <div
              v-for="d in health.diagnostics"
              :key="d.id"
              style="
                padding: 6px 8px;
                border-radius: var(--r-xs);
                background: var(--bg-surface);
                color: var(--ink-secondary);
              "
            >
              <div class="mono" style="font-weight: 600; color: var(--ink-primary)">
                {{ plain(d.statusLabel || d.status) }}
                {{ d.httpStatus ? `· HTTP ${d.httpStatus}` : "" }}
              </div>
              <div style="margin-top: 2px; overflow-wrap: anywhere">
                {{ plain(d.evidence || d.error || "无详细说明") }}
              </div>
              <div
                v-if="Array.isArray(d.raw?.attempts) && d.raw.attempts.length"
                class="mono"
                style="margin-top: 4px; font-size: 10.5px; color: var(--ink-muted)"
              >
                已尝试 {{ d.raw.attempts.length }} 次公开抓取：{{
                  d.raw.attempts
                    .slice(0, 3)
                    .map((a) => `${a.statusCode ?? a.httpStatus ?? "ERR"} ${a.url || ""}`)
                    .join(" | ")
                }}
              </div>
            </div>
          </div>
        </details>

        <div
          v-if="safeUrl(provider.officialEvidence)"
          style="font-size: 11px; color: var(--ink-secondary)"
        >
          官方迁移公告：<a
            :href="safeUrl(provider.officialEvidence)"
            target="_blank"
            rel="nofollow noopener noreferrer"
          >查看依据 ↗</a>
        </div>

        <div class="provider-foot">
          <div style="display: flex; gap: 10px; align-items: center; font-size: var(--text-xs)">
            <a
              v-if="safeUrl(provider.website)"
              :href="safeUrl(provider.website)"
              target="_blank"
              rel="nofollow noopener noreferrer"
            >
              官网 ↗
            </a>
            <a
              v-if="safeUrl(provider.directorySource)"
              style="color: var(--ink-muted)"
              :href="safeUrl(provider.directorySource)"
              target="_blank"
              rel="nofollow noopener noreferrer"
            >
              目录 ↗
            </a>
          </div>
          <button
            type="button"
            class="btn btn-xs"
            :class="
              health.available > 0 ? 'btn-primary' : health.planCount > 0 ? 'btn-soft' : ''
            "
            data-action="drill-provider"
            :data-provider-id="provider.id"
            :disabled="health.planCount === 0"
            @click="store.drillProvider(provider.id)"
          >
            {{ health.planCount > 0 ? `筛选 ${health.planCount} 款套餐 →` : "暂无固定套餐" }}
          </button>
        </div>
      </article>
    </div>
  </template>
</template>
