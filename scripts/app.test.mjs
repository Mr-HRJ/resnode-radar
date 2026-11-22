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
    assert.match(url, /^data\/products\.json\?t=\d+$/);
    assert.equal(opts.cache, "no-store");
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

  // 1. Track isolation via Top Filter Dock: True Residential ISP excludes Datacenter Native IP
  env.click("[data-filter-dock] [data-track='home']");
  assert.match(env.text("[data-view-panel='terminal']"), /加州 AT&T 双ISP 家宽/);
  assert.doesNotMatch(env.text("[data-view-panel='terminal']"), /JP-CN2-Starter/);
  assert.match(env.getHref(), /track=home/);

  // 2. Smart zero-results counterfactual attribution & 1-click relaxation
  env.input("[data-filter-dock] [data-terminal-search]", "JP-CN2");
  assert.ok(env.document.querySelector("[data-zero-results]"));
  env.click("[data-action='apply-relaxation']");
  assert.ok(!env.document.querySelector("[data-zero-results]"));

  // 2b. Advanced filter popover opens & closes via Escape; clickable column sort updates URL
  env.click("[data-action='toggle-advanced']");
  assert.ok(env.document.querySelector("[data-adv-popover]"));
  env.pressKey("Escape");
  assert.ok(!env.document.querySelector("[data-adv-popover]"));
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

  // 5. Command Palette via Cmd+K & Escape
  env.pressKey("k", { metaKey: true });
  assert.equal(env.document.querySelector("[data-palette-backdrop]").hidden, false);
  env.pressKey("Escape");
  assert.equal(env.document.querySelector("[data-palette-backdrop]").hidden, true);

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
