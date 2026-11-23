import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parseCatalogPage, cleanPublicUrl, canonicalCatalogPageKey, discoverCatalogLinks } from "./adapters/catalog-pages.mjs";
import { monitorPublicCatalog, parseUsvps24 } from "./adapters/public-catalog.mjs";
import { parseCatalogApi, parseJdidcApi, parseNodeMach } from "./adapters/catalog-api.mjs";
import { providers } from "../providers.js";
import { providerHealth } from "../src/domain/catalog.js";
import { priceQuote, comparePrices } from "../pricing.js";
const source = { id: "vendor", providerId: "vendor", provider: "Vendor", url: "https://vendor.example/store/vps", adapter: "public_catalog" };
const baseRecord = (s, r, x) => ({ sourceId: s.id, provider: s.provider, sourceUrl: s.url, ...x });
const htmlResult = (html, extra = {}) => ({ html, ok: true, statusCode: 200, finalUrl: source.url, headers: {}, ...extra });
const parse = (html, options = {}) => parseCatalogPage({ ...source, ...options }, htmlResult(html), { baseRecord });
const card = (stock = '3 Available', link = '/cart.php?a=add&pid=4') => `<div class="package"><h3 class="package-title">Tokyo KVM</h3><div class="package-box"><span class="price-discount">$100.00</span><span class="price">$12.00</span><span class="price-cycle">Monthly</span><ul><li>2 vCPU</li><li>4 GB RAM</li><li>40 GB NVMe</li><li>1 Gbps</li></ul><p>${stock}</p>${link ? `<a href="${link}">Order now</a>` : ''}</div></div>`;

