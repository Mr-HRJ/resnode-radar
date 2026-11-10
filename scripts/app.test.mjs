import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse, HTMLElement } from "node-html-parser";

// Parse the actual page and execute its modules, with only browser APIs and
// fetch replaced. No requests or monitor jobs run in this rendering test.
function installPage(t) {
  const document = parse(readFileSync(new URL("../index.html", import.meta.url), "utf8"));
  document.documentElement = document.querySelector("html");
  const handlers = new WeakMap();
  const styles = new WeakMap();
  const frames = new Map();
  let nextFrame = 0;
  const globals = {
    document,
    window: { location: { href: "https://example.invalid/" }, addEventListener() {} },
    HTMLSelectElement: class { static [Symbol.hasInstance](node) { return node.tagName === "SELECT"; } },
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    setInterval() {}
  };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name]);
  }
  for (const [name, descriptor] of Object.entries({
    dataset: { get() { return Object.fromEntries(Object.entries(this.attributes).filter(([key]) => key.startsWith("data-")).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase()), value])); } },
    style: { get() { if (!styles.has(this)) styles.set(this, {}); return styles.get(this); } },
    addEventListener: { value(event, handler) { if (!handlers.has(this)) handlers.set(this, {}); handlers.get(this)[event] = handler; } },
    scrollIntoView: { value() {} }
  })) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, ...descriptor });
    t.after(() => delete HTMLElement.prototype[name]);
  }
  const tokenList = Object.getPrototypeOf(document.documentElement.classList);
  t.mock.method(tokenList, "toggle", function (name, force = !this.contains(name)) {
    if (force) this.add(name); else this.remove(name);
    return force;
  });
  return {
    document,
    text: (selector) => document.querySelector(selector).textContent.trim(),
    click(selector) { const node = document.querySelector(selector); handlers.get(node).click({ target: node }); },
    change(selector, value) { const node = document.querySelector(selector); node.value = value; handlers.get(node).change({ target: node }); },
    finishAnimations() {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(performance.now() + 1000));
    }
  };
}

const payload = {
  generatedAt: "2026-10-08T12:00:00Z", sourceCount: 1,
  summary: { total: 1, available: 1, unavailable: 0, blocked: 0, error: 0 },
  products: [{ id: "synthetic", sourceId: "test", provider: "Synthetic only", name: "Synthetic product", status: "available", stockCount: 3, orderUrl: "https://example.invalid/order" }]
};

function assertUnavailable(page) {
  assert.equal(page.text("[data-monitor-status]"), "本站数据加载失败");
  assert.ok(page.document.querySelector("[data-monitor-status]").classList.contains("has-warning"));
  assert.equal(page.text("[data-trust-state]"), "本站监控数据不可用");
  assert.equal(page.text("[data-trust-freshness]"), "当前库存未知");
  assert.match(page.text("[data-monitor-summary]"), /本站监控数据加载失败.*当前库存未知/);
  for (const selector of ["[data-products]", "[data-mobile-products]"]) {
    assert.match(page.text(selector), /本站监控数据加载失败/);
    assert.doesNotMatch(page.text(selector), /Synthetic product/);
  }
  for (const selector of ["[data-stat-total]", "[data-stat-available]", "[data-stat-unavailable]", "[data-stat-sources]", "[data-trust-age]", "[data-sync]"]) {
    assert.equal(page.text(selector), "-", selector);
  }
  assert.equal(page.text("[data-result-count]"), "显示 0 / 0 条");
}

test("site data loading, errors, and repeated refreshes stay consistent", async (t) => {
  const page = installPage(t);
  const requests = [];
  t.mock.method(globalThis, "fetch", (url, options) => {
    assert.match(url, /^data\/products\.json\?t=\d+$/);
    assert.equal(options.cache, "no-store");
    return new Promise((resolve, reject) => requests.push({ resolve, reject }));
  });
  const settle = async (kind) => {
    const request = requests.shift();
    assert.ok(request);
    if (kind === "network") request.reject(new TypeError("Failed to fetch"));
    else if (kind === "http") request.resolve(new Response("Unavailable", { status: 503 }));
    else if (kind === "json") request.resolve(new Response("{invalid"));
    else request.resolve(new Response(JSON.stringify(payload)));
    await new Promise(setImmediate);
  };
  const assertLoading = () => {
    assert.equal(page.text("[data-monitor-status]"), "加载监控数据中");
    assert.equal(page.text("[data-trust-freshness]"), "加载中");
    assert.match(page.text("[data-mobile-products]"), /加载监控数据中/);
    assert.ok(!page.document.querySelector("[data-monitor-status]").classList.contains("has-warning"));
    assert.ok(page.document.querySelector(".skel-row"));
  };
  const assertSuccess = () => {
    page.finishAnimations();
    assert.equal(page.text("[data-monitor-status]"), "监控正常");
    assert.ok(!page.document.querySelector("[data-monitor-status]").classList.contains("has-warning"));
    assert.equal(page.text("[data-stat-total]"), "1");
    assert.equal(page.text("[data-stat-unavailable]"), "0");
    assert.match(page.text("[data-products]"), /Synthetic product/);
    assert.match(page.text("[data-mobile-products]"), /Synthetic product/);
  };
  await import("../app.js");
  await t.test("initial pending request shows loading", assertLoading);
  for (const kind of ["network", "json"]) {
    await settle(kind);
    await t.test(`${kind} failure is site data unavailable, not zero inventory`, () => assertUnavailable(page));
    page.click("[data-filter-reset]");
    await t.test(`${kind} failure survives filter reset`, () => assertUnavailable(page));
    page.click("[data-refresh]");
    await t.test(`retry after ${kind} failure shows loading`, assertLoading);
  }
  await settle("success");
  await t.test("success recovers product rows and summaries", assertSuccess);
  page.click("[data-refresh]");
  await t.test("pending refresh retains the previous summary", () => assert.equal(page.text("[data-stat-total]"), "1"));
  await settle("http");
  await t.test("HTTP failure clears previously loaded data", () => {
    assertUnavailable(page);
    assert.match(page.text("[data-products]"), /HTTP 503/);
  });
  page.click("[data-refresh]");
  await settle("success");
  page.click("[data-refresh]");
  await settle("network");
  page.finishAnimations();
  await t.test("rapid failure cannot restore counts from an earlier success animation", () => assertUnavailable(page));
  page.click("[data-refresh]");
  await settle("success");
  await t.test("a later success clears the error and warning", assertSuccess);
  assert.equal(requests.length, 0);
});

