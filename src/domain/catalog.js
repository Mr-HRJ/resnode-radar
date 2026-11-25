import { providers } from "../../providers.js";
import { comparePrices } from "../../pricing.js";
import { savedKey } from "../../saved.js";
import { hasSharedIpEvidence } from "./network.js";
import {
  BANDWIDTH_OPTIONS,
  BUDGET_OPTIONS,
  CPU_OPTIONS,
  CYCLE_OPTIONS,
  DISK_OPTIONS,
  MACRO_REGIONS,
  MEMORY_OPTIONS,
  OPT_OPTIONS,
  ROUTE_OPTIONS,
  TRAFFIC_OPTIONS,
  describeLocation,
  describePricing,
  describeRouteProfile,
  declaredRouteText,
  detectedRoutes,
  macroRegionsFor,
  matchesRoute,
  normalizeSearch,
  parseNumericSpecs,
  plain,
  productRegions,
  productSearchText,
  productSpecs,
  regionFlag
} from "./format.js";

export const REVIEW_DOSSIERS = {
  aaitr: { path: "reviews/aaitr.html", title: "AaITR 家宽实测档案（草稿）" },
  lisahost: { path: "reviews/lisahost.html", title: "LisaHost 实测档案（草稿）" }
};

export const RISK_EXPLANATIONS = {
  "order-only": "官方页存在下单按钮，但未公布确切可售数量，结算时仍可能缺货。",
  "stock-unstated": "商家未展示实时库存数值，建议前往官方订购页确认。",
  "incomplete-fields": "部分硬件、地区或带宽字段未在官方公开页完整列出。",
  "nat-shared": "NAT 共享 IPv4 或动态共享端口方案，非独享独立 IPv4。",
  "no-extra-risk": "抓取阶段未检测到额外受阻、快照降级或共享限制风险。",
  "manual-confirm": "交付或库存需工单/客服人工确认。",
  "third-party-snapshot": "因官方站点开启反爬验证，当前数据来自第三方 Reader 公开快照，时效与字段弱于一手直连。",
  "direct-blocked": "监控直连触发 Cloudflare/WAF 挑战页，未能直接读取官方实时库存。",
  "price-missing": "公开页面未提取到明确数值报价，请以官方下单页结算金额为准。",
  unavailable: "当前监控记录显示为售罄或不可订购。",
  "unknown-status": "页面可达但未能解析出明确的库存可用信号。"
};

/**
 * Editorial provider order, not measured popularity. Catalog size is not demand.
 * The four owner-selected priority brands remain visible even when collection fails.
 */
export const POPULAR_PROVIDER_WEIGHTS = Object.freeze({
  bwh: 480,
  dmit: 475,
  gomami: 470,
  vmiss: 465,
  vps: 440,
  misaka: 435,
  lisahost: 430,
  greencloud: 425,
  lightlayer: 415,
  spartan: 410,
  rfc: 400,
  zgovps: 395,
  evoxt: 390,
  saltyfish: 385,
  isif: 380,
  zorocloud: 375,
  bestvm: 370,
  neburst: 365,
  berohost: 355,
  akko: 350,
  yunyoo: 345,
  bage: 340,
  racknerd: 335,
  netcup: 330,
  wepc: 325,
  boil: 320,
  "666clouds": 315,
  hostdare: 310,
  vircs: 305,
  ipraft: 300,
  pqs: 295,
  nube: 285,
  cstonecloud: 280,
  polocloud: 275,
  usvps24: 270,
  tothost: 265,
  moonvm: 260,
  cloudsilk: 255,
  buyvm: 250,
  hosthatch: 245,
  aaitr: 240
});

export function providerBaseWeight(providerId) {
  return POPULAR_PROVIDER_WEIGHTS[String(providerId || "").toLowerCase()] || 0;
}

export function isHotProvider(providerId) {
  return ["bwh", "dmit", "gomami", "vmiss"].includes(String(providerId || "").toLowerCase());
}

/**
 * Evidence-backed 7-dimension shop tag taxonomy.
 * - "hot": established mainstream / top-attention benchmark brands (editorial stature, never catalog SKU count).
 * - "veteran": verified long-running hosts with multi-year operational track records.
 * - "home": verified residential broadband / dual-ISP specialist providers (live share + verified specialist fallback).
 * - "line": verified CN-optimized direct-routing specialist providers (CN2 GIA / 9929 / CMIN2 / 3-net / SoftBank / IIJ).
 * - "perf": verified big-port (>=2.5G/10Gbps) or Ryzen/EPYC high-performance hardware specialist providers.
 * - "value": verified whole-shop spec-per-yuan / affordable lineup (requires meaningful catalog share >=25% or low median <=¥65).
 * - "budget": verified low-entry non-NAT lineup (<= CNY 15/mo floor with low median or high <=¥20 share, excluding NAT-only shops).
 */
export const SHOP_TAG_ORDER = Object.freeze(["hot", "veteran", "home", "line", "perf", "value", "budget"]);

export const SHOP_TAG_DEFS = Object.freeze({
  hot: Object.freeze({
    key: "hot",
    shortLabel: "热门",
    label: "热门顶流",
    tone: "hot",
    summary: "业内长期高关注的主流标杆品牌（按真实品牌影响力核定，绝不以套餐数量充数）",
    searchAliases: Object.freeze(["热门", "热门顶流", "热门口碑", "顶流", "口碑", "主流", "旗舰", "大厂"])
  }),
  veteran: Object.freeze({
    key: "veteran",
    shortLabel: "老牌",
    label: "老牌稳健",
    tone: "veteran",
    summary: "持续运营多年、历经市场周期验证的稳健老牌主机商（拒绝短期跑路面板）",
    searchAliases: Object.freeze(["老牌", "老牌稳健", "稳健", "稳定", "老商家", "老厂"])
  }),
  home: Object.freeze({
    key: "home",
    shortLabel: "家宽",
    label: "原生家宽",
    tone: "home",
    summary: "主营真住宅宽带 / 双 ISP 原生宿主（实测在售家宽占比 ≥40% 或已核验本土宽带专营商，排除 NAT 混充）",
    searchAliases: Object.freeze(["家宽", "原生家宽", "双ISP", "住宅", "住宅专营", "TikTok"])
  }),
  line: Object.freeze({
    key: "line",
    shortLabel: "优线",
    label: "回国优线",
    tone: "line",
    summary: "主营 CN2 GIA / 9929 / CMIN2 / 三网回程 / 软银等大陆直连优化线路（实测优化款占比 ≥45% 或专营优化品牌）",
    searchAliases: Object.freeze(["优线", "回国优线", "优化", "精品网", "直连", "三网", "CN2", "9929"])
  }),
  perf: Object.freeze({
    key: "perf",
    shortLabel: "高配",
    label: "大口高配",
    tone: "perf",
    summary: "主力提供 ≥2.5Gbps/10Gbps 大带宽端口或 AMD Ryzen / EPYC 高性能硬件方案（实测占比 ≥45%）",
    searchAliases: Object.freeze(["高配", "大口高配", "性能", "大带宽", "万兆", "10Gbps", "Ryzen", "EPYC"])
  }),
  value: Object.freeze({
    key: "value",
    shortLabel: "性价比",
    label: "高性价比",
    tone: "value",
    summary: "全店非 NAT 现货整体高配置比或平价均衡（达标款占比 ≥25% 或全店中位价 ≤￥65/月，排除个别低配引流面板）",
    searchAliases: Object.freeze(["性价比", "高性价比", "划算", "超值", "均衡"])
  }),
  budget: Object.freeze({
    key: "budget",
    shortLabel: "低价",
    label: "低价入门",
    tone: "budget",
    summary: "非 NAT 明码固定周期现货低至 ≤￥15/月且整体亲民（严格排除 NAT 共享端口与超微玩具机）",
    searchAliases: Object.freeze(["低价", "低价入门", "便宜", "平价", "入门", "特价"])
  })
});

export const EDITORIAL_SHOP_PROFILES = Object.freeze({
  bwh: Object.freeze({
    hot: "IT7 旗下旗舰标杆，CN2 GIA / CMIN2 / 9929 限量传家宝代表品牌",
    veteran: "IT7 Networks 旗下自 2012 年起持续运营十余年的老牌主机商",
    line: "美西/日本/香港/荷兰多机房高端 CN2 GIA 与三网精品优化代表"
  }),
  dmit: Object.freeze({
    hot: "CN2 GIA / CMIN2 / 9929 头部高关注一线标杆品牌",
    line: "美西/香港/东京三网精品回程（Pro / EB 系列）标杆运营商"
  }),
  gomami: Object.freeze({
    hot: "亚太（日/港/新）高关注优化线路与大带宽口碑品牌",
    line: "香港/东京/新加坡精品直连优化代表商家"
  }),
  vmiss: Object.freeze({
    hot: "加元计价，高关注 CN2 GIA / 9929 / CMIN2 / IIJ 热门商家",
    line: "覆盖美日港韩英多区三网精品与 IIJ/BGP 优化线路"
  }),
  vps: Object.freeze({
    hot: "xTom 旗下主流品牌，覆盖欧美亚多区 CN 优化线路",
    line: "xTom 自有骨干网，东京软银/法兰克福 9929/圣何塞 GIA 主力商家"
  }),
  lisahost: Object.freeze({
    hot: "跨境双 ISP 与住宅 IP 代表性高关注商家",
    home: "美英台日港多区双 ISP 原生住宅与静态/动态家宽主力商家"
  }),
  misaka: Object.freeze({
    hot: "自有 AS57695 全球多区网络与优化节点运营商"
  }),
  greencloud: Object.freeze({
    hot: "全球 20+ 机房万兆 KVM 与亚太优化高关注商家",
    veteran: "2013 年成立并持续稳定运营十余年的老牌国际主机商"
  }),
  spartan: Object.freeze({
    hot: "西雅图 4837 回程与 Path 高防 Ryzen/EPYC 高关注商家",
    veteran: "2013 年起运营的英系老牌主机商，硬件与账单口碑稳健"
  }),
  zgovps: Object.freeze({
    hot: "高关注 AMD EPYC/Ryzen 硬件与美日港优化节点商家"
  }),
  rfc: Object.freeze({
    hot: "亚太优化与高端落地高关注代表品牌",
    line: "香港/日本/新加坡精品回国优化与 CTC/CMI 线路专营"
  }),
  saltyfish: Object.freeze({
    hot: "欧美 CN2 GIA / 9929 / CMIN2 热门优化线路商家",
    line: "法兰克福/圣何塞/阿姆斯特丹精品回国优化专营"
  }),
  isif: Object.freeze({
    hot: "亚太优化与高关注落地节点代表品牌",
    line: "日港新低延迟直连与亚太优化线路代表"
  }),
  wepc: Object.freeze({
    hot: "多国 TikTok 跨境住宅 / 双 ISP 热门代表商家",
    home: "美欧亚多国 TikTok 直播家宽与双 ISP 节点专营"
  }),
  netcup: Object.freeze({
    veteran: "德国纽伦堡老牌大厂（Anexia 集团旗下），Root Server 稳健标杆"
  }),
  buyvm: Object.freeze({
    veteran: "Frantech 旗下自 2010 年起运营的老牌主机商，卢森堡/美西口碑稳健"
  }),
  hostdare: Object.freeze({
    veteran: "2015 年起持续运营的老牌商家，美西 CN2 GIA 与大流量年付稳定代表"
  }),
  hosthatch: Object.freeze({
    veteran: "2011 年成立的老牌全球多区 NVMe 与大盘存储主机商"
  }),
  moonvm: Object.freeze({
    veteran: "多年稳定运营的港台动态/静态本土宽带老牌商家",
    home: "台湾中华电信 HiNet 与香港 HKT / HGC 本土家宽代表商家"
  }),
  evoxt: Object.freeze({
    veteran: "多年持续运营的多国高主频月付云主机商家"
  }),
  racknerd: Object.freeze({
    veteran: "美西多年稳定运营的年付促销 KVM 代表商家"
  }),
  boil: Object.freeze({
    home: "港台日 HKT / HKBN / HGC / Telus 本土宽带大口节点代表商家"
  }),
  tothost: Object.freeze({
    home: "越南本土 VNPT / CMC ISP 运营商线路与不限流量代表商家"
  }),
  aaitr: Object.freeze({
    home: "本站独立实测档案收录的美区 AT&T 真住宅家宽专营商家"
  }),
  usvps24: Object.freeze({
    home: "专注美区本土住宅宽带（Verizon / AT&T / Frontier）方案商家"
  }),
  lightlayer: Object.freeze({
    line: "Megalayer 旗下云品牌，主营港台美日菲 CN2 / 优化直连线路"
  }),
  pqs: Object.freeze({
    line: "港台日 CN2 / HiNet / IPLC 跨境优化线路专营老商家"
  })
});

