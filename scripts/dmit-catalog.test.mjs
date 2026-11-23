import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDmitSku, collectDmitPlans, dmitUrl, monitorDmitCatalog, parseDmitPlans } from "./adapters/dmit-catalog.mjs";

const source = { id: "catalog-dmit", provider: "DMIT", url: "https://www.dmit.io/pages/pricing" };
const card = (pid, name = "TINY", cycle = "Monthly") => `<div class="plan-card"><div class="plan-card-name">${name}</div><div class="plan-card-specs">
  <div class="plan-spec"><i class="fas fa-microchip"></i>1 vCore</div><div class="plan-spec"><i class="fas fa-memory"></i>2GB</div>
  <div class="plan-spec"><i class="fas fa-hdd"></i>20GB SSD</div><div class="plan-spec"><i class="fas fa-exchange-alt"></i>1000GB Max<sup> (IN, OUT)</sup></div>
  <div class="plan-spec"><i class="fas fa-bolt"></i>1Gbps</div></div><div class="plan-card-price">$10.90<span>/${cycle}</span></div>
  <div class="plan-card-action">${pid ? `<button onclick="if (!window.__cfRLUnblockHandlers) return false; window.location.href='/cart.php?a=add&pid=${pid}'">Order Now</button>` : '<button disabled>Out of Stock</button>'}</div></div>`;
const group = (location, family, network, cards) => `<div class="plan-group" data-loc="${location}" data-hw="${family}" data-net="${network}" style="display:none"><div class="plan-cards">${cards}</div></div>`;
const catalogHtml = group("lax", "as3", "premium", card("253")) + group("hkg", "an5", "premium", card("125", "TINY", "Annually")) + group("lax", "an4", "eyeball", card(null, "MINI"));
const response = (html, url = source.url, statusCode = 200) => ({ html, finalUrl: url, statusCode, ok: statusCode === 200, headers: {} });
const catalog = response(catalogHtml);
const soldOut = response("<title>Shopping Cart - DMIT, Inc.</title><h1>Out of Stock</h1><p>We are currently out of stock on this item so orders for it have been suspended.</p>", "https://www.dmit.io/cart.php?a=add&pid=253");
const configure = response('<form id="frmConfigureProduct"><select name="billingcycle"><option value="monthly">$149.90 USD Monthly</option><option value="annually">$1798.80 USD Annually</option></select></form>', "https://www.dmit.io/cart.php?a=confproduct&i=0");
const challenge = response("<title>Just a moment...</title>", source.url, 403);

test("DMIT retains identically named plans across regions and hidden groups", () => {
  const plans = parseDmitPlans(source, catalog);
  assert.equal(plans.length, 3);
  assert.equal(new Set(plans.map((p) => p.id)).size, 3);
  assert.deepEqual(plans.map((p) => p.region), ["美国", "香港", "美国"]);
  assert.match(plans[0].hardware, /2GB RAM/);
  assert.equal(plans[0].orderUrl, "https://www.dmit.io/cart.php?a=add&pid=253");
  assert.equal(plans[0].status, "unknown"); // A marketing Order Now button is not live stock.
  assert.equal(plans[1].raw.billingCycle, "annually");
  assert.equal(plans[2].status, "unavailable");
  assert.equal(plans[2].raw.pid, null);
  assert.equal(plans[2].stockCount, null);
  assert.ok(plans.every((p) => p.raw.referencePrice && p.currency === "USD"));
});

test("DMIT rejects schema changes and duplicate or external SKU identities", () => {
  for (const html of [catalogHtml.replace('data-loc="lax"', 'data-loc="new"'), catalogHtml + group("lax", "as3", "premium", card("253")), catalogHtml.replace('pid=125', 'pid=253'), catalogHtml.replace("/cart.php?a=add&pid=253", "https://example.com/cart.php?a=add&pid=253"), "<p>Maintenance</p>"]) {
    assert.throws(() => parseDmitPlans(source, response(html)), /DMIT public catalog/);
  }
});