test("catalog parser preserves plan title, current price and exact stock", () => {
  const [p] = parse(card());
  assert.equal(p.name, "Tokyo KVM"); assert.equal(p.priceValue, 12); assert.equal(p.status, "available"); assert.equal(p.stockCount, 3); assert.equal(p.region, "日本"); assert.match(p.hardware, /4 GB RAM/);
});
test("DigitalFyre-style SKU cards retain labeled storage and a specific order entry", () => {
  const html = '<div class="package"><h3 class="package-title">NANO N1</h3><div class="price">$3.00</div><div class="price-cycle">Monthly</div><ul><li>CPU Cores: 1</li><li>Ram: 512 MB</li><li>Storage: 10 GB</li><li>IPv4: 1</li><li>IPv6: /64</li><li>Bandwidth: 1 TB</li></ul><a href="/store/vps/nano-n1">Order Now</a></div>';
  const [row] = parse(html, { currency: "USD" });
  assert.equal(row.name, "NANO N1");
  assert.equal(row.hardware, "CPU Cores: 1 / Ram: 512 MB / Storage: 10 GB");
  assert.equal(row.priceValue, 3);
  assert.equal(priceQuote(row).monthly, 3);
  assert.equal(row.status, "available");
  assert.equal(row.stockCount, null);
  assert.equal(row.orderUrl, "https://vendor.example/store/vps/nano-n1");
});
test("FAQ prose with example prices and hardware is not a product", () => {
  const faq = '<section><h2>Questions worth answering.</h2><div class="seo-faq"><details><summary>What does the entry plan cost?</summary><p>It starts at $19. ISP-XS includes 2 vCPU and 2 GB RAM.</p></details></div></section>';
  assert.deepEqual(parse(faq), []);
  assert.equal(parse(card() + faq).length, 1);
});
test("hash-routed purchase links survive without turning navigation anchors into plans or inventing stock", () => {
  const html = card('No inventory published', '/#/buy/isp-xs');
  const [plan] = parse(html);
  assert.equal(plan.orderUrl, 'https://vendor.example/#/buy/isp-xs');
  assert.equal(plan.status, 'unknown');
  assert.equal(plan.stockCount, null);
  const otherPage = parseCatalogPage(source, htmlResult(html, { finalUrl: 'https://vendor.example/region/vps' }), { baseRecord })[0];
  assert.equal(plan.id, otherPage.id);
  assert.notEqual(plan.id, parse(html.replace('isp-xs', 'isp-s'))[0].id);
  assert.equal(parse(card('No inventory published', '#/buy/isp-xs'))[0].orderUrl, `${source.url}#/buy/isp-xs`);
  assert.equal(parse(card('No inventory published', '#pricing'))[0].orderUrl, null);
  assert.equal(cleanPublicUrl('/#/buy/isp-xs', source.url), 'https://vendor.example/');
  assert.deepEqual(discoverCatalogLinks('<a href="/#/buy/isp-xs">Order VPS</a>', source.url, source), []);
});
test("configured pricing selectors preserve terms before the price and the published VAT note", () => {
  const html = card('No inventory published', null).replace('<span class="price-discount">$100.00</span><span class="price">$12.00</span><span class="price-cycle">Monthly</span>', '<span class="contract">12 months contract period, from monthly</span><span data-test="price">€8.26</span><span>€9.50</span><span class="vat">(incl. 19% VAT)</span>');
  const [plan] = parse(html, { priceSelector: '[data-test="price"]', cycleSelector: '.contract', priceNoteSelector: '.vat', currency: 'EUR' });
  assert.equal(plan.priceValue, 8.26);
  assert.equal(plan.raw.billingCycle, '12 months contract period, from monthly');
  assert.equal(priceQuote(plan).months, 1);
  assert.equal(priceQuote(plan).baseOnly, true);
  assert.match(plan.note, /19% VAT/);
});
test("Chinese zero inventory wins over an order button and sold-out cards survive missing links", () => {
  assert.equal(parse(card('0 可用'))[0].status, "unavailable");
  const [sold] = parse(card('Sold Out', null)); assert.equal(sold.status, "unavailable"); assert.equal(sold.stockCount, 0);
});
test("shared marketing order entries preserve distinct plans without implying stock", () => {
  const first = card('No inventory published', '/order/vps/');
  const second = first.replace('Tokyo KVM', 'Osaka KVM').replace('$12.00', '$24.00');
  const plans = parse(first + second, { sharedOrderEntry: true });
  assert.equal(plans.length, 2);
  assert.notEqual(plans[0].id, plans[1].id);
  assert.ok(plans.every((p) => p.status === 'unknown' && p.stockCount === null));
  assert.equal(parse(first.replace('$12.00', '$13.00'), { sharedOrderEntry: true })[0].id, plans[0].id);
  assert.equal(parse(card('0 Available', '/order/vps/'), { sharedOrderEntry: true })[0].status, 'unavailable');
});
test("opt-in WHMCS catalog queries preserve route identity, exclusions and discovery scope", () => {
  const html = '<a href="/store/sjc-premium">VPS</a><a href="/index.php?rp=/store/sjc-premium">VPS</a><a href="/store/server-hardwares">Hardware</a><a href="/store/sjc-premium/plan">Order</a><a href="https://foreign.example/store/vps">Other</a>';
  const links = discoverCatalogLinks(html, source.url, { ...source, catalogRoute: 'whmcs-query', excludePaths: ['server-hardwares'] });
  assert.deepEqual(links.map((x) => x.url), ['https://vendor.example/index.php?rp=%2Fstore%2Fsjc-premium']);
  assert.equal(canonicalCatalogPageKey(links[0].url), canonicalCatalogPageKey('https://vendor.example/store/sjc-premium'));
});
test("newly recovered public catalog countries are recognized from the plan or group label", () => {
  for (const [label, country] of [['Washington, DC', '美国'], ['Washington DC', '美国'], ['France', '法国'], ['Bulgaria', '保加利亚'], ['新西兰', '新西兰'], ['巴西', '巴西'], ['马来西亚', '马来西亚'], ['越南', '越南']]) {
    assert.equal(parse(card().replace('Tokyo KVM', `${label} KVM`))[0].region, country);
  }
});
test("opt-in configurable VPS families retain starting prices and explicit stock without invented hardware", () => {
  const html = `<div class="product"><header><span id="product17-name">美国 RCN</span><span>0 可用</span></header><p>美国 RCN VDS 原生住宅IP<br>100M峰值带宽，配置自由选择</p><footer>起价 <span class="price">$15.00 USD</span> 每月 <a href="/index.php?rp=/store/us-rcn-vds/rcn-vds">立即订购</a></footer></div>`;
  assert.deepEqual(parse(html), []);
  const [plan] = parse(html, { configurableFamilies: true, nameSelector: 'header span[id$="-name"]' });
  assert.equal(plan.name, '美国 RCN');
  assert.equal(plan.status, 'unavailable');
  assert.equal(plan.stockCount, 0);
  assert.equal(plan.hardware, null);
  assert.equal(plan.category, 'home');
  assert.equal(plan.priceValue, 15);
  assert.equal(plan.raw.configurable, true);
  assert.equal(priceQuote(plan).baseOnly, true);
  assert.equal(priceQuote(plan).monthly, null);
  assert.deepEqual(parse(html.replace('/index.php?rp=/store/us-rcn-vds/rcn-vds', '/login'), { configurableFamilies: true }), []);
});
test("bandwidth is not GBP, marketing cards are not plans, unknown stock stays unknown", () => {
  assert.equal(parse('<article><h3>Hosting</h3><p>KVM VPS 1Gbps</p><a href="/login">Order</a></article>').length, 0);
  assert.equal(parse('<div class="product"><h3>News</h3><p>VPS hosting from $4.99</p></div>').length, 0);
  assert.equal(parse(card('No stock published', '/login'))[0].status, 'unknown');
  assert.equal(parse(card('No stock published', null))[0].status, 'unknown');
});
test("catalog excludes only explicit aggregate and add-on names, including table rows", () => {
  for (const name of ['Additional Services', ' Simple   pricing ', 'POPULAR PLANS', 'Configuration', 'VPS Plans & Pricing']) {
    assert.equal(parse(card().replace('Tokyo KVM', name)).length, 0, name);
    assert.equal(parse(`<table><tr><td>${name}</td><td>2 vCPU / 4 GB RAM</td><td>$12.00 monthly</td><td><a href="/cart.php?a=add&pid=4">Order now</a></td></tr></table>`).length, 0, name);
  }
  for (const name of ['Additional Services VPS', 'Simple Pricing KVM', 'Popular Plans Plus']) {
    const rows = parse(card().replace('Tokyo KVM', name));
    assert.equal(rows.length, 1, name);
    assert.equal(rows[0].name, name);
  }
});
test("catalog handles decimal comma and dedicated-server exclusions", () => {
  const [p] = parse(card().replace('$12.00', '€2,20')); assert.equal(p.priceValue, 2.2);
  assert.equal(parse(card().replace('Tokyo KVM', 'Dedicated Server E5')).length, 0);
});
test("discovery stays on official hosts, excludes checkout and language mirrors, strips referrals", () => {
  const html = '<a href="/store/hk?ref=123">HK VPS</a><a href="https://evil.example/store/vps">VPS</a><a href="/store/hk?language=french">French</a><a href="/cart.php?a=add&pid=1">Order</a>';
  assert.deepEqual(discoverCatalogLinks(html, source.url, source).map((x) => x.url), ['https://vendor.example/store/hk']);
  assert.equal(cleanPublicUrl('http://127.0.0.1/store'), null); assert.equal(cleanPublicUrl('https://user:pass@vendor.example/'), null);
  const dupHtml = '<a href="/index.php?rp=/store/usa-shared">US</a><a href="/store/usa-shared/">US Clean</a>';
  assert.equal(canonicalCatalogPageKey("https://vendor.example/index.php?rp=/store/usa-shared"), "https://vendor.example/store/usa-shared");
  assert.deepEqual(discoverCatalogLinks(dupHtml, source.url, source).map((x) => x.url), ["https://vendor.example/store/usa-shared/"]);
});