const SHARED_PORT_GUARD_RE = /住宅共享|共享\s*ipv4|ipv4\s*入站[^/,\n]*端口|包含\s*\d+\s*个端口/i;
const SPECIAL_ADMIN_CHINA_PREFIX_RE = /(?:中国|中國|china)\s*[·\-/]?\s*(?=香港|澳门|澳門|台湾|台灣|臺灣|hong\s*kong|macau|macao|taiwan)/gi;
const MAINLAND_DOMESTIC_RE =
  /中国内地|中国大陆|大陆机房|国内机房|中国机房|华北|华东|华南|华中|西南|西北|东北|北京|上海|天津|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|广西|海南|四川|贵州|云南|陕西|甘肃|青海|内蒙|宁夏|新疆|西藏|广州|深圳|东莞|佛山|珠海|中山|惠州|江门|汕头|湛江|肇庆|清远|韶关|杭州|宁波|温州|嘉兴|湖州|绍兴|金华|台州|丽水|衢州|舟山|南京|苏州|无锡|常州|镇江|南通|扬州|徐州|宿迁|泰州|盐城|连云港|淮安|济南|青岛|烟台|威海|潍坊|淄博|枣庄|临沂|济宁|东营|德州|日照|郑州|洛阳|开封|许昌|新乡|焦作|南阳|信阳|武汉|襄阳|十堰|宜昌|荆州|黄石|孝感|长沙|株洲|湘潭|衡阳|岳阳|常德|成都|绵阳|德阳|宜宾|泸州|南充|乐山|眉山|西安|咸阳|宝鸡|渭南|延安|石家庄|廊坊|保定|唐山|秦皇岛|张家口|邯郸|沧州|太原|大同|长治|沈阳|大连|鞍山|抚顺|营口|长春|哈尔滨|大庆|齐齐哈尔|合肥|芜湖|蚌埠|宿州|淮南|马鞍山|滁州|福州|厦门|泉州|漳州|莆田|龙岩|宁德|南昌|九江|赣州|上饶|南宁|柳州|桂林|北海|海口|三亚|贵阳|遵义|贵安|昆明|曲靖|大理|兰州|西宁|银川|中卫|乌鲁木齐|克拉玛依|拉萨|呼和浩特|包头|鄂尔多斯|乌兰察布|(?:^|[\s·\-/,()[\]])(?:中国|中國)(?:$|[\s·\-/,()[\]])|\b(?:mainland\s*china|china|beijing|shanghai|tianjin|chongqing|guangzhou|shenzhen|dongguan|foshan|zhuhai|guangdong|hangzhou|ningbo|wenzhou|jiaxing|shaoxing|taizhou|zhejiang|nanjing|suzhou|wuxi|changzhou|zhenjiang|nantong|yangzhou|xuzhou|suqian|jiangsu|jinan|qingdao|yantai|weihai|zaozhuang|shandong|zhengzhou|luoyang|henan|wuhan|xiangyang|shiyan|hubei|changsha|hunan|chengdu|sichuan|xi'?an|shaanxi|shijiazhuang|langfang|baoding|hebei|taiyuan|shanxi|shenyang|dalian|liaoning|changchun|jilin|harbin|heilongjiang|hefei|wuhu|anhui|fuzhou|xiamen|quanzhou|fujian|nanchang|jiangxi|nanning|guangxi|haikou|sanya|hainan|guiyang|guizhou|kunming|yunnan|lanzhou|gansu|xining|qinghai|yinchuan|zhongwei|ningxia|urumqi|xinjiang|lhasa|tibet|hohhot|inner\s*mongolia)\b/i;

const MULTI_REGION_RE = /多地区|多地區|全球|多国|多國|\b(?:global|worldwide|multiple)\b/i;

const EXPLICIT_OVERSEAS_REGION_RE =
  /香港|澳门|澳門|台湾|台灣|臺灣|台北|臺北|彰化|美国|美國|洛杉矶|洛杉磯|圣何塞|聖荷西|硅谷|矽谷|西雅图|西雅圖|纽约|紐約|芝加哥|达拉斯|達拉斯|迈阿密|邁阿密|阿什本|堪萨斯|凤凰城|鳳凰城|盐湖城|鹽湖城|华盛顿|加州|夏威夷|加拿大|多伦多|蒙特利尔|温哥华|墨西哥|巴西|圣保罗|阿根廷|智利|日本|东京|東京|大阪|韩国|韓國|首尔|首爾|新加坡|马来西亚|馬來西亞|吉隆坡|越南|胡志明|河内|泰国|泰國|曼谷|菲律宾|马尼拉|印尼|印度尼西亚|雅加达|印度|孟买|澳大利亚|澳大利亞|澳洲|悉尼|墨尔本|新西兰|奥克兰|阿联酋|迪拜|杜拜|以色列|土耳其|伊斯坦布尔|英国|英國|伦敦|倫敦|考文垂|曼彻斯特|爱尔兰|都柏林|德国|德國|法兰克福|法蘭克福|柏林|纽伦堡|杜塞尔多夫|荷兰|荷蘭|阿姆斯特丹|法国|法國|巴黎|马赛|波尔多|瑞士|苏黎世|瑞典|斯德哥尔摩|挪威|奥斯陆|芬兰|赫尔辛基|丹麦|哥本哈根|冰岛|雷克雅未克|西班牙|马德里|巴塞罗那|葡萄牙|里斯本|意大利|米兰|罗马|奥地利|维也纳|比利时|布鲁塞尔|波兰|华沙|捷克|布拉格|匈牙利|布达佩斯|罗马尼亚|羅馬尼亞|布加勒斯特|保加利亚|索非亚|克罗地亚|萨格勒布|希腊|雅典|爱沙尼亚|拉脱维亚|立陶宛|乌克兰|基辅|俄罗斯|莫斯科|南非|约翰内斯堡|尼日利亚|拉各斯|欧洲|歐洲|北美|亚太|亞太|美西|美东|东南亚|\b(?:us|usa|united\s*states|los\s*angeles|san\s*jose|seattle|new\s*york|chicago|dallas|miami|ashburn|kansas|phoenix|california|canada|toronto|montreal|vancouver|mexico|brazil|hk|cnhk|hong\s*kong|mo|macau|macao|tw|cntw|taiwan|taipei|jp|japan|tokyo|osaka|kr|icn|korea|seoul|sg|sgp|singapore|my|malaysia|vn|vietnam|th|thailand|ph|philippines|indonesia|jakarta|india|au|australia|sydney|new\s*zealand|auckland|uae|dubai|israel|turkey|istanbul|uk|gb|united\s*kingdom|london|coventry|ireland|dublin|de|germany|frankfurt|berlin|nl|netherlands|amsterdam|fr|france|paris|switzerland|zurich|sweden|stockholm|norway|oslo|finland|helsinki|denmark|copenhagen|iceland|spain|madrid|portugal|lisbon|italy|milan|austria|vienna|belgium|brussels|poland|warsaw|czech|prague|hungary|romania|bucharest|bulgaria|sofia|croatia|greece|athens|estonia|ukraine|south\s*africa|johannesburg|nigeria|europe|eu|north\s*america|apac|asia\s*pacific)\b/i;

const mainlandProviderIds = new Set(
  providers.filter((prov) => Array.isArray(prov.regions) && prov.regions.includes("CN")).map((prov) => prov.id.toLowerCase())
);

function stripSpecialAdminChina(text) {
  return String(text || "").replace(SPECIAL_ADMIN_CHINA_PREFIX_RE, "");
}

function isMainlandDomesticPlan(plan) {
  const regText = stripSpecialAdminChina([...(plan._regions || []), plain(plan.region), plain(plan.name)].join(" "));
  return MAINLAND_DOMESTIC_RE.test(regText);
}

function isVerifiedCrossBorderPlan(plan) {
  if (!plan || isMainlandDomesticPlan(plan)) return false;
  const declaredRegions = Array.isArray(plan._regions)
    ? plan._regions.map((r) => plain(r)).filter(Boolean)
    : productRegions(plan);
  if (declaredRegions.length === 0) return false;

  const pid = String(plan._providerId || plan.providerId || "").toLowerCase();
  const providerHasMainland = mainlandProviderIds.has(pid);

  let hasOverseasEvidence = false;
  for (const rawRegion of declaredRegions) {
    const cleaned = stripSpecialAdminChina(rawRegion);
    if (MAINLAND_DOMESTIC_RE.test(cleaned)) return false;
    if (EXPLICIT_OVERSEAS_REGION_RE.test(cleaned)) {
      hasOverseasEvidence = true;
    } else if (MULTI_REGION_RE.test(cleaned) && !providerHasMainland) {
      hasOverseasEvidence = true;
    }
  }
  return hasOverseasEvidence;
}

export function evaluateProviderTags(provider, providerPlans = []) {
  const id = String(typeof provider === "string" ? provider : provider?.id || "").toLowerCase();
  const profile = EDITORIAL_SHOP_PROFILES[id] || {};

  let rawAvailCount = 0;
  const pricedCatalog = [];
  const specQualifiedPlans = [];
  for (const p of providerPlans || []) {
    if (!p || p.diagnostic || p.status !== "available" || !isCurrentCatalogPlan(p)) continue;
    rawAvailCount += 1;
    if (p._classify?.isNat) continue;
    const rawBlob = [p.name, p.hardware, p.bandwidth, p.route, p.note].map(plain).join(" ");
    if (SHARED_PORT_GUARD_RE.test(rawBlob)) continue;
    if (!isVerifiedCrossBorderPlan(p)) continue;

    const isBaremetal = /\b(dual\s+xeon|e5-\d{4})\b|物理机|独立服务器|裸金属|dedicated\s+server|254个ip/i.test(rawBlob);
    if (isBaremetal) continue;

    // Unified live eligibility gate: exclude starting/teaser quotes, unknown cycles, and missing/expired FX conversions
    const quote = p._pricing?.quote;
    const cny = p._pricing?.cnyMonthly;
    if (quote?.baseOnly || !Number.isFinite(quote?.months) || quote.months <= 0 || !Number.isFinite(cny) || cny <= 0) {
      continue;
    }
    pricedCatalog.push(p);

    const ns = p._numSpecs || {};
    if (Number.isFinite(ns.bandwidthMbps) && ns.bandwidthMbps < 50) continue;
    if (!Number.isFinite(ns.memoryGb) || ns.memoryGb < 0.5) continue;
    if (Number.isFinite(ns.diskGb) && ns.diskGb < 8) continue;
    if (!ns.unlimitedTraffic && (!Number.isFinite(ns.trafficGb) || ns.trafficGb < 500)) continue;
    specQualifiedPlans.push(p);
  }
  pricedCatalog.sort((a, b) => a._pricing.cnyMonthly - b._pricing.cnyMonthly);
  specQualifiedPlans.sort((a, b) => a._pricing.cnyMonthly - b._pricing.cnyMonthly);

  const catalogCount = pricedCatalog.length;
  const shopDenom = Math.max(rawAvailCount, catalogCount);
  const pricedCoverage = shopDenom > 0 ? catalogCount / shopDenom : 0;
  const canFallbackSpecialist = rawAvailCount === 0 || pricedCoverage >= 0.5;

  const explicitResShopRe = /家宽|家寬|住宅|民宅|residential|dual\s*isp|双\s*isp|雙\s*isp|本土\s*isp|isp\b|at&t|verizon|comcast|frontier|spectrum|sprint|hinet|hkt|hkbn|hgc|kddi|vnpt/i;
  let liveNonSmallCount = 0;
  let liveResCount = 0;
  let liveOptCount = 0;
  let liveTriGiaCount = 0;
  let liveBigPortPerfCount = 0;
  for (const p of pricedCatalog) {
    const bw = p._numSpecs?.bandwidthMbps;
    if (Number.isFinite(bw) && bw < 50) continue;
    liveNonSmallCount += 1;
    const resBlob = [p.name, p.route, p.note].map(plain).join(" ");
    if (p._classify?.isResidential && explicitResShopRe.test(resBlob)) liveResCount += 1;
    if (p._classify?.hasCnOpt) liveOptCount += 1;
    if ((p._classify?.routeProfile?.netCount || 0) >= 3 || /cn2\s*gia/i.test(`${plain(p.route)} ${plain(p.name)}`)) {
      liveTriGiaCount += 1;
    }
    const rawCpu = [p.name, p.hardware].map(plain).join(" ");
    if ((Number.isFinite(bw) && bw >= 2500) || /\bryzen\b/i.test(rawCpu) || (/\bepyc\s*(?:7|9)\w+/i.test(rawCpu) && !p._regions?.includes("中国内地") && id !== "leikwanhost")) {
      liveBigPortPerfCount += 1;
    }
  }

  // Whole-shop price distribution MUST come from the full eligible catalog, never a cherry-picked spec subset
  const catalogMinCny = catalogCount > 0 ? pricedCatalog[0]._pricing.cnyMonthly : null;
  const catalogP25Cny = catalogCount > 0 ? pricedCatalog[Math.floor(catalogCount * 0.25)]._pricing.cnyMonthly : null;
  const catalogMedCny = catalogCount > 0 ? pricedCatalog[Math.floor(catalogCount * 0.5)]._pricing.cnyMonthly : null;

  const qualCount = specQualifiedPlans.length;
  const qualMinCny = qualCount > 0 ? specQualifiedPlans[0]._pricing.cnyMonthly : null;

  let le15Count = 0;
  let le20Count = 0;
  let le30Count = 0;
  let has1GBAffordable = false;
  const highSpecPlans = [];
  const cheapCnOptPlans = [];

  for (const p of specQualifiedPlans) {
    const cny = p._pricing.cnyMonthly;
    const ns = p._numSpecs || {};
    const mem = ns.memoryGb;
    const bw = ns.bandwidthMbps;
    const tr = ns.trafficGb;
    const unl = Boolean(ns.unlimitedTraffic);
    const has100M = !Number.isFinite(bw) || bw >= 100;
    const hasVerifiableQuota = unl || (Number.isFinite(tr) && tr >= 500);
    if (cny <= 15) le15Count += 1;
    if (cny <= 20) le20Count += 1;
    if (cny <= 30) le30Count += 1;
    if (Number.isFinite(mem) && mem >= 1 && cny <= 35) has1GBAffordable = true;
    if (Number.isFinite(mem) && mem >= 1 && has100M && hasVerifiableQuota && cny <= 70 && (mem * 10) / cny >= 0.9) {
      highSpecPlans.push(p);
    }
    if (p._classify?.hasCnOpt && Number.isFinite(mem) && mem >= 1 && has100M && hasVerifiableQuota && cny <= 40) {
      cheapCnOptPlans.push(p);
    }
  }

  const tags = [];

  // 1. Hot (热门顶流)
  if (profile.hot) {
    tags.push({
      ...SHOP_TAG_DEFS.hot,
      reason: profile.hot,
      basis: "editorial"
    });
  }

  // 2. Veteran (老牌稳健)
  if (profile.veteran) {
    tags.push({
      ...SHOP_TAG_DEFS.veteran,
      reason: profile.veteran,
      basis: "editorial"
    });
  }

  // 3. Home / Dual-ISP Specialist (原生家宽)
  let homeReason = null;
  let homeBasis = "live";
  const resShare = shopDenom > 0 ? liveResCount / shopDenom : 0;
  if (pricedCoverage >= 0.5 && ((liveResCount >= 4 && resShare >= 0.4) || (liveResCount >= 20 && resShare >= 0.35))) {
    homeReason = `实测在售 ${liveResCount} 款独立 IP 住宅/双 ISP 现货（占在售 ${Math.round(resShare * 100)}%）`;
  } else if (profile.home && canFallbackSpecialist) {
    homeReason = liveNonSmallCount > 0 ? profile.home : `${profile.home}（当前待核验实时库存）`;
    homeBasis = "editorial";
  }
  if (homeReason) {
    tags.push({
      ...SHOP_TAG_DEFS.home,
      reason: homeReason,
      basis: homeBasis
    });
  }

  // 4. CN-Optimized Direct Route Specialist (回国优线)
  let lineReason = null;
  let lineBasis = "live";
  const optShare = shopDenom > 0 ? liveOptCount / shopDenom : 0;
  if (
    pricedCoverage >= 0.5 &&
    ((liveOptCount >= 4 && optShare >= 0.45) ||
      (liveTriGiaCount >= 12 && optShare >= 0.4) ||
      (qualCount >= 2 && liveOptCount === shopDenom && liveOptCount >= 2))
  ) {
    const triNote = liveTriGiaCount >= 3 ? `，含 ${liveTriGiaCount} 款三网/CN2 GIA` : "";
    lineReason = `实测在售 ${liveOptCount} 款大陆直连优化现货（占在售 ${Math.round(optShare * 100)}%${triNote}）`;
  } else if (profile.line && canFallbackSpecialist) {
    lineReason = liveNonSmallCount > 0 ? profile.line : `${profile.line}（当前待核验实时库存）`;
    lineBasis = "editorial";
  }
  if (lineReason) {
    tags.push({
      ...SHOP_TAG_DEFS.line,
      reason: lineReason,
      basis: lineBasis
    });
  }

  // 5. Big-Port / High-Performance Hardware Specialist (大口高配)
  const perfShare = shopDenom > 0 ? liveBigPortPerfCount / shopDenom : 0;
  if (pricedCoverage >= 0.5 && liveBigPortPerfCount >= 6 && perfShare >= 0.44) {
    tags.push({
      ...SHOP_TAG_DEFS.perf,
      reason: `实测在售 ${liveBigPortPerfCount} 款 ≥2.5G/10G 大带宽或 Ryzen/EPYC 现货（占在售 ${Math.round(perfShare * 100)}%）`,
      basis: "live"
    });
  }

  // 6. High Value (高性价比): strictly live-price-backed against whole-catalog denominator & whole-catalog median
  let valueReason = null;
  const highSpecShare = shopDenom > 0 ? highSpecPlans.length / shopDenom : 0;
  const cheapOptShare = shopDenom > 0 ? cheapCnOptPlans.length / shopDenom : 0;
  const le30Share = shopDenom > 0 ? le30Count / shopDenom : 0;
  const le20Share = shopDenom > 0 ? le20Count / shopDenom : 0;
  if (pricedCoverage >= 0.5 && qualCount >= 2 && qualMinCny !== null) {
    if (highSpecPlans.length >= 2 && (highSpecShare >= 0.25 || (highSpecShare >= 0.12 && catalogMedCny !== null && catalogMedCny <= 65))) {
      valueReason = `实测 ${highSpecPlans.length} 款高内存配置比非 NAT 现货（占在售 ${Math.round(highSpecShare * 100)}%，每￥10 ≥ 0.9G 内存）`;
    } else if (cheapCnOptPlans.length >= 2 && (cheapOptShare >= 0.25 || (cheapOptShare >= 0.12 && catalogMedCny !== null && catalogMedCny <= 65))) {
      valueReason = `实测 ${cheapCnOptPlans.length} 款平价 CN 优化现货（占在售 ${Math.round(cheapOptShare * 100)}%，￥${cheapCnOptPlans[0]._pricing.cnyMonthly.toFixed(1)}/月起）`;
    } else if (
      le30Count >= 3 &&
      (le30Share >= 0.25 || (le30Share >= 0.2 && catalogMedCny !== null && catalogMedCny <= 65)) &&
      catalogP25Cny !== null &&
      catalogP25Cny <= 40 &&
      catalogMedCny !== null &&
      catalogMedCny <= 65 &&
      has1GBAffordable
    ) {
      valueReason = `实测多档平价非 NAT 现货（￥${qualMinCny.toFixed(1)}/月起，全店中位 ￥${Math.round(catalogMedCny)}/月）`;
    } else if (
      le20Count >= 4 &&
      (le20Share >= 0.25 || (le20Share >= 0.15 && catalogMedCny !== null && catalogMedCny <= 65)) &&
      catalogMedCny !== null &&
      catalogMedCny <= 65 &&
      has1GBAffordable
    ) {
      valueReason = `实测 ${le20Count} 款 ≤ ￥20/月 非 NAT 现货（占在售 ${Math.round(le20Share * 100)}%，￥${qualMinCny.toFixed(1)}/月起）`;
    }
  }

  if (valueReason) {
    tags.push({
      ...SHOP_TAG_DEFS.value,
      reason: valueReason,
      basis: "live"
    });
  }

  // 7. Budget Entry (低价入门): strictly live-price-backed against whole-catalog denominator & whole-catalog median
  let budgetReason = null;
  const isLiveBudget =
    pricedCoverage >= 0.5 &&
    qualCount >= 2 &&
    qualMinCny !== null &&
    ((le15Count >= 1 && ((catalogMedCny !== null && catalogMedCny <= 65 && le20Share >= 0.15) || le20Share >= 0.25)) ||
      (le20Count >= 4 && catalogP25Cny !== null && catalogP25Cny <= 35 && le20Share >= 0.15));

  if (isLiveBudget) {
    budgetReason = `实测非 NAT 现货 ￥${qualMinCny.toFixed(1)}/月起${le20Count >= 2 ? `（${le20Count} 款 ≤ ￥20/月）` : ""}`;
  }

  if (budgetReason) {
    tags.push({
      ...SHOP_TAG_DEFS.budget,
      reason: budgetReason,
      basis: "live"
    });
  }

  const byKey = new Map(tags.map((t) => [t.key, t]));
  let primaryTag = null;
  if (byKey.has("hot")) {
    primaryTag = byKey.get("hot");
  } else if (
    byKey.has("budget") &&
    ((qualMinCny !== null && qualMinCny <= 10.5) || (!byKey.has("value") && !byKey.has("veteran") && !byKey.has("home") && !byKey.has("line") && !byKey.has("perf")))
  ) {
    primaryTag = byKey.get("budget");
  } else if (byKey.has("home")) {
    primaryTag = byKey.get("home");
  } else if (byKey.has("line")) {
    primaryTag = byKey.get("line");
  } else if (byKey.has("veteran")) {
    primaryTag = byKey.get("veteran");
  } else if (byKey.has("value")) {
    primaryTag = byKey.get("value");
  } else if (byKey.has("perf")) {
    primaryTag = byKey.get("perf");
  } else if (byKey.has("budget")) {
    primaryTag = byKey.get("budget");
  }

  return {
    tags,
    primaryTag,
    metrics: {
      nonNatAvailCount: liveNonSmallCount,
      nonNatPricedCount: qualCount,
      catalogPricedCount: catalogCount,
      shopDenom,
      minCny: qualMinCny,
      catalogMinCny,
      p25Cny: catalogP25Cny,
      medCny: catalogMedCny,
      le15Count,
      le20Count,
      le30Count,
      liveResCount,
      liveOptCount,
      highSpecCount: highSpecPlans.length,
      cheapCnOptCount: cheapCnOptPlans.length
    }
  };
}

export const PLAN_TAG_ORDER = Object.freeze([
  "blockbuster",
  "generous",
  "annual",
  "value",
  "home-opt",
  "perf",
  "scarce",
  "budget"
]);

export const PLAN_TAG_DEFS = Object.freeze({
  blockbuster: Object.freeze({
    key: "blockbuster",
    shortLabel: "爆款",
    label: "口碑爆款",
    tone: "blockbuster",
    summary: "搬瓦工限量传家宝与头部商家公认经典特惠代表型号（仅标注具体口碑 SKU，绝非全店乱标）",
    searchAliases: Object.freeze(["爆款", "口碑爆款", "热门爆款", "传家宝", "限量", "代表款"])
  }),
  generous: Object.freeze({
    key: "generous",
    shortLabel: "便宜量大",
    label: "便宜量大",
    tone: "generous",
    summary: "非 NAT 明码现货月均 ≤￥35 伴核验大带宽不限流量/≥3TB 大流量/≥4G 大内存，或 ≤￥45 伴 ≥100G 大盘（排除未知带宽与小水管）",
    searchAliases: Object.freeze(["便宜量大", "量大", "量大管饱", "大流量", "不限流量", "大盘"])
  }),
  annual: Object.freeze({
    key: "annual",
    shortLabel: "年付惠",
    label: "年付特惠",
    tone: "annual",
    summary: "≥1G 内存、固定年付/长周期折合月均超低（普通 ≤￥24/月，CN 优化或真家宽 ≤￥48/月）的省心长付实惠款",
    searchAliases: Object.freeze(["年付特惠", "年付惠", "年付神机", "年付特价", "年付小鸡", "传家宝"])
  }),
  value: Object.freeze({
    key: "value",
    shortLabel: "性价比",
    label: "高性价比",
    tone: "value",
    summary: "带宽与流量均已明示的平价 ≥100M CN 回国优化、平价真家宽/双 ISP，或 ≥2核4G 高配置比非 NAT 现货",
    searchAliases: Object.freeze(["性价比", "高性价比", "划算", "超值"])
  }),
  "home-opt": Object.freeze({
    key: "home-opt",
    shortLabel: "家宽直连",
    label: "家宽直连",
    tone: "home-opt",
    summary: "明码固定周期（月均 ≤￥220）真住宅/双 ISP 且自带 CN 回国优化线路（9929/4837/CN2/三网/HiNet/IIJ），跨境免中转直连",
    searchAliases: Object.freeze(["家宽直连", "直连家宽", "免中转", "直播家宽", "双ISP直连"])
  }),
  perf: Object.freeze({
    key: "perf",
    shortLabel: "高配",
    label: "性能高配",
    tone: "perf",
    summary: "至少 ≥2核4G 且标明 AMD Ryzen / EPYC / Xeon Gold·Platinum 处理器（≤￥85/月），或 ≥4核8G 大带宽多核高配现货（≤￥75/月）",
    searchAliases: Object.freeze(["性能高配", "高配", "硬核性能", "万兆", "10Gbps", "Ryzen", "EPYC"])
  }),
  scarce: Object.freeze({
    key: "scarce",
    shortLabel: "紧俏",
    label: "紧俏余量",
    tone: "scarce",
    summary: "≥1G 内存、≥100M 端口且实测精确余量仅剩 1–5 台的主流平价/优化/家宽紧俏现货（剔除高价冷门大鸡）",
    searchAliases: Object.freeze(["紧俏", "紧俏余量", "稀缺", "余量告急", "仅剩", "手慢无"])
  }),
  budget: Object.freeze({
    key: "budget",
    shortLabel: "低价",
    label: "低价入门",
    tone: "budget",
    summary: "≥512M 内存、≥10G 硬盘、非小水管且明码固定周期折合月均 ≤￥18 的可用低门槛现货（排除玩具容器与 NAT）",
    searchAliases: Object.freeze(["低价", "便宜", "平价", "低价入门", "入门", "尝鲜"])
  })
});

const BWH_LIMITED_NAME_RE = /\b(amsterdam\s+plan|minibox|biggerbox|powerbox|sakurabox|megabox|minichicken|tokyo\s+plan|the\s+plan|limited\s+edition)\b/i;
const DMIT_SIGNATURE_RE = /\b(wee|malibu|corona|eb\.|pro\.)\b/i;
const VPS_SIGNATURE_RE = /\b(mini|starter|voyager)\b/i;
const PREMIUM_OPT_RE = /\b(cn2\s*gia|9929|cmin2)\b/i;
const FLAGSHIP_CPU_RE = /\b(amd\s+ryzen(?:\s*[579]?\s*\d{4}\w*)?|ryzen(?:\s*[579]?\s*\d{4}\w*)?|amd\s+epyc(?:\s*(?:7|9)\w+|\s*(?:genoa|milan|rome|turin))?|epyc\s*(?:7|9)\w+|xeon\s*(?:platinum|gold)(?:\s*\d{4}\w*)?)\b/i;
const EXPLICIT_MULTI_VCPU_RE = /\b([2-9]|\d{2})\s*x\s*[\d.]+\s*ghz\s*vcpu/i;
const HOME_SIGNAL_RE = /家宽|家寬|住宅|双\s*isp|雙\s*isp|dual\s*isp|hinet|att\b|at&t|verizon|frontier|comcast|softbank|软银/i;
const BARE_METAL_RE = /\b(dual\s+xeon|e5-\d{4})\b|物理机|独立服务器|裸金属|dedicated\s+server/i;

function formatTagTraffic(gb) {
  if (gb >= 1024 && gb % 1024 === 0) return `${gb / 1024}TB`;
  if (gb >= 1000 && gb % 1000 === 0) return `${gb / 1000}TB`;
  return `${(gb / 1024).toFixed(1)}TB`;
}

function formatTagPort(mbps) {
  if (mbps >= 1000 && mbps % 1000 === 0) return `${mbps / 1000}Gbps`;
  return `${mbps}Mbps`;
}

/**
 * Evidence-backed per-product highlight tags.
 * Never labels sold-out, historical, diagnostic, NAT/shared-port, mainland domestic IDC, toy micro-containers,
 * small-pipe traps, or unconvertible/stale-FX price claims.
 */
export function evaluatePlanTags(plan) {
  if (!plan || plan.diagnostic || plan.status !== "available" || !isCurrentCatalogPlan(plan)) {
    return { tags: [], primaryTag: null };
  }
  const classify = plan._classify;
  if (!classify || classify.isNat) {
    return { tags: [], primaryTag: null };
  }
  const rawBlob = [plan.name, plan.hardware, plan.bandwidth, plan.route, plan.note].map(plain).join(" ");
  if (SHARED_PORT_GUARD_RE.test(rawBlob) || !isVerifiedCrossBorderPlan(plan)) {
    return { tags: [], primaryTag: null };
  }

  const quote = plan._pricing?.quote;
  const cny = plan._pricing?.cnyMonthly;
  const months = quote?.months || 0;
  // Unified admission check across ALL 8 plan tags: fixed cycle, non-teaser price, and valid (<=7d ECB) CNY conversion
  if (!Number.isFinite(cny) || cny <= 0 || quote?.baseOnly || !Number.isFinite(months) || months <= 0) {
    return { tags: [], primaryTag: null };
  }

  const ns = plan._numSpecs || {};
  const pid = String(plan._providerId || "").toLowerCase();
  const name = plain(plan.name);
  const route = classify.routeProfile || {};
  const hasCnOpt = Boolean(classify.hasCnOpt);
  const isRes = Boolean(classify.isResidential);
  const isPremiumOpt = (route.netCount || 0) >= 2 || PREMIUM_OPT_RE.test(`${plain(plan.route)} ${name}`);

  const mem = ns.memoryGb;
  const disk = ns.diskGb;
  const explicitMultiCpu = EXPLICIT_MULTI_VCPU_RE.exec(rawBlob);
  const cpu = Number.isFinite(ns.cpuCores) ? ns.cpuCores : (explicitMultiCpu ? Number(explicitMultiCpu[1]) : null);
  const bw = ns.bandwidthMbps;
  const tr = ns.trafficGb;
  const unl = Boolean(ns.unlimitedTraffic);
  const hasVerifiedQuota = unl || (Number.isFinite(tr) && tr >= 500);
  // Every product tag strictly requires verified numeric port bandwidth (>=50Mbps) and verified traffic quota (>=500G/UNL)
  if (!Number.isFinite(bw) || bw < 50 || !hasVerifiedQuota) {
    return { tags: [], primaryTag: null };
  }

  const tags = [];

  // 1. Blockbuster (口碑爆款): strictly verified iconic / limited / cult-favorite SKUs only
  let blockReason = null;
  if (pid === "bwh" && cny <= 65 && (String(plan.sourceId) === "bwh-limited-pids" || BWH_LIMITED_NAME_RE.test(name))) {
    blockReason = "搬瓦工限量传家宝系列";
  } else if (pid === "dmit" && DMIT_SIGNATURE_RE.test(name) && cny <= 55) {
    blockReason = `DMIT 高关注入门/特惠代表款（￥${cny.toFixed(1)}/月）`;
  } else if (pid === "vmiss" && hasCnOpt && cny <= 45) {
    blockReason = `VMISS 平价优化线路热门款（￥${cny.toFixed(1)}/月）`;
  } else if (pid === "gomami" && hasCnOpt && cny <= 65) {
    blockReason = `Gomami 亚太优化高关注款（￥${cny.toFixed(1)}/月）`;
  } else if (pid === "vps" && hasCnOpt && VPS_SIGNATURE_RE.test(name) && cny <= 55) {
    blockReason = `V.PS 热门入门优化款（￥${cny.toFixed(1)}/月）`;
  } else if (pid === "lisahost" && /特价年付/.test(name) && cny <= 50 && (isRes || hasCnOpt)) {
    blockReason = `LisaHost 经典特价年付${isRes ? "双ISP/家宽" : "三网"}代表款（￥${cny.toFixed(1)}/月）`;
  } else if (pid === "akko" && hasCnOpt && /mini\s*年付特惠/i.test(name) && cny <= 45) {
    blockReason = `AkkoCloud 经典 CN2 年付特惠款（￥${cny.toFixed(1)}/月）`;
  } else if (pid === "666clouds" && isRes && hasCnOpt && /新手首选/.test(name) && cny <= 60) {
    blockReason = `六六云代表美西双ISP 9929 热门款（￥${cny.toFixed(1)}/月）`;
  } else if (pid === "iaclouds" && hasCnOpt && months >= 12 && /ggboom/i.test(name) && cny <= 35) {
    blockReason = `破云 GGBOOM 热门大陆优化年付特价款（￥${cny.toFixed(1)}/月）`;
  } else if (pid === "racknerd" && months >= 12 && Number.isFinite(mem) && mem >= 1 && cny <= 10) {
    blockReason = `RackNerd 经典低价年付促销款（￥${cny.toFixed(1)}/月）`;
  } else if (pid === "hostdare" && hasCnOpt && /\b(cssd|camd|ckvm)\d*\b/i.test(name) && cny <= 35) {
    blockReason = `HostDare 经典 CN2 GIA 特惠款（￥${cny.toFixed(1)}/月）`;
  }

  if (blockReason) {
    tags.push({ ...PLAN_TAG_DEFS.blockbuster, reason: blockReason });
  }

  // 2. Generous & Cheap (便宜量大): requires explicitly verified bandwidth & usable RAM/disk
  let genReason = null;
  const diskOk = !Number.isFinite(disk) || disk >= 15;
  if (Number.isFinite(bw) && Number.isFinite(mem) && mem >= 1 && diskOk) {
    if (cny <= 35 && unl && bw >= 100) {
      genReason = `￥${cny.toFixed(1)}/月 · ${mem}G 内存 · ${formatTagPort(bw)} 不限流量`;
    } else if (cny <= 35 && bw >= 200 && Number.isFinite(tr) && tr >= 3000) {
      genReason = `￥${cny.toFixed(1)}/月 · ${formatTagPort(bw)} · ${formatTagTraffic(tr)} 大流量`;
    } else if (cny <= 18 && bw >= 200 && Number.isFinite(tr) && tr >= 2000) {
      genReason = `￥${cny.toFixed(1)}/月 · ${formatTagPort(bw)} · ${formatTagTraffic(tr)} 流量`;
    } else if (
      cny <= 35 &&
      bw >= 200 &&
      (unl || (Number.isFinite(tr) && tr >= 1000)) &&
      Number.isFinite(cpu) &&
      cpu >= 2 &&
      mem >= 4 &&
      Number.isFinite(disk) &&
      disk >= 30
    ) {
      genReason = `￥${cny.toFixed(1)}/月 · ${cpu}C/${mem}G/${disk}G 大内存高配`;
    } else if (cny <= 45 && bw >= 200 && (unl || (Number.isFinite(tr) && tr >= 1000)) && Number.isFinite(disk) && disk >= 100) {
      genReason = `￥${cny.toFixed(1)}/月 · ${disk}G 大盘存储`;
    }
  }

  if (genReason) {
    tags.push({ ...PLAN_TAG_DEFS.generous, reason: genReason });
  }

  // 3. Annual Bargain (年付特惠): >=1G RAM, >=10G disk, verified port & traffic >=500G, low annualized cost
  const annualSpecOk =
    months >= 12 &&
    Number.isFinite(mem) &&
    mem >= 1 &&
    (!Number.isFinite(disk) || disk >= 10) &&
    hasVerifiedQuota;
  const isStdAnnualGem = annualSpecOk && bw >= 100 && (unl || (Number.isFinite(tr) && tr >= 800)) && cny <= 24;
  const isOptResAnnualGem = annualSpecOk && (hasCnOpt || isRes) && bw >= 50 && cny <= 48;
  if (isStdAnnualGem || isOptResAnnualGem) {
    const cycleText = plan._pricing?.displayLabel || "年付";
    const trackNote = isRes && hasCnOpt ? "家宽直连" : isRes ? "真家宽/双ISP" : hasCnOpt ? `${route.headline || "CN优化"}` : "大流量常规";
    tags.push({
      ...PLAN_TAG_DEFS.annual,
      reason: `${cycleText}（折合 ￥${cny.toFixed(1)}/月 · ${trackNote} · 长付实惠款）`
    });
  }

  // 4. High Value (高性价比): requires verified RAM, verified >=100M port, and verified >=500G/UNL traffic
  let valReason = null;
  if (Number.isFinite(mem) && mem >= 1 && Number.isFinite(bw) && hasVerifiedQuota) {
    if (hasCnOpt && bw >= 100 && ((isPremiumOpt && cny <= 48) || cny <= 36)) {
      valReason = `平价${route.headline || "CN优化"}（￥${cny.toFixed(1)}/月 · ${formatTagPort(bw)}）`;
    } else if (isRes && bw >= 100 && cny <= 55) {
      valReason = `平价真家宽/双ISP（￥${cny.toFixed(1)}/月 · ${formatTagPort(bw)}）`;
    } else if (
      Number.isFinite(cpu) &&
      cpu >= 2 &&
      mem >= 4 &&
      Number.isFinite(disk) &&
      disk >= 25 &&
      bw >= 200 &&
      (unl || (Number.isFinite(tr) && tr >= 1000)) &&
      cny <= 65 &&
      (mem * 10) / cny >= 1.0
    ) {
      valReason = `${cpu}C/${mem}G/${disk}G 仅 ￥${cny.toFixed(1)}/月（高配置比）`;
    }
  }

  if (valReason) {
    tags.push({ ...PLAN_TAG_DEFS.value, reason: valReason });
  }

  // 5. Residential + CN Optimized Direct (家宽直连): verified fixed-cycle, explicit home/ISP signal, no baremetal
  if (
    isRes &&
    hasCnOpt &&
    cny <= 220 &&
    bw >= 50 &&
    hasVerifiedQuota &&
    HOME_SIGNAL_RE.test(`${name} ${plain(plan.route)}`) &&
    !BARE_METAL_RE.test(rawBlob)
  ) {
    const routeLabel = route.headline || "CN 回国优化";
    tags.push({
      ...PLAN_TAG_DEFS["home-opt"],
      reason: `￥${cny.toFixed(1)}/月 · 真住宅/双ISP 叠加 ${routeLabel} · ${formatTagPort(bw)}（直连免中转）`
    });
  }

  // 6. Performance High-Spec (性能高配): strictly >=2C & >=4G RAM, verified >=500M port, and verified >=1TB/UNL traffic
  let perfReason = null;
  const cpuMatch = rawBlob.match(FLAGSHIP_CPU_RE);
  if (
    cpuMatch &&
    Number.isFinite(cpu) &&
    cpu >= 2 &&
    Number.isFinite(mem) &&
    mem >= 4 &&
    (!Number.isFinite(disk) || disk >= 25) &&
    bw >= 500 &&
    (unl || (Number.isFinite(tr) && tr >= 1000)) &&
    cny <= 85
  ) {
    const cpuLabel = cpuMatch[0].replace(/\s+/g, " ").trim();
    const portNote = bw >= 2500 ? ` · ${formatTagPort(bw)} 端口` : ` · ${formatTagPort(bw)}`;
    perfReason = `￥${cny.toFixed(1)}/月 · ${cpuLabel} · ${cpu}C/${mem}G${portNote}`;
  } else if (
    Number.isFinite(cpu) &&
    cpu >= 4 &&
    Number.isFinite(mem) &&
    mem >= 8 &&
    Number.isFinite(disk) &&
    disk >= 40 &&
    bw >= 500 &&
    (unl || (Number.isFinite(tr) && tr >= 1000)) &&
    cny <= 75
  ) {
    perfReason = `￥${cny.toFixed(1)}/月 · ${cpu}C/${mem}G/${disk}G · ${formatTagPort(bw)} 多核大内存`;
  }

  if (perfReason) {
    tags.push({ ...PLAN_TAG_DEFS.perf, reason: perfReason });
  }

  // 7. Scarce Exact Stock (紧俏余量): exact 1-5 units, >=1G RAM, >=100M port, verified quota, consumer/prosumer price cap
  if (
    plan._isExactStock &&
    Number.isFinite(plan.stockCount) &&
    plan.stockCount >= 1 &&
    plan.stockCount <= 5 &&
    Number.isFinite(mem) &&
    mem >= 1 &&
    (!Number.isFinite(disk) || disk >= 10) &&
    bw >= 100 &&
    hasVerifiedQuota &&
    (cny <= 60 || ((isRes || pid === "boil") && cny <= 160)) &&
    (hasCnOpt || isRes || cny <= 45 || providerBaseWeight(pid) >= 240)
  ) {
    const trait = isRes ? "真家宽" : hasCnOpt ? (route.headline || "优化线路") : cny <= 45 ? `￥${cny.toFixed(1)}/月平价` : "热门机房";
    tags.push({
      ...PLAN_TAG_DEFS.scarce,
      reason: `实测精确余量仅剩 ${plan.stockCount} 台（${trait} · ${formatTagPort(bw)} 紧俏现货）`
    });
  }

  // 8. Budget Entry (低价入门): >=512M RAM, >=10G disk, verified >=100M port, verified >=500G/UNL traffic, <=¥18/mo
  if (
    cny <= 18 &&
    Number.isFinite(mem) &&
    mem >= 0.5 &&
    Number.isFinite(disk) &&
    disk >= 10 &&
    bw >= 100 &&
    hasVerifiedQuota
  ) {
    tags.push({
      ...PLAN_TAG_DEFS.budget,
      reason: `￥${cny.toFixed(1)}/月 · ${mem >= 1 ? `${mem}G` : "512M"} 内存 / ${disk}G 硬盘 · ${formatTagPort(bw)} 可用低门槛现货`
    });
  }

  const byKey = new Map(tags.map((t) => [t.key, t]));
  const primaryTag =
    byKey.get("blockbuster") ||
    byKey.get("generous") ||
    byKey.get("home-opt") ||
    byKey.get("annual") ||
    byKey.get("perf") ||
    byKey.get("value") ||
    byKey.get("scarce") ||
    byKey.get("budget") ||
    null;
  return { tags, primaryTag };
}

export const DEFAULT_FILTERS = Object.freeze({
  track: "all",
  opt: "all",
  deal: "all",
  status: "available",
  exactOnly: false,
  noNat: false,
  noSnapshot: false,
  fixedPriceOnly: false,
  savedOnly: false,
  region: "all",
  route: "all",
  cpu: "all",
  memory: "all",
  disk: "all",
  bandwidth: "all",
  traffic: "all",
  budget: "all",
  minPrice: "",
  maxPrice: "",
  cycle: "all",
  provider: "all",
  q: "",
  sort: "recommended"
});

export const SORT_OPTIONS = [
  { value: "recommended", label: "常用商家 · 现货优先" },
  { value: "cny-asc", label: "💰 月均参考价：低 → 高" },
  { value: "cny-desc", label: "💎 月均参考价：高 → 低" },
  { value: "stock-desc", label: "📦 精确库存：多 → 少" },
  { value: "event-recent", label: "⚡ 近期补货/变价优先" },
  { value: "orig-asc", label: "💵 原币种报价：低 → 高" }
];

const residentialTextRe = /家宽|家寬|住宅|民宅|residential|dual\s*isp|双\s*isp|雙\s*isp|comcast|verizon|at&t|frontier|hinet|softbank|att\b/i;
const nativeIpRe = /原生\s*ip|native\s*ip/i;

const providerLookup = new Map();
for (const p of providers) {
  providerLookup.set(p.id.toLowerCase(), p);
  for (const name of [p.name, ...(p.aliases || []), ...(p.inventoryNames || [])]) {
    if (name) providerLookup.set(normalizeSearch(name), p);
  }
}

export function resolveProvider(product) {
  if (!product) return null;
  if (product.providerId) {
    const byId = providerLookup.get(String(product.providerId).toLowerCase());
    if (byId) return byId;
  }
  const byName = providerLookup.get(normalizeSearch(plain(product.provider)));
  return byName || null;
}

/**
 * Strict ontological classification:
 * Never conflates a datacenter VPS claiming "Native IP" with true residential/ISP broadband (`category === "home"`).
 */
export function classifyProduct(product) {
  const category = product?.category === "home" ? "home" : product?.category === "vps" ? "vps" : "unclassified";
  const textBlob = [product?.name, product?.route, product?.region, product?.note].map(plain).join(" ");
  const hasNatTag = Array.isArray(product?.riskTags) && product.riskTags.some((t) => t?.value === "nat-shared");
  const isNat = hasNatTag || hasSharedIpEvidence(product);

  const isResidential = category === "home";
  const isDualIsp = /双\s*isp|雙\s*isp|dual\s*isp/i.test(textBlob);
  const isNativeIp = nativeIpRe.test(textBlob);

  const routes = detectedRoutes(product);
  const routeProfile = describeRouteProfile(product, { isResidential, isDualIsp, isNativeIp, isNat });
  const hasCnOpt = routeProfile.hasCnOpt;
  const isLanding = !isResidential && !hasCnOpt;

  let ipTier;
  if (isResidential) {
    ipTier = isDualIsp
      ? { value: "residential-dual-isp", label: "家宽·双ISP", tone: "home" }
      : { value: "residential", label: "真家宽·ISP", tone: "home" };
  } else if (hasCnOpt) {
    ipTier = { value: "cn-optimized", label: isNativeIp ? "优化·原生IP" : "回国优化", tone: "opt" };
  } else if (isNativeIp) {
    ipTier = { value: "datacenter-native", label: "机房原生IP", tone: "native" };
  } else {
    ipTier = { value: "datacenter", label: "国际纯落地", tone: "landing" };
  }

  const delivery = isNat ? "nat" : "unknown";

  return {
    category,
    isResidential,
    isDualIsp,
    isNativeIp,
    isNat,
    isLanding,
    delivery,
    ipTier,
    routes,
    routeProfile,
    hasCnOpt,
    mentionsResidentialInVps: !isResidential && residentialTextRe.test(textBlob)
  };
}

export function buildEventIndex(events = []) {
  const byProduct = new Map();
  const byProvider = new Map();
  for (const ev of events) {
    if (!ev || !ev.at) continue;
    const pid = ev.productId;
    if (pid) {
      if (!byProduct.has(pid)) byProduct.set(pid, []);
      byProduct.get(pid).push(ev);
    }
    const prov = resolveProvider(ev);
    const provId = prov?.id || ev.providerId || normalizeSearch(plain(ev.provider));
    if (provId) {
      if (!byProvider.has(provId)) byProvider.set(provId, []);
      byProvider.get(provId).push(ev);
    }
  }
  return { byProduct, byProvider };
}

export function normalizeProduct(raw, index, exchangeRates, eventIndex = new Map(), now = Date.now()) {
  if (Array.isArray(raw?.riskTags) && !hasSharedIpEvidence(raw)) {
    raw = { ...raw, riskTags: raw.riskTags.filter((tag) => tag?.value !== "nat-shared") };
  }
  const providerObj = resolveProvider(raw);
  const providerId = providerObj?.id || raw?.providerId || normalizeSearch(plain(raw?.provider)) || "unknown";
  const key = savedKey(raw) || `row:${index}`;
  const classify = classifyProduct(raw);
  const pricing = describePricing(raw, exchangeRates, now);
  const specs = productSpecs(raw);
  const numSpecs = parseNumericSpecs(raw, specs);
  const regions = productRegions(raw);
  const macroRegions = macroRegionsFor(raw);
  const location = describeLocation({ ...raw, _macroRegions: macroRegions });
  const flag = regionFlag(regions[0] || raw?.region || "");
  const search = productSearchText(raw, specs);
  const eventsForSku = eventIndex instanceof Map ? eventIndex.get(raw?.id) || [] : eventIndex?.byProduct?.get(raw?.id) || [];
  const latestEvent = eventsForSku[0] || null;
  const latestEventMs = latestEvent ? Date.parse(latestEvent.at) || 0 : 0;
  const evidenceVal = raw?.evidenceLevel?.value || "unverified";
  const isSnapshot = evidenceVal === "snapshot" || raw?.raw?.strategy === "reader_snapshot";
  const isExactStock = evidenceVal === "stock-count" && Number.isInteger(raw?.stockCount) && raw.stockCount > 0;
  const riskTags = Array.isArray(raw?.riskTags) ? raw.riskTags.filter(Boolean) : [];
  const highRiskCount = riskTags.filter((r) => r.severity === "high").length;

  const normalized = {
    ...raw,
    diagnostic: Boolean(raw?.diagnostic) || ["blocked", "error"].includes(raw?.status),
    _idx: index,
    _key: key,
    _providerId: providerId,
    _providerName: providerObj?.name || plain(raw?.provider) || "未知商家",
    _providerWeight: providerBaseWeight(providerId),
    _dossier: REVIEW_DOSSIERS[providerObj?.id] || null,
    _classify: classify,
    _declaredRouteText: declaredRouteText(raw),
    _pricing: pricing,
    _specs: specs,
    _numSpecs: numSpecs,
    _regions: regions,
    _macroRegions: macroRegions,
    _location: location,
    _flag: flag,
    _search: search,
    _events: eventsForSku,
    _latestEvent: latestEvent,
    _latestEventMs: latestEventMs,
    _isExactStock: isExactStock,
    _isSnapshot: isSnapshot,
    _evidenceRank: Number.isFinite(raw?.evidenceLevel?.rank) ? raw.evidenceLevel.rank : 6,
    _highRiskCount: highRiskCount
  };

  const planTagInfo = evaluatePlanTags(normalized);
  normalized._planTags = planTagInfo.tags;
  normalized._primaryPlanTag = planTagInfo.primaryTag;
  if (planTagInfo.tags.length > 0) {
    const tagBlob = normalizeSearch(planTagInfo.tags.flatMap((t) => [t.shortLabel, t.label, ...(t.searchAliases || [])]).join(" "));
    if (tagBlob) normalized._search = `${normalized._search} ${tagBlob}`;
  }

  return normalized;
}

export function matchesCycle(product, cycle) {
  if (!cycle || cycle === "all") return true;
  const months = product?._pricing?.quote?.months;
  if (cycle === "monthly") return months === 1;
  if (cycle === "quarterly") return months === 3;
  if (cycle === "semiannual") return months === 6;
  if (cycle === "annual") return Number.isFinite(months) && months >= 12;
  return true;
}

export function matchesRegion(product, region) {
  if (!region || region === "all") return true;
  if (product._macroRegions?.includes(region)) return true;
  const target = normalizeSearch(region);
  return (product._regions || []).some((r) => normalizeSearch(r) === target);
}

export function matchesHardwareSpecs(product, filters) {
  const ns = product._numSpecs || {};
  if (filters.cpu && filters.cpu !== "all") {
    const c = ns.cpuCores;
    if (!Number.isFinite(c)) return false;
    if (filters.cpu === "1" && c !== 1) return false;
    if (filters.cpu === "2" && c !== 2) return false;
    if (filters.cpu === "4" && (c < 3 || c > 4)) return false;
    if (filters.cpu === "8+" && c < 6) return false;
  }
  if (filters.memory && filters.memory !== "all") {
    const m = ns.memoryGb;
    if (!Number.isFinite(m)) return false;
    if (filters.memory === "le1" && m > 1) return false;
    if (filters.memory === "2" && m !== 2) return false;
    if (filters.memory === "4" && m !== 4) return false;
    if (filters.memory === "8" && m !== 8) return false;
    if (filters.memory === "16+" && m < 16) return false;
  }
  if (filters.disk && filters.disk !== "all") {
    const d = ns.diskGb;
    if (!Number.isFinite(d)) return false;
    if (filters.disk === "le20" && d > 20) return false;
    if (filters.disk === "21-50" && (d < 21 || d > 50)) return false;
    if (filters.disk === "51-100" && (d < 51 || d > 100)) return false;
    if (filters.disk === "100+" && d < 100) return false;
  }
  if (filters.bandwidth && filters.bandwidth !== "all") {
    const b = ns.bandwidthMbps;
    if (!Number.isFinite(b)) return false;
    if (filters.bandwidth === "le100" && b > 100) return false;
    if (filters.bandwidth === "200-500" && (b < 200 || b > 500)) return false;
    if (filters.bandwidth === "1g" && b !== 1000) return false;
    if (filters.bandwidth === "2.5g+" && b < 2000) return false;
  }
  if (filters.traffic && filters.traffic !== "all") {
    if (filters.traffic === "unlimited") {
      if (!ns.unlimitedTraffic) return false;
    } else {
      const t = ns.trafficGb;
      if (!Number.isFinite(t)) return false;
      if (filters.traffic === "le500" && t > 500) return false;
      if (filters.traffic === "501-1024" && (t < 501 || t > 1024)) return false;
      if (filters.traffic === "1t-3t" && (t < 1024 || t > 3072)) return false;
      if (filters.traffic === "3t+" && t < 3072) return false;
    }
  }
  return true;
}

export function matchesBudgetRange(product, filters) {
  const hasPreset = filters.budget && filters.budget !== "all";
  const minRaw = String(filters.minPrice ?? "").trim();
  const maxRaw = String(filters.maxPrice ?? "").trim();
  const hasMin = minRaw !== "" && Number.isFinite(Number(minRaw));
  const hasMax = maxRaw !== "" && Number.isFinite(Number(maxRaw));

  if (!hasPreset && !hasMin && !hasMax) return true;
  const cny = product._pricing?.cnyMonthly;
  if (!Number.isFinite(cny)) return false;

  if (hasMin && cny < Number(minRaw)) return false;
  if (hasMax && cny > Number(maxRaw)) return false;

  if (hasPreset && !hasMin && !hasMax) {
    const opt = BUDGET_OPTIONS.find((b) => b.value === filters.budget);
    if (opt) {
      if (opt.min !== null && cny < opt.min) return false;
      if (opt.max !== null && cny > opt.max) return false;
    } else if (/^\d+(?:\.\d+)?$/.test(filters.budget)) {
      // Backward compatibility for legacy ?budget=60 / ?budget=150 links
      if (cny > Number(filters.budget)) return false;
    }
  }
  return true;
}

export function matchesFilters(product, filters = DEFAULT_FILTERS, savedSet = new Set()) {
  if (!product || product.diagnostic) return false;
  const c = product._classify;

  if (filters.track === "home" && !c.isResidential) return false;
  if (filters.track === "vps" && c.isResidential) return false;
  if (filters.track === "cn-opt" && (c.isResidential || !c.hasCnOpt)) return false;
  if (filters.track === "landing" && !c.isLanding) return false;

  if (filters.opt === "3net" && (c.routeProfile?.netCount || 0) < 3) return false;
  if (filters.opt === "2net" && (c.routeProfile?.netCount || 0) < 2) return false;
  if (filters.opt === "opt" && !c.hasCnOpt) return false;
  if (filters.opt === "intl" && c.hasCnOpt) return false;
  if (filters.opt === "native" && !c.isResidential && !c.isDualIsp && !c.isNativeIp) return false;

  if (filters.deal && filters.deal !== "all") {
    const pTags = product._planTags || [];
    if (filters.deal === "any") {
      if (pTags.length === 0) return false;
    } else if (!pTags.some((t) => t.key === filters.deal)) {
      return false;
    }
  }

  if (filters.status && filters.status !== "all") {
    if (product.status !== filters.status) return false;
  }
  if (filters.exactOnly && !product._isExactStock) return false;
  if (filters.noNat && c.isNat) return false;
  if (filters.noSnapshot && product._isSnapshot) return false;
  if (filters.fixedPriceOnly) {
    const q = product._pricing.quote;
    if (q.baseOnly || q.months === null || q.amount === null) return false;
  }
  if (filters.savedOnly && !savedSet.has(product._key)) return false;

  if (!matchesRegion(product, filters.region)) return false;
  if (filters.route && filters.route !== "all" && !matchesRoute(product, filters.route)) return false;
  if (!matchesHardwareSpecs(product, filters)) return false;
  if (!matchesBudgetRange(product, filters)) return false;
  if (!matchesCycle(product, filters.cycle)) return false;

  if (filters.provider && filters.provider !== "all") {
    if (product._providerId !== filters.provider) return false;
  }

  if (filters.q && filters.q.trim()) {
    const tokens = normalizeSearch(filters.q).split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      if (!product._search.includes(token)) return false;
    }
  }

  return true;
}