test("ordinary VPS and residential categories work independently from IP filters on desktop and mobile", async (t) => {
  const page = installPage(t);
  const products = [
    { ...payload.products[0], id: "ordinary-native", category: "vps", name: "普通原生 IP VPS", provider: "General provider" },
    { ...payload.products[0], id: "ordinary-basic", category: "vps", name: "普通 KVM VPS", provider: "General provider" },
    { ...payload.products[0], id: "home", category: "home", name: "真实家庭宽带 VPS", provider: "Home provider" }
  ];
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    ...payload, products, summary: { ...payload.summary, total: 3, available: 3 }
  })));
  await import("../app.js?category-regression");
  await new Promise(setImmediate);
  assert.equal(page.text("[data-count-vps]"), "2");
  assert.equal(page.text("[data-count-home]"), "1");
  const rows = () => page.text("[data-products]");
  const mobile = () => page.text("[data-mobile-products]");
  page.click('[data-category="vps"]');
  assert.equal(page.text("[data-title-category]"), "普通 VPS");
  assert.match(rows(), /普通原生 IP VPS/);
  assert.match(mobile(), /普通 KVM VPS/);
  assert.doesNotMatch(rows(), /真实家庭宽带/);
  assert.doesNotMatch(mobile(), /真实家庭宽带/);
  page.change("[data-filter-ip-type]", "native");
  assert.match(rows(), /普通原生 IP VPS/);
  assert.doesNotMatch(rows(), /普通 KVM VPS/);
  page.click('[data-category="home"]');
  assert.equal(page.document.querySelector("[data-filter-ip-type]").value, "all");
  assert.match(rows(), /真实家庭宽带/);
  assert.doesNotMatch(rows(), /普通原生 IP/);
  assert.match(mobile(), /家宽 \/ 住宅 VPS/);
  page.click('[data-ip-type="home"]');
  assert.match(rows(), /真实家庭宽带/);
  assert.equal(page.text("[data-title-category]"), "家宽 / 住宅 VPS");
  page.click('[data-category="all"]');
  assert.match(rows(), /普通原生 IP VPS/);
  assert.match(rows(), /普通 KVM VPS/);
  assert.match(rows(), /真实家庭宽带/);
});

test("directory diagnostics stay out of inventory; pagination and currency filters retain matching results", async (t) => {
  const page = installPage(t);
  const plans = Array.from({ length: 35 }, (_, i) => ({ id: `plan-${i}`, providerId: "lisahost", provider: "LisaHost", name: `Plan ${String(i + 1).padStart(2, '0')}`, category: "vps", price: `USD ${i+1}/month`, priceValue: i+1, status: "available", orderUrl: "https://lisahost.com/" }));
  const diagnostic = { id:"diagnostic",providerId:"dmit",provider:"DMIT",name:"Access diagnostic",diagnostic:true,status:"blocked",evidence:"HTTP 403",sourceUrl:"https://www.dmit.io/" };
  const cny = { ...plans[0], id:"cny", name:"CNY Plan", price:"CNY 9/month",priceValue:9 };
  t.mock.method(globalThis,"fetch",async()=>new Response(JSON.stringify({...payload,products:[...plans,cny,diagnostic],summary:{total:37,available:36,blocked:1}})));
  window.history = { replaceState(_,__,url) { window.location.href = url; } };
  await import("../app.js?directory-pagination"); await new Promise(setImmediate);
  assert.equal(page.document.querySelectorAll('[data-products] tr[data-key]').length,30);
  assert.equal(page.text('[data-count-all]'),'36');assert.doesNotMatch(page.text('[data-products]'),/Access diagnostic/);
  page.click('[data-page-next]');assert.equal(page.text('[data-page-label]'),'2 / 2');assert.equal(page.document.querySelectorAll('[data-products] tr[data-key]').length,6);
  page.change('[data-filter-currency]','CNY');assert.equal(page.text('[data-page-label]'),'1 / 1');assert.match(page.text('[data-products]'),/CNY Plan/);assert.match(window.location.href,/currency=CNY/);
  page.click('.primary-nav [data-view="providers"]');assert.equal(page.document.querySelector('[data-directory-view]').hidden,false);assert.equal(page.document.querySelector('[data-inventory-view]').hidden,true);assert.match(page.text('[data-provider-grid]'),/访问受限/);
  page.click('[data-provider-inventory="lisahost"]');assert.equal(page.document.querySelector('[data-inventory-view]').hidden,false);assert.equal(page.document.querySelector('[data-filter-provider]').value,'LisaHost');assert.equal(page.document.querySelector('[data-filter-currency]').value,'all');
});
