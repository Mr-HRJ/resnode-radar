import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse, HTMLElement } from "node-html-parser";
import { mountApp } from "../src/app.js";
import { mountReviewDossier } from "../src/review-dossier.js";
import { providers } from "../providers.js";

function installDomEnvironment(t, htmlFile = "../index.html", initialUrl = "https://radar.example/") {
  const document = parse(readFileSync(new URL(htmlFile, import.meta.url), "utf8"));
  document.documentElement = document.querySelector("html");
  document.body = document.querySelector("body");
  document.visibilityState = "visible";
  document.activeElement = document.body;
  document.createElement = (tag) => parse(`<${tag}></${tag}>`).firstChild;

  const storage = new Map();
  const docHandlers = new Map();
  let currentHref = initialUrl;

  const win = {
    location: {
      get href() { return currentHref; },
      set href(v) { currentHref = v; }
    },
    history: {
      replaceState(_state, _title, url) {
        if (url) currentHref = String(url);
      }
    },
    addEventListener() {}
  };

  const globals = {
    document,
    window: win,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, val) => storage.set(key, String(val))
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {}
  };

  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => (original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name]));
  }

  document.addEventListener = (type, fn) => {
    if (!docHandlers.has(type)) docHandlers.set(type, []);
    docHandlers.get(type).push(fn);
  };
  document.removeEventListener = (type, fn) => {
    const list = docHandlers.get(type);
    if (!list) return;
    const idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
  };

  Object.defineProperties(HTMLElement.prototype, {
    dataset: {
      configurable: true,
      get() {
        return Object.fromEntries(
          Object.entries(this.attributes)
            .filter(([k]) => k.startsWith("data-"))
            .map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase()), v])
        );
      }
    },
    hidden: {
      configurable: true,
      get() { return this.hasAttribute("hidden"); },
      set(val) {
        if (val) this.setAttribute("hidden", "");
        else this.removeAttribute("hidden");
      }
    },
    closest: {
      configurable: true,
      value(selector) {
        let cur = this;
        while (cur && cur.tagName) {
          if (cur.matches?.(selector)) return cur;
          cur = cur.parentNode;
        }
        return null;
      }
    },
    matches: {
      configurable: true,
      value(selector) {
        if (selector.startsWith("[") && selector.endsWith("]")) {
          const inner = selector.slice(1, -1);
          const eqIdx = inner.indexOf("=");
          if (eqIdx === -1) return this.hasAttribute(inner);
          const attr = inner.slice(0, eqIdx);
          const rawVal = inner.slice(eqIdx + 1).replace(/^['"]|['"]$/g, "");
          return this.getAttribute(attr) === rawVal;
        }
        if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
        return this.tagName?.toLowerCase() === selector.toLowerCase();
      }
    },
    focus: {
      configurable: true,
      value() { document.activeElement = this; }
    }
  });
  t.after(() => {
    for (const k of ["dataset", "hidden", "closest", "matches", "focus"]) {
      delete HTMLElement.prototype[k];
    }
  });

  const tokenList = Object.getPrototypeOf(document.documentElement.classList);
  t.mock.method(tokenList, "toggle", function (name, force = !this.contains(name)) {
    if (force) this.add(name);
    else this.remove(name);
    return force;
  });

  return {
    document,
    getHref: () => currentHref,
    text: (sel) => document.querySelector(sel)?.textContent?.trim() ?? "",
    clickNode(node) {
      assert.ok(node, "Missing click node");
      for (const fn of docHandlers.get("click") || []) {
        fn({ target: node, preventDefault() {} });
      }
    },
    click(sel) {
      const node = document.querySelector(sel);
      assert.ok(node, `Missing click target: ${sel}`);
      for (const fn of docHandlers.get("click") || []) {
        fn({ target: node, preventDefault() {} });
      }
    },
    change(sel, value, checked) {
      const node = document.querySelector(sel);
      assert.ok(node, `Missing change target: ${sel}`);
      if (value !== undefined) node.value = value;
      if (checked !== undefined) node.checked = checked;
      for (const fn of docHandlers.get("change") || []) {
        fn({ target: node });
      }
    },
    input(sel, value) {
      const node = document.querySelector(sel);
      assert.ok(node, `Missing input target: ${sel}`);
      node.value = value;
      for (const fn of docHandlers.get("input") || []) {
        fn({ target: node });
      }
    },
    pressKey(key, extra = {}) {
      for (const fn of docHandlers.get("keydown") || []) {
        fn({ key, preventDefault() {}, ...extra });
      }
    },
    focus(sel) {
      const node = document.querySelector(sel);
      assert.ok(node, `Missing focus target: ${sel}`);
      node.focus?.();
      for (const fn of docHandlers.get("focusin") || []) {
        fn({ target: node });
      }
      return node;
    },
    blur(sel, relatedSel = null) {
      const node = document.querySelector(sel);
      assert.ok(node, `Missing blur target: ${sel}`);
      const relatedTarget = relatedSel ? document.querySelector(relatedSel) : null;
      for (const fn of docHandlers.get("focusout") || []) {
        fn({ target: node, relatedTarget });
      }
    }
  };
}

const samplePayload = {
  schemaVersion: 1,
  generatedAt: new Date(Date.now() - 10 * 60000).toISOString(),
  sourceCount: 3,
  summary: { total: 4, available: 2, unavailable: 0, unknown: 1, blocked: 1, error: 0 },
  eventTracking: { startedAt: new Date(Date.now() - 86400000).toISOString(), retentionDays: 7, limit: 300 },
  exchangeRates: { base: "CNY", date: new Date().toISOString().slice(0, 10), rates: { CNY: 1, USD: 7.0 } },
  events: [
    {
      id: "ev-1",
      type: "restock",
      at: new Date(Date.now() - 30 * 60000).toISOString(),
      productId: "home-att",
      providerId: "usvps24",
      provider: "USVPS24(干杯Cloud)",
      name: "加州 AT&T 双ISP 家宽",
      region: "美国",
      price: "$20/month",
      priceValue: 20,
      currency: "USD",
      stockCount: 8,
      orderUrl: "https://usvps24.com/order/1"
    },
    {
      id: "ev-2",
      type: "price",
      at: new Date(Date.now() - 90 * 60000).toISOString(),
      productId: "dc-native",
      providerId: "zorocloud",
      provider: "ZoroCloud",
      name: "JP-CN2-Starter",
      region: "日本",
      price: "¥39/月",
      priceValue: 39,
      previousPrice: "¥49/月",
      previousPriceValue: 49,
      currency: "CNY",
      stockCount: null,
      orderUrl: "https://my.zorocloud.com/order/jp"
    }
  ],
  products: [
    {
      id: "home-att",
      sourceId: "usvps24",
      providerId: "usvps24",
      provider: "USVPS24(干杯Cloud)",
      category: "home",
      adapter: "public_catalog",
      sourceUrl: "https://usvps24.com/",
      fetchedAt: new Date().toISOString(),
      region: "美国",
      route: "AT&T 双 ISP 住宅 IP",
      name: "加州 AT&T 双ISP 家宽",
      hardware: "2 vCPU / 4 GB RAM / 40 GB NVMe",
      bandwidth: "500 Mbps / 2 TB",
      price: "$20/month",
      priceValue: 20,
      currency: "USD",
      status: "available",
      statusLabel: "库存 8",
      stockCount: 8,
      orderUrl: "https://usvps24.com/order/1",
      evidence: "Official API stock=8",
      evidenceLevel: { value: "stock-count", label: "精确库存 8", className: "is-count", rank: 1 },
      riskTags: [{ value: "no-extra-risk", label: "未见额外风险", severity: "low" }]
    },
    {
      id: "dc-native",
      sourceId: "zoro",
      providerId: "zorocloud",
      provider: "ZoroCloud",
      category: "vps",
      adapter: "whmcs_group",
      sourceUrl: "https://my.zorocloud.com/",
      fetchedAt: new Date().toISOString(),
      region: "日本",
      route: "CN2 GIA 原生 IP",
      name: "JP-CN2-Starter",
      hardware: "1 vCPU / 1 GB RAM / 20 GB SSD",
      bandwidth: "200 Mbps / 500 GB",
      price: "¥39/月",
      priceValue: 39,
      currency: "CNY",
      status: "available",
      statusLabel: "可订购入口",
      stockCount: null,
      orderUrl: "https://my.zorocloud.com/order/jp",
      evidence: "Official WHMCS order button",
      evidenceLevel: { value: "official-order", label: "官方订购入口", className: "is-official", rank: 2 },
      riskTags: [{ value: "order-only", label: "仅证明可下单", severity: "medium" }]
    },
    {
      id: "diag-row",
      sourceId: "taipei101",
      providerId: "taipei101",
      provider: "Taipei101",
      category: "unclassified",
      adapter: "public_catalog",
      sourceUrl: "https://vps.taipei/",
      fetchedAt: new Date().toISOString(),
      diagnostic: true,
      name: "Taipei101 采集状态",
      status: "blocked",
      statusLabel: "直连受阻",
      httpStatus: 403,
      evidence: "HTTP 403 WAF Challenge",
      raw: { attempts: [{ url: "https://vps.taipei/", statusCode: 403 }] },
      evidenceLevel: { value: "blocked", label: "直连受阻", className: "is-blocked", rank: 5 },
      riskTags: [{ value: "direct-blocked", label: "官方直连受阻", severity: "high" }]
    }
  ]
};