function isCurrentCatalogPlan(record) {
  return record && !record.diagnostic && !["blocked", "error"].includes(record.status) &&
    !record.raw?.historical && record.verification?.state !== "historical";
}

// Current catalog data takes precedence over editorial priority and active filters.
export function rankProvidersByPopularity(allPlans = [], facetCounts = null) {
  const scaleMap = new Map();
  for (const p of allPlans) {
    if (!p || p.diagnostic) continue;
    let cur = scaleMap.get(p._providerId);
    if (!cur) {
      cur = { avail: 0, total: 0, current: 0, plans: [] };
      scaleMap.set(p._providerId, cur);
    }
    cur.total += 1;
    cur.plans.push(p);
    if (isCurrentCatalogPlan(p)) cur.current += 1;
    if (p.status === "available") cur.avail += 1;
  }

  return [...providers]
    .map((prov) => {
      const sc = scaleMap.get(prov.id) || { avail: 0, total: 0, current: 0, plans: [] };
      const base = providerBaseWeight(prov.id);
      const count = facetCounts ? facetCounts.get(prov.id) || 0 : sc.avail;
      const tagInfo = evaluateProviderTags(prov, sc.plans);
      return {
        provider: prov,
        avail: sc.avail,
        total: sc.total,
        hasCurrentPlans: sc.current > 0,
        count,
        isHot: isHotProvider(prov.id),
        shopTags: tagInfo.tags,
        primaryTag: tagInfo.primaryTag,
        tagMetrics: tagInfo.metrics,
        score: base
      };
    })
    .sort((a, b) => Number(b.hasCurrentPlans) - Number(a.hasCurrentPlans) || b.score - a.score || b.count - a.count || a.provider.name.localeCompare(b.provider.name, "zh-CN"));
}

