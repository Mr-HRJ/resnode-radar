import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFlawlessNode, parseLightNodeLanding, parsePageLimitCatalog, parsePaymenterCatalog } from "./adapters/page-limit-catalogs.mjs";

const baseRecord = (s, r, values) => ({ sourceId: s.id, provider: s.provider, ...values });
const result = (html, url) => ({ html, finalUrl: url, statusCode: 200, ok: true });

// ---------------------------------------------------------------- FlawlessNode
const fnSource = { id: "catalog-flawlessnode", provider: "Flawless Node", url: "https://www.flawlessnode.com/pricing/", catalogFormat: "flawlessnode" };
const fnRow = ({ routing = "basic", name = "流量型 Basic S", host = "Gen 1 / Gen 2", cpu = "2 vCPU", ram = "2 GB", disk = "15GB NVMe", traffic = "8TB (Out)", uplink = "2Gbps", price = "$10/mo", href = "https://panel.flawlessnode.com/products/LAX-Bandwidth/LAX-Bandwidth-Basic-S/checkout" } = {}) => `
  <tr class="pricing-plan-row border-b" data-routing="${routing}">
    <th scope="row"><div class="inline-flex"><span>${name}</span><span class="badge">${routing}</span></div></th>
    <td>${host}</td><td>${cpu}</td><td>${ram}</td><td>${disk}</td><td>${traffic}</td><td>${uplink}</td><td>${price}</td>
    <td>${href ? `<a href="${href}" aria-label="操作 - ${name}"><svg><use href="#cart"></use></svg></a>` : ""}</td>
  </tr>`;
const fnPage = (rows, header = ["套餐名称 (Plan)", "宿主机类型 (Host Type)", "处理器 (vCPU)", "内存 (RAM)", "硬盘 (Storage)", "流量 (Traffic)", "上联 (Uplink)", "价格 (Price)", "操作"]) => `<html><body>
  <button class="routing-tab" data-routing="basic">Basic (AS60068)</button><button class="routing-tab" data-routing="pro">Pro (AS9929)</button>
  <button class="region-tab" data-target="region-lax1" role="tab">洛杉矶 (LAX1)</button>
  <div id="region-lax1" class="region-content block" role="tabpanel"><table><thead><tr>${header.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
  <tbody>${rows.join("")}</tbody></table></div></body></html>`;

test("FlawlessNode pricing rows become named plans with cycle, route and product checkout", () => {
  const rows = parseFlawlessNode(fnSource, result(fnPage([
    fnRow(),
    fnRow({ routing: "pro", name: "流量型 Pro 2XS", host: "Gen 2", price: "$21/3mo", href: "https://panel.flawlessnode.com/products/LAX-Bandwidth/LAX-Bandwidth-Pro-2XS/checkout" }),
    fnRow({ name: "Basic 特殊款 1", price: "$36/yr", href: "" })
  ]), fnSource.url), { baseRecord });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => [r.name, r.price, r.priceValue, r.status, r.route, r.region]), [
    ["流量型 Basic S (洛杉矶 (LAX1))", "$10 月付", 10, "available", "AS60068", "美国"],
    ["流量型 Pro 2XS (洛杉矶 (LAX1))", "$21 季付", 21, "available", "AS9929", "美国"],
    ["Basic 特殊款 1 (洛杉矶 (LAX1))", "$36 年付", 36, "unknown", "AS60068", "美国"]
  ]);
  assert.equal(rows[0].orderUrl, "https://panel.flawlessnode.com/products/LAX-Bandwidth/LAX-Bandwidth-Basic-S/checkout");
  assert.equal(rows[0].hardware, "2 vCPU / 2 GB RAM / 15GB NVMe / Gen 1 / Gen 2");
  assert.equal(rows[0].bandwidth, "8TB (Out) / 2Gbps");
  assert.equal(rows[2].orderUrl, null);
  assert.equal(new Set(rows.map((r) => r.id)).size, 3);
});

test("FlawlessNode throws on schema drift instead of returning empty inventory", () => {
  assert.throws(() => parseFlawlessNode(fnSource, result("<html><body>maintenance</body></html>", fnSource.url), { baseRecord }), /schema changed: region tables missing/);
  assert.throws(() => parseFlawlessNode(fnSource, result(fnPage([fnRow({ price: "$10 per month" })]), fnSource.url), { baseRecord }), /price format/);
  assert.throws(() => parseFlawlessNode(fnSource, result(fnPage([fnRow()], ["Plan", "Price"]), fnSource.url), { baseRecord }), /header/);
  assert.throws(() => parseFlawlessNode(fnSource, result(fnPage([fnRow()]), "https://www.flawlessnode.com/"), { baseRecord }), /unsupported pricing URL/);
});