test("discovery excludes customer add-ons and configured non-catalog paths", () => {
  const html = '<a href="/cart.php?gid=addons">Product Addons</a><a href="/cart.php?gid=renewals">Renewals</a><a href="/store/ssl">SSL</a><a href="/cart.php?gid=12">VPS</a><a href="/order/config/index/vps/?pricing_id=7">Configure VPS</a><a href="/products/vps/checkout">Buy</a>';
  assert.deepEqual(discoverCatalogLinks(html, source.url, { ...source, excludePaths: ['/store/ssl'] }).map((x) => x.url), ['https://vendor.example/cart.php?gid=12']);
});

test("discovery excludes restock notification actions under WHMCS store paths", () => {
  const html = '<a href="/store/index.php?m=product_restock_notifier&_action=notify&_pid=34">补货通知</a><a href="/index.php?m=product_restock_notifier&_action=notify&_pid=35">Notify me</a><a href="/store/nttispipvps">VPS</a>';
  assert.deepEqual(discoverCatalogLinks(html, source.url, source).map((x) => x.url), ['https://vendor.example/store/nttispipvps']);
});

test("HostBill quickcart identity deduplicates the same offer across marketing pages without inventing stock", () => {
  const html = card('No inventory published', 'https://billing.vendor.example/?cmd=module&module=quickcart&id=59&showconfig=1&cycle=a');
  const first = parseCatalogPage(source, htmlResult(html), { baseRecord })[0];
  const second = parseCatalogPage(source, htmlResult(html, { finalUrl: 'https://vendor.example/pricing' }), { baseRecord })[0];
  assert.equal(first.id, second.id);
  assert.equal(first.status, 'unknown');
});
test("safe document bases resolve catalog links and product order identities", () => {
  const pageUrl = 'https://vendor.example/products/kvm/';
  const cases = [
    ['https://vendor.example/', 'https://vendor.example/'],
    ['../../', 'https://vendor.example/'],
    ['/billing/', 'https://vendor.example/billing/'],
    ['//my.vendor.example/', 'https://my.vendor.example/'],
    ['https://checkout.example/', 'https://checkout.example/']
  ];
  const configured = { ...source, allowedOrigins: ['https://checkout.example'] };
  for (const [href, expectedBase] of cases) {
    const base = `<head><base href="${href}"></head>`;
    assert.deepEqual(discoverCatalogLinks(`${base}<a href="cart/mini-kvm-vps/">Mini KVM VPS</a>`, pageUrl, configured).map((link) => link.url), [`${expectedBase}cart/mini-kvm-vps/`], href);
    const [plan] = parseCatalogPage(configured, htmlResult(base + card('No stock published', 'cart.php?a=add&amp;pid=4&amp;ref=123'), { finalUrl: pageUrl }), { baseRecord });
    const [canonical] = parseCatalogPage(configured, htmlResult(card('No stock published', `${expectedBase}cart.php?a=add&pid=4`)), { baseRecord });
    assert.equal(plan.orderUrl, `${expectedBase}cart.php?a=add&pid=4`, href);
    assert.equal(plan.id, canonical.id, href);
    assert.equal(plan.sourceUrl, pageUrl);
    assert.equal(plan.raw.catalogPage, pageUrl);
    assert.equal(plan.status, 'available');
    assert.equal(plan.stockCount, null);
  }
});
test("unsafe document bases are ignored for discovery, orders and identities", () => {
  const pageUrl = 'https://vendor.example/products/kvm/';
  const links = '<a href="cart/mini-kvm-vps/">Mini KVM VPS</a>';
  const product = card('No stock published', 'cart.php?a=add&pid=4');
  const [expected] = parseCatalogPage(source, htmlResult(product, { finalUrl: pageUrl }), { baseRecord });
  for (const href of [
    'https://foreign.example/', '//foreign.example/', 'https://vendor.example.foreign.example/',
    'https://visitor:example@vendor.example/', 'https://user@vendor.example/',
    'javascript:alert(1)', 'data:text/html,ignored', 'ftp://vendor.example/',
    'http://127.0.0.1/', 'http://[::1]/', 'https://vendor.example.local/', 'https://'
  ]) {
    const base = `<head><base href="${href}"></head>`;
    assert.deepEqual(discoverCatalogLinks(base + links, pageUrl, source).map((link) => link.url), [`${pageUrl}cart/mini-kvm-vps/`], href);
    const [plan] = parseCatalogPage(source, htmlResult(base + product, { finalUrl: pageUrl }), { baseRecord });
    assert.equal(plan.orderUrl, expected.orderUrl, href);
    assert.equal(plan.id, expected.id, href);
    assert.equal(plan.sourceUrl, pageUrl);
  }
});
test("only the first document base with an href is considered", () => {
  const link = '<a href="cart/mini-kvm-vps/">Mini KVM VPS</a>';
  const pageUrl = 'https://vendor.example/products/';
  assert.deepEqual(discoverCatalogLinks(`<base target="_blank"><base href="/"><base href="/ignored/">${link}`, pageUrl, source).map((item) => item.url), ['https://vendor.example/cart/mini-kvm-vps/']);
  assert.deepEqual(discoverCatalogLinks(`<base href="https://foreign.example/"><base href="/">${link}`, pageUrl, source).map((item) => item.url), ['https://vendor.example/products/cart/mini-kvm-vps/']);
});
test("document bases preserve explicit sellouts and fetched-page fallback records", () => {
  const pageUrl = 'https://vendor.example/products/kvm/';
  const base = '<base href="/billing/">';
  for (const stock of ['Sold Out', '0 可用']) {
    const [plan] = parseCatalogPage(source, htmlResult(base + card(stock, 'cart.php?a=add&pid=4'), { finalUrl: pageUrl }), { baseRecord });
    assert.equal(plan.status, 'unavailable', stock);
    assert.equal(plan.stockCount, 0);
    assert.equal(plan.orderUrl, 'https://vendor.example/billing/cart.php?a=add&pid=4');
  }
  for (const stock of ['Sold Out', '3 Available']) {
    const result = htmlResult(card(stock, null), { finalUrl: pageUrl });
    const [expected] = parseCatalogPage(source, result, { baseRecord });
    const [plan] = parseCatalogPage(source, { ...result, html: base + result.html }, { baseRecord });
    assert.deepEqual(plan, expected, stock);
    assert.equal(plan.orderUrl, stock === 'Sold Out' ? null : pageUrl);
    assert.equal(plan.sourceUrl, pageUrl);
    assert.equal(plan.raw.catalogPage, pageUrl);
  }
  assert.deepEqual(parseCatalogPage({ ...source, excludePaths: ['/products/'] }, htmlResult(base + card(), { finalUrl: pageUrl }), { baseRecord }), []);
});
function helpers(routes, calls) {
  return { baseRecord, fetchHtml: async (_, url) => { calls.push(url); if (!routes[url]) throw new Error('Unconfigured read'); return routes[url]; }, blockedRecord: (s,r,message) => baseRecord(s,r,{status:'blocked',evidence:message}), errorRecord: (s,error) => baseRecord(s,null,{status:'error',evidence:error.message}) };
}