export function sortProducts(list, sortKey = "recommended") {
  const arr = [...list];
  const statusWeight = (p) => (p.status === "available" ? 0 : p.status === "unknown" ? 1 : 2);

  if (sortKey !== "recommended") {
    arr.sort((a, b) => {
      if (sortKey === "cny-asc") {
        const ca = a._pricing.cnyMonthly ?? Infinity;
        const cb = b._pricing.cnyMonthly ?? Infinity;
        return statusWeight(a) - statusWeight(b) || ca - cb || comparePrices(a, b) || a._idx - b._idx;
      }
      if (sortKey === "cny-desc") {
        const ca = a._pricing.cnyMonthly ?? -1;
        const cb = b._pricing.cnyMonthly ?? -1;
        return statusWeight(a) - statusWeight(b) || cb - ca || a._idx - b._idx;
      }
      if (sortKey === "stock-desc") {
        const sa = Number.isInteger(a.stockCount) ? a.stockCount : -1;
        const sb = Number.isInteger(b.stockCount) ? b.stockCount : -1;
        return statusWeight(a) - statusWeight(b) || sb - sa || a._evidenceRank - b._evidenceRank || a._idx - b._idx;
      }
      if (sortKey === "event-recent") {
        return b._latestEventMs - a._latestEventMs || statusWeight(a) - statusWeight(b) || a._evidenceRank - b._evidenceRank || a._idx - b._idx;
      }
      if (sortKey === "orig-asc") {
        return statusWeight(a) - statusWeight(b) || comparePrices(a, b) || a._idx - b._idx;
      }
      return a._idx - b._idx;
    });
    return arr;
  }

  // Rank each provider's plans by evidence and price before interleaving brands.
  const innerRankCompare = (a, b) => {
    const ca = a._pricing.cnyMonthly ?? Infinity;
    const cb = b._pricing.cnyMonthly ?? Infinity;
    const natA = a._classify.isNat ? 1 : 0;
    const natB = b._classify.isNat ? 1 : 0;
    return (
      statusWeight(a) - statusWeight(b) ||
      a._evidenceRank - b._evidenceRank ||
      natA - natB ||
      a._highRiskCount - b._highRiskCount ||
      ca - cb ||
      comparePrices(a, b) ||
      a._idx - b._idx
    );
  };

  arr.sort(innerRankCompare);

  // One plan per provider per wave keeps large catalogs from filling the first screen.
  const seenPerProvider = new Map();
  const waveOf = new Map();
  for (const p of arr) {
    const k = `${statusWeight(p)}:${p._providerId}`;
    const n = seenPerProvider.get(k) || 0;
    seenPerProvider.set(k, n + 1);
    waveOf.set(p, n);
  }

  arr.sort((a, b) => {
    return (
      statusWeight(a) - statusWeight(b) ||
      waveOf.get(a) - waveOf.get(b) ||
      (b._providerWeight || 0) - (a._providerWeight || 0) ||
      innerRankCompare(a, b)
    );
  });

  return arr;
}