test("skeleton loading, HTTP 503 honest degradation, and retry recovery isolate diagnostics", async (t) => {
  const env = installDomEnvironment(t);
  const pending = [];
  t.mock.method(globalThis, "fetch", (url, opts) => {
    assert.equal(url, "data/products.json");
    assert.equal(opts.cache, "default");
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  });

  const app = mountApp();
  t.after(() => app.dispose());

  // 1. Skeleton state
  assert.equal(env.text("[data-telemetry-label]"), "同步快照中…");
  assert.ok(env.document.querySelector("[data-skeleton-grid]"));

  // 2. Upstream HTTP 503 failure -> honest error panel, never mock data
  pending.shift().resolve(new Response(JSON.stringify({ error: "Inventory source returned HTTP 503" }), { status: 503 }));
  await new Promise(setImmediate);
  assert.equal(env.text("[data-telemetry-label]"), "上游数据源不可用");
  assert.equal(env.text("[data-stat-available]"), "-");
  assert.match(env.text("[data-error-panel]"), /HTTP 503/);

  // 3. Manual retry recovers real catalog and excludes diagnostic records from purchasable terminal
  env.click("[data-action='refresh-snapshot']");
  pending.shift().resolve(new Response(JSON.stringify(samplePayload)));
  await new Promise(setImmediate);

  assert.match(env.text("[data-telemetry-label]"), /实时快照/);
  assert.equal(env.text("[data-stat-available]"), "2");
  assert.equal(env.text("[data-stat-exact]"), "1");
  assert.equal(env.text("[data-stat-home]"), "1");
  assert.equal(env.text("[data-stat-blocked]"), "1");
  assert.match(env.text("[data-view-panel='terminal']"), /加州 AT&T 双ISP 家宽/);
  assert.doesNotMatch(env.text("[data-view-panel='terminal']"), /Taipei101 采集状态/);
});

test("provider view distinguishes a failed initial snapshot from an empty catalog and supports retry", async (t) => {
  const env = installDomEnvironment(t, "../index.html", "https://radar.example/?view=providers");
  let failed = true;
  t.mock.method(globalThis, "fetch", async () => failed
    ? Response.json({ error: "Inventory source unavailable" }, { status: 503 })
    : Response.json(samplePayload));
  const app = mountApp();
  t.after(() => app.dispose());
  await new Promise(setImmediate);

  assert.match(env.text("[data-view-panel='providers']"), /无法加载.*商家/);
  assert.equal(env.document.querySelectorAll(".provider-card").length, 0);
  failed = false;
  env.click("[data-view-panel='providers'] [data-action='refresh-snapshot']");
  await new Promise(setImmediate);
  assert.ok(env.document.querySelectorAll(".provider-card").length > 0);
  assert.match(env.text("[data-view-panel='providers']"), /USVPS24/);
});

test("compact bandwidth display keeps byte-per-second units distinct from bit-per-second units", async (t) => {
  const env = installDomEnvironment(t);
  const payload = structuredClone(samplePayload);
  payload.products[0].bandwidth = "1000 MBps / 2 TB";
  payload.products[1].bandwidth = "1000 Mbps / 1 TB";
  t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  const app = mountApp();
  t.after(() => app.dispose());
  await new Promise(setImmediate);

  assert.equal(env.text("[data-product-id='home-att'] .bw-highlight"), "1000 MBps");
  assert.equal(env.text("[data-product-id='dc-native'] .bw-highlight"), "1 Gbps");
  assert.equal(app.store.getState().plans.find((p) => p.id === "home-att")._numSpecs.bandwidthMbps, 8000);
});

test("stale snapshot (>90m) and expired FX (>7d) surface honest status banners and stop CNY conversion", async (t) => {
  const env = installDomEnvironment(t);
  const stalePayload = {
    ...samplePayload,
    generatedAt: new Date(Date.now() - 120 * 60000).toISOString(),
    exchangeRates: { base: "CNY", date: "2026-01-01", rates: { CNY: 1, USD: 7.0 } }
  };
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(stalePayload)));

  const app = mountApp();
  t.after(() => app.dispose());
  await new Promise(setImmediate);

  assert.match(env.text("[data-telemetry-label]"), /快照偏旧/);
  assert.match(env.text("[data-status-banner]"), /超过 30 分钟/);
  assert.match(env.text("[data-status-banner]"), /已超 7 天有效期/);
  assert.match(env.text("[data-view-panel='terminal']"), /汇率超7天/);
});

test("track isolation, zero-result recovery, command palette, compare matrix, inspector, watchlist, and workspaces work end-to-end", async (t) => {
  const env = installDomEnvironment(t);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(samplePayload)));

  const app = mountApp();
  t.after(() => app.dispose());
  await new Promise(setImmediate);

  // 1. Track isolation via Top Facet Matrix Card: True Residential ISP excludes Datacenter Native IP
  assert.equal(env.document.querySelector("[data-filter-dock] [data-terminal-search]"), null);
  env.click("[data-filter-dock] [data-track='home']");
  assert.match(env.text("[data-view-panel='terminal']"), /加州 AT&T 双ISP 家宽/);
  assert.doesNotMatch(env.text("[data-view-panel='terminal']"), /JP-CN2-Starter/);
  assert.match(env.getHref(), /track=home/);

  // 2. Smart zero-results counterfactual attribution via conflicting route pill & 1-click relaxation
  env.click("[data-filter-dock] [data-route='cn2']");
  assert.ok(env.document.querySelector("[data-zero-results]"));
  env.click("[data-action='apply-relaxation']");
  assert.ok(!env.document.querySelector("[data-zero-results]"));

  // 2b. Uncollected priority brands stay visible; other zero-count shops remain hidden.
  assert.match(env.text("[data-app-header]"), /VPS雷达/);
  assert.match(env.text("[data-app-header]"), /vpsld/);
  assert.match(env.text(".market-spotlight"), /全网大盘/);
  env.click("[data-action='reset-filters']");
  assert.match(env.text(".terminal-table"), /官方入口 · 未报数/);
  assert.doesNotMatch(env.text(".terminal-table"), /有货可购/);
  env.click("[data-action='toggle-shops-expand']");
  assert.match(env.text("[data-action='toggle-shops-expand']"), /收起店铺/);
  assert.match(env.text("[data-shops-row]"), /ZoroCloud/);
  assert.doesNotMatch(env.text("[data-shops-row]"), /Taipei101/);
  assert.match(env.text("[data-shops-row] [data-provider='dmit']"), /热门\s+DMIT\s+待核验/);
  env.click("[data-action='toggle-shops-expand']");
  env.click("[data-filter-dock] [data-spec-key='cpu'][data-spec-val='2']");
  assert.match(env.getHref(), /cpu=2/);
  env.input("[data-filter-dock] [data-price-max]", "200");
  assert.match(env.getHref(), /maxP=200/);
  env.click("[data-action='sort-col']");
  assert.match(env.getHref(), /sort=cny-asc/);

  // 3. Reset, add both plans to Compare, open Compare Modal with Diff toggle, close via Escape
  env.click("[data-action='reset-filters']");
  const compareBtns = env.document.querySelectorAll(".terminal-table [data-action='toggle-compare']");
  assert.equal(compareBtns.length, 2);
  env.clickNode(compareBtns[0]);
  env.clickNode(env.document.querySelectorAll(".terminal-table [data-action='toggle-compare']")[1]);
  assert.equal(env.text("[data-compare-badge]"), "2/4");
  assert.equal(env.document.querySelector("[data-compare-dock]").hidden, false);

  env.click("[data-action='open-compare']");
  assert.equal(env.document.querySelector("[data-compare-modal]").hidden, false);
  assert.equal(env.document.body.classList.contains("scroll-locked"), true);
  assert.match(env.text("[data-compare-modal]"), /多方案关键指标横向对比/);
  assert.match(env.text("[data-compare-modal]"), /最低/);
  env.pressKey("Escape");
  assert.equal(env.document.querySelector("[data-compare-modal]").hidden, true);
  assert.equal(env.document.body.classList.contains("scroll-locked"), false);

  // 4. Open Plan Inspector Drawer & close via Escape
  env.click(".terminal-table tr[data-action='inspect-plan']");
  assert.equal(env.document.querySelector("[data-inspector-backdrop]").hidden, false);
  assert.match(env.text("[data-inspector-backdrop]"), /原始采集证据链与风险审计/);
  env.pressKey("Escape");
  assert.equal(env.document.querySelector("[data-inspector-backdrop]").hidden, true);

  // 5. Command Palette via Cmd+K, filter list via Enter, & Escape
  env.pressKey("k", { metaKey: true });
  assert.equal(env.document.querySelector("[data-palette-backdrop]").hidden, false);
  env.input("[data-palette-input]", "AT&T");
  env.pressKey("Enter");
  assert.equal(env.document.querySelector("[data-palette-backdrop]").hidden, true);
  assert.match(env.getHref(), /q=AT%26T/);
  env.click("[data-action='clear-search']");
  assert.doesNotMatch(env.getHref(), /q=/);

  // 6. Save item & open Saved Watchlist Drawer
  env.click(".terminal-table [data-action='toggle-save']");
  assert.equal(env.text("[data-saved-count]"), "1");
  env.click("[data-action='open-saved']");
  assert.equal(env.document.querySelector("[data-saved-backdrop]").hidden, false);
  env.pressKey("Escape");
  assert.equal(env.document.querySelector("[data-saved-backdrop]").hidden, true);

  // 7. Navigate Radar (restock + price delta %), Providers (all deduplicated vendors + collecting filter + diagnostic), and Guide Presets
  env.click("[data-nav-view='radar']");
  assert.match(env.text("[data-view-panel='radar']"), /补货上架/);
  assert.match(env.text("[data-view-panel='radar']"), /-20\.4%/);

  env.click("[data-nav-view='providers']");
  assert.match(env.text("[data-view-panel='providers']"), new RegExp(`${providers.length} 家`));
  assert.match(env.text("[data-view-panel='providers']"), /查看采集诊断证据/);
  assert.match(env.text("[data-view-panel='providers']"), /仅看收集中/);
  env.click("[data-action='set-prov-health'][data-health='collecting']");
  assert.match(env.text("[data-view-panel='providers']"), /目录收集中/);
  assert.match(env.text("[data-view-panel='providers']"), /六六云/);
  env.click("[data-action='reset-providers']");

  env.click("[data-nav-view='guide']");
  env.click("[data-preset='us-home-dedicated']");
  assert.equal(env.document.querySelector("[data-view-panel='terminal']").hidden, false);
  assert.match(env.getHref(), /track=home/);
  assert.match(env.getHref(), /noNat=1/);
});