test("redirect destinations count as visited without consuming a second page budget", async () => {
  const calls = [];
  const target = 'https://vendor.example/store/tokyo';
  const next = 'https://vendor.example/store/osaka';
  const routes = {
    [source.url]: htmlResult(card() + `<a href="${target}">Tokyo VPS</a><a href="${next}">Osaka VPS</a>`, { finalUrl: target }),
    [next]: htmlResult(card('0 Available', '/cart.php?a=add&pid=5'), { finalUrl: next })
  };
  const records = await monitorPublicCatalog({ ...source, maxPages: 2 }, helpers(routes, calls));
  assert.deepEqual(calls, [source.url, next]);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].collection, { pagesChecked: 2, pageLimitReached: false, failedPages: 0 });
});

test("source deadline preserves parsed plans with an explicit incomplete-coverage diagnostic", async () => {
  const calls = [];
  const routes = { [source.url]: htmlResult(card() + '<a href="/store/next">Next VPS</a>') };
  let time = 0;
  const records = await monitorPublicCatalog(source, { ...helpers(routes, calls), deadline: 1, now: () => time++ });
  assert.deepEqual(calls, [source.url]);
  assert.ok(records.some((p) => p.status === 'available'));
  assert.ok(records.some((p) => p.diagnostic && p.status === 'error'));
  assert.equal(records[0].collection.timeBudgetReached, true);
  assert.equal(records[0].collection.pageLimitReached, false);
});
test("V.PS document bases prevent repeated relative catalog paths and duplicate plans", async () => {
  const configured = { ...source, url: 'https://vps.hosting/products/', maxPages: 4 };
  const next = 'https://vps.hosting/cart/mini-kvm-vps/';
  const html = '<head><base href="https://vps.hosting/" /></head><a href="cart/mini-kvm-vps/">Mini KVM VPS</a>' + card('No stock published', 'cart.php?a=add&pid=4');
  const calls = [];
  const routes = {
    [configured.url]: htmlResult(html, { finalUrl: configured.url }),
    [next]: htmlResult(html, { finalUrl: next })
  };
  const records = await monitorPublicCatalog(configured, helpers(routes, calls));
  assert.deepEqual(calls, [configured.url, next]);
  assert.equal(records.length, 1);
  assert.equal(records[0].orderUrl, 'https://vps.hosting/cart.php?a=add&pid=4');
  assert.equal(records[0].sourceUrl, next);
  assert.deepEqual(records[0].collection, { pagesChecked: 2, pageLimitReached: false, failedPages: 0 });
});
test("public catalogs tolerate a normal login-widget script and cf-turnstile widget on HTTP 200 without falsely reporting a challenge", async () => {
  const html = `<html><head><title>Portal Home</title></head><body><div class="cf-turnstile"></div>${card()}</body></html>`;
  const rows = await monitorPublicCatalog(
    { ...source, discover: false },
    {
      fetchHtml: async () => htmlResult(html),
      isAntiBotResult: (r) => /cf-turnstile/i.test(r.html),
      baseRecord,
      blockedRecord: (s, r, e) => baseRecord(s, r, { status: "blocked", evidence: e }),
      errorRecord: (s, e) => baseRecord(s, null, { status: "error", evidence: e.message })
    }
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "available");
  const calls = [];
  const records = await monitorPublicCatalog({ ...source, discover: false }, helpers({ [source.url]: htmlResult(card() + '<script src="cf-turnstile.js"></script>') }, calls));
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "available");
});
test("blocked responses and empty public catalogs produce diagnostics, never sold-out plans", async () => {
  for (const result of [htmlResult('Just a moment',{ok:false,statusCode:403}),htmlResult('<h1>Sign in</h1>')]) {
    const records = await monitorPublicCatalog({...source,discover:false},helpers({[source.url]:result},[]));
    assert.equal(records[0].diagnostic,true); assert.ok(['blocked','unknown'].includes(records[0].status)); assert.equal(records[0].priceValue ?? null,null);
  }
});
test("catalog walk is bounded and retains partial failures", async () => {
  const next='https://vendor.example/store/japan', third='https://vendor.example/store/us';const calls=[];
  const routes={[source.url]:htmlResult(card()+`<a href="${next}">Japan VPS</a><a href="${third}">US VPS</a>`),[next]:htmlResult('Denied',{statusCode:403,ok:false,finalUrl:next})};
  const records=await monitorPublicCatalog({...source,maxPages:2},helpers(routes,calls));assert.equal(calls.length,2);assert.ok(records.some(p=>p.status==='available'));assert.ok(records.some(p=>p.diagnostic&&p.status==='blocked'));assert.equal(records[0].collection.pageLimitReached,true);
});
test("public API ignores physical servers and negative stock is not an exact quantity", () => {
  const item={id:'v',name:'KVM',service_type:'compute',is_active:true,is_hidden:false,stock:-1,price:10,currency:'USD',billing_cycle:'monthly',specs:{cpu:1,memory:1024,disk:20},regions:['jp-tyo']};
  const records=parseCatalogApi({...source,catalogFormat:'100tb'},htmlResult(JSON.stringify({data:{list:[item,{...item,id:'d',service_type:'dedicated'}]}})),{baseRecord});assert.equal(records.length,1);assert.equal(records[0].stockCount,null);assert.equal(records[0].status,'unknown');
});
test("USVPS24 purchase restrictions do not become generally available inventory", () => {
  const plans=[{id:1,name:'US VPS',available:true,eligible:false,stock:2,price:12,currency:'USD',specs:{cpu:1}}];
  const html=`<div data-page='${JSON.stringify({props:{plans}})}'></div>`;assert.equal(parseUsvps24(source,htmlResult(html),{baseRecord})[0].status,'unknown');
});
test("NodeMach public list excludes proxy products and respects payable flag", () => {
  const p={id:4,name:'Standard',type:'instance',in_stock:true,payable:false,display:35.99,description:[]};
  const html=`<script data-page="app" type="application/json">${JSON.stringify({props:{data:{data:[p,{...p,id:1,type:'standard'}]}}})}</script>`;
  const rows=parseNodeMach(source,htmlResult(html),{baseRecord});assert.equal(rows.length,1);assert.equal(rows[0].status,'unavailable');
});
test("all directory providers have scheduled collection and no copied referral URLs", () => {
  const sources=JSON.parse(readFileSync(new URL('../monitor/sources.json',import.meta.url)));
  assert.equal(new Set(providers.map(p=>p.id)).size,providers.length);
  assert.equal(providers.length, 121);
  for(const id of ['zgovps','berohost','spartan','attvps','bocchi','jcloud','mondoze','nexkr','tamago','666clouds','cloudsilk','tothost','buyvm','jindouyun']) assert.ok(providers.some(p=>p.id===id),id);
  for(const p of providers){assert.ok(sources.some(s=>s.providerId===p.id),p.id);assert.doesNotMatch(p.website,/(?:aff(?:iliate)?|ref(?:erral)?|utm_)[=/]/i);}
});
test("provider health distinguishes coverage from actual inventory", () => {
  const p={id:'v',inventoryNames:['Vendor']};
  assert.equal(providerHealth(p,[{provider:'Vendor',diagnostic:true,status:'blocked'}]).known,0);
  assert.equal(providerHealth(p,[{provider:'Vendor',status:'unknown'}]).state,'unknown');
  assert.equal(providerHealth(p,[{provider:'Vendor',status:'available'},{provider:'Vendor',status:'error'}]).state,'partial');
});
test("price comparison preserves currency, billing period and starting-price uncertainty", () => {
  const yearly={price:'USD 24/year',priceValue:24};const monthly={price:'USD 3/month',priceValue:3};
  assert.equal(priceQuote(yearly).monthly,2);assert.ok(comparePrices(yearly,monthly)<0);assert.equal(priceQuote({price:'JPY 8800/月',priceValue:8800}).currency,'JPY');assert.equal(priceQuote({price:'$9.99/月起',priceValue:9.99}).monthly,null);assert.equal(priceQuote({price:'€12',priceValue:12}).monthly,null);assert.equal(priceQuote({price:'USD 60 Semi-Annually',priceValue:60}).months,6);
});