export function computeFacetCounts(plans, filters, savedSet) {
  const tracks = { all: 0, home: 0, "cn-opt": 0, landing: 0, vps: 0 };
  const withoutTrack = { ...filters, track: "all" };
  for (const p of plans) {
    if (!matchesFilters(p, withoutTrack, savedSet)) continue;
    tracks.all += 1;
    if (p._classify.isResidential) tracks.home += 1;
    else {
      tracks.vps += 1;
      if (p._classify.hasCnOpt) tracks["cn-opt"] += 1;
      if (p._classify.isLanding) tracks.landing += 1;
    }
  }

  const regions = new Map();
  const withoutRegion = { ...filters, region: "all" };
  for (const r of MACRO_REGIONS) regions.set(r.value, 0);
  for (const p of plans) {
    if (!matchesFilters(p, withoutRegion, savedSet)) continue;
    regions.set("all", (regions.get("all") || 0) + 1);
    for (const code of p._macroRegions) {
      regions.set(code, (regions.get(code) || 0) + 1);
    }
  }

  const routes = new Map();
  const withoutRoute = { ...filters, route: "all" };
  for (const r of ROUTE_OPTIONS) routes.set(r.value, 0);
  for (const p of plans) {
    if (!matchesFilters(p, withoutRoute, savedSet)) continue;
    routes.set("all", (routes.get("all") || 0) + 1);
    for (const opt of ROUTE_OPTIONS) {
      if (opt.value !== "all" && matchesRoute(p, opt.value)) {
        routes.set(opt.value, (routes.get(opt.value) || 0) + 1);
      }
    }
  }

  const providerCounts = new Map();
  const withoutProvider = { ...filters, provider: "all" };
  for (const p of plans) {
    if (!matchesFilters(p, withoutProvider, savedSet)) continue;
    providerCounts.set(p._providerId, (providerCounts.get(p._providerId) || 0) + 1);
  }

  const deals = new Map([["all", 0], ["any", 0], ...PLAN_TAG_ORDER.map((k) => [k, 0])]);
  const withoutDeal = { ...filters, deal: "all" };
  for (const p of plans) {
    if (!matchesFilters(p, withoutDeal, savedSet)) continue;
    deals.set("all", (deals.get("all") || 0) + 1);
    const pTags = p._planTags || [];
    if (pTags.length > 0) {
      deals.set("any", (deals.get("any") || 0) + 1);
      for (const t of pTags) {
        if (deals.has(t.key)) deals.set(t.key, (deals.get(t.key) || 0) + 1);
      }
    }
  }

  return { tracks, regions, routes, providerCounts, deals };
}