test("shop picker searches aliases without filtering products and preserves the selected shortcut", async (t) => {
  const env = installDomEnvironment(t);
  const payload = structuredClone(samplePayload);
  const extraProviders = ["vps", "evoxt", "misaka", "lisahost", "greencloud", "spartan", "zgovps", "racknerd"];
  payload.products.push(...extraProviders.map((providerId) => ({ ...samplePayload.products[1], id: `${providerId}-plan`, providerId })));
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(payload)));
  const app = mountApp();
  t.after(() => app.dispose());
  await new Promise(setImmediate);
  const beforeRows = env.document.querySelectorAll(".terminal-table tbody tr").length;
  const beforeShortcuts = env.document.querySelectorAll("[data-shops-row] [data-provider]").map((el) => el.getAttribute("data-provider"));
  assert.equal(env.document.querySelector("[data-shop-picker]").hidden, true);
  assert.equal(env.document.querySelector("[data-shops-row] [data-provider='racknerd']"), null);

  env.click("[data-action='toggle-shops-expand']");
  assert.equal(env.document.querySelector("[data-shop-picker]").hidden, false);
  assert.equal(env.document.activeElement, env.document.querySelector("[data-shop-search]"));
  assert.deepEqual(env.document.querySelectorAll("[data-shops-row] [data-provider]").map((el) => el.getAttribute("data-provider")), beforeShortcuts);
  env.input("[data-shop-search]", "狗妈咪");
  assert.equal(env.document.activeElement, env.document.querySelector("[data-shop-search]"));
  assert.equal(env.document.querySelectorAll(".shop-choice").length, 1);
  assert.match(env.text(".shop-choice"), /热门\s+Gomami\s+待核验/);
  assert.equal(env.document.querySelectorAll(".terminal-table tbody tr").length, beforeRows);
  assert.equal(app.store.getState().filters.q, "");
  assert.doesNotMatch(env.getHref(), /q=/);

  env.input("[data-shop-search]", '<img src=x onerror="alert(1)">');
  assert.equal(env.document.querySelector("[data-shop-picker] img"), null);
  assert.match(env.text(".shop-picker-empty"), /没有找到匹配的商家/);
  env.click("[data-action='clear-shop-search']");
  assert.equal(env.document.querySelector(".shop-picker-empty"), null);
  env.input("[data-shop-search]", "RACKNERD");
  env.click("[data-shop-picker] [data-provider='racknerd']");
  assert.equal(app.store.getState().filters.provider, "racknerd");
  assert.equal(env.document.querySelector("[data-shop-picker]").hidden, true);
  assert.equal(env.document.querySelector("[data-shops-row] [data-provider='racknerd']").getAttribute("aria-pressed"), "true");
  assert.equal(env.document.querySelectorAll(".terminal-table tbody tr").length, 1);

  env.click("[data-action='toggle-shops-expand']");
  assert.equal(app.store.getState().shopQuery, "");
  assert.equal(env.document.querySelector("[data-shop-picker] [data-provider='racknerd']").getAttribute("aria-pressed"), "true");
  env.pressKey("Escape");
  assert.equal(env.document.querySelector("[data-shop-picker]").hidden, true);
  assert.equal(env.document.activeElement, env.document.querySelector("[data-action='toggle-shops-expand']"));
});

test("billing formats stay consistent across lists, cards, details, saved items, comparison and events", async (t) => {
  const env = installDomEnvironment(t);
  const payload = structuredClone(samplePayload);
  Object.assign(payload.products[0], { price: "USD 72 / Annually", priceValue: 72 });
  Object.assign(payload.products[1], { price: "156.00元/季付", priceValue: 156 });
  Object.assign(payload.events[0], { price: "USD 72 / Annually", priceValue: 72 });
  Object.assign(payload.events[1], { price: "156.00元/季付", priceValue: 156, previousPrice: "196.00元/季付", previousPriceValue: 196 });
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(payload)));
  const app = mountApp();
  t.after(() => app.dispose());
  await new Promise(setImmediate);

  assert.equal(env.text("[data-product-id='home-att'] .price-primary"), "$72/年");
  assert.equal(env.text("[data-product-id='dc-native'] .price-primary"), "￥156/季度");
  assert.match(env.text("[data-product-id='home-att'] .price-sub"), /￥42\.0\/月/);
  assert.equal(env.text(".live-capsule-item[data-product-id='home-att'] .ev-price"), "$72/年");
  env.click(".terminal-table [data-product-id='home-att'] [data-action='toggle-save']");
  env.click("[data-action='open-saved']");
  assert.match(env.text("[data-saved-backdrop]"), /\$72\/年/);
  env.pressKey("Escape");

  env.click(".terminal-table [data-product-id='home-att'] [data-action='toggle-compare']");
  env.click(".terminal-table [data-product-id='dc-native'] [data-action='toggle-compare']");
  env.click("[data-action='open-compare']");
  assert.match(env.text("[data-compare-modal]"), /\$72\/年/);
  assert.match(env.text("[data-compare-modal]"), /￥156\/季度/);
  env.pressKey("Escape");

  env.click(".terminal-table [data-product-id='home-att']");
  assert.equal(env.text(".insp-price-orig"), "$72/年");
  assert.match(env.text("[data-inspector-backdrop]"), /官方报价原文\s+USD 72 \/ Annually/);
  env.pressKey("Escape");
  env.pressKey("k", { metaKey: true });
  env.input("[data-palette-input]", "AT&T");
  assert.match(env.text("[data-action='palette-plan'][data-product-id='home-att'] .palette-item-sub"), /\$72\/年/);
  env.pressKey("Escape");

  env.click("[data-layout='grid']");
  assert.equal(env.text("[data-product-id='home-att'] .price-primary"), "$72/年");
  assert.equal(env.text("[data-product-id='dc-native'] .price-primary"), "￥156/季度");
  env.click("[data-nav-view='radar']");
  assert.match(env.text(".tape-list"), /\$72\/年/);
  assert.match(env.text(".tape-list"), /￥156\/季度/);
  assert.equal(env.text(".price-old"), "￥196/季度");
});

test("budget presets and custom amounts replace each other without leaving hidden filters", async (t) => {
  const env = installDomEnvironment(t);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(samplePayload)));
  const app = mountApp();
  t.after(() => app.dispose());
  await new Promise(setImmediate);

  env.input("[data-filter-dock] [data-price-min]", "100");
  env.input("[data-filter-dock] [data-price-max]", "200");
  assert.match(env.text(".terminal-table"), /加州 AT&T/);
  assert.doesNotMatch(env.text(".terminal-table"), /JP-CN2-Starter/);
  assert.ok(env.document.querySelector("[data-filter-select='budget'] option[value='custom'][selected]"));

  env.change("[data-filter-select='budget']", "20-50");
  assert.equal(app.store.getState().filters.minPrice, "");
  assert.equal(app.store.getState().filters.maxPrice, "");
  assert.match(env.text(".terminal-table"), /JP-CN2-Starter/);
  assert.doesNotMatch(env.text(".terminal-table"), /加州 AT&T/);
  assert.doesNotMatch(env.getHref(), /minP=|maxP=/);

  env.input("[data-filter-dock] [data-price-min]", "100");
  assert.equal(app.store.getState().filters.budget, "all");
  assert.match(env.text(".terminal-table"), /加州 AT&T/);
  env.change("[data-filter-select='budget']", "all");
  assert.equal(env.document.querySelectorAll(".terminal-table tbody tr").length, 2);
  assert.equal(env.document.querySelector("[data-filter-select='budget'] option[value='custom']"), null);
});

