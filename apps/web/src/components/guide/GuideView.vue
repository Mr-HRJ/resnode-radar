<script setup>
import { computed } from "vue";
import { ElButton, ElProgress } from "element-plus";
import {
  DEFAULT_FILTERS,
  PLAN_TAG_DEFS,
  PLAN_TAG_ORDER,
  SHOP_TAG_DEFS,
  SHOP_TAG_ORDER,
  matchesFilters,
  matchesRoute
} from "@resnode-radar/contracts";
import ShopTagBadge from "../icons/ShopTagBadge.vue";
import PlanTagBadge from "../icons/PlanTagBadge.vue";

const props = defineProps({
  store: {
    type: Object,
    required: true
  }
});

const ROUTE_LADDER = [
  {
    key: "cn2",
    group: "ct",
    tier: "T0 旗舰",
    tierClass: "is-t0",
    name: "电信 CN2 GIA",
    asn: "AS4809",
    badgeTone: "is-cn2",
    stability: 95,
    peakNote: "三网晚高峰抖动最低、跨洋拥塞控制最强",
    pitfall: "核对是「三网双程 GIA」还是「仅电信单网回程 GIA」"
  },
  {
    key: "9929",
    group: "cu",
    tier: "T0 旗舰",
    tierClass: "is-t0",
    name: "联通精品网 9929",
    asn: "AS9929 / CUII",
    badgeTone: "is-9929",
    stability: 92,
    peakNote: "联通高端国际骨干，欧美方向晚高峰表现极稳",
    pitfall: "常见于美西与法兰克福双 ISP 住宅回程方案"
  },
  {
    key: "cmin2",
    group: "cm",
    tier: "T0 旗舰",
    tierClass: "is-t0",
    name: "移动精品网 CMIN2",
    asn: "AS58807",
    badgeTone: "is-cmin2",
    stability: 91,
    peakNote: "移动新一代高端专网，彻底改善移动宽带跨洋丢包",
    pitfall: "区分高端 CMIN2 (AS58807) 与普通 CMI 直连 (AS58453)"
  },
  {
    key: "4837",
    group: "cu",
    tier: "T1 主力",
    tierClass: "is-t1",
    name: "联通 4837 直连",
    asn: "AS4837",
    badgeTone: "is-4837",
    stability: 76,
    peakNote: "大带宽、高流量性价比之选，许多美西双 ISP 采用",
    pitfall: "晚高峰带宽竞争大于 9929，需关注端口是独享还是共享峰值"
  },
  {
    key: "iij_sb",
    group: "apac",
    tier: "T1 亚太",
    tierClass: "is-t1",
    name: "日本 软银 / IIJ",
    asn: "AS17676 / AS2497",
    badgeTone: "is-jp",
    stability: 74,
    peakNote: "联通直连软银低延迟，日本本土民宅常见 SoftBank 宿主",
    pitfall: "部分南方电信直连晚高峰存在绕路或波动"
  },
  {
    key: "hinet",
    group: "apac",
    tier: "T1 亚太",
    tierClass: "is-t1",
    name: "台湾中华电信 HiNet",
    asn: "AS3462",
    badgeTone: "is-jp",
    stability: 72,
    peakNote: "台湾原生家宽标杆，流媒体与繁体业务解锁纯净度高",
    pitfall: "大多为动态 IP 或共享 NAT 端口，买前务必确认交付形态"
  },
  {
    key: "bgp",
    group: "apac",
    tier: "T2 落地",
    tierClass: "is-t2",
    name: "BGP 国际互联",
    asn: "NTT / Cogent / GTT",
    badgeTone: "is-bgp",
    stability: 42,
    peakNote: "海外互联带宽充沛、单价极低，适合做中转后端纯落地",
    pitfall: "无内地直连保障，切勿当作直连主力机裸连使用"
  }
];

