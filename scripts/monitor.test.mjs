import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const monitorPath = fileURLToPath(new URL("./monitor.mjs", import.meta.url));
const sourceUrl = "https://www.aaitr.com/store/srv";
const sitemapUrl = "https://www.aaitr.com/sitemap.xml";
const productHtml = '<div id="products"><div class="card"><h4>Offline VPS</h4><p>Plenty in Stock</p><a href="/cart.php?a=add&pid=1">Order Now</a></div></div>';
const mockFetch = `
import { readFileSync, writeFileSync } from "node:fs";
const routes = JSON.parse(readFileSync("routes.json", "utf8"));
const calls = [];
globalThis.fetch = async (input, options, redirects = 0) => {
  const url = String(input);
  calls.push({ url, redirect: options.redirect });
  writeFileSync("calls.json", JSON.stringify(calls));
  const route = routes[url];
  if (!route) throw new Error("Unexpected offline request: " + url);
  if (route.error) throw new Error(route.error);
  const status = route.status ?? 200;
  if (options.redirect === "follow" && [301, 302, 303, 307, 308].includes(status) && route.location) {
    if (redirects === 20) throw new TypeError("fetch failed: too many redirects");
    return globalThis.fetch(new URL(route.location, url).href, options, redirects + 1);
  }
  const response = new Response(route.body ?? "", {
    status,
    headers: route.location ? { location: route.location } : {}
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
};
`;