test("priority brands show pending stock honestly and never label every plan hot", async (t) => {
  const env = installDomEnvironment(t);
  const payload = structuredClone(samplePayload);
  payload.products.push(
    ...Array.from({ length: 6 }, (_, i) => ({ ...samplePayload.products[1], id: `bwh-${i}`, providerId: "bwh", provider: "搬瓦工(BWH)" })),
    { ...samplePayload.products[2], id: "dmit-diag", providerId: "dmit", provider: "DMIT" }
  );
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(payload)));
  const app = mountApp();
  t.after(() => app.dispose());
  await new Promise(setImmediate);

  const shopIds = env.document.querySelectorAll("[data-shops-row] [data-provider]").map((el) => el.getAttribute("data-provider"));
  assert.deepEqual(shopIds.slice(1, 5), ["bwh", "zorocloud", "usvps24", "dmit"]);
  env.click("[data-action='toggle-shops-expand']");
  const pickerIds = env.document.querySelectorAll(".shop-choice").map((el) => el.getAttribute("data-provider"));
  const mobileIds = env.document.querySelectorAll("[data-mobile-filter-sheet] [data-filter-select='provider'] option").map((el) => el.getAttribute("value"));
  assert.deepEqual(pickerIds.slice(0, 4), ["bwh", "zorocloud", "usvps24", "dmit"]);
  assert.deepEqual(mobileIds.slice(1, 5), pickerIds.slice(0, 4));
  assert.ok(pickerIds.indexOf("vmiss") > pickerIds.indexOf("zorocloud"));
  assert.equal(env.document.querySelector(".tag-badge.is-hot"), null);
  assert.ok(env.document.querySelector(".terminal-table .tag-badge.is-restock"));
  assert.match(env.text("[data-mobile-filter-sheet] option[value='dmit']"), /待核验/);

  env.click("[data-filter-dock] [data-provider='bwh']");
  assert.equal(env.document.querySelectorAll(".terminal-table tbody tr").length, 6);
  assert.equal(env.document.querySelector(".tag-badge.is-hot"), null);
  env.click("[data-layout='grid']");
  assert.equal(env.document.querySelectorAll(".plan-grid .plan-card").length, 6);
  assert.equal(env.document.querySelector(".tag-badge.is-hot"), null);

  env.click("[data-filter-dock] [data-provider='dmit']");
  assert.match(env.text("[data-zero-results]"), /库存待核验/);
  assert.match(env.text("[data-zero-results]"), /官方页面访问受限/);
  assert.doesNotMatch(env.text("[data-zero-results]"), /条件存在互斥/);
  assert.equal(env.document.querySelector("[data-zero-results] a").getAttribute("href"), "https://www.dmit.io/");
  env.click("[data-zero-results] [data-action='reset-filters']");
  assert.equal(env.document.querySelector("[data-zero-results]"), null);

  env.click("[data-nav-view='providers']");
  assert.deepEqual(env.document.querySelectorAll(".provider-name").slice(0, 4).map((el) => el.textContent), ["搬瓦工(BWH)", "ZoroCloud", "USVPS24(干杯Cloud)", "DMIT"]);
});

test("standalone review dossier page hydrates live provider telemetry under unified design system", async (t) => {
  const env = installDomEnvironment(t, "../reviews/aaitr.html", "https://radar.example/reviews/aaitr.html");
  t.mock.method(globalThis, "fetch", async () =>
    new Response(
      JSON.stringify({
        ...samplePayload,
        products: [
          {
            ...samplePayload.products[0],
            id: "aaitr-1",
            providerId: "aaitr",
            provider: "AaITR",
            name: "US Verizon Residential NAT"
          }
        ]
      })
    )
  );
  const dossier = await mountReviewDossier();
  t.after(() => dossier.dispose());
  assert.match(env.text("[data-review-live-box]"), /US Verizon Residential NAT/);
});

test("overlapping refreshes share a request and disposal aborts without mutating state", async (t) => {
  installDomEnvironment(t);
  const requests = [];
  t.mock.method(globalThis, "fetch", (_url, options) => new Promise((resolve) => requests.push({ resolve, signal: options.signal })));
  const app = mountApp();
  t.after(() => app.dispose());
  const pending = app.refresh();
  assert.equal(requests.length, 1);
  requests[0].resolve(new Response(JSON.stringify(samplePayload)));
  await pending;
  assert.equal(app.store.getState().loadState, "ready");

  const next = app.refresh();
  assert.equal(requests.length, 2);
  const previous = app.store.getState().payload;
  app.dispose();
  assert.equal(requests[1].signal.aborted, true);
  requests[1].resolve(new Response(JSON.stringify({ ...samplePayload, generatedAt: "2020-01-01T00:00:00Z" })));
  await next;
  assert.equal(app.store.getState().payload, previous);
});

test("invalid comparison deep links do not leave an invisible scroll lock", async (t) => {
  const env = installDomEnvironment(t, "../index.html", "https://radar.example/?cmp=gone&compareOpen=1");
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(samplePayload)));
  const app = mountApp();
  t.after(() => app.dispose());
  await new Promise(setImmediate);
  assert.equal(app.store.getState().compareOpen, false);
  assert.deepEqual(app.store.getState().compareKeys, []);
  assert.equal(env.document.body.classList.contains("scroll-locked"), false);
  assert.doesNotMatch(env.getHref(), /cmp=|compareOpen=/);
});

test("provider diagnostics escape fetched URLs and KPI totals match their filters", async (t) => {
  const env = installDomEnvironment(t, "../index.html", "https://radar.example/?view=providers");
  const payload = structuredClone(samplePayload);
  const diagnostic = payload.products.find((p) => p.diagnostic);
  diagnostic.raw = { attempts: [{ url: '<img src=x onerror="alert(1)">', httpStatus: '<svg onload="alert(1)">' }] };
  payload.products[0].collection = { pageLimitReached: true };
  payload.products[1].status = "unavailable";
  payload.products.push({ ...diagnostic, id: "partial-diagnostic", providerId: payload.products[1].providerId, provider: payload.products[1].provider });
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(payload)));
  const app = mountApp();
  t.after(() => app.dispose());
  await new Promise(setImmediate);
  assert.equal(env.document.querySelector(".diag-box img"), null);
  assert.equal(env.document.querySelector(".diag-box svg"), null);
  assert.match(env.text(".diag-box"), /<img/);
  const available = Number(env.text("[data-health='available'] .kpi-val"));
  env.click("[data-health='available']");
  assert.equal(env.document.querySelectorAll(".provider-card").length, available);
  const issue = Number(env.text("[data-health='issue'] .kpi-val"));
  env.click("[data-health='issue']");
  assert.equal(env.document.querySelectorAll(".provider-card").length, issue);
});

test("live ticker ribbon, sync bar, and non-flicker transition classes respect filters and state updates", async (t) => {
  const env = installDomEnvironment(t);
  let resolveFetch;
  t.mock.method(globalThis, "fetch", () => new Promise((r) => { resolveFetch = r; }));

  const app = mountApp();
  t.after(() => app.dispose());

  // Sync bar sweeps indeterminately while initial snapshot is loading
  assert.equal(env.document.querySelector("[data-sync-progress]").classList.contains("is-syncing"), true);

  resolveFetch(new Response(JSON.stringify(samplePayload)));
  await new Promise(setImmediate);

  assert.equal(env.document.querySelector("[data-sync-progress]").classList.contains("is-syncing"), false);
  assert.ok(env.document.querySelector("[data-live-ribbon]"));
  assert.match(env.text("[data-live-ribbon]"), /加州 AT&T 双ISP 家宽/);
  assert.match(env.text("[data-live-ribbon]"), /JP-CN2-Starter/);

  // Filtering scopes the live ribbon and marks canvas refresh without re-triggering view entrance
  env.click("[data-filter-dock] [data-track='home']");
  assert.equal(env.document.querySelector("[data-view-panel='terminal']").classList.contains("is-view-entering"), false);
  assert.equal(env.document.querySelector("[data-terminal-canvas]").classList.contains("is-refreshing"), true);
  assert.match(env.text("[data-live-ribbon]"), /加州 AT&T 双ISP 家宽/);
  assert.doesNotMatch(env.text("[data-live-ribbon]"), /JP-CN2-Starter/);

  // Clicking a marquee item opens Inspector with entrance animation once; mutating inside drawer does not re-slide
  env.click("[data-live-ribbon] [data-action='inspect-ticker-event']");
  const inspector = env.document.querySelector("[data-inspector-backdrop]");
  assert.equal(inspector.hidden, false);
  assert.equal(inspector.classList.contains("is-entering"), true);

  env.click("[data-inspector-backdrop] [data-action='toggle-save']");
  assert.equal(inspector.hidden, false);
  assert.equal(inspector.classList.contains("is-entering"), false);
  env.pressKey("Escape");

  // Radar view renders live scanner dial and real velocity bar
  env.click("[data-nav-view='radar']");
  assert.equal(env.document.querySelector("[data-view-panel='radar']").classList.contains("is-view-entering"), true);
  assert.ok(env.document.querySelector(".radar-scanner-dial"));
  assert.ok(env.document.querySelector(".velocity-strip"));
});