export function listActiveFilterBadges(filters) {
  const badges = [];
  const trackMap = {
    home: "类型: 真家宽/双ISP",
    "cn-opt": "类型: CN回国优化",
    landing: "类型: 国际纯落地",
    vps: "类型: 机房VPS"
  };
  if (filters.track !== "all") {
    badges.push({ key: "track", label: trackMap[filters.track] || `类型: ${filters.track}` });
  }
  if (filters.opt && filters.opt !== "all") {
    const m = OPT_OPTIONS.find((o) => o.value === filters.opt);
    badges.push({ key: "opt", label: m ? m.label : `优化: ${filters.opt}` });
  }
  if (filters.deal && filters.deal !== "all") {
    const m = PLAN_TAG_DEFS[filters.deal];
    badges.push({ key: "deal", label: filters.deal === "any" ? "亮点: 全部精选" : `亮点: ${m ? m.label : filters.deal}` });
  }
  if (filters.status !== DEFAULT_FILTERS.status) {
    const map = { all: "全部库存状态", unavailable: "仅看售罄", unknown: "仅看库存未公开", available: "仅看可购" };
    badges.push({ key: "status", label: `状态: ${map[filters.status] || filters.status}` });
  }
  if (filters.exactOnly) badges.push({ key: "exactOnly", label: "精确库存" });
  if (filters.noNat) badges.push({ key: "noNat", label: "排除 NAT" });
  if (filters.noSnapshot) badges.push({ key: "noSnapshot", label: "排除快照" });
  if (filters.fixedPriceOnly) badges.push({ key: "fixedPriceOnly", label: "明码固定周期" });
  if (filters.savedOnly) badges.push({ key: "savedOnly", label: "本地收藏" });
  if (filters.region !== "all") {
    const m = MACRO_REGIONS.find((r) => r.value === filters.region);
    badges.push({ key: "region", label: `地区: ${m ? m.label : filters.region}` });
  }
  if (filters.route !== "all") {
    const m = ROUTE_OPTIONS.find((r) => r.value === filters.route);
    badges.push({ key: "route", label: `线路: ${m ? m.label : filters.route}` });
  }
  if (filters.cpu && filters.cpu !== "all") {
    const m = CPU_OPTIONS.find((o) => o.value === filters.cpu);
    badges.push({ key: "cpu", label: `CPU: ${m ? m.label : filters.cpu}` });
  }
  if (filters.memory && filters.memory !== "all") {
    const m = MEMORY_OPTIONS.find((o) => o.value === filters.memory);
    badges.push({ key: "memory", label: `内存: ${m ? m.label : filters.memory}` });
  }
  if (filters.disk && filters.disk !== "all") {
    const m = DISK_OPTIONS.find((o) => o.value === filters.disk);
    badges.push({ key: "disk", label: `硬盘: ${m ? m.label : filters.disk}` });
  }
  if (filters.bandwidth && filters.bandwidth !== "all") {
    const m = BANDWIDTH_OPTIONS.find((o) => o.value === filters.bandwidth);
    badges.push({ key: "bandwidth", label: `带宽: ${m ? m.label : filters.bandwidth}` });
  }
  if (filters.traffic && filters.traffic !== "all") {
    const m = TRAFFIC_OPTIONS.find((o) => o.value === filters.traffic);
    badges.push({ key: "traffic", label: `流量: ${m ? m.label : filters.traffic}` });
  }
  if (filters.minPrice || filters.maxPrice) {
    badges.push({
      key: "priceRange",
      label: `预算: ￥${filters.minPrice || "0"}–${filters.maxPrice || "不限"}/月`
    });
  } else if (filters.budget !== "all") {
    const m = BUDGET_OPTIONS.find((b) => b.value === filters.budget);
    badges.push({ key: "budget", label: `预算: ${m ? m.label : `≤￥${filters.budget}`}` });
  }
  if (filters.cycle !== "all") {
    const m = CYCLE_OPTIONS.find((c) => c.value === filters.cycle);
    badges.push({ key: "cycle", label: `周期: ${m ? m.label : filters.cycle}` });
  }
  if (filters.provider !== "all") {
    const prov = providers.find((p) => p.id === filters.provider);
    badges.push({ key: "provider", label: `店铺: ${prov ? prov.name : filters.provider}` });
  }
  if (filters.q && filters.q.trim()) {
    badges.push({ key: "q", label: `关键词: “${filters.q.trim()}”` });
  }
  return badges;
}

