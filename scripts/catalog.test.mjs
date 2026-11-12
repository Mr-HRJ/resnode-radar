import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parseCatalogPage, cleanPublicUrl, discoverCatalogLinks } from "./adapters/catalog-pages.mjs";
import { monitorPublicCatalog, parseUsvps24 } from "./adapters/public-catalog.mjs";
import { parseCatalogApi, parseNodeMach } from "./adapters/catalog-api.mjs";
import { providers } from "../providers.js";
import { providerHealth } from "../directory.js";
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
test("Chinese zero inventory wins over an order button and sold-out cards survive missing links", () => {
  assert.equal(parse(card('0 可用'))[0].status, "unavailable");
  const [sold] = parse(card('Sold Out', null)); assert.equal(sold.status, "unavailable"); assert.equal(sold.stockCount, 0);
});
test("bandwidth is not GBP, marketing cards are not plans, unknown stock stays unknown", () => {
  assert.equal(parse('<article><h3>Hosting</h3><p>KVM VPS 1Gbps</p><a href="/login">Order</a></article>').length, 0);
  assert.equal(parse('<div class="product"><h3>News</h3><p>VPS hosting from $4.99</p></div>').length, 0);
  assert.equal(parse(card('No stock published', '/login'))[0].status, 'unknown');
  assert.equal(parse(card('No stock published', null))[0].status, 'unknown');
});
test("catalog excludes only explicit aggregate and add-on names, including table rows", () => {
  for (const name of ['Additional Services', ' Simple   pricing ', 'POPULAR PLANS']) {
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
test("public catalogs tolerate a normal login-widget script without falsely reporting a challenge", async () => {
  const calls = []; const records = await monitorPublicCatalog({...source,discover:false},helpers({[source.url]:htmlResult(card()+'<script src="cf-turnstile.js"></script>')},calls));
  assert.equal(records.length,1); assert.equal(records[0].status,'available');
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
  for(const id of ['zgovps','berohost','spartan']) assert.ok(providers.some(p=>p.id===id),id);
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