test("8-column table surfaces dedicated location column, 3-net / 2-net route tiers, and normalized hardware/bandwidth", async (t) => {
  const env = installDomEnvironment(t);
  const payload = structuredClone(samplePayload);
  payload.products.push(
    {
      ...samplePayload.products[1],
      id: "bwh-ams",
      providerId: "bwh",
      provider: "搬瓦工(BWH)",
      region: "荷兰",
      route: "CN2 GIA / 9929 / CMIN2",
      name: "The Amsterdam Plan",
      hardware: "CPU: 1x AMD / RAM: 1024 MB / SSD: 20 GB RAID-10",
      bandwidth: "Link speed: 2.5 Gigabit / Transfer: 1000 GB/mo"
    },
    {
      ...samplePayload.products[1],
      id: "dual-net",
      providerId: "saltyfish",
      provider: "SaltyFish(咸鱼云)",
      region: "德国",
      route: "回国9929+CMIN2",
      name: "FRA-P1-Mini",
      hardware: "4 CPU vCore (AMD Ryzen 9950X) / 6144MB DDR5 RAM / 150GB Raid NVMe SSD Storage",
      bandwidth: "1000 Mbps / 1 TB"
    }
  );
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(payload)));
  const app = mountApp();
  t.after(() => app.dispose());
  await new Promise(setImmediate);

  assert.equal(env.document.querySelectorAll(".terminal-table thead th").length, 8);
  assert.match(env.text("[data-product-id='bwh-ams'] .col-loc"), /NL\s+阿姆斯特丹/);
  assert.match(env.text("[data-product-id='bwh-ams'] .col-net"), /三网精品优化/);
  assert.match(env.text("[data-product-id='bwh-ams'] .col-net"), /电·CN2 GIA/);
  assert.match(env.text("[data-product-id='bwh-ams'] .col-net"), /联·9929/);
  assert.match(env.text("[data-product-id='bwh-ams'] .col-net"), /移·CMIN2/);
  assert.equal(env.text("[data-product-id='bwh-ams'] .hw-chip"), "1C / 1G / 20G");
  assert.equal(env.text("[data-product-id='bwh-ams'] .bw-highlight"), "2.5 Gbps");

  assert.match(env.text("[data-product-id='dual-net'] .col-loc"), /DE\s+法兰克福/);
  assert.match(env.text("[data-product-id='dual-net'] .col-net"), /双网优化 · 联\+移/);
  assert.equal(env.text("[data-product-id='dual-net'] .hw-chip"), "4C / 6G / 150G");
  assert.equal(env.text("[data-product-id='dual-net'] .bw-highlight"), "1 Gbps");

  // Filter by 3-net optimization and 2-net+ optimization
  env.click("[data-filter-dock] [data-opt='3net']");
  assert.equal(env.document.querySelectorAll(".terminal-table tbody tr").length, 1);
  assert.match(env.text(".terminal-table"), /The Amsterdam Plan/);

  env.click("[data-filter-dock] [data-opt='2net']");
  assert.equal(env.document.querySelectorAll(".terminal-table tbody tr").length, 2);
});

test("shop picker category tabs, provider quick filters & sorting, and interactive guide workshop work end-to-end", async (t) => {
  const env = installDomEnvironment(t);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(samplePayload)));
  const app = mountApp();
  t.after(() => app.dispose());
  await new Promise(setImmediate);

  // Shop picker category tabs
  env.click("[data-action='toggle-shops-expand']");
  env.click("[data-action='set-shop-tab'][data-shop-tab='home']");
  assert.match(env.text("[data-shop-picker]"), /USVPS24/);
  assert.doesNotMatch(env.text("[data-shop-picker] .shop-picker-grid"), /搬瓦工/);
  env.click("[data-action='toggle-shops-expand']");
  assert.equal(app.store.getState().shopTab, "all");

  // Provider directory quick region pills, sorting, and inline sample plan inspection
  env.click("[data-nav-view='providers']");
  env.click("[data-action='set-prov-region'][data-prov-region='JP']");
  assert.ok(env.document.querySelectorAll(".provider-card").length > 0);
  env.change("[data-provider-sort]", "avail-desc");
  assert.equal(env.document.querySelector(".provider-card .provider-name").textContent, "ZoroCloud");
  env.click(".provider-card .prov-sample-item");
  assert.equal(env.document.querySelector("[data-inspector-backdrop]").hidden, false);
  env.pressKey("Escape");
  env.click("[data-action='reset-providers']");
  assert.equal(app.store.getState().providersSort, "recommended");

  // Interactive Guide workshop: checklist toggle, route explorer tabs, and 1-click route jump
  env.click("[data-nav-view='guide']");
  assert.match(env.text("[data-view-panel='guide']"), /已核验 0\/4/);
  env.click("[data-action='toggle-guide-check'][data-check-id='chk-asn']");
  assert.match(env.text("[data-view-panel='guide']"), /已核验 1\/4/);
  env.click("[data-action='set-guide-route-tab'][data-route-tab='ct']");
  assert.equal(env.document.querySelectorAll(".route-ladder-row").length, 1);
  env.click("[data-action='guide-jump-route'][data-route='cn2']");
  assert.equal(env.document.querySelector("[data-view-panel='terminal']").hidden, false);
  assert.match(env.getHref(), /route=cn2/);
  env.click("[data-nav-view='guide']");
  env.click("[data-action='guide-jump-opt'][data-opt='native']");
  assert.equal(app.store.getState().filters.track, "vps");
  assert.equal(app.store.getState().filters.opt, "native");
  assert.doesNotMatch(env.text("[data-terminal-shell]"), /AT&T 住宅宽带/);
});