export function diagnoseZeroResults(plans, filters, savedSet = new Set()) {
  const candidates = [];
  const check = (keys, label, patch) => {
    const next = { ...filters, ...patch };
    let count = 0;
    for (const p of plans) {
      if (matchesFilters(p, next, savedSet)) count += 1;
    }
    if (count > 0) {
      candidates.push({ keys, label, patch, recoveredCount: count });
    }
  };

  if (filters.q && filters.q.trim()) check(["q"], `清空搜索关键词「${filters.q.trim()}」`, { q: "" });
  if (filters.provider !== "all") {
    const prov = providers.find((p) => p.id === filters.provider);
    check(["provider"], `放宽店铺限定「${prov ? prov.name : filters.provider}」→ 全部店铺`, { provider: "all" });
  }
  if (filters.track !== "all") check(["track"], "切换为「全部节点类型」", { track: "all" });
  if (filters.opt && filters.opt !== "all") check(["opt"], "放宽「线路优化」限制", { opt: "all" });
  if (filters.deal && filters.deal !== "all") {
    const m = PLAN_TAG_DEFS[filters.deal];
    check(["deal"], `放宽商品亮点「${m ? m.label : filters.deal}」→ 全部商品`, { deal: "all" });
  }
  if (filters.region !== "all") {
    const m = MACRO_REGIONS.find((r) => r.value === filters.region);
    check(["region"], `放宽地区「${m ? m.label : filters.region}」→ 全部地区`, { region: "all" });
  }
  if (filters.route !== "all") {
    const m = ROUTE_OPTIONS.find((r) => r.value === filters.route);
    check(["route"], `放宽线路「${m ? m.label : filters.route}」→ 全部线路`, { route: "all" });
  }
  if (filters.cpu && filters.cpu !== "all") check(["cpu"], "放宽 CPU 核数限制", { cpu: "all" });
  if (filters.memory && filters.memory !== "all") check(["memory"], "放宽内存容量限制", { memory: "all" });
  if (filters.disk && filters.disk !== "all") check(["disk"], "放宽硬盘容量限制", { disk: "all" });
  if (filters.bandwidth && filters.bandwidth !== "all") check(["bandwidth"], "放宽端口带宽限制", { bandwidth: "all" });
  if (filters.traffic && filters.traffic !== "all") check(["traffic"], "放宽月流量配额限制", { traffic: "all" });
  if (filters.minPrice || filters.maxPrice || filters.budget !== "all") {
    check(["budget", "minPrice", "maxPrice"], "放宽月均预算范围限制", { budget: "all", minPrice: "", maxPrice: "" });
  }
  if (filters.status === "available") check(["status"], "包含已售罄与库存未公开套餐", { status: "all" });
  else if (filters.status !== "all") check(["status"], "切回全部库存状态", { status: "all" });
  if (filters.exactOnly) check(["exactOnly"], "关闭「仅看精确库存数字」", { exactOnly: false });
  if (filters.noNat) check(["noNat"], "关闭「排除 NAT / 共享 IP」", { noNat: false });
  if (filters.noSnapshot) check(["noSnapshot"], "允许包含第三方快照记录", { noSnapshot: false });
  if (filters.fixedPriceOnly) check(["fixedPriceOnly"], "允许包含起步价/周期未明套餐", { fixedPriceOnly: false });
  if (filters.cycle !== "all") check(["cycle"], "放宽计费周期限制", { cycle: "all" });
  if (filters.savedOnly) check(["savedOnly"], "退出「仅看本地收藏」", { savedOnly: false });

  if (candidates.length === 0) {
    if (filters.track !== "all" && filters.region !== "all") {
      check(["track", "region"], "同时放宽「类型」与「地区」限制", { track: "all", region: "all" });
    }
    if (filters.provider !== "all" && filters.status === "available") {
      check(["provider", "status"], "显示该店铺含售罄在内的全部记录或切回全部店铺", { status: "all" });
    }
  }

  candidates.sort((a, b) => b.recoveredCount - a.recoveredCount);
  return {
    activeCount: listActiveFilterBadges(filters).length,
    suggestions: candidates.slice(0, 5)
  };
}

