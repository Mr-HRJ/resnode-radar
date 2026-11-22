export function renderGuideView() {
  return `
    <div class="workspace-head">
      <div>
        <h1 class="workspace-title">选机核验口径与防踩坑手册</h1>
        <p class="workspace-sub">用工程证据替代商家营销话术：从 IP 宿主本质、回程线路、计费周期到监控可信度分级。</p>
      </div>
    </div>

    <div class="guide-presets" aria-label="高频业务场景一键直达">
      <button type="button" class="guide-preset-card" data-action="apply-preset" data-preset="us-home-dedicated">
        <span class="pill pill-home" style="align-self:flex-start">跨境电商 / 社媒</span>
        <strong>美区家宽（排除 NAT 标记） →</strong>
        <span>自动隔离普通机房原生 IP，排除 NAT 共享端口，仅看当前可购的美区住宅/双 ISP 套餐。</span>
      </button>
      <button type="button" class="guide-preset-card" data-action="apply-preset" data-preset="cn2-opt">
        <span class="pill pill-vps" style="align-self:flex-start">低延迟回程 / 建站</span>
        <strong>CN2 GIA 精品优化 →</strong>
        <span>锁定明确声明 CN2 GIA / GT（AS4809）且当前可订购的节点，按证据强度与价格排序。</span>
      </button>
      <button type="button" class="guide-preset-card" data-action="apply-preset" data-preset="budget-monthly">
        <span class="pill pill-ok" style="align-self:flex-start">轻量试错</span>
        <strong>≤ ¥60/月 明码月付 →</strong>
        <span>剔除起步选配价与周期不明套餐，基于 ECB 有效汇率筛选人民币月均 60 元以内月付方案。</span>
      </button>
      <button type="button" class="guide-preset-card" data-action="apply-preset" data-preset="exact-stock">
        <span class="pill pill-ok" style="align-self:flex-start">最高确定性</span>
        <strong>仅看精确库存数字 →</strong>
        <span>只保留官方页面公布具体剩余台数（<code>stock-count</code>）的高置信度在售套餐。</span>
      </button>
    </div>

    <div class="guide-grid">
      <article class="guide-card">
        <h3>1. 真家宽 / 双 ISP 与“机房原生 IP”的本质隔离</h3>
        <p>商家常把数据中心（Hosting ASN）广播出的本地归属段宣传为“原生 IP”，但在 TikTok、支付网关与流媒体风控模型中，<strong>ASN 宿主类型</strong>决定了绝大多数风控分差：</p>
        <ul>
          <li><strong>真家宽 / 双 ISP（青碧色标签）</strong>：仅当监控源明确归类为住宅宽带或双 ISP 宿主（<code>category: "home"</code>）时才归入本赛道，典型如 AT&amp;T、Verizon、Frontier、HiNet、SoftBank 民宅段。</li>
          <li><strong>机房原生 IP（钴蓝色标签）</strong>：属于数据中心机房（<code>category: "vps"</code>）但在 WHOIS 注册地与物理机房一致，适合建站、常规解锁与中转，<strong>绝不会被混入真家宽赛道</strong>。</li>
          <li><strong>防坑核验动作</strong>：买前在证据抽屉核对是否存在 <code>NAT/共享</code> 标签；到手后第一时间查 <code>bgp.tools</code> 与 IPinfo 的 <code>asn.type</code> 及 <code>company.type</code>，双 <code>isp</code> 才满足严格双 ISP 口径。</li>
        </ul>
      </article>

      <article class="guide-card">
        <h3>2. 常见回程线路速查矩阵</h3>
        <table class="route-matrix-table">
          <thead>
            <tr>
              <th>线路标识</th>
              <th>对应 ASN / 特征</th>
              <th>适用场景与注意点</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>CN2 GIA</strong></td>
              <td class="mono">AS4809</td>
              <td>电信晚高峰最稳、抖动最低，三网表现均衡；需核验是否“双程”或仅“回程”。</td>
            </tr>
            <tr>
              <td><strong>联通 9929</strong></td>
              <td class="mono">AS9929 / CUII</td>
              <td>联通高端精品网，拥塞率极低；常见于美西与欧洲高质量直连节点。</td>
            </tr>
            <tr>
              <td><strong>移动 CMIN2</strong></td>
              <td class="mono">AS58807</td>
              <td>中国移动高端国际骨干，对移动宽带晚高峰提升极为明显。</td>
            </tr>
            <tr>
              <td><strong>联通 4837</strong></td>
              <td class="mono">AS4837</td>
              <td>高性价比普通直连骨干，大带宽大流量居多；部分美西双 ISP 家宽采用 4837 回程。</td>
            </tr>
            <tr>
              <td><strong>BGP / 纯落地</strong></td>
              <td class="mono">国际互联</td>
              <td>直连内地晚高峰易丢包，通常作为中转后端落地或纯海外业务节点使用。</td>
            </tr>
          </tbody>
        </table>
      </article>

      <article class="guide-card">
        <h3>3. 价格防套路与 ECB 参考汇率红线</h3>
        <ul>
          <li><strong>永不篡改原始账单</strong>：每一行主数字永远完整展示官方币种与原始计费周期（如 <code>USD 72 / Annually</code>），绝不把年付伪装成低价月付。</li>
          <li><strong>起步价 &amp; 周期不明拒绝折算</strong>：包含「起 / from / configurable」或未标明自然月周期（如按 30 天/小时/一次性计费、周期表述冲突）的套餐，前端明确标注原因并停止月均折算。</li>
          <li><strong>7 天 ECB 汇率红线</strong>：外币折算参考人民币均来自欧洲央行（ECB）官方每日 XML 快照；若汇率日期超过 7 天，前端将自动熔断外币折算并弹出诚实提示，绝不使用陈旧汇率。</li>
          <li><strong>非结算价声明</strong>：参考月均人民币仅用于横向比价，不包含增值税（VAT）、发卡行货币转换费或支付网关手续费。</li>
        </ul>
      </article>

      <article class="guide-card">
        <h3>4. 证据等级、数据时效与诚实性边界</h3>
        <ul>
          <li><strong>精确库存（最高）</strong>：官方页面直接解析到明确正整数库存（如 <code>余 6</code>），置信度最高。</li>
          <li><strong>官方订购入口</strong>：官方页确认存在可点击订购路径，但未公开具体剩余台数，结算时仍可能缺货。</li>
          <li><strong>第三方快照（高风险提醒）</strong>：当商家开启 Cloudflare 挑战页阻断直连时（如 AaITR），仅在明确标注「第三方快照」前提下展示公开 Reader 快照并附完整 <code>attempts</code> 尝试记录。</li>
          <li><strong>30 分钟新鲜度预警 &amp; 零伪造降级</strong>：采集器每 10 分钟运行一次，快照超 30 分钟即触发顶部预警；页面每 5 分钟在可见标签页自动重读已发布 JSON（不触发爬虫）；若上游返回 <code>HTTP 503</code>，直接诚实降级并支持手动重试。</li>
          <li><strong>本地收藏声明</strong>：收藏夹仅保存在当前浏览器 <code>localStorage</code>，不会向服务器上传或发送补货推送通知。</li>
        </ul>
      </article>
    </div>

    <div class="guide-card" style="margin-top:var(--sp-4)">
      <h3>深度实测档案索引（统一设计体系）</h3>
      <p style="margin:0">以下为站长正在补齐一手账单、ASN 与晚高峰路由证据的结构化档案（诚实标注草稿状态，绝不展示虚构跑分）：</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <a class="btn btn-sm btn-soft" href="reviews/aaitr.html">AaITR 家宽与住宅网络实测档案 →</a>
        <a class="btn btn-sm btn-soft" href="reviews/lisahost.html">LisaHost 多地区双 ISP / 原生节点实测档案 →</a>
      </div>
    </div>
  `;
}