test("radar tape renders 9-column fixed table with route hierarchy, bandwidth/traffic, and honest offline fallbacks", async (t) => {
  const env = installDomEnvironment(t, "../index.html", "https://radar.example/?view=radar");
  const payload = structuredClone(samplePayload);
  payload.events.push(
    {
      id: "ev-offline-plain",
      type: "soldout",
      at: new Date(Date.now() - 45 * 60000).toISOString(),
      productId: "gone-plain",
      providerId: "bwh",
      provider: "搬瓦工(BWH)",
      name: "Special KVM Promo",
      region: "荷兰",
      price: "$49.99/year",
      priceValue: 49.99,
      currency: "USD",
      stockCount: 0,
      orderUrl: null
    },
    {
      id: "ev-offline-explicit",
      type: "restock",
      at: new Date(Date.now() - 50 * 60000).toISOString(),
      productId: "gone-explicit",
      providerId: "nmcloud",
      provider: "NMCloud(牛马云)",
      name: "[HINET家宽|1区] 苗栗-NAT-100Mbps",
      region: "台湾",
      price: "¥25/月",
      priceValue: 25,
      currency: "CNY",
      stockCount: 2,
      orderUrl: "https://nmcloud.example/order/1"
    }
  );
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(payload)));
  const app = mountApp();
  t.after(() => app.dispose());
  await new Promise(setImmediate);

  const headers = env.document.querySelectorAll(".radar-tape-table thead th").map((th) => th.textContent.trim());
  assert.deepEqual(headers, [
    "观测时间",
    "异动类型",
    "商家与套餐型号",
    "机房位置",
    "回程线路 · 三网明细",
    "带宽 / 流量",
    "异动价格",
    "当前状态",
    "操作"
  ]);

  const rows = env.document.querySelectorAll(".radar-tape-table tbody tr.tape-row");
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.querySelectorAll("td").length, 9);
  }

  assert.match(env.text("[data-product-id='home-att'] .col-tape-net"), /AT&T 住宅宽带/);
  assert.match(env.text("[data-product-id='home-att'] .col-tape-bw"), /500 Mbps/);
  assert.match(env.text("[data-product-id='home-att'] .col-tape-bw"), /2\s*T/);
  assert.match(env.text("[data-product-id='dc-native'] .col-tape-net"), /电信 CN2 GIA/);
  assert.match(env.text("[data-product-id='dc-native'] .col-tape-bw"), /200 Mbps/);
  assert.match(env.text("[data-product-id='dc-native'] .col-tape-bw"), /500\s*G/);

  // Offline event without explicit route/speed stays strictly honest (never fabricates "国际标准互联")
  const offlinePlainRow = rows.find((r) => r.textContent.includes("Special KVM Promo"));
  assert.ok(offlinePlainRow);
  assert.match(offlinePlainRow.querySelector(".col-tape-status").textContent, /快照已下线/);
  assert.equal(offlinePlainRow.querySelector(".col-tape-net").textContent.trim(), "下线未留档");
  assert.equal(offlinePlainRow.querySelector(".col-tape-bw").textContent.trim(), "下线未留档");

  // Offline event with explicit route & speed in plan name surfaces declared facts
  const offlineExplicitRow = rows.find((r) => r.textContent.includes("苗栗-NAT-100Mbps"));
  assert.ok(offlineExplicitRow);
  assert.match(offlineExplicitRow.querySelector(".col-tape-net").textContent, /HiNet/);
  assert.match(offlineExplicitRow.querySelector(".col-tape-bw").textContent, /100 Mbps/);

  // Radar search also matches newly surfaced route column
  env.input("[data-radar-search]", "CN2 GIA");
  assert.equal(env.document.querySelectorAll(".radar-tape-table tbody tr.tape-row").length, 1);
  assert.match(env.text(".radar-tape-table"), /JP-CN2-Starter/);

  // Narrow/mobile viewport (<=860px): radar time-window buttons (24h/72h/7天) remain visible via .radar-window-toggle and operable
  const componentsCss = readFileSync(new URL("../styles/components.css", import.meta.url), "utf8");
  const mobileMediaMatch = componentsCss.match(/@media\s*\(max-width:\s*860px\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(mobileMediaMatch, "Expected @media (max-width: 860px) block in components.css");
  assert.doesNotMatch(mobileMediaMatch[1], /(?:^|\s)\.view-toggle\s*\{\s*display:\s*none/m);
  assert.match(mobileMediaMatch[1], /\.radar-window-toggle\s*\{\s*display:\s*inline-flex/);

  globalThis.window.innerWidth = 390;
  env.input("[data-radar-search]", "");
  const winGroup = env.document.querySelector(".radar-window-toggle");
  assert.ok(winGroup);
  assert.equal(winGroup.classList.contains("layout-view-toggle"), false);
  const winBtns = winGroup.querySelectorAll("[data-action='set-radar-window']");
  assert.deepEqual(winBtns.map((b) => b.textContent.trim()), ["24h", "72h", "7天"]);
  env.click("[data-action='set-radar-window'][data-window='24h']");
  assert.match(env.getHref(), /rWin=24h/);
  assert.equal(env.document.querySelector("[data-action='set-radar-window'][data-window='24h']").classList.contains("is-active"), true);
  env.click("[data-action='set-radar-window'][data-window='72h']");
  assert.match(env.getHref(), /rWin=72h/);
});

test("top telemetry bar renders live today visits + hover breakdown when /api/stats responds and degrades silently on 404/503", async (t) => {
  const env = installDomEnvironment(t);
  let statsAvailable = false;
  let currentPv = 1284;
  const methodsSeen = [];

  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (String(url).includes("api/stats")) {
      methodsSeen.push(options.method || "GET");
      if (!statsAvailable) {
        return new Response("Not Found", { status: 404 });
      }
      return Response.json({
        schemaVersion: 1,
        day: "2026-11-24",
        timezone: "Asia/Shanghai",
        todayPv: currentPv,
        todayUv: Math.min(412, currentPv),
        totalPv: 18920,
        totalUv: 5310,
        updatedAt: "2026-11-24T02:55:00.000Z"
      });
    }
    return Response.json(samplePayload);
  });

  const app = mountApp();
  t.after(() => app.dispose());
  await new Promise(setImmediate);

  // Unified HH:MM:SS YYYY-MM-DD live clock and no redundant ECB chip
  assert.match(env.text("[data-live-clock]"), /^\d{2}:\d{2}:\d{2} \d{4}-\d{2}-\d{2}$/);
  assert.equal(env.document.querySelector("[data-fx-pill]"), null);

  // 1. Silent graceful degradation when /api/stats returns 404
  const missingResult = await app.refreshVisitStats(true);
  assert.equal(missingResult, null);
  assert.equal(env.document.querySelector("[data-visit-stat]"), null);
  assert.equal(env.document.querySelector("[data-status-banner]"), null);

  // 2. Live counter pill placed inside .telemetry-left with number-only scale-pop animation (capsule stays still)
  statsAvailable = true;
  const liveResult = await app.refreshVisitStats(true);
  assert.equal(liveResult.todayPv, 1284);
  assert.ok(env.document.querySelector(".telemetry-left [data-visit-stat]"));
  assert.equal(env.document.querySelector(".visit-hover-card"), null);
  assert.equal(env.text("[data-stat-visits]"), "1284");
  assert.equal(env.document.querySelector(".tele-stat-visits").classList.contains("is-visit-popping"), false);
  assert.equal(env.document.querySelector("[data-stat-visits]").classList.contains("is-visit-num-pop"), true);

  // 3. Subsequent visitor increase re-triggers number-only scale-up/scale-down pop animation
  currentPv = 1292;
  await app.refreshVisitStats(true);
  assert.equal(env.text("[data-stat-visits]"), "1292");
  assert.equal(env.document.querySelector(".tele-stat-visits").classList.contains("is-visit-popping"), false);
  assert.equal(env.document.querySelector("[data-stat-visits]").classList.contains("is-visit-num-pop"), true);
  assert.deepEqual(methodsSeen, ["POST", "POST", "POST"]);

  // Hidden counters keep receiving updates; crossing the strict threshold reveals them.
  for (const pv of [999, 1000, 1001, 0, 1001]) {
    currentPv = pv;
    const result = await app.refreshVisitStats(true);
    assert.equal(result.todayPv, pv);
    assert.equal(app.store.getState().visitStats.todayPv, pv);
    const badge = env.document.querySelector("[data-visit-stat]");
    assert.equal(Boolean(badge), pv > 1000);
    if (badge) assert.equal(env.text("[data-stat-visits]"), String(pv));
  }
});

test("3880 plans remain fully searchable and sortable with bounded DOM and stable selection nodes", async (t) => {
  const env = installDomEnvironment(t, "../index.html", "https://radar.example/?status=all");
  const products = Array.from({ length: 3880 }, (_, index) => ({
    ...samplePayload.products[1],
    id: `large-${index}`,
    name: `Large catalog plan ${index}`,
    priceValue: index + 1,
    price: `¥${index + 1}/月`
  }));
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...samplePayload, products, events: [] }));
  const app = mountApp({ statsEndpoint: "" });
  t.after(() => app.dispose());
  await new Promise(setImmediate);
  assert.equal(app.store.getState().plans.length, 3880);
  assert.equal(env.document.querySelectorAll(".terminal-table tr[data-product-id]").length, 24);
  assert.equal(env.document.querySelectorAll(".plan-card").length, 0);
  assert.equal(env.document.querySelector("[data-action='load-more'], [data-action='load-all']"), null);
  assert.match(env.text(".result-summary"), /3880/);
  assert.ok(env.document.querySelectorAll("*").length < 4000);

  const row = env.document.querySelector(".terminal-table tr[data-product-id]");
  const save = row.querySelector("[data-action='toggle-save']");
  env.clickNode(save);
  env.clickNode(row.querySelector("[data-action='toggle-compare']"));
  env.clickNode(row);
  env.click("[data-action='close-inspector']");
  app.store.setVisitStats({ day: "2026-11-23", todayPv: 1, todayUv: 1, totalPv: 1, totalUv: 1 });
  assert.equal(env.document.querySelector(".terminal-table tr[data-product-id]"), row);
  assert.equal(save.getAttribute("aria-pressed"), "true");

  app.store.patchFilters({ q: "Large catalog plan 3879" });
  assert.equal(env.document.querySelectorAll(".terminal-table tr[data-product-id]").length, 1);
  assert.equal(env.document.querySelector(".terminal-table tr[data-product-id]").getAttribute("data-product-id"), "large-3879");
  app.store.patchFilters({ q: "", sort: "cny-desc" });
  assert.equal(env.document.querySelector(".terminal-table tr[data-product-id]").getAttribute("data-product-id"), "large-3879");
  app.store.patchFilters({ savedOnly: true });
  assert.equal(env.document.querySelectorAll(".terminal-table tr[data-product-id]").length, 1);
  env.click(".terminal-table [data-action='toggle-save']");
  assert.ok(env.document.querySelector("[data-zero-results]"));
  app.store.patchFilters({ savedOnly: false });
  app.store.setLayout("grid");
  assert.equal(env.document.querySelector(".terminal-table"), null);
  assert.ok(env.document.querySelectorAll(".plan-card").length <= 30);
  app.store.setView("radar");
  assert.equal(env.document.querySelectorAll("[data-virtual-block]").length, 0);
});

test("filter changes position results below the actual sticky header on mobile", async (t) => {
  const env = installDomEnvironment(t);
  globalThis.window.innerWidth = 390;
  globalThis.window.innerHeight = 844;
  const header = env.document.querySelector("[data-app-header]");
  header.getBoundingClientRect = () => ({ bottom: 158 });
  t.mock.method(globalThis, "fetch", async () => Response.json(samplePayload));
  const app = mountApp({ statsEndpoint: "" });
  t.after(() => app.dispose());
  await new Promise(setImmediate);

  // The old and new canvases represent a reader already deep in the list.
  const prototype = Object.getPrototypeOf(header);
  Object.defineProperty(prototype, "getBoundingClientRect", {
    configurable: true, value() { return { top: -2000, bottom: -1000 }; }
  });
  t.after(() => delete prototype.getBoundingClientRect);
  let scroll;
  globalThis.window.scrollBy = options => { scroll = options; };
  app.store.patchFilters({ sort: "cny-desc" });
  assert.deepEqual(scroll, { top: -2166, behavior: "instant" });
});

