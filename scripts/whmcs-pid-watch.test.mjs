import assert from "node:assert/strict";
import { test } from "node:test";
import { monitorWhmcsPidWatch, parseWhmcsConfProduct } from "./adapters/whmcs-pid-watch.mjs";

const baseRecord = (source, result, extra) => ({
  sourceId: source.id,
  providerId: source.providerId,
  provider: source.provider,
  sourceUrl: source.url,
  finalUrl: result?.finalUrl ?? source.url,
  httpStatus: result?.statusCode ?? null,
  ...extra
});

const blockedRecord = (source, result, reason) => baseRecord(source, result, { status: "blocked", statusLabel: "被阻断", evidence: reason, error: reason });
const errorRecord = (source, error, extra = {}) => baseRecord(source, null, { status: "error", statusLabel: "抓取失败", evidence: error.message, error: error.message, ...extra });

const source = {
  id: "bwh-limited-pids",
  providerId: "bwh",
  provider: "搬瓦工(BWH)",
  category: "vps",
  adapter: "whmcs_pid_watch",
  url: "https://bandwagonhost.com/cart.php",
  currency: "USD",
  requestIntervalMs: 0,
  plans: [
    { pid: "159", name: "The Amsterdam Plan", region: "荷兰", route: "CN2 GIA / 9929 / CMIN2" },
    { pid: "151", name: "MINIBOX-10-512", region: "美国", route: "CN2 GIA" },
    { pid: "157", name: "MEGABOX-PRO", region: "美国", route: "CN2 GIA / CMIN2" },
    { pid: "999", name: "Retired Plan", region: "美国" }
  ]
};

const confHtml = ({ title, invite = false, price = "$39.00 USD Annually" }) => `
  <html><body>
    <div class="cartbox">
      <strong>VPS - Self-managed - ${title}</strong><br />
      ${invite ? "**Very limited availability - Invite code required**<br />" : "**Limited availability**<br />"}
      SSD: 20 GB RAID-10<br />
      RAM: 1024 MB<br />
      CPU: 1x AMD<br />
      Transfer: 1000 GB/mo<br />
      Link speed: 2.5 Gigabit<br />
      Location: Amsterdam, DC1<br />
    </div>
    <select name="billingcycle"><option value="annually">${price}</option></select>
  </body></html>
`;

test("parseWhmcsConfProduct extracts specs, billing cycle, and invite-only restriction", () => {
  const open = parseWhmcsConfProduct(confHtml({ title: "The Amsterdam Plan" }));
  assert.equal(open.name, "The Amsterdam Plan");
  assert.equal(open.price, "USD 39 Annually");
  assert.equal(open.priceValue, 39);
  assert.equal(open.currency, "USD");
  assert.equal(open.inviteRequired, false);
  assert.match(open.hardware, /1x AMD/);
  assert.match(open.bandwidth, /2\.5 Gigabit/);

  const gated = parseWhmcsConfProduct(confHtml({ title: "MINIBOX-10-512", invite: true, price: "$29.00 USD Annually" }));
  assert.equal(gated.inviteRequired, true);
  assert.equal(gated.priceValue, 29);
});

test("monitorWhmcsPidWatch distinguishes available confproduct, invite-only, out-of-stock, and retired pids", async () => {
  const seenCookies = [];
  const fetchImpl = async (url, options = {}) => {
    const u = new URL(url);
    if (u.searchParams.get("a") === "add") {
      const pid = u.searchParams.get("pid");
      if (pid === "159") {
        return new Response("", { status: 302, headers: { location: "/cart.php?a=confproduct&i=0", "set-cookie": "PHPSESSID=abc159; path=/" } });
      }
      if (pid === "151") {
        return new Response("", { status: 302, headers: { location: "/cart.php?a=confproduct&i=0", "set-cookie": "PHPSESSID=abc151; path=/" } });
      }
      if (pid === "157") {
        return new Response("<html><body><h2>Out of Stock</h2><p>We are currently out of stock on this plan.</p></body></html>", { status: 200 });
      }
      return new Response("", { status: 302, headers: { location: "/cart.php" } });
    }
    if (u.searchParams.get("a") === "confproduct") {
      seenCookies.push(options.headers?.cookie);
      if (options.headers?.cookie === "PHPSESSID=abc159") {
        return new Response(confHtml({ title: "The Amsterdam Plan" }), { status: 200 });
      }
      return new Response(confHtml({ title: "MINIBOX-10-512", invite: true, price: "$29.00 USD Annually" }), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const records = await monitorWhmcsPidWatch(source, {
    waitForRequestSlot: async () => {},
    userAgent: "TestAgent/1.0",
    isAntiBotResult: () => false,
    baseRecord,
    blockedRecord,
    errorRecord,
    fetchImpl
  });

  assert.equal(records.length, 4);
  assert.deepEqual(seenCookies, ["PHPSESSID=abc159", "PHPSESSID=abc151"]);

  const byPid = Object.fromEntries(records.map((r) => [r.raw.pid, r]));
  assert.equal(byPid["159"].status, "available");
  assert.equal(byPid["159"].priceValue, 39);
  assert.equal(byPid["159"].orderUrl, "https://bandwagonhost.com/cart.php?a=add&pid=159");

  assert.equal(byPid["151"].status, "unknown");
  assert.equal(byPid["151"].statusLabel, "需邀请码");
  assert.equal(byPid["151"].priceValue, 29);

  assert.equal(byPid["157"].status, "unavailable");
  assert.equal(byPid["157"].stockCount, 0);
  assert.equal(byPid["157"].priceValue, null);

  assert.equal(byPid["999"].status, "unknown");
  assert.equal(byPid["999"].statusLabel, "入口未开放");
});

test("monitorWhmcsPidWatch stops immediately on Cloudflare/403 challenge without bypassing", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("<html><title>Just a moment...</title></html>", { status: 403 });
  };
  const records = await monitorWhmcsPidWatch(source, {
    waitForRequestSlot: async () => {},
    userAgent: "TestAgent/1.0",
    isAntiBotResult: () => true,
    baseRecord,
    blockedRecord,
    errorRecord,
    fetchImpl
  });
  assert.equal(calls, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].diagnostic, true);
  assert.equal(records[0].status, "blocked");
});

test("configuration-page failures and empty 200 pages never become available plans", async () => {
  for (const [status, body, expected] of [[403, 'Forbidden', 'blocked'], [503, 'Unavailable', 'error'], [200, '<h2>Maintenance</h2>', 'unknown']]) {
    const records = await monitorWhmcsPidWatch({ ...source, plans: source.plans.slice(0, 1) }, {
      waitForRequestSlot: async () => {}, userAgent: 'test', isAntiBotResult: () => false,
      baseRecord, blockedRecord, errorRecord,
      fetchImpl: async (url) => new URL(url).searchParams.get('a') === 'add'
        ? new Response('', { status: 302, headers: { location: '/cart.php?a=confproduct&i=0' } })
        : new Response(body, { status })
    });
    assert.equal(records[0].status, expected);
  }
});

test("stock keywords in scripts and comments do not prove a sellout", async () => {
  const records = await monitorWhmcsPidWatch({ ...source, plans: source.plans.slice(0, 1) }, {
    waitForRequestSlot: async () => {}, userAgent: 'test', isAntiBotResult: () => false,
    baseRecord, blockedRecord, errorRecord,
    fetchImpl: async () => new Response('<script>const message="Out of Stock";</script><!-- Sold Out --><main>Choose a plan</main>')
  });
  assert.equal(records[0].status, 'unknown');
});