export function providerHealth(provider, allRecords = []) {
  const names = new Set(
    [provider?.id, provider?.name, ...(provider?.aliases || []), ...(provider?.inventoryNames || [])]
      .filter(Boolean)
      .map((v) => normalizeSearch(v))
  );
  const matched = [];
  for (const rec of allRecords) {
    if (!rec) continue;
    if (rec._providerId) {
      if (rec._providerId === provider?.id) matched.push(rec);
      continue;
    }
    const byId = provider?.id && rec.providerId && String(rec.providerId).toLowerCase() === String(provider.id).toLowerCase();
    const byName = rec.provider && names.has(normalizeSearch(plain(rec.provider)));
    if (byId || byName) matched.push(rec);
  }

  let available = 0;
  let unavailable = 0;
  let unknown = 0;
  let blocked = 0;
  let error = 0;
  let exactCount = 0;
  let pageLimitReached = false;
  const diagnostics = [];
  const plans = [];

  for (const r of matched) {
    if (r.collection?.pageLimitReached) pageLimitReached = true;
    if (r.diagnostic) {
      diagnostics.push(r);
      if (r.status === "blocked") blocked += 1;
      else if (r.status === "error") error += 1;
      else unknown += 1;
      continue;
    }
    plans.push(r);
    if (r.status === "available") {
      available += 1;
      if (r.evidenceLevel?.value === "stock-count" && Number.isInteger(r.stockCount) && r.stockCount > 0) {
        exactCount += 1;
      }
    } else if (r.status === "unavailable") {
      unavailable += 1;
    } else if (r.status === "blocked") {
      blocked += 1;
    } else if (r.status === "error") {
      error += 1;
    } else {
      unknown += 1;
    }
  }

  const known = available + unavailable;
  const hasFailure = blocked > 0 || error > 0 || diagnostics.some((d) => d.status === "blocked" || d.status === "error");

  let state = "unknown";
  if (matched.length === 0) state = "unmonitored";
  else if (available > 0 && hasFailure) state = "partial";
  else if (available > 0) state = "healthy";
  else if (hasFailure && known === 0) state = "blocked";
  else if (unavailable > 0 && hasFailure) state = "partial";
  else if (unavailable > 0) state = "soldout";
  else state = "unknown";

  return {
    state,
    total: matched.length,
    planCount: plans.length,
    currentPlanCount: plans.filter(isCurrentCatalogPlan).length,
    known,
    available,
    unavailable,
    unknown,
    blocked,
    error,
    exactCount,
    pageLimitReached,
    diagnostics,
    plans
  };
}