test("visit counters use visit units and skip motion when reduced motion is requested", async (t) => {
  const env = installDomEnvironment(t);
  globalThis.window.matchMedia = () => ({ matches: true });
  t.mock.method(globalThis, "fetch", async url => String(url).includes("api/stats")
    ? Response.json({ day: "2026-11-24", todayPv: 1010, todayUv: 3, totalPv: 1020, totalUv: 5 })
    : Response.json(samplePayload));
  const app = mountApp();
  t.after(() => app.dispose());
  await new Promise(setImmediate);
  await app.refreshVisitStats();
  assert.equal(env.text(".visit-label"), "今日访问:");
  assert.equal(env.text(".visit-unit"), "次");
  assert.equal(env.text("[data-stat-visits]"), "1010");
  assert.equal(env.document.querySelector("[data-stat-visits]").classList.contains("is-visit-num-pop"), false);
});

test("yesterday's cached visits are not displayed as today's counts", async (t) => {
  const env = installDomEnvironment(t);
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: () => JSON.stringify({ day: "2020-01-01", todayPv: 99, todayUv: 9, totalPv: 100, totalUv: 10 })
  } });
  t.after(() => original ? Object.defineProperty(globalThis, "sessionStorage", original) : delete globalThis.sessionStorage);
  t.mock.method(globalThis, "fetch", async () => Response.json(samplePayload));
  const app = mountApp({ statsEndpoint: "" });
  t.after(() => app.dispose());
  await new Promise(setImmediate);
  assert.equal(env.document.querySelector("[data-visit-stat]"), null);
});

test("evidence-based shop tags render across shop picker and directory with tag tabs, search aliases, and URL sync", async (t) => {
  const env = installDomEnvironment(t);
  const payload = structuredClone(samplePayload);
  payload.products.push(
    {
      ...samplePayload.products[1],
      id: "dpnet-1",
      providerId: "dpnet",
      provider: "DPNET",
      name: "DPNET 2C4G",
      route: "国际 BGP",
      hardware: "2 vCPU / 4 GB RAM / 50 GB SSD",
      price: "$2.00/month",
      priceValue: 2.0,
      currency: "USD"
    },
    {
      ...samplePayload.products[1],
      id: "dpnet-2",
      providerId: "dpnet",
      provider: "DPNET",
      name: "DPNET 4C8G",
      route: "国际 BGP",
      hardware: "4 vCPU / 8 GB RAM / 90 GB SSD",
      price: "$4.79/month",
      priceValue: 4.79,
      currency: "USD"
    },
    {
      ...samplePayload.products[1],
      id: "dedi-1",
      providerId: "dedirock",
      provider: "DediRock",
      name: "Yearly Saver",
      route: "国际 BGP",
      hardware: "1 vCPU / 1 GB RAM / 10 GB SSD",
      price: "$10.88/year",
      priceValue: 10.88,
      currency: "USD"
    },
    {
      ...samplePayload.products[1],
      id: "dedi-2",
      providerId: "dedirock",
      provider: "DediRock",
      name: "Yearly Economy",
      route: "国际 BGP",
      hardware: "1 vCPU / 2 GB RAM / 20 GB SSD",
      price: "$17.88/year",
      priceValue: 17.88,
      currency: "USD"
    },
    {
      ...samplePayload.products[1],
      id: "lazy-nat",
      providerId: "lazycat",
      provider: "LazyCatCloud(懒猫云)",
      name: "UK Mini NAT",
      price: "¥3/月",
      priceValue: 3,
      currency: "CNY",
      riskTags: [{ value: "nat-shared", label: "NAT 共享", severity: "medium" }]
    }
  );
  t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  const app = mountApp({ statsEndpoint: "" });
  t.after(() => app.dispose());
  await new Promise(setImmediate);

  // Open shop picker and check factual primary badges across 7 dimensions + animated SVG icons
  env.click("[data-action='toggle-shops-expand']");
  assert.equal(env.text("[data-shop-picker] [data-provider='dmit'] .shop-tag"), "热门");
  assert.ok(env.document.querySelector("[data-shop-picker] [data-provider='dmit'] .shop-tag .is-flame-svg"));
  assert.equal(env.text("[data-shop-picker] [data-provider='usvps24'] .shop-tag"), "家宽");
  assert.equal(env.text("[data-shop-picker] [data-provider='dpnet'] .shop-tag"), "性价比");
  assert.equal(env.text("[data-shop-picker] [data-provider='dedirock'] .shop-tag"), "低价");
  // NAT-only cheap vendor and single-plan mid-priced vendor stay neutrally untagged
  assert.equal(env.document.querySelector("[data-shop-picker] [data-provider='lazycat'] .shop-tag"), null);
  assert.equal(env.document.querySelector("[data-shop-picker] [data-provider='zorocloud'] .shop-tag"), null);

  // Filtering by 低价入门 tab surfaces both dedirock & dual-tagged dpnet (displaying 低价 badge) and excludes NAT-only lazycat
  env.click("[data-action='set-shop-tab'][data-shop-tab='tag:budget']");
  const budgetIds = env.document.querySelectorAll(".shop-choice").map((el) => el.getAttribute("data-provider"));
  assert.ok(budgetIds.includes("dedirock"));
  assert.ok(budgetIds.includes("dpnet"));
  assert.ok(!budgetIds.includes("lazycat"));
  assert.equal(env.text("[data-shop-picker] [data-provider='dpnet'] .shop-tag"), "低价");

  // Search alias "便宜" matches budget-tagged shops and excludes non-budget shops
  env.click("[data-action='set-shop-tab'][data-shop-tab='all']");
  env.input("[data-shop-search]", "便宜");
  const searchIds = env.document.querySelectorAll(".shop-choice").map((el) => el.getAttribute("data-provider"));
  assert.ok(searchIds.includes("dedirock"));
  assert.ok(!searchIds.includes("usvps24"));
  env.click("[data-action='toggle-shops-expand']");

  // Directory view supports both 1-click badge filtering and dropdown + URL sync
  env.click("[data-nav-view='providers']");
  env.click("[data-provider-id='usvps24'] .shop-tag[data-action='filter-prov-tag']");
  assert.match(env.getHref(), /provTag=home/);
  env.change("[data-provider-select='tag']", "budget");
  assert.match(env.getHref(), /provTag=budget/);
  assert.match(env.text("[data-view-panel='providers']"), /DediRock/);
  assert.match(env.text("[data-view-panel='providers']"), /DPNET/);
  assert.doesNotMatch(env.text("[data-view-panel='providers']"), /USVPS24/);
  env.click("[data-action='reset-providers']");
  assert.doesNotMatch(env.getHref(), /provTag=/);
});