// ------------------------------------------------------------------- Paymenter
const bugSource = { id: "catalog-bugnet", provider: "BUG NET(虫网)", url: "https://bug.pw/products/us-northwest-seattle-lite", catalogFormat: "paymenter" };
const footer = `<footer><a href="https://paymenter.org">Powered by</a></footer>`;
const card = (slug, name, price, checkout) => `<div class="flex flex-col"><h2 class="text-xl font-bold">${name}</h2><h3 class="text-lg">${price}</h3>
  <div class="mt-auto"><a href="https://bug.pw/products/us-northwest-seattle-lite/${slug}" wire:navigate class="flex-grow"><button>檢視</button></a>
  ${checkout ? `<a href="https://bug.pw/products/us-northwest-seattle-lite/${slug}/checkout" wire:navigate><button><svg></svg></button></a>` : ""}</div></div>`;
const categoryPage = `<html><body><nav><a href="https://bug.pw/products/japan-tokyo-performance">Japan - Tokyo (Performance)</a></nav>
  <main><div class="grid">${card("seattle-vps-marsbilled-yearly", "Seattle VPS Mars(Billed Yearly)", "£29.99", false)}${card("seattle-vps-venus", "Seattle VPS Venus", "£3.99", true)}</div></main>${footer}</body></html>`;
const productPage = (badge, name, price, checkout) => `<html><body><main class="mt-16 grow"><div wire:snapshot="{}" class="container">
  <span class="text-xs">${badge}</span><div><div><h2 class="text-3xl">${name}</h2><h3 class="text-xl">${price}</h3></div></div>
  <article class="prose"><p>CPU: 2 vCore Intel Xeon E5</p><p>RAM: 2GB DDR4 ECC</p><p>Storage: 25GB SSD</p><p>Traffic: 2000GB @ 1 Gbps (In + Out)</p><p>IP: 1 IPv4 + /64 IPv6</p></article>
  ${checkout ? `<a href="${checkout}" wire:navigate><button>加入購物車</button></a>` : ""}</div></main>${footer}</body></html>`;

test("Paymenter category page: checkout link means purchasable, absence stays unknown", () => {
  const rows = parsePaymenterCatalog(bugSource, result(categoryPage, bugSource.url), { baseRecord });
  assert.deepEqual(rows.map((r) => [r.name, r.price, r.priceValue, r.currency, r.status, r.orderUrl, r.region]), [
    ["Seattle VPS Mars(Billed Yearly)", "£29.99 年付", 29.99, "GBP", "unknown", null, "美国"],
    ["Seattle VPS Venus", "£3.99 起", 3.99, "GBP", "available", "https://bug.pw/products/us-northwest-seattle-lite/seattle-vps-venus/checkout", "美国"]
  ]);
});

test("Paymenter product page badge is explicit stock and replaces the category record id", () => {
  const productUrl = "https://bug.pw/products/us-northwest-seattle-lite/seattle-vps-marsbilled-yearly";
  const [sold] = parsePaymenterCatalog(bugSource, result(productPage("產品 Seattle VPS Mars(Billed Yearly) 已售罄", "Seattle VPS Mars(Billed Yearly)", "£29.99", null), productUrl), { baseRecord });
  const [fromCategory] = parsePaymenterCatalog(bugSource, result(categoryPage, bugSource.url), { baseRecord });
  assert.equal(sold.id, fromCategory.id);
  assert.deepEqual([sold.status, sold.stockCount, sold.orderUrl, sold.statusLabel], ["unavailable", 0, null, "已售罄"]);
  assert.equal(sold.hardware, "CPU: 2 vCore Intel Xeon E5 / RAM: 2GB DDR4 ECC / Storage: 25GB SSD");
  assert.equal(sold.bandwidth, "Traffic: 2000GB @ 1 Gbps (In + Out) / IP: 1 IPv4 + /64 IPv6");
  const venusUrl = "https://bug.pw/products/us-northwest-seattle-lite/seattle-vps-venus";
  const [live] = parsePaymenterCatalog(bugSource, result(productPage("有現貨", "Seattle VPS Venus", "£3.99", `${venusUrl}/checkout`), venusUrl), { baseRecord });
  assert.deepEqual([live.status, live.orderUrl], ["available", `${venusUrl}/checkout`]);
  const [english] = parsePaymenterCatalog(bugSource, result(productPage("Product Seattle VPS Venus is out of stock", "Seattle VPS Venus", "£3.99", null), venusUrl), { baseRecord });
  assert.equal(english.status, "unavailable");
});