const CHECKLIST_STEPS = [
  {
    id: "chk-nat",
    step: "STEP 01 · 下单前",
    title: "确认「独立 IPv4」还是「NAT 共享端口」",
    desc: "在本站套餐详情抽屉查看是否带有 NAT/共享 警告；动态共享端口无法绑定 80/443 且邻里风控互相牵连。",
    toolLabel: "开启排除 NAT 选机",
    toolAction: "guide-jump-nonat"
  },
  {
    id: "chk-asn",
    step: "STEP 02 · 交付后",
    title: "在 bgp.tools 核验上游 ASN 宿主属性",
    desc: "输入分配到的 IPv4，查看归属 ASN 是否为真实宽带运营商（如 AT&T AS7018 / Verizon AS701），而非机房 IDC。",
    toolLabel: "打开 bgp.tools ↗",
    toolHref: "https://bgp.tools/"
  },
  {
    id: "chk-ipinfo",
    step: "STEP 03 · 交付后",
    title: "在 IPinfo 校验 asn.type 与 company.type 双字段",
    desc: '只有 asn.type = "isp" 且 company.type = "isp" 同时成立，才属于严格意义上的「真双 ISP 住宅段」。',
    toolLabel: "打开 IPinfo.io ↗",
    toolHref: "https://ipinfo.io/"
  },
  {
    id: "chk-mtr",
    step: "STEP 04 · 晚高峰",
    title: "20:30–23:00 实测三网回程路由与持续丢包",
    desc: "在退换期内使用 ping.pe 或 NextTrace 跑三网回程，确认去回程均命中商家承诺的 4809 / 9929 / 58807 节点。",
    toolLabel: "打开 ping.pe ↗",
    toolHref: "https://ping.pe/"
  }
];

function countMatching(patch) {
  const list = props.store.plans.value;
  if (!list.length) return null;
  const f = { ...DEFAULT_FILTERS, status: "available", ...patch };
  let n = 0;
  for (const p of list) {
    if (matchesFilters(p, f, props.store.state.savedKeys)) n += 1;
  }
  return n;
}

const stats = computed(() => {
  const list = props.store.plans.value;
  let homeTotal = 0;
  let nativeDcTotal = 0;
  let natTotal = 0;
  let snapTotal = 0;
  let orderOnlyTotal = 0;
  for (const p of list) {
    if (p.status !== "available") continue;
    if (p._classify?.isResidential) homeTotal += 1;
    else if (p._classify?.isNativeIp) nativeDcTotal += 1;
    if (p._classify?.isNat) natTotal += 1;
    if (p._isSnapshot) snapTotal += 1;
    else if (!p._isExactStock) orderOnlyTotal += 1;
  }
  const blockedCount = props.store.diagnostics.value.filter(
    (d) => d.status === "blocked" || d.status === "error"
  ).length;

  return {
    usHomeCount: countMatching({ track: "home", region: "US", noNat: true }),
    cn2Count: countMatching({ route: "cn2" }),
    budgetCount: countMatching({ budget: "60", cycle: "monthly", fixedPriceOnly: true }),
    exactCount: countMatching({ exactOnly: true }),
    homeTotal,
    nativeDcTotal,
    natTotal,
    snapTotal,
    orderOnlyTotal,
    blockedCount
  };
});

const visibleRoutes = computed(() => {
  const tab = props.store.state.guideRouteTab || "all";
  return ROUTE_LADDER.filter((r) => tab === "all" || r.group === tab).map((rt) => {
    const list = props.store.plans.value;
    const liveCnt = list.length
      ? list.filter((p) => p.status === "available" && matchesRoute(p, rt.key)).length
      : null;
    return { ...rt, liveCnt };
  });
});

const checkedCount = computed(
  () => CHECKLIST_STEPS.filter((s) => props.store.state.guideChecked.has(s.id)).length
);

function jumpTerminal(patch) {
  props.store.setView("terminal");
  props.store.updateFilters({ ...DEFAULT_FILTERS, status: "available", ...patch });
}
</script>