test("a verified price selector reads the active DPNET price instead of the crossed-out offer", () => {
  const [p]=parse('<div class="pr9x-card"><h6>2 CPU / 4 GB RAM</h6><span>US$ 2.99</span><div><span>USD</span><h3>2.19</h3><span>/mo</span></div><p>50 GB SSD</p><a href="https://my.vendor.example/index.php?rp=/store/budget-vps/budget-1">Get This Plan</a></div>',{nameSelector:'h6',priceSelector:'h3',currency:'USD'});
  assert.equal(p.priceValue,2.19); assert.match(p.price,/USD 2.19/);
});

test("JDIDC public API preserves exact stock, negative sellouts, dual-ISP category, and excludes non-VPS groups", () => {
  const payload = {
    status: 200,
    data: {
      fgs: [
        {
          id: 58,
          name: "双ISP",
          group: [
            {
              id: 223,
              name: "美国家宽ISP A区",
              products: [
                { id: 1403, type: "dcimcloud", gid: 223, name: "美国双ISP住宅云主机 2核2G", description: "<li>核心：2核</li><li>内存：2GB</li><li>硬盘：40G SSD</li><li>带宽：25Mbps</li><li>流量：不限流量</li><li>路线：回国9929+CMIN2</li>", stock_control: 1, qty: 12, product_price: "38.00", billingcycle: "monthly", billingcycle_zh: "月" },
                { id: 1404, type: "dcimcloud", gid: 223, name: "美国双ISP住宅云主机 售罄款", description: "<li>核心：2核</li>", stock_control: 1, qty: -2, product_price: "38.00", billingcycle: "monthly", billingcycle_zh: "月" }
              ]
            }
          ]
        },
        {
          id: 11,
          name: "大陆 · 物理机",
          group: [{ id: 111, name: "物理机", products: [{ id: 999, type: "dcimcloud", name: "物理机E5", product_price: "500.00", stock_control: 1, qty: 5, billingcycle: "monthly" }] }]
        }
      ]
    }
  };
  const jdidcSource = { id: "catalog-jdidc", providerId: "jdidc", provider: "JDIDC", url: "https://www.jdidc.cn/api/common/prolist-proxy.php", website: "https://www.jdidc.cn/", catalogFormat: "jdidc" };
  const rows = parseJdidcApi(jdidcSource, htmlResult(JSON.stringify(payload)), { baseRecord });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].category, "home");
  assert.equal(rows[0].status, "available");
  assert.equal(rows[0].stockCount, 12);
  assert.equal(rows[0].region, "美国");
  assert.equal(rows[0].price, "CNY 38/月");
  assert.equal(rows[0].orderUrl, "https://www.jdidc.cn/user/product-config.php?id=1403");
  assert.equal(rows[1].status, "unavailable");
  assert.equal(rows[1].stockCount, 0);
});

test("JDIDC plan location outranks routing prose and missing stock never becomes a sellout", () => {
  const quantities = [null, "", undefined, "invalid", 1.5, true, 0, "3"];
  const products = quantities.map((qty, i) => ({
    id: i + 1, name: "德国9929 2核2GB", type: "cloud", product_price: 28,
    billingcycle: "monthly", stock_control: 1, qty, description: "<li>美国中转线路</li>"
  }));
  const result = htmlResult(JSON.stringify({ data: { fgs: [{ name: "美国 / 德国", group: [{ name: "德国9929", products }] }] } }));
  const rows = parseJdidcApi({ ...source, website: "https://www.jdidc.cn/" }, result, { baseRecord });
  for (const row of rows) assert.equal(row.region, "德国");
  for (const row of rows.slice(0, 6)) {
    assert.equal(row.status, "unknown");
    assert.equal(row.stockCount, null);
  }
  assert.equal(rows[6].status, "unavailable");
  assert.equal(rows[6].stockCount, 0);
  assert.equal(rows[7].status, "available");
  assert.equal(rows[7].stockCount, 3);
});