test("Paymenter parser rejects non-storefront or drifted pages", () => {
  assert.throws(() => parsePaymenterCatalog(bugSource, result(`<html><body>${footer}</body></html>`, bugSource.url), { baseRecord }), /no product cards/);
  assert.throws(() => parsePaymenterCatalog(bugSource, result(categoryPage, "https://bug.pw/cart"), { baseRecord }), /unsupported Paymenter URL/);
  assert.throws(() => parsePaymenterCatalog(bugSource, result(productPage("有現貨", "X", "3.99 GBP", null), "https://bug.pw/products/a/b"), { baseRecord }), /price format/);
});

// ------------------------------------------------------------------- LightNode
const lnSource = { id: "catalog-lightnode", provider: "LightNode", url: "https://go.lightnode.com/hong-kong-vps", catalogFormat: "lightnode" };
const lnCard = (plan, amount, config, region = "cn-hongkong-3") => `<div class="_card_14pwf_73" data-pricing-card="true"><div class="_cardHeader_14pwf_110">
  <div class="_planName_14pwf_113">${plan}</div><div class="_price_14pwf_119"><span class="_priceFigure_14pwf_131"><span class="_currency_14pwf_127">$</span><span class="_amount_14pwf_134" data-price-value="true">${amount}</span></span><span class="_priceUnit_14pwf_139">/month</span></div>
  <div class="_productName_14pwf_145">Hong Kong VPS</div></div><ul class="_specs_14pwf_151"><li><span><span>2 GB</span> <span>DDR4 Memory</span></span></li><li><span><span>1 vCPU</span> <span>High Frequency</span></span></li>
  <li><span><span>50 GB</span> <span>NVMe SSD Storage</span></span></li><li><span><span>1 TB</span> <span>Bandwidth</span></span></li><li><svg></svg><span>HK T4 Data Center</span></li></ul>
  <div class="_cardFooter_14pwf_193"><a href="https://console.lightnode.com/product/instance/create?region=${region}&amp;zone=${region}-a&amp;config=${config}&amp;type=CPU_SHARE">Get Started</a></div></div>`;

test("LightNode landing cards keep region-specific price and console deep link but never claim stock", () => {
  const html = `<html><body><a href="https://console.lightnode.com/product/instance/create?region=cn-hongkong-3&zone=cn-hongkong-3-a&config=1C2M50S&type=CPU_SHARE">Create</a>${lnCard("Start", "10.41", "1C2M50S")}${lnCard("Agency", "20.11", "2C4M50S")}
    <div><h3>More resources, less cost</h3><p>1 vCPU Computer 2 GB Memory</p><p>$15</p></div></body></html>`;
  const rows = parseLightNodeLanding(lnSource, result(html, lnSource.url), { baseRecord });
  assert.deepEqual(rows.map((r) => [r.id, r.name, r.price, r.priceValue, r.status, r.region]), [
    ["catalog-lightnode:plan:cn-hongkong-3:1C2M50S", "Start 1C2M50S (Hong Kong)", "$10.41 /month", 10.41, "unknown", "Hong Kong"],
    ["catalog-lightnode:plan:cn-hongkong-3:2C4M50S", "Agency 2C4M50S (Hong Kong)", "$20.11 /month", 20.11, "unknown", "Hong Kong"]
  ]);
  assert.equal(rows[0].orderUrl, "https://console.lightnode.com/product/instance/create?region=cn-hongkong-3&zone=cn-hongkong-3-a&config=1C2M50S&type=CPU_SHARE");
  assert.equal(rows[0].raw.dataCenter, "HK T4 Data Center");
  assert.equal(rows[0].stockCount, null);
});

test("LightNode parser throws when pricing cards disappear and dispatcher routes formats", () => {
  assert.throws(() => parseLightNodeLanding(lnSource, result("<html><body><p>$7.71</p></body></html>", lnSource.url), { baseRecord }), /pricing cards missing/);
  assert.throws(() => parseLightNodeLanding(lnSource, result(lnCard("Start", "N/A", "1C2M50S"), lnSource.url), { baseRecord }), /card fields/);
  assert.equal(parsePageLimitCatalog(lnSource, result(lnCard("Start", "7.71", "1C2M50S", "us-siliconvalley-1"), lnSource.url), { baseRecord }).length, 1);
  assert.throws(() => parsePageLimitCatalog({ ...lnSource, catalogFormat: "nope" }, result("", lnSource.url), { baseRecord }), /Unsupported/);
});
