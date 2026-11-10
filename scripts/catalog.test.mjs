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
test("catalog handles decimal comma and dedicated-server exclusions", () => {
  const [p] = parse(card().replace('$12.00', '€2,20')); assert.equal(p.priceValue, 2.2);
  assert.equal(parse(card().replace('Tokyo KVM', 'Dedicated Server E5')).length, 0);
});
test("discovery stays on official hosts, excludes checkout and language mirrors, strips referrals", () => {
  const html = '<a href="/store/hk?ref=123">HK VPS</a><a href="https://evil.example/store/vps">VPS</a><a href="/store/hk?language=french">French</a><a href="/cart.php?a=add&pid=1">Order</a>';
  assert.deepEqual(discoverCatalogLinks(html, source.url, source).map((x) => x.url), ['https://vendor.example/store/hk']);
  assert.equal(cleanPublicUrl('http://127.0.0.1/store'), null); assert.equal(cleanPublicUrl('https://user:pass@vendor.example/'), null);
});
function helpers(routes, calls) {
  return { baseRecord, fetchHtml: async (_, url) => { calls.push(url); if (!routes[url]) throw new Error('Unconfigured read'); return routes[url]; }, blockedRecord: (s,r,message) => baseRecord(s,r,{status:'blocked',evidence:message}), errorRecord: (s,error) => baseRecord(s,null,{status:'error',evidence:error.message}) };
}
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
test("all 57 MeowVPS entries plus existing vendors have scheduled collection and no copied referral URLs", () => {
  const sources=JSON.parse(readFileSync(new URL('../monitor/sources.json',import.meta.url)));
  assert.equal(providers.length,62);assert.equal(new Set(providers.map(p=>p.id)).size,62);
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
