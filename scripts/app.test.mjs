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
  assert.match(env.text("[data-shops-row] [data-provider='dmit']"), /DMIT\s+待核验/);
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
  assert.match(env.text(".shop-choice"), /Gomami\s+待核验/);
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