test("evidence-based product highlight tags render across table, cards, inspector, compare, directory samples, and deal filter pills", async (t) => {
  const env = installDomEnvironment(t);
  const payload = structuredClone(samplePayload);
  payload.products.push(
    {
      ...samplePayload.products[1],
      id: "bwh-ams-hit",
      sourceId: "bwh-limited-pids",
      providerId: "bwh",
      provider: "搬瓦工(BWH)",
      name: "The Amsterdam Plan",
      region: "荷兰",
      route: "CN2 GIA / 9929 / CMIN2",
      hardware: "1 vCPU / 1 GB RAM / 20 GB SSD",
      bandwidth: "2.5 Gbps / 1000 GB",
      price: "$39/year",
      priceValue: 39,
      currency: "USD"
    },
    {
      ...samplePayload.products[1],
      id: "bwh-regular-high",
      sourceId: "catalog-bwh",
      providerId: "bwh",
      provider: "搬瓦工(BWH)",
      name: "SPECIAL 40G KVM PROMO V5 - CN2 GIA ECOMMERCE VPS",
      region: "美国",
      route: "CN2 GIA",
      hardware: "2 vCPU / 2 GB RAM / 40 GB SSD",
      bandwidth: "2.5 Gbps / 2000 GB",
      price: "$89.99/quarter",
      priceValue: 89.99,
      currency: "USD"
    },
    {
      ...samplePayload.products[1],
      id: "dpnet-big",
      providerId: "dpnet",
      provider: "DPNET",
      name: "2 CPU / 4 GB RAM",
      region: "欧洲",
      route: "BGP",
      hardware: "2 vCPU / 4 GB RAM / 50 GB SSD",
      bandwidth: "1000 Mbps / Unlimited",
      price: "$2.00/month",
      priceValue: 2.0,
      currency: "USD"
    },
    {
      ...samplePayload.products[1],
      id: "wepc-home-9929",
      providerId: "wepc",
      provider: "WePC(车库云)",
      category: "home",
      name: "美国洛杉矶Cogent_9929_家宽直播",
      region: "美国",
      route: "联通 9929 双ISP住宅",
      hardware: "1 vCPU / 1 GB RAM / 10 GB SSD",
      bandwidth: "200 Mbps / 1 TB",
      price: "$15.9/month",
      priceValue: 15.9,
      currency: "USD"
    },
    {
      ...samplePayload.products[1],
      id: "hostdzire-epyc",
      providerId: "hostdzire",
      provider: "HostDzire",
      name: "Singapore VPS #2 AMD EPYC 7763",
      region: "新加坡",
      route: "BGP",
      hardware: "2 vCPU AMD EPYC 7763 / 4 GB RAM / 40 GB NVMe",
      bandwidth: "10000 Mbps / 2000 GB",
      price: "$6.99/month",
      priceValue: 6.99,
      currency: "USD"
    },
    {
      ...samplePayload.products[1],
      id: "lazy-cheap-nat",
      providerId: "lazycat",
      provider: "LazyCatCloud(懒猫云)",
      name: "UK Mini NAT",
      region: "英国",
      route: "家宽",
      price: "¥3/月",
      priceValue: 3,
      currency: "CNY",
      riskTags: [{ value: "nat-shared", label: "NAT 共享", severity: "medium" }]
    }
  );
  t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  const app = mountApp({ statsEndpoint: "" });
  t.after(() => app.dispose());
  await new Promise(setImmediate);

  // Table rows show factual highlight tags with front SVG icons in front of brand names; ordinary high-tier & NAT plans stay untagged
  assert.equal(env.text("[data-product-id='bwh-ams-hit'] .plan-tag"), "爆款");
  assert.ok(env.document.querySelector("[data-product-id='bwh-ams-hit'] .plan-tag .is-flame-svg"));
  assert.equal(env.text("[data-product-id='dpnet-big'] .plan-tag"), "便宜量大");
  assert.equal(env.text("[data-product-id='wepc-home-9929'] .plan-tag"), "家宽直连");
  assert.equal(env.text("[data-product-id='hostdzire-epyc'] .plan-tag"), "高配");
  assert.equal(env.document.querySelector("[data-product-id='bwh-regular-high'] .plan-tag"), null);
  assert.equal(env.document.querySelector("[data-product-id='lazy-cheap-nat'] .plan-tag"), null);

  // Clicking an inline .plan-tag in a table row toggles ?deal= directly WITHOUT opening the Inspector drawer
  env.click("[data-product-id='bwh-ams-hit'] .plan-tag[data-action='set-deal']");
  assert.match(env.getHref(), /deal=blockbuster/);
  assert.equal(env.document.querySelector("[data-inspector-backdrop]")?.hidden, true);
  env.click("[data-product-id='bwh-ams-hit'] .plan-tag[data-action='set-deal']");
  assert.doesNotMatch(env.getHref(), /deal=/);

  // Filter dock deal pills filter accurately and sync ?deal= in URL across all 8 dimensions
  env.click("[data-filter-dock] [data-action='set-deal'][data-deal='blockbuster']");
  assert.match(env.getHref(), /deal=blockbuster/);
  assert.equal(env.document.querySelectorAll(".terminal-table tbody tr").length, 1);
  assert.equal(env.document.querySelector(".terminal-table tbody tr").getAttribute("data-product-id"), "bwh-ams-hit");

  env.click("[data-filter-dock] [data-action='set-deal'][data-deal='home-opt']");
  assert.match(env.getHref(), /deal=home-opt/);
  assert.equal(env.document.querySelectorAll(".terminal-table tbody tr").length, 1);
  assert.equal(env.text("[data-product-id='wepc-home-9929'] .plan-tag"), "家宽直连");

  env.click("[data-filter-dock] [data-action='set-deal'][data-deal='perf']");
  assert.match(env.getHref(), /deal=perf/);
  assert.equal(env.document.querySelectorAll(".terminal-table tbody tr").length, 1);
  assert.equal(env.text("[data-product-id='hostdzire-epyc'] .plan-tag"), "高配");

  env.click("[data-filter-dock] [data-action='set-deal'][data-deal='annual']");
  assert.match(env.getHref(), /deal=annual/);
  assert.equal(env.text("[data-product-id='bwh-ams-hit'] .plan-tag"), "年付惠");

  // Filtering by 低价入门 shows dpnet-big with 低价 badge and excludes NAT-only lazy-cheap-nat
  env.click("[data-filter-dock] [data-action='set-deal'][data-deal='budget']");
  assert.match(env.getHref(), /deal=budget/);
  assert.equal(env.document.querySelectorAll(".terminal-table tbody tr").length, 1);
  assert.equal(env.text("[data-product-id='dpnet-big'] .plan-tag"), "低价");

  // Card view preserves highlight tags
  env.click("[data-layout='grid']");
  assert.equal(env.text(".plan-card[data-product-id='dpnet-big'] .plan-tag"), "低价");

  // Toggle deal pill off back to all, open Inspector on bwh-ams-hit and check transparent audit card
  env.click("[data-filter-dock] [data-action='set-deal'][data-deal='budget']");
  assert.doesNotMatch(env.getHref(), /deal=/);
  env.click("[data-layout='table']");
  env.click("[data-product-id='bwh-ams-hit']");
  assert.match(env.text("[data-inspector-plan-tags]"), /口碑爆款/);
  assert.match(env.text("[data-inspector-plan-tags]"), /搬瓦工限量传家宝系列/);
  assert.match(env.text("[data-inspector-plan-tags]"), /年付特惠/);
  assert.match(env.text("[data-inspector-plan-tags]"), /高性价比/);
  // Clicking "同款 →" inside Inspector jumps directly to that deal filter and closes drawer
  env.click("[data-inspector-plan-tags] [data-action='jump-deal-from-inspector'][data-deal='annual']");
  assert.match(env.getHref(), /deal=annual/);
  assert.equal(env.document.querySelector("[data-inspector-backdrop]")?.hidden, true);
  env.click("[data-filter-dock] [data-action='set-deal'][data-deal='annual']");
  assert.doesNotMatch(env.getHref(), /deal=/);

  // Compare modal surfaces 商品亮点标签 row when compared plans carry tags
  env.click("[data-product-id='bwh-ams-hit'] [data-action='toggle-compare']");
  env.click("[data-product-id='dpnet-big'] [data-action='toggle-compare']");
  env.click("[data-action='open-compare']");
  assert.match(env.text("[data-compare-modal]"), /商品亮点标签/);
  assert.match(env.text("[data-compare-modal]"), /爆款/);
  assert.match(env.text("[data-compare-modal]"), /便宜量大/);
  env.pressKey("Escape");

  // Provider directory sample plans surface the blockbuster plan first with its tag
  env.click("[data-nav-view='providers']");
  const bwhSample = env.document.querySelector(".prov-sample-item[data-product-id='bwh-ams-hit']");
  assert.ok(bwhSample);
  assert.equal(bwhSample.querySelector(".plan-tag")?.textContent?.trim(), "爆款");

  // Keyboard focusin / focusout / Escape / dispose accessibility lifecycle on [data-tag-hud]
  env.click("[data-nav-view='terminal']");
  const hud = env.document.querySelector("[data-tag-hud]");
  assert.equal(hud.hidden, true);
  assert.equal(hud.getAttribute("aria-hidden"), "true");

  // 1) Focusing a focusable shop shortcut button containing a nested .shop-tag opens HUD and links aria-describedby
  const shopBtn = env.focus("[data-shops-row] [data-provider='bwh']");
  assert.equal(hud.hidden, false);
  assert.equal(hud.getAttribute("aria-hidden"), "false");
  assert.match(shopBtn.getAttribute("aria-describedby") || "", /\bradar-tag-hud\b/);
  assert.match(env.text("[data-tag-hud]"), /IT7/);

  // Blurring away to a non-tag button closes HUD and cleans up aria-describedby
  env.blur("[data-shops-row] [data-provider='bwh']", "[data-action='reset-filters']");
  assert.equal(hud.hidden, true);
  assert.equal(hud.getAttribute("aria-hidden"), "true");
  assert.equal(shopBtn.hasAttribute("aria-describedby"), false);

  // 2) Focusing an inline interactive .plan-tag directly opens HUD, and Escape dismisses it cleanly
  const inlinePlanTag = env.focus("[data-product-id='bwh-ams-hit'] .plan-tag[data-action='set-deal']");
  assert.equal(hud.hidden, false);
  assert.equal(hud.getAttribute("aria-hidden"), "false");
  assert.match(inlinePlanTag.getAttribute("aria-describedby") || "", /\bradar-tag-hud\b/);
  assert.match(env.text("[data-tag-hud]"), /搬瓦工限量传家宝系列/);
  env.pressKey("Escape");
  assert.equal(hud.hidden, true);
  assert.equal(hud.getAttribute("aria-hidden"), "true");
  assert.equal(inlinePlanTag.hasAttribute("aria-describedby"), false);

  // 3) Disposing the app detaches focusin/focusout listeners cleanly
  app.dispose();
  env.focus("[data-product-id='bwh-ams-hit'] .plan-tag[data-action='set-deal']");
  assert.equal(hud.hidden, true);
});