function runMonitor(routes, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "resnode-monitor-test-"));
  try {
    mkdirSync(join(dir, "monitor"));
    writeFileSync(join(dir, "monitor/sources.json"), JSON.stringify([{
      id: "offline-aaitr",
      provider: "AaITR",
      category: "home",
      adapter: "aaitr_store",
      url: sourceUrl,
      browserProbe: { enabled: false },
      readerSnapshot: { enabled: false },
      ...overrides
    }]));
    writeFileSync(join(dir, "routes.json"), JSON.stringify(routes));
    writeFileSync(join(dir, "calls.json"), "[]");
    writeFileSync(join(dir, "mock-fetch.mjs"), mockFetch);
    execFileSync(process.execPath, ["--import", join(dir, "mock-fetch.mjs"), monitorPath], {
      cwd: dir,
      env: { ...process.env, MONITOR_FETCH_RETRIES: "0", MONITOR_CONCURRENCY: "1" }
    });
    return {
      products: JSON.parse(readFileSync(join(dir, "data/products.json"), "utf8")).products,
      calls: JSON.parse(readFileSync(join(dir, "calls.json"), "utf8"))
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const unsafeUrls = [
  "https://aaitr.com.evil.com/store/phish",
  "https://www.aaitr.com.evil.com/store/phish",
  "https://aaitr.com@evil.com/store/phish",
  "http://aaitr.com@127.0.0.1/store/latest/meta-data",
  "https://reader@aaitr.com/store/phish",
  "https://reader:password@www.aaitr.com/store/phish",
  "//evil.com/store/phish",
  "ftp://aaitr.com/store/phish"
];

for (const url of unsafeUrls) {
  test(`discovery rejects ${url}`, () => {
    const { products, calls } = runMonitor({
      [sourceUrl]: { body: "No product cards" },
      [sitemapUrl]: { body: `<loc>${url}</loc>` },
      [url]: { body: productHtml }
    }, { discoveryUrls: [sitemapUrl] });
    assert.deepEqual(calls.map((call) => call.url), [sourceUrl, sitemapUrl]);
    assert.equal(products[0].status, "error");
    assert.equal(products[0].raw.attempts.at(-1).note, "0 AaITR URL(s) found");
  });
}

for (const candidate of [
  "https://aaitr.com/store/valid",
  "http://www.aaitr.com/store/valid",
  "HTTPS://AAITR.COM/store/valid",
  "//aaitr.com/store/valid",
  "/store/valid",
  "/cart.php?gid=7"
]) {
  test(`discovery accepts ${candidate}`, () => {
    const resolved = new URL(candidate, sitemapUrl).href;
    const { products, calls } = runMonitor({
      [sourceUrl]: { body: "No product cards" },
      [sitemapUrl]: { body: `<loc>${candidate}</loc>\n<loc>${candidate}</loc>` },
      [resolved]: { body: productHtml }
    }, { discoveryUrls: [sitemapUrl] });
    assert.deepEqual(calls.map((call) => call.url), [sourceUrl, sitemapUrl, resolved]);
    assert.equal(products[0].status, "available");
    assert.equal(products[0].raw.strategy, "discovered_http");
    assert.equal(products[0].orderUrl, new URL("/cart.php?a=add&pid=1", resolved).href);
  });
}

for (const location of unsafeUrls) {
  test(`direct HTTP rejects redirect to ${location}`, () => {
    const { products, calls } = runMonitor({
      [sourceUrl]: { status: 302, location },
      [new URL(location, sourceUrl).href]: { body: productHtml }
    });
    assert.deepEqual(calls.map((call) => call.url), [sourceUrl]);
    assert.equal(products[0].status, "error");
    assert.equal(products[0].raw.attempts[0].outcome, "error");
    assert.match(products[0].raw.attempts[0].error, /AaITR URL/);
  });
}

test("official redirects resolve relative paths and both allowed hostnames", () => {
  const relativeUrl = "https://www.aaitr.com/store/relative";
  const finalUrl = "http://aaitr.com/store/final";
  const { products, calls } = runMonitor({
    [sourceUrl]: { status: 301, location: "/store/relative" },
    [relativeUrl]: { status: 307, location: finalUrl },
    [finalUrl]: { body: productHtml }
  });
  assert.deepEqual(calls.map((call) => call.url), [sourceUrl, relativeUrl, finalUrl]);
  assert.equal(products[0].status, "available");
  assert.equal(products[0].finalUrl, finalUrl);
  assert.equal(products[0].orderUrl, "http://aaitr.com/cart.php?a=add&pid=1");
});

test("a later redirect cannot leave an allowed hostname", () => {
  const nextUrl = "https://aaitr.com/store/next";
  const offHost = "https://evil.com/store/phish";
  const { products, calls } = runMonitor({
    [sourceUrl]: { status: 303, location: nextUrl },
    [nextUrl]: { status: 302, location: offHost },
    [offHost]: { body: productHtml }
  });
  assert.deepEqual(calls.map((call) => call.url), [sourceUrl, nextUrl]);
  assert.equal(products[0].status, "error");
  assert.match(products[0].raw.attempts[0].error, /AaITR URL/);
});

test("invalid configured official URLs fail before making any request", () => {
  for (const url of ["https://evil.com/store/phish", "https://reader@aaitr.com/store/phish", "not a URL"]) {
    const { products, calls } = runMonitor({ [url]: { body: productHtml } }, { url });
    assert.deepEqual(calls, []);
    assert.equal(products[0].status, "error");
    assert.equal(products[0].raw.attempts[0].outcome, "error");
    assert.match(products[0].raw.attempts[0].error, /URL/);
  }
});

test("discovery does not read a sitemap redirected off the allowed hosts", () => {
  const offHost = "https://evil.com/sitemap.xml";
  const { products, calls } = runMonitor({
    [sourceUrl]: { body: "No product cards" },
    [sitemapUrl]: { status: 308, location: offHost },
    [offHost]: { body: "https://aaitr.com/store/injected" },
    "https://aaitr.com/store/injected": { body: productHtml }
  }, { discoveryUrls: [sitemapUrl] });
  assert.deepEqual(calls.map((call) => call.url), [sourceUrl, sitemapUrl]);
  assert.equal(products[0].status, "error");
  assert.equal(products[0].raw.attempts.at(-1).outcome, "error");
  assert.match(products[0].raw.attempts.at(-1).error, /AaITR URL/);
});

test("official redirect loops retain a bounded error", () => {
  const { products, calls } = runMonitor({ [sourceUrl]: { status: 302, location: sourceUrl } });
  assert.equal(calls.length, 21);
  assert.equal(products[0].status, "error");
  assert.match(products[0].raw.attempts[0].error, /redirect/i);
});

test("transport and HTTP failures keep their existing attempt evidence", () => {
  const failed = runMonitor({ [sourceUrl]: { error: "Offline transport failure" } });
  assert.equal(failed.products[0].status, "error");
  assert.equal(failed.products[0].raw.attempts[0].error, "Offline transport failure");
  const unavailable = runMonitor({ [sourceUrl]: { status: 503, body: "Unavailable" } });
  assert.equal(unavailable.products[0].raw.attempts[0].outcome, "http_error");
  assert.equal(unavailable.products[0].raw.attempts[0].httpStatus, 503);
});

test("Reader requests keep the separate third-party acquisition path", () => {
  const readerUrl = `https://r.jina.ai/${sourceUrl}`;
  const { products, calls } = runMonitor({
    [sourceUrl]: { body: "No product cards" },
    [readerUrl]: { status: 503 }
  }, { readerSnapshot: { enabled: true, urls: [sourceUrl] } });
  assert.equal(calls.at(-1).url, readerUrl);
  assert.equal(calls.at(-1).redirect, "follow");
  assert.equal(products[0].raw.attempts.at(-1).strategy, "reader_snapshot");
  assert.equal(products[0].raw.attempts.at(-1).outcome, "http_error");
});

test("other provider adapters keep automatic redirects", () => {
  const finalUrl = "https://other-provider.com/catalog";
  const { products, calls } = runMonitor({
    [sourceUrl]: { status: 302, location: finalUrl },
    [finalUrl]: { body: productHtml }
  }, { adapter: "whmcs_group", provider: "Offline provider" });
  assert.equal(calls[0].redirect, "follow");
  assert.equal(products[0].status, "available");
  assert.equal(products[0].finalUrl, finalUrl);
});


const englishFeatures = {
  CPU: "1vCPU (Opt)", RAM: "512MB (Opt)", Disk: "8GB SSD (Fixed)",
  Bandwidth: "100Mbps Peak (Opt)", Traffic: "1000GB (In+Out) (Fixed)",
  "Port Forwarding": "Free (10 Ports)", Location: "USA, CA (Residential)"
};
const chineseFeatures = {
  CPU: "2vCPU", 内存: "1GB", 硬盘: "16GB SSD", 带宽: "50Mbps",
  流量: "500GB", 转发: "10 ports", 位置: "日本 东京"
};
for (const strategy of ["official", "reader"]) {
  for (const [locale, features, expected] of [
    ["English", englishFeatures, ["1vCPU (Opt) / 512MB (Opt) / 8GB SSD (Fixed)", "100Mbps Peak (Opt) / 1000GB (In+Out) (Fixed) / Free (10 Ports)", "USA, CA (Residential)"]],
    ["Chinese", chineseFeatures, ["2vCPU / 1GB / 16GB SSD", "50Mbps / 500GB / 10 ports", "日本 东京"]],
    ["mixed keys prefer existing Chinese values", { ...englishFeatures, ...chineseFeatures }, ["2vCPU / 1GB / 16GB SSD", "50Mbps / 500GB / 10 ports", "日本 东京"]],
    ["missing fields preserve hints", { CPU: "1vCPU" }, ["1vCPU", "", "fallback region"]]
  ]) {
    test(`AaITR ${strategy} normalizes ${locale}`, () => {
      const lines = Object.entries(features).map(([key, value]) => `${key}: ${value}`);
      const readerUrl = `https://r.jina.ai/${sourceUrl}`;
      const routes = strategy === "official" ? {
        [sourceUrl]: { body: `<div id="products"><div class="card"><h4>Offline VPS</h4><p>Plenty in Stock</p>${lines.map((line) => `<p>${line}</p>`).join("")}<a href="/cart.php?a=add&pid=1">Order Now</a></div></div>` }
      } : {
        [sourceUrl]: { body: "No product cards" },
        [readerUrl]: { body: `Markdown Content:\nOffline VPS Plenty in Stock\n${lines.join("\n")}` }
      };
      const { products, calls } = runMonitor(routes, {
        regionHint: "fallback region",
        readerSnapshot: { enabled: strategy === "reader", urls: [sourceUrl] }
      });
      assert.equal(products.length, 1);
      const record = products[0];
      assert.deepEqual([record.hardware, record.bandwidth, record.region], expected);
      assert.deepEqual(record.raw.features, features);
      assert.equal(record.status, "available");
      assert.equal(record.stockCount, null);
      assert.equal(record.raw.strategy, strategy === "reader" ? "reader_snapshot" : "direct_http");
      assert.deepEqual(calls.map((call) => call.url), strategy === "reader" ? [sourceUrl, readerUrl] : [sourceUrl]);
      if (strategy === "reader") {
        assert.match(record.note, /第三方 Reader 快照/);
        assert.match(record.statusLabel, /^快照:/);
      }
    });
  }
}