<template>
  <section class="prov-deck guide-hero-deck" aria-label="选机避坑与交互核验工坊">
    <div class="prov-deck-top">
      <div class="prov-deck-heading">
        <h1 class="radar-deck-title">选机避坑手册 · 真伪核验交互工坊</h1>
        <span class="prov-deck-sub">
          用工程证据拆穿营销话术：从「真假双 ISP 隔离」「三网回程天梯」到「账单防套路熔断」一站自检
        </span>
      </div>
      <div style="display: flex; gap: 8px; align-items: center">
        <a class="btn btn-xs btn-soft" href="reviews/aaitr.html">AaITR 实测档案 →</a>
        <a class="btn btn-xs btn-soft" href="reviews/lisahost.html">LisaHost 实测档案 →</a>
      </div>
    </div>
  </section>

  <!-- 1. 四大高频选机发射台 -->
  <div class="guide-presets" aria-label="高频业务场景一键直达">
    <button
      type="button"
      class="guide-preset-card is-accent-home"
      style="--stagger-i: 0"
      data-action="apply-preset"
      data-preset="us-home-dedicated"
      @click="store.applyPreset('us-home-dedicated')"
    >
      <div class="preset-card-head">
        <span class="badge-solid badge-solid-home">跨境社媒 / TikTok</span>
        <span v-if="stats.usHomeCount !== null" class="preset-live-cnt num">
          {{ stats.usHomeCount }} 款可购 →
        </span>
      </div>
      <strong>美区真家宽（剔除 NAT）</strong>
      <span>强制隔离机房假“原生 IP”，排除动态共享端口，直达美区本土住宅宿主。</span>
    </button>

    <button
      type="button"
      class="guide-preset-card is-accent-opt"
      style="--stagger-i: 1"
      data-action="apply-preset"
      data-preset="cn2-opt"
      @click="store.applyPreset('cn2-opt')"
    >
      <div class="preset-card-head">
        <span class="badge-solid badge-solid-opt">低延迟建站 / 远程</span>
        <span v-if="stats.cn2Count !== null" class="preset-live-cnt num">
          {{ stats.cn2Count }} 款可购 →
        </span>
      </div>
      <strong>电信 CN2 回程线路</strong>
      <span>筛选标注 CN2 的现货；GIA、GT 及具体回程以各套餐声明为准。</span>
    </button>

    <button
      type="button"
      class="guide-preset-card is-accent-budget"
      style="--stagger-i: 2"
      data-action="apply-preset"
      data-preset="budget-monthly"
      @click="store.applyPreset('budget-monthly')"
    >
      <div class="preset-card-head">
        <span class="badge-solid badge-solid-landing">低成本月付试错</span>
        <span v-if="stats.budgetCount !== null" class="preset-live-cnt num">
          {{ stats.budgetCount }} 款可购 →
        </span>
      </div>
      <strong>≤ ￥60/月 明码固定月付</strong>
      <span>剔除选配起步价与长周期绑定，基于有效 ECB 汇率锁定低门槛月付方案。</span>
    </button>

    <button
      type="button"
      class="guide-preset-card is-accent-exact"
      style="--stagger-i: 3"
      data-action="apply-preset"
      data-preset="exact-stock"
      @click="store.applyPreset('exact-stock')"
    >
      <div class="preset-card-head">
        <span class="badge-solid badge-solid-native">最高库存确定性</span>
        <span v-if="stats.exactCount !== null" class="preset-live-cnt num">
          {{ stats.exactCount }} 款可购 →
        </span>
      </div>
      <strong>官方明报精确余量现货</strong>
      <span>只看官方接口/页面返回明确正整数库存（余 N）的方案，告别下单后缺货。</span>
    </button>
  </div>

  <!-- 2. IP 宿主对比 + 4 步交互验真器 -->
  <div class="guide-bento-grid">
    <section class="guide-panel" style="--stagger-i: 4" aria-label="真家宽与机房原生IP本质对比">
      <div class="guide-panel-head">
        <div>
          <span class="guide-step-kicker">ONTOLOGY ISOLATION</span>
          <h2>一图分清「真家宽 · 双ISP」与「机房原生 IP」</h2>
        </div>
        <span class="pill pill-home">风控核心分水岭</span>
      </div>

      <div class="ip-spectrum-grid">
        <div class="ip-tier-box is-tier-home">
          <div class="ip-tier-top">
            <span class="badge-solid badge-solid-home">家宽·双ISP</span>
            <span class="mono num" style="font-size: 11px; color: var(--home-fg)">
              在售 {{ stats.homeTotal }} 款
            </span>
          </div>
          <div class="ip-tier-asn mono">asn.type: <strong>isp</strong> + company: <strong>isp</strong></div>
          <p>
            上游与归属均为真实宽带运营商（AT&amp;T / Verizon / Frontier / SoftBank / HiNet），社媒、支付风控信任度最高。
          </p>
          <ElButton
            size="small"
            type="primary"
            plain
            class="radar-el-btn"
            data-action="guide-jump-track"
            data-track="home"
            @click="jumpTerminal({ track: 'home' })"
          >
            筛选真家宽 →
          </ElButton>
        </div>

        <div class="ip-tier-box is-tier-dc">
          <div class="ip-tier-top">
            <span class="badge-solid badge-solid-native">机房原生IP</span>
            <span class="mono num" style="font-size: 11px; color: var(--purple-fg)">
              在售 {{ stats.nativeDcTotal }} 款
            </span>
          </div>
          <div class="ip-tier-asn mono">asn.type: <strong>hosting</strong> (本地注册)</div>
          <p>
            WHOIS 国籍与机房物理所在地一致，可解锁部分流媒体，但宿主仍是数据中心，<strong>绝不可混充住宅宽带</strong>。
          </p>
          <ElButton
            size="small"
            class="radar-el-btn"
            data-action="guide-jump-opt"
            data-opt="native"
            data-track="vps"
            @click="jumpTerminal({ opt: 'native', track: 'vps' })"
          >
            查看原生IP →
          </ElButton>
        </div>

        <div class="ip-tier-box is-tier-nat">
          <div class="ip-tier-top">
            <span class="pill pill-warn">NAT 共享端口</span>
            <span class="mono num" style="font-size: 11px; color: var(--warn-fg)">
              在售 {{ stats.natTotal }} 款
            </span>
          </div>
          <div class="ip-tier-asn mono">1 个公网 IPv4 · 多户共享端口段</div>
          <p>
            价格低廉（常见于 HiNet/日本民宅合租），适合轻量解锁中转，但无独立 80/443 端口且易受邻居牵连。
          </p>
          <ElButton
            size="small"
            class="radar-el-btn"
            data-action="guide-jump-nonat"
            @click="jumpTerminal({ noNat: true })"
          >
            一键排除 NAT →
          </ElButton>
        </div>
      </div>

      <div class="scene-fit-matrix" aria-label="主流业务场景IP宿主准入速查">
        <div class="scene-fit-row">
          <strong>TikTok 运营 / 跨境电商店铺</strong>
          <span class="net-micro-tag is-home">必须真家宽·双ISP</span>
          <span class="scene-fit-note">严查宿主 ASN，禁用机房段与共享端口</span>
        </div>
        <div class="scene-fit-row">
          <strong>AI 工具解锁 / 流媒体日常观看</strong>
          <span class="net-micro-tag is-native">家宽 / 机房原生均可</span>
          <span class="scene-fit-note">关注 IP 归属国与 DNS 原生解锁纯净度</span>
        </div>
        <div class="scene-fit-row">
          <strong>建站 / API 网关 / 自建独立服务</strong>
          <span class="net-micro-tag is-9929">必须独立 IPv4</span>
          <span class="scene-fit-note">需独占 80/443 端口，务必排除 NAT</span>
        </div>
        <div class="scene-fit-row">
          <strong>中转后端落地 / 大流量传输备份</strong>
          <span class="net-micro-tag is-bgp">普通机房高性价比</span>
          <span class="scene-fit-note">优先看端口带宽峰值与月流量配额</span>
        </div>
      </div>
    </section>

    <section class="guide-panel" style="--stagger-i: 5" aria-label="交互式四步验真自检清单">
      <div class="guide-panel-head">
        <div>
          <span class="guide-step-kicker">INTERACTIVE CHECKLIST</span>
          <h2 id="guide-checklist-heading">买前 &amp; 交付后 4 步验真自检表</h2>
        </div>
        <span
          class="pill num"
          :class="checkedCount === CHECKLIST_STEPS.length ? 'pill-ok' : 'pill-vps'"
        >
          已核验 {{ checkedCount }}/{{ CHECKLIST_STEPS.length }}
        </span>
      </div>

      <ElProgress
        aria-labelledby="guide-checklist-heading"
        :percentage="Math.round((checkedCount / CHECKLIST_STEPS.length) * 100)"
        :stroke-width="6"
        :show-text="false"
        :status="checkedCount === CHECKLIST_STEPS.length ? 'success' : undefined"
        style="margin: 8px 0 12px"
      />

      <div class="guide-checklist">
        <div
          v-for="item in CHECKLIST_STEPS"
          :key="item.id"
          class="guide-check-item"
          :class="{ 'is-checked': store.state.guideChecked.has(item.id) }"
        >
          <button
            type="button"
            class="guide-check-toggle"
            data-action="toggle-guide-check"
            :data-check-id="item.id"
            :aria-pressed="String(store.state.guideChecked.has(item.id))"
            @click="store.toggleGuideCheck(item.id)"
          >
            <span class="guide-check-box">
              {{ store.state.guideChecked.has(item.id) ? "✓" : "" }}
            </span>
            <div class="guide-check-text">
              <div class="guide-check-meta">{{ item.step }}</div>
              <strong>{{ item.title }}</strong>
              <span>{{ item.desc }}</span>
            </div>
          </button>
          <div class="guide-check-act">
            <a
              v-if="item.toolHref"
              class="btn btn-xs"
              :href="item.toolHref"
              target="_blank"
              rel="noopener noreferrer"
            >
              {{ item.toolLabel }}
            </a>
            <ElButton
              v-else
              size="small"
              type="primary"
              plain
              class="radar-el-btn"
              :data-action="item.toolAction"
              @click="jumpTerminal({ noNat: true })"
            >
              {{ item.toolLabel }}
            </ElButton>
          </div>
        </div>
      </div>
    </section>
  </div>

  <!-- 3. 交互式三网回程等级天梯 -->
  <section
    class="guide-panel"
    style="--stagger-i: 6; margin-top: var(--sp-4)"
    aria-label="回程骨干线路交互式天梯"
  >
    <div class="guide-panel-head">
      <div>
        <span class="guide-step-kicker">BACKBONE TIER EXPLORER</span>
        <h2>三网回程骨干等级天梯与实时现货直达</h2>
      </div>
      <div class="facet-wrap" role="group" aria-label="按运营商筛选线路天梯">
        <button
          v-for="[val, lbl] in [
            ['all', '全部骨干'],
            ['ct', '中国电信'],
            ['cu', '中国联通'],
            ['cm', '中国移动'],
            ['apac', '亚太 / 国际']
          ]"
          :key="val"
          type="button"
          class="f-pill"
          :class="{ 'is-active': store.state.guideRouteTab === val }"
          data-action="set-guide-route-tab"
          :data-route-tab="val"
          @click="store.setGuideRouteTab(val)"
        >
          {{ lbl }}
        </button>
      </div>
    </div>

    <div class="route-ladder-list">
      <div v-for="rt in visibleRoutes" :key="rt.key" class="route-ladder-row">
        <div class="ladder-col-ident">
          <span class="ladder-tier" :class="rt.tierClass">{{ rt.tier }}</span>
          <div>
            <div style="display: flex; align-items: center; gap: 6px">
              <strong>{{ rt.name }}</strong>
              <span class="net-micro-tag mono" :class="rt.badgeTone">{{ rt.asn }}</span>
            </div>
            <div class="ladder-sub">{{ rt.peakNote }}</div>
          </div>
        </div>

        <div class="ladder-col-meter" title="架构抗拥塞等级示意（非实测延迟跑分）">
          <div class="ladder-meter-lbl">
            <span>晚高峰架构优先级</span>
            <span class="mono">{{ rt.tier.split(" ")[0] }}</span>
          </div>
          <div class="region-bar-track">
            <span class="region-bar-fill" :style="{ width: `${rt.stability}%` }"></span>
          </div>
        </div>

        <div class="ladder-col-pitfall">
          <span class="pitfall-tag">避坑要点</span>
          <span>{{ rt.pitfall }}</span>
        </div>

        <div class="ladder-col-cta">
          <ElButton
            size="small"
            class="radar-el-btn"
            :type="rt.liveCnt ? 'primary' : 'default'"
            :plain="!rt.liveCnt"
            data-action="guide-jump-route"
            :data-route="rt.key"
            @click="jumpTerminal({ route: rt.key })"
          >
            {{ rt.liveCnt !== null ? `看现货 (${rt.liveCnt}) →` : "筛选此线路 →" }}
          </ElButton>
        </div>
      </div>
    </div>
  </section>

  <!-- 4. 库存证据四级天梯 & 账单防套路 -->
  <div class="guide-bento-grid" style="margin-top: var(--sp-4)">
    <section class="guide-panel" style="--stagger-i: 7" aria-label="库存证据可信度四级天梯">
      <div class="guide-panel-head">
        <div>
          <span class="guide-step-kicker">EVIDENCE TRUST LADDER</span>
          <h2>库存证据四级可信度分级（拒绝假有货）</h2>
        </div>
        <span class="pill pill-ok">20 分钟级源站巡检</span>
      </div>

      <div class="pricing-anatomy-list">
        <div class="anatomy-row is-good">
          <div class="anatomy-quote">
            <span class="pill pill-ok num">● 余 8 · 精确现货</span>
            <span class="mono num" style="font-size: 11px; color: var(--ok-fg)">
              当前 {{ stats.exactCount ?? "-" }} 款
            </span>
          </div>
          <div class="anatomy-desc">
            <strong>L1 最高置信 · 官方明报余量</strong>
            <span>官方公开页或账单接口直接返回明确正整数库存，下单确定性最高。</span>
          </div>
        </div>

        <div class="anatomy-row is-info">
          <div class="anatomy-quote">
            <span class="pill pill-vps">● 可订购入口</span>
            <span class="mono num" style="font-size: 11px; color: var(--vps-fg)">
              当前 {{ stats.orderOnlyTotal }} 款
            </span>
          </div>
          <div class="anatomy-desc">
            <strong>L2 官方订购可达 · 未公开余量</strong>
            <span>确认官方下单入口有效且无售罄标记，但商家未展示具体剩余台数。</span>
          </div>
        </div>

        <div class="anatomy-row is-warn">
          <div class="anatomy-quote">
            <span class="pill pill-warn">快照有货</span>
            <span class="mono num" style="font-size: 11px; color: var(--warn-fg)">
              当前 {{ stats.snapTotal }} 款
            </span>
          </div>
          <div class="anatomy-desc">
            <strong>L3 第三方公开快照回退（高风险提醒）</strong>
            <span>源站开启挑战盾时回退公开 Reader 快照，强制高亮提示前往官网复核。</span>
          </div>
        </div>

        <div class="anatomy-row is-danger">
          <div class="anatomy-quote">
            <span class="pill pill-danger">✕ 直连受阻</span>
            <span class="mono num" style="font-size: 11px; color: var(--danger-fg)">
              隔离 {{ stats.blockedCount }} 条
            </span>
          </div>
          <div class="anatomy-desc">
            <strong>L4 异常诊断独立隔离（绝不混充缺货）</strong>
            <span>WAF 拦截全部收纳于「商家名录」附原始 HTTP 尝试记录；超 30 分钟自动弹出陈旧预警。</span>
          </div>
        </div>
      </div>
    </section>

    <section class="guide-panel" style="--stagger-i: 8" aria-label="账单防套路与ECB汇率红线">
      <div class="guide-panel-head">
        <div>
          <span class="guide-step-kicker">HONEST PRICING ANATOMY</span>
          <h2>价格防套路拆解与 7 天 ECB 汇率熔断</h2>
        </div>
      </div>

      <div class="pricing-anatomy-list">
        <div class="anatomy-row is-good">
          <div class="anatomy-quote">
            <span class="mono" style="font-weight: 800; color: var(--price-main)">$72/年</span>
            <span class="mono" style="font-size: 11px; color: var(--price-cny)">折合 ￥42.0/月</span>
          </div>
          <div class="anatomy-desc">
            <strong>原币种账单置顶 + 明码自然月折算</strong>
            <span>保留官方实际结算周期与原金额（绝不把年付伪装成月付低价），下方基于欧洲央行（ECB）汇率单列月均比价参考。</span>
          </div>
        </div>

        <div class="anatomy-row is-warn">
          <div class="anatomy-quote">
            <span class="mono" style="font-weight: 800; color: var(--ink-primary)">$9.99/月起</span>
            <span class="pill pill-warn">起步价 · 停算</span>
          </div>
          <div class="anatomy-desc">
            <strong>选配起步价 / 非自然月周期拒绝强算</strong>
            <span>含 <code>from / 起 / configurable</code>、按 30 天或按小时计费的方案一律停止月均换算，防止钓鱼低价误导排序。</span>
          </div>
        </div>

        <div class="anatomy-row is-danger">
          <div class="anatomy-quote">
            <span class="pill pill-danger">ECB &gt; 7 天</span>
            <span class="mono" style="font-size: 11px; color: var(--danger-fg)">自动熔断外币折算</span>
          </div>
          <div class="anatomy-desc">
            <strong>7 天汇率新鲜度熔断 &amp; 非结算声明</strong>
            <span>一旦 ECB 汇率快照超过 7 天，前端自动暂停所有外币折算并弹出横幅告警；折算值不含 VAT 税费与发卡行手续费。</span>
          </div>
        </div>

        <div class="anatomy-row is-info">
          <div class="anatomy-quote">
            <div style="display: flex; gap: 4px; flex-wrap: wrap">
              <ShopTagBadge
                v-for="k in SHOP_TAG_ORDER.slice(0, 4)"
                :key="k"
                :tag="SHOP_TAG_DEFS[k]"
                compact
              />
              <PlanTagBadge
                v-for="k in PLAN_TAG_ORDER"
                :key="k"
                :tag="PLAN_TAG_DEFS[k]"
                compact
              />
            </div>
            <span class="mono" style="font-size: 11px; color: var(--ink-muted)">
              店铺 7 维 &amp; 商品 8 维
            </span>
          </div>
          <div class="anatomy-desc">
            <strong>店铺（7 维）与商品亮点（8 维）分口径严格核验（绝不瞎给标签）</strong>
            <span>
              店铺「热门」「老牌」按真实品牌资历核定，「家宽」「优线」「高配」「性价比」「低价」按实时非 NAT 现货占比核验；商品「爆款」「便宜量大」「年付惠」「性价比」「家宽直连」「高配」「紧俏」「低价」逐项校验真实核数、内存、端口带宽与流量底线，彻底剔除 1C/1G 假高配、10–30M 小水管、玩具容器与高价大切片。
            </span>
          </div>
        </div>
      </div>

      <div class="dossier-cta-strip">
        <div>
          <strong>站长一手实测档案库（诚实草稿标注，零虚构跑分）</strong>
          <span>共享同一套实时监控快照水合引擎</span>
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap">
          <a class="btn btn-xs btn-primary" href="reviews/aaitr.html">AaITR 住宅实测 →</a>
          <a class="btn btn-xs btn-primary" href="reviews/lisahost.html">LisaHost 双ISP实测 →</a>
        </div>
      </div>
    </section>
  </div>
</template>