test("DMIT confirms inventory only from the exact anonymous SKU result", () => {
  const plans = parseDmitPlans(source, catalog);
  const absent = applyDmitSku(plans[0], soldOut).plan;
  assert.equal(absent.status, "unavailable");
  assert.equal(absent.stockCount, null);
  assert.equal(absent.raw.inventoryChecked, true);
  const offered = applyDmitSku(plans[1], configure).plan;
  assert.equal(offered.status, "available");
  assert.equal(offered.priceValue, 1798.8); // Keep the advertised annual billing cycle.
  assert.equal(offered.raw.referencePrice, false);
  assert.match(offered.price, /\/年$/);
  assert.equal(offered.orderUrl, plans[1].orderUrl);
  assert.equal(applyDmitSku(plans[0], response("Order Now", plans[0].orderUrl)).plan.status, "unknown");
  assert.equal(applyDmitSku(plans[0], challenge).plan.status, "unknown");
  assert.equal(applyDmitSku(plans[0], response(configure.html + "Invitation Code", configure.finalUrl)).plan.status, "unknown");
});

test("DMIT fetches published PIDs only and preserves catalog-only sold out cards", async () => {
  const visited = [];
  const result = await collectDmitPlans(source, async (url) => {
    visited.push(url);
    return url === source.url ? catalog : url.includes("pid=253") ? soldOut : configure;
  });
  assert.equal(result.plans.length, 3);
  assert.equal(result.pagesChecked, 3);
  assert.equal(result.skuTotal, 2);
  assert.equal(result.skuChecked, 2);
  assert.equal(result.failedPages, 0);
  assert.deepEqual(result.plans.map((p) => p.status), ["unavailable", "available", "unavailable"]);
  assert.ok(visited.every((url) => !url.includes("checkout")));
});

test("DMIT stops on challenges and keeps remaining inventory unknown with a diagnosis", async () => {
  let calls = 0;
  const result = await collectDmitPlans(source, async () => ++calls === 1 ? catalog : challenge);
  assert.equal(calls, 2);
  assert.equal(result.skuChecked, 1);
  assert.equal(result.failedPages, 1);
  assert.deepEqual(result.plans.slice(0, 2).map((p) => p.status), ["unknown", "unknown"]);
  const records = await monitorDmitCatalog(source, {
    runWorker: async () => result, baseRecord: (s, r, extra) => ({ sourceId: s.id, ...extra }),
    blockedRecord: (s, r, evidence) => ({ status: "blocked", evidence }), errorRecord: (s, e) => ({ status: "error", error: e.message })
  });
  assert.equal(records.length, 4);
  assert.equal(records.at(-1).diagnostic, true);
  assert.equal(records.at(-1).raw.attempts.at(-1).reason, "challenge");
  assert.equal(records[0].collection.failedPages, 1);
});

test("DMIT exposes native worker failure without fabricated inventory", async () => {
  const records = await monitorDmitCatalog(source, { runWorker: async () => { throw Error("native runtime failed"); }, errorRecord: (s, e) => ({ status: "error", error: e.message }) });
  assert.equal(records.length, 1);
  assert.equal(records[0].diagnostic, true);
  assert.match(records[0].error, /native runtime failed/);
});

test("DMIT stops on HTTP 429 without retrying or changing egress", async () => {
  let calls = 0;
  const result = await collectDmitPlans(source, async () => ++calls === 1 ? catalog : { ...challenge, statusCode: 429 });
  assert.equal(calls, 2);
  assert.equal(result.attempts.at(-1).reason, "rate-limited");
  assert.equal(result.plans[0].status, "unknown");
  assert.equal(result.skuChecked, 1);
});

test("DMIT URL boundaries reject credentials, checkout and non-storefront destinations", () => {
  for (const value of ["http://www.dmit.io/pages/pricing", "https://user:pass@www.dmit.io/cart.php", "https://www.dmit.io:8443/cart.php", "https://app.vmiss.com/", "https://www.dmit.io/clientarea.php", "https://www.dmit.io/cart.php?a=checkout", "https://www.dmit.io/cart.php?a=empty", "https://www.dmit.io/cart.php?a=add&pid=1&token=private"]) assert.throws(() => dmitUrl(value));
  assert.equal(dmitUrl("/cart.php?a=confproduct&i=0"), configure.finalUrl);
});
