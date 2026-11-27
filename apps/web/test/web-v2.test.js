import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { formatSnapshotId, projectToCompact } from "@resnode-radar/contracts";
import AnnouncementsCard from "../src/components/radar/AnnouncementsCard.vue";
import { mountApp } from "../src/main.js";
import { mountReviewDossier } from "../src/review-main.js";
import { loadRadarSnapshot } from "../src/services/snapshot-client.js";

function makeCompactBundle(payload, observationsByProduct = new Map()) {
  const v1Sha256 = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const snapshotId = formatSnapshotId(payload.generatedAt, v1Sha256);
  const { snapshot, audits } = projectToCompact(payload, {
    v1Sha256,
    snapshotId,
    observationsByProduct
  });
  const pointer = {
    schemaVersion: 2,
    dictVersion: 1,
    mode: "v2",
    snapshotId,
    v1Sha256,
    generatedAt: payload.generatedAt,
    publishedAt: payload.publishedAt || payload.generatedAt,
    snapshotPath: `data/snapshots/${snapshotId}/snapshot.json`,
    auditDirPath: `data/snapshots/${snapshotId}/audit`
  };
  return { snapshotId, v1Sha256, pointer, snapshot, audits };
}

function makeBasePayload(now = Date.now()) {
  const generatedAt = new Date(now - 5 * 60_000).toISOString();
  const fxDate = new Date(now).toISOString().slice(0, 10);
  return {
    schemaVersion: 1,
    generatedAt,
    sourceCount: 4,
    summary: { total: 4, available: 2, unavailable: 0, unknown: 1, blocked: 1, error: 0 },
    eventTracking: {
      startedAt: new Date(now - 86_400_000).toISOString(),
      retentionDays: 7,
      limit: 300
    },
    exchangeRates: {
      base: "CNY",
      date: fxDate,
      rates: { CNY: 1, USD: 7.0, EUR: 7.6 }
    },
    events: [
      {
        id: "ev-1",
        type: "restock",
        at: new Date(now - 25 * 60_000).toISOString(),
        productId: "home-att",
        providerId: "usvps24",
        provider: "USVPS24(干杯Cloud)",
        name: "加州 AT&T 双ISP 家宽",
        region: "美国",
        price: "$20/month",
        priceValue: 20,
        currency: "USD",
        stockCount: 4,
        orderUrl: "https://usvps24.com/order/1"
      },
      {
        id: "ev-2",
        type: "price",
        at: new Date(now - 80 * 60_000).toISOString(),
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
      },
      {
        id: "ev-offline",
        type: "soldout",
        at: new Date(now - 120 * 60_000).toISOString(),
        productId: "removed-sku",
        providerId: "dmit",
        provider: "DMIT",
        name: "HKG.Pro.Archived",
        region: "香港",
        price: "$39.9/month",
        priceValue: 39.9,
        currency: "USD",
        stockCount: 0,
        orderUrl: ""
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
        fetchedAt: generatedAt,
        region: "美国",
        route: "AT&T 双 ISP 住宅 IP",
        name: "加州 AT&T 双ISP 家宽",
        hardware: "2 vCPU / 4 GB RAM / 40 GB NVMe",
        bandwidth: "500 Mbps / 2 TB",
        price: "$20/month",
        priceValue: 20,
        currency: "USD",
        status: "available",
        statusLabel: "库存 4",
        stockCount: 4,
        orderUrl: "https://usvps24.com/order/1",
        evidence: "Official API stock=4",
        evidenceLevel: { value: "stock-count", label: "精确库存 4", className: "is-count", rank: 1 },
        riskTags: [{ value: "no-extra-risk", label: "未见额外风险", severity: "low" }],
        raw: {
          features: { ASN: "AS7018 AT&T" },
          attempts: [{ strategy: "direct", statusCode: 200, ok: true, url: "https://usvps24.com/api" }]
        }
      },
      {
        id: "dc-native",
        sourceId: "zoro",
        providerId: "zorocloud",
        provider: "ZoroCloud",
        category: "vps",
        adapter: "whmcs_group",
        sourceUrl: "https://my.zorocloud.com/",
        fetchedAt: generatedAt,
        region: "日本东京",
        route: "电信 CN2 GIA 原生 IP",
        name: "JP-CN2-Starter",
        hardware: "2 vCPU / 2 GB RAM / 30 GB SSD",
        bandwidth: "200 Mbps / 1 TB",
        price: "¥39/月",
        priceValue: 39,
        currency: "CNY",
        status: "available",
        statusLabel: "可订购",
        stockCount: null,
        orderUrl: "https://my.zorocloud.com/order/jp",
        evidence: "WHMCS cart button",
        evidenceLevel: { value: "official-order", label: "官方订购入口", className: "is-order", rank: 2 },
        riskTags: [{ value: "no-extra-risk", label: "未见额外风险", severity: "low" }]
      },
      {
        id: "bwh-ams-hit",
        sourceId: "bwh-limited-pids",
        providerId: "bwh",
        provider: "搬瓦工(BWH)",
        category: "vps",
        adapter: "whmcs_pid",
        sourceUrl: "https://bwh81.net/",
        fetchedAt: generatedAt,
        region: "荷兰阿姆斯特丹",
        route: "CN2 GIA / 9929 / CMIN2",
        name: "The Amsterdam Plan",
        hardware: "1 vCPU / 1 GB RAM / 20 GB SSD",
        bandwidth: "2.5 Gbps / 1000 GB",
        price: "$39/year",
        priceValue: 39,
        currency: "USD",
        status: "available",
        statusLabel: "可订购",
        stockCount: null,
        orderUrl: "https://bwh81.net/cart.php?a=add&pid=151",
        evidence: "PID 151 available",
        evidenceLevel: { value: "official-order", label: "官方订购入口", className: "is-order", rank: 2 },
        riskTags: [{ value: "no-extra-risk", label: "未见额外风险", severity: "low" }]
      },
      {
        id: "diag-dmit",
        sourceId: "dmit-main",
        providerId: "dmit",
        provider: "DMIT",
        category: "vps",
        adapter: "whmcs_group",
        sourceUrl: "https://www.dmit.io/",
        fetchedAt: generatedAt,
        region: "美国",
        route: "",
        name: "DMIT 官方源抓取诊断",
        hardware: "",
        bandwidth: "",
        price: "",
        priceValue: null,
        currency: "",
        status: "blocked",
        statusLabel: "直连受阻",
        stockCount: null,
        diagnostic: true,
        httpStatus: 403,
        evidence: "Cloudflare challenge",
        evidenceLevel: { value: "blocked", label: "直连受阻", className: "is-blocked", rank: 5 },
        riskTags: [{ value: "waf-blocked", label: "官方源受阻", severity: "high" }],
        raw: {
          attempts: [
            {
              strategy: "direct",
              statusCode: 403,
              ok: false,
              url: 'https://www.dmit.io/cart.php?x=<script>alert(1)</script>'
            }
          ]
        }
      }
    ]
  };
}

function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => {
      map.set(String(k), String(v));
    },
    removeItem: (k) => {
      map.delete(String(k));
    },
    clear: () => {
      map.clear();
    }
  };
}

function ensureWebStorage() {
  if (typeof window.localStorage?.clear !== "function") {
    const ls = makeMemoryStorage();
    Object.defineProperty(window, "localStorage", { configurable: true, writable: true, value: ls });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: ls });
  } else {
    window.localStorage.clear();
  }
  if (typeof window.sessionStorage?.clear !== "function") {
    const ss = makeMemoryStorage();
    Object.defineProperty(window, "sessionStorage", { configurable: true, writable: true, value: ss });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, writable: true, value: ss });
  } else {
    window.sessionStorage.clear();
  }
}

function setupHostDom(pathAndQuery = "/") {
  globalThis.__RADAR_DISABLE_AUTO_MOUNT__ = true;
  ensureWebStorage();
  window.innerWidth = 1440;
  window.innerHeight = 900;
  const rel = pathAndQuery.startsWith("http")
    ? new URL(pathAndQuery).pathname + new URL(pathAndQuery).search
    : pathAndQuery;
  window.history.replaceState(null, "", rel);
  document.head.innerHTML = `<meta name="radar-base" content="./" />`;
  document.body.className = "";
  document.body.innerHTML = `<div id="app" data-app-root></div>`;
  return document.querySelector("[data-app-root]");
}

async function flushUi(app = null) {
  if (app?.refresh) {
    await app.refresh(false);
  }
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

const activeApps = [];
afterEach(() => {
  while (activeApps.length) {
    activeApps.pop().dispose();
  }
  vi.restoreAllMocks();
});

describe("AnnouncementsCard XSS & rendering guarantees", () => {
  it("escapes hostile titles, strips javascript: URLs, and renders baseline/soldout badges", () => {
    const at = "2026-11-24T10:00:00.000Z";
    const items = [
      {
        id: "xss",
        title: '<img src=x onerror="alert(1)">',
        url: "javascript:alert(1)",
        source: "Official Feed",
        trust: "official",
        firstSeenAt: at,
        baseline: true,
        candidates: [
          {
            provider: "Vendor",
            url: "https://vendor.example/cart.php?pid=42",
            verification: { state: "verified", status: "unavailable", checkedAt: at }
          }
        ]
      },
      ...Array.from({ length: 48 }, (_, i) => ({
        id: `ann-${i}`,
        title: `Announcement ${i}`,
        url: `https://news.example/${i}`,
        source: "Official Feed",
        firstSeenAt: at,
        candidates: []
      }))
    ];
    const wrapper = mount(AnnouncementsCard, {
      props: {
        feed: {
          sources: [{ id: "s1", name: "Official Feed", status: "ok", checkedAt: at }],
          items
        }
      }
    });

    const html = wrapper.html();
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(wrapper.text()).toContain("售罄");
    expect(wrapper.text()).toContain("首次导入");
    expect(wrapper.text()).toContain("Announcement 47");
    wrapper.unmount();
  });
});

describe("Vue 3 Workbench + Dual-Protocol v2 Snapshot Architecture", () => {
  it("loads v2 CompactSnapshot via /api/v1/pulse, skips unchanged polls, lazy-loads Inspector audit, and recovers on 404 AUDIT_EXPIRED", async () => {
    setupHostDom("https://vpsld.com/");
    const now = Date.parse("2026-11-25T12:00:00.000Z");
    const v1PayloadA = makeBasePayload(now);
    const {
      snapshotId: snapIdA,
      pointer: pointerA,
      snapshot: compactA,
      audits: auditsA
    } = makeCompactBundle(
      v1PayloadA,
      new Map([
        ["home-att", [{ at: v1PayloadA.generatedAt, status: "available", stockCount: 4, price: "$20/month" }]]
      ])
    );

    const v1PayloadB = makeBasePayload(now + 60_000);
    v1PayloadB.products[0].stockCount = 2;
    v1PayloadB.products[0].statusLabel = "库存 2";
    const {
      snapshotId: snapIdB,
      pointer: pointerB,
      snapshot: compactB,
      audits: auditsB
    } = makeCompactBundle(v1PayloadB);

    let currentSnap = snapIdA;
    let expireAuditA = false;
    const fetchedUrls = [];
    const statsCalls = [];
    let recordedPv = 1520;
    let recordedUv = 410;

    const fetchMock = vi.fn(async (url, init = {}) => {
      const u = String(url);
      fetchedUrls.push(u);
      if (u.endsWith("/api/v1/stats")) {
        const method = (init?.method || "GET").toUpperCase();
        statsCalls.push(method);
        if (method === "POST") {
          recordedPv += 1;
          recordedUv += 1;
        }
        return Response.json({
          schemaVersion: 1,
          day: "2026-11-25",
          todayPv: recordedPv,
          todayUv: recordedUv,
          totalPv: 25000 + (recordedPv - 1520),
          totalUv: 6800 + (recordedUv - 410)
        });
      }
      if (u.endsWith("/api/v1/pulse")) {
        const activePointer = currentSnap === snapIdA ? pointerA : pointerB;
        return Response.json({
          ...activePointer,
          stats: {
            schemaVersion: 1,
            day: "2026-11-25",
            todayPv: recordedPv,
            todayUv: recordedUv,
            totalPv: 25000,
            totalUv: 6800
          }
        });
      }
      if (u.endsWith(`/${snapIdA}/snapshot.json`)) return Response.json(compactA);
      if (u.endsWith(`/${snapIdB}/snapshot.json`)) return Response.json(compactB);
      if (u.endsWith(`/${snapIdA}/audit/usvps24.json`)) {
        if (expireAuditA) return new Response("Not Found", { status: 404 });
        return Response.json(auditsA.get("usvps24"));
      }
      if (u.endsWith(`/${snapIdB}/audit/usvps24.json`)) {
        return Response.json(auditsB.get("usvps24"));
      }
      if (u.endsWith(`/${snapIdB}/audit/bwh-limited-pids.json`)) {
        return Response.json(auditsB.get("bwh-limited-pids"));
      }
      return new Response("Not Found", { status: 404 });
    });

    const app = mountApp({
      fetchImpl: fetchMock,
      initialNowMs: now
    });
    activeApps.push(app);
    await flushUi(app);

    expect(app.store.state.protocolMode).toBe("v2");
    expect(app.store.state.snapshotId).toBe(snapIdA);
    // Even though /api/v1/pulse returned stats, a brand-new session MUST still send 1 POST to /api/v1/stats!
    expect(statsCalls).toEqual(["POST"]);
    expect(document.querySelector("[data-stat-visits]")?.textContent).toBe("1521");
    expect(document.querySelectorAll(".terminal-table tr[data-product-id]").length).toBe(3);

    // Bidirectional viewport resize across 860px breakpoint (1440 -> 390 -> 720 -> 1440) switches table <-> cards reactively!
    window.innerWidth = 390;
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    expect(document.querySelector(".terminal-table")).toBeNull();
    expect(document.querySelectorAll(".plan-card[data-product-id]").length).toBe(3);

    window.innerWidth = 720;
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    expect(document.querySelector(".terminal-table")).toBeNull();
    expect(document.querySelectorAll(".plan-card[data-product-id]").length).toBe(3);

    window.innerWidth = 1440;
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    expect(document.querySelectorAll(".terminal-table tr[data-product-id]").length).toBe(3);
    expect(document.querySelectorAll(".plan-card[data-product-id]").length).toBe(0);

    // Unchanged snapshotId on poll must NOT re-download snapshot.json!
    const countBeforePoll = fetchedUrls.filter((u) => u.endsWith("/snapshot.json")).length;
    expect(countBeforePoll).toBe(1);
    await app.refresh(false);
    expect(fetchedUrls.filter((u) => u.endsWith("/snapshot.json")).length).toBe(1);

    // Opening Inspector lazy-loads per-source audit shard (HTTP attempts + observations)
    document.querySelector("tr[data-product-id='home-att']").click();
    await flushUi();
    expect(document.querySelector("[data-inspector-backdrop]")?.hidden).toBe(false);
    expect(document.querySelector("[data-inspector-attempts]")?.textContent).toContain("HTTP 200 OK");
    expect(document.querySelector("[data-inspector-observations]")?.textContent).toContain("(余 4)");

    // Close inspector, simulate server advancing to snapIdB and GC'ing snapIdA's uncached audit shard
    document.querySelector("[data-action='close-inspector']").click();
    await flushUi();
    currentSnap = snapIdB;
    expireAuditA = true;

    // Inspecting bwh-ams-hit (uncached shard) when snapIdA expired (404) triggers coordinated full refresh to snapIdB!
    fetchMock.mockImplementationOnce(async (url) => {
      fetchedUrls.push(String(url));
      return new Response("Not Found", { status: 404 });
    });
    document.querySelector("tr[data-product-id='bwh-ams-hit']").click();
    await flushUi();
    await flushUi(app);

    expect(app.store.state.snapshotId).toBe(snapIdB);
    expect(document.querySelector("tr[data-product-id='home-att']")?.textContent).toContain("余 2");

    // Incompatible dictVersion or unknown mode in pulse/latest MUST fail closed (code: "SCHEMA") EVEN WHEN snapshotId === currentSnapshotId!
    for (const badPointer of [
      { ...pointerB, dictVersion: 99 },
      { ...pointerB, mode: "future-mode" },
      { ...pointerB, schemaVersion: 99 }
    ]) {
      await expect(
        loadRadarSnapshot({
          currentSnapshotId: snapIdB,
          fetchImpl: async (url) =>
            String(url).endsWith("/api/v1/pulse")
              ? Response.json(badPointer)
              : new Response("Not Found", { status: 404 })
        })
      ).rejects.toMatchObject({ code: "SCHEMA" });

      await expect(
        loadRadarSnapshot({
          currentSnapshotId: snapIdB,
          fetchImpl: async (url) =>
            String(url).endsWith("/api/v1/pulse")
              ? new Response("Unavailable", { status: 503 })
              : Response.json(badPointer)
        })
      ).rejects.toMatchObject({ code: "SCHEMA" });
    }

    fetchMock.mockImplementationOnce(async () => Response.json({ ...pointerB, dictVersion: 99 }));
    await app.refresh(false);
    expect(app.store.state.errorDetail?.code).toBe("SCHEMA");

    // Re-mounting within the same sessionStorage on the same day must NOT issue a duplicate POST hit!
    app.dispose();
    activeApps.pop();
    document.body.innerHTML = `<div id="app" data-app-root></div>`;
    const appReloaded = mountApp({
      fetchImpl: fetchMock,
      initialNowMs: now
    });
    activeApps.push(appReloaded);
    await flushUi(appReloaded);
    expect(statsCalls.filter((m) => m === "POST").length).toBe(1);
  });

  it("falls back to latest.json on /api/v1/pulse 503 and honors rollback mode: v1-fallback to data/products.json", async () => {
    setupHostDom("https://vpsld.com/");
    const now = Date.parse("2026-11-25T12:00:00.000Z");
    const v1Payload = makeBasePayload(now);
    const { snapshotId: snapId, pointer: validPointer, snapshot: compact } = makeCompactBundle(v1Payload);

    let rollbackActive = false;
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/api/v1/pulse")) {
        return new Response("Bad Gateway", { status: 503 });
      }
      if (u.endsWith("/data/v2/latest.json")) {
        if (rollbackActive) {
          return Response.json({
            schemaVersion: 2,
            mode: "v1-fallback",
            updatedAt: new Date(now + 120_000).toISOString(),
            fallbackPath: "data/products.json"
          });
        }
        return Response.json(validPointer);
      }
      if (u.endsWith(`/${snapId}/snapshot.json`)) {
        return Response.json(compact);
      }
      if (u.endsWith("/data/products.json")) {
        const rolled = makeBasePayload(now + 120_000);
        rolled.products[0].name = "Rollback V1 Verified Plan";
        return Response.json(rolled);
      }
      return new Response("Not Found", { status: 404 });
    });

    const app = mountApp({ fetchImpl: fetchMock, initialNowMs: now, statsEndpoint: "" });
    activeApps.push(app);
    await flushUi(app);

    expect(app.store.state.protocolMode).toBe("v2");
    expect(document.body.textContent).toContain("加州 AT&T 双ISP 家宽");

    // Flip latest.json to v1-fallback -> already-open v2 tab switches cleanly to data/products.json!
    rollbackActive = true;
    await app.refresh(false);
    await flushUi(app);

    expect(app.store.state.protocolMode).toBe("v1");
    expect(document.body.textContent).toContain("Rollback V1 Verified Plan");
  });

  it("re-evaluates 7-day ECB FX expiration immediately via tickClock even when snapshotId never changes", async () => {
    setupHostDom("https://vpsld.com/");
    const day0 = Date.parse("2026-11-20T12:00:00.000Z");
    const payload = makeBasePayload(day0);
    payload.exchangeRates.date = "2026-11-20";

    const app = mountApp({
      endpoint: "data/products.json",
      fetchImpl: async () => Response.json(payload),
      initialNowMs: day0,
      statsEndpoint: ""
    });
    activeApps.push(app);
    await flushUi(app);

    // Initially FX is fresh -> USD $20/month converts to ￥140/月
    expect(document.querySelector("tr[data-product-id='home-att']")?.textContent).toContain("折合");
    expect(document.querySelector("[data-status-banner]")).toBeNull();

    // Advance reactive clock past 7-day FX expiration without changing snapshotId!
    const day9 = Date.parse("2026-11-29T01:00:00.000Z");
    app.store.tickClock(day9);
    await nextTick();

    expect(document.querySelector("[data-status-banner]")?.textContent).toContain("已超 7 天有效期");
    expect(document.querySelector("tr[data-product-id='home-att']")?.textContent).not.toContain("折合 ￥140");

    // Also verify when an in-flight snapshot fetch crosses the 7-day FX expiration boundary BEFORE committing!
    app.dispose();
    activeApps.pop();
    setupHostDom("https://vpsld.com/");
    let resolveInFlightFetch = null;
    const appInFlight = mountApp({
      endpoint: "data/products.json",
      fetchImpl: () =>
        new Promise((resolve) => {
          resolveInFlightFetch = () => resolve(Response.json(payload));
        }),
      initialNowMs: day0,
      statsEndpoint: ""
    });
    activeApps.push(appInFlight);
    await Promise.resolve();
    // Advance clock past 7-day FX boundary WHILE initial snapshot request is still awaiting network response!
    appInFlight.store.tickClock(day9);
    resolveInFlightFetch();
    await flushUi(appInFlight);

    expect(document.querySelector("[data-status-banner]")?.textContent).toContain("已超 7 天有效期");
    expect(document.querySelector("tr[data-product-id='home-att']")?.textContent).not.toContain("折合 ￥140");
    // Subsequent tickClock must remain fused
    appInFlight.store.tickClock(day9 + 30_000);
    await nextTick();
    expect(document.querySelector("tr[data-product-id='home-att']")?.textContent).not.toContain("折合 ￥140");
  });

  it("preserves track isolation, zero-result relaxation, shop & deal tags, URL sync, command palette, compare, watchlist, and [data-tag-hud] a11y/XSS", async () => {
    setupHostDom("https://vpsld.com/?cmp=nonexistent-key&compareOpen=1");
    const now = Date.parse("2026-11-25T12:00:00.000Z");
    const payload = makeBasePayload(now);
    // Inject hostile tag text probe via product name to verify [data-tag-hud] never executes HTML
    payload.products.push({
      ...payload.products[1],
      id: "dpnet-big",
      providerId: "dpnet",
      provider: "DPNET",
      name: "DPNET 2C4G Unlimited",
      region: "德国",
      route: "BGP",
      hardware: "2 vCPU / 4 GB RAM / 50 GB SSD",
      bandwidth: "1000 Mbps / Unlimited",
      price: "$2.00/month",
      priceValue: 2.0,
      currency: "USD"
    });

    const app = mountApp({
      endpoint: "data/products.json",
      fetchImpl: async () => Response.json(payload),
      initialNowMs: now,
      statsEndpoint: ""
    });
    activeApps.push(app);
    await flushUi();

    // Invalid ?cmp= deep link must NOT leave body.scroll-locked
    expect(document.body.classList.contains("scroll-locked")).toBe(false);

    // Track isolation: "home" shows AT&T residential and excludes ZoroCloud DC native IP
    document.querySelector("[data-filter-dock] [data-action='set-track'][data-track='home']").click();
    await nextTick();
    expect(window.location.href).toContain("track=home");
    expect(document.querySelector("tr[data-product-id='home-att']")).not.toBeNull();
    expect(document.querySelector("tr[data-product-id='dc-native']")).toBeNull();

    // Mutually exclusive filter -> zero results + 1-click relaxation
    document.querySelector("[data-filter-dock] [data-action='set-route'][data-route='cn2']").click();
    await nextTick();
    expect(document.querySelector("[data-zero-results]")).not.toBeNull();
    document.querySelector("[data-action='apply-relaxation']").click();
    await nextTick();
    expect(document.querySelector("[data-zero-results]")).toBeNull();

    app.store.resetFilters();
    await nextTick();

    // Inline .plan-tag click filters ?deal=blockbuster WITHOUT opening Inspector drawer!
    const inlinePlanTag = document.querySelector(
      "tr[data-product-id='bwh-ams-hit'] .plan-tag[data-action='set-deal']"
    );
    expect(inlinePlanTag?.textContent?.trim()).toBe("爆款");
    inlinePlanTag.click();
    await nextTick();
    expect(window.location.href).toContain("deal=blockbuster");
    expect(document.querySelector("[data-inspector-backdrop]")?.hidden).toBe(true);
    inlinePlanTag.click();
    await nextTick();
    expect(window.location.href).not.toContain("deal=blockbuster");

    // Save + Compare + URL sync (?cmp= uses savedKey _key, ?inspect= uses product.id)
    document.querySelector("tr[data-product-id='bwh-ams-hit'] [data-action='toggle-save']").click();
    document.querySelector("tr[data-product-id='bwh-ams-hit'] [data-action='toggle-compare']").click();
    document.querySelector("tr[data-product-id='dpnet-big'] [data-action='toggle-compare']").click();
    await nextTick();
    expect(document.querySelector("[data-saved-count]")?.textContent).toBe("1");
    expect(window.location.href).toContain("cmp=");

    document.querySelector("[data-action='open-compare']").click();
    await nextTick();
    expect(document.querySelector("[data-compare-modal]")?.textContent).toContain("商品亮点标签");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(document.querySelector("[data-compare-modal]")?.hidden).toBe(true);

    // [data-tag-hud] keyboard focusin / Escape / XSS safety / dispose cleanup
    const hud = document.querySelector("[data-tag-hud]");
    expect(hud.hidden).toBe(true);
    const hostileTipEl = document.querySelector(
      "tr[data-product-id='bwh-ams-hit'] .plan-tag[data-action='set-deal']"
    );
    hostileTipEl.setAttribute("data-tag-tip-reason", '<img src=x onerror="window.__xss=1">');
    hostileTipEl.focus();
    hostileTipEl.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await flushUi();
    expect(hud.hidden).toBe(false);
    expect(hostileTipEl.getAttribute("aria-describedby")).toContain("radar-tag-hud");
    expect(hud.querySelector("img")).toBeNull();
    expect(hud.textContent).toContain('<img src=x onerror="window.__xss=1">');

    // Resizing viewport from 1440px -> 390px while HUD is open near right edge must re-clamp HUD left inside 390px!
    hostileTipEl.getBoundingClientRect = () => ({
      top: 160,
      bottom: 182,
      left: 1260,
      right: 1320,
      width: 60,
      height: 22
    });
    window.innerWidth = 1440;
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    expect(Number.parseInt(hud.style.left, 10)).toBeGreaterThan(900);

    window.innerWidth = 390;
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    const clampedLeft = Number.parseInt(hud.style.left, 10);
    expect(clampedLeft).toBeGreaterThanOrEqual(10);
    expect(clampedLeft + 280).toBeLessThanOrEqual(390);
    window.innerWidth = 1440;
    window.dispatchEvent(new Event("resize"));
    await nextTick();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(hud.hidden).toBe(true);
    expect(hostileTipEl.hasAttribute("aria-describedby")).toBe(false);

    // Providers view escapes fetched diagnostic URLs & syncs ?provTag=
    document.querySelector("[data-nav-view='providers']").click();
    await nextTick();
    const dmitCard = document.querySelector("[data-provider-id='dmit']");
    expect(dmitCard?.querySelector("script")).toBeNull();
    expect(dmitCard?.textContent).toContain("<script>alert(1)</script>");
    document
      .querySelector("[data-provider-id='usvps24'] .shop-tag[data-action='filter-prov-tag']")
      .click();
    await nextTick();
    expect(window.location.href).toContain("provTag=home");

    // Radar view renders 9-column tape with offline fallback
    document.querySelector("[data-nav-view='radar']").click();
    await nextTick();
    expect(document.querySelector(".radar-tape-table")?.textContent).toContain("快照已下线");
    expect(document.querySelector(".radar-tape-table")?.textContent).toContain("下线未留档");

    // Guide view interactive checklist & presets
    document.querySelector("[data-nav-view='guide']").click();
    await nextTick();
    document.querySelector("[data-action='toggle-guide-check'][data-check-id='chk-nat']").click();
    await nextTick();
    expect(document.querySelector("[data-view-panel='guide']")?.textContent).toContain("已核验 1/4");
  });

  it("renders 3880 plans via @tanstack/vue-virtual with bounded DOM (<4000 nodes) in both table and card modes", async () => {
    setupHostDom("https://vpsld.com/?status=all");
    const now = Date.parse("2026-11-25T12:00:00.000Z");
    const base = makeBasePayload(now);
    const products = Array.from({ length: 3880 }, (_, idx) => ({
      ...base.products[1],
      id: `large-${idx}`,
      name: `Large catalog plan ${idx}`,
      priceValue: idx + 1,
      price: `¥${idx + 1}/月`
    }));

    const app = mountApp({
      endpoint: "data/products.json",
      fetchImpl: async () => Response.json({ ...base, products, events: [] }),
      initialNowMs: now,
      statsEndpoint: ""
    });
    activeApps.push(app);
    await flushUi(app);

    expect(app.store.plans.value.length).toBe(3880);
    const renderedRows = document.querySelectorAll(".terminal-table tr[data-product-id]");
    expect(renderedRows.length).toBeGreaterThanOrEqual(16);
    expect(renderedRows.length).toBeLessThanOrEqual(32);
    expect(document.querySelectorAll("*").length).toBeLessThan(4000);

    // Search reaches the very last plan immediately
    app.store.updateFilters({ q: "Large catalog plan 3879" });
    await nextTick();
    expect(document.querySelectorAll(".terminal-table tr[data-product-id]").length).toBe(1);
    expect(
      document
        .querySelector(".terminal-table tr[data-product-id]")
        ?.getAttribute("data-product-id")
    ).toBe("large-3879");

    // Card grid mode also stays virtualized and bounded
    app.store.updateFilters({ q: "" });
    app.store.setLayout("grid");
    await nextTick();
    expect(document.querySelector(".terminal-table")).toBeNull();
    expect(document.querySelectorAll(".plan-card").length).toBeLessThanOrEqual(36);
    expect(document.querySelectorAll("*").length).toBeLessThan(4000);
  });

  it("hydrates standalone review dossier pages via dual-protocol loader, trips 7-day FX fuse on timer/visibilitychange, cleans up on dispose, and toggles theme", async () => {
    globalThis.__RADAR_DISABLE_AUTO_MOUNT__ = true;
    ensureWebStorage();
    window.history.replaceState(null, "", "/reviews/aaitr.html");
    document.head.innerHTML = `<meta name="radar-base" content="../" />`;
    document.body.innerHTML = `
      <button type="button" data-action="toggle-theme">☾ 暗色</button>
      <div data-review-live-box data-provider-id="usvps24"></div>
    `;

    // Start 60ms before 2026-11-20 FX expires at 2026-11-27T00:00:00.000Z!
    let mockNow = Date.parse("2026-11-26T23:59:59.940Z");
    const payload = makeBasePayload(mockNow);
    payload.exchangeRates.date = "2026-11-20";
    const { snapshotId: snapId, pointer: dossierPointer, snapshot: compact } = makeCompactBundle(payload);

    const dossier = await mountReviewDossier({
      now: () => mockNow,
      initialNowMs: mockNow,
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.endsWith("/api/v1/pulse")) {
          return Response.json(dossierPointer);
        }
        if (u.endsWith(`/${snapId}/snapshot.json`)) return Response.json(compact);
        return new Response("Not Found", { status: 404 });
      }
    });
    activeApps.push(dossier);
    await flushUi();

    expect(document.querySelector("[data-review-live-box]")?.textContent).toContain(
      "加州 AT&T 双ISP 家宽"
    );
    expect(document.querySelector("[data-review-live-box]")?.textContent).toContain("余 4");
    expect(document.querySelector("[data-review-live-box]")?.textContent).toContain("≈ ￥140/月");

    document.querySelector("[data-action='toggle-theme']").click();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    // 1) Advance clock past 7-day FX expiration & fire visibilitychange -> must immediately fuse USD conversion!
    mockNow = Date.parse("2026-11-27T00:01:00.000Z");
    document.dispatchEvent(new Event("visibilitychange"));
    await nextTick();
    expect(document.querySelector("[data-review-live-box]")?.textContent).not.toContain("￥140/月");
    expect(document.querySelector("[data-review-live-box]")?.textContent).toContain(
      "汇率超7天 (2026-11-20) · 停算"
    );

    // 2) Also verify automatic fxBoundaryTimer fires without manual visibilitychange!
    dossier.dispose();
    activeApps.pop();
    document.body.innerHTML = `<div data-review-live-box data-provider-id="usvps24"></div>`;
    mockNow = Date.parse("2026-11-26T23:59:59.970Z");
    const dossierAuto = await mountReviewDossier({
      now: () => mockNow,
      initialNowMs: mockNow,
      endpoint: "data/products.json",
      fetchImpl: async () => Response.json(payload)
    });
    activeApps.push(dossierAuto);
    await flushUi();
    expect(document.querySelector("[data-review-live-box]")?.textContent).toContain("≈ ￥140/月");

    mockNow = Date.parse("2026-11-27T00:00:00.200Z");
    await new Promise((r) => setTimeout(r, 110));
    await nextTick();
    expect(document.querySelector("[data-review-live-box]")?.textContent).toContain(
      "汇率超7天 (2026-11-20) · 停算"
    );

    // 3) Dispose cleans up timers and visibilitychange listener cleanly
    dossierAuto.dispose();
    activeApps.pop();
    mockNow = Date.parse("2026-11-20T12:00:00.000Z");
    document.dispatchEvent(new Event("visibilitychange"));
    await nextTick();
    expect(document.querySelector("[data-review-live-box]")?.innerHTML || "").toBe("");
  });

  it("handles HTTP 503 honest degradation + retry, stale (>30m) banner, byte vs bit bandwidth, budget mutual exclusion, overlapping refresh dedup, visit stats thresholds, and defense-in-depth stale pointer recovery", async () => {
    setupHostDom("https://vpsld.com/");
    const now = Date.parse("2026-11-25T12:00:00.000Z");

    // Pre-seed yesterday's visit stats in sessionStorage -> must NOT display as today's!
    window.sessionStorage.setItem(
      "resnode-radar:visit-stats:v1",
      JSON.stringify({ day: "2020-01-01", todayPv: 2500, todayUv: 500, totalPv: 5000, totalUv: 900 })
    );

    let failInitial = true;
    let fetchCount = 0;
    let currentPv = 1000;
    const stalePayload = makeBasePayload(now);
    stalePayload.generatedAt = new Date(now - 45 * 60_000).toISOString(); // 45m old -> stale!
    stalePayload.products[1].bandwidth = "50 MB/s / 1 TB"; // Byte-per-second unit must stay MB/s, not Mbps

    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("api/v1/stats") || u.includes("api/stats")) {
        return Response.json({
          schemaVersion: 1,
          day: "2026-11-25",
          todayPv: currentPv,
          todayUv: 100,
          totalPv: 5000,
          totalUv: 800
        });
      }
      fetchCount += 1;
      await new Promise((r) => setTimeout(r, 15));
      if (failInitial) {
        return Response.json({ error: "Upstream collector unavailable" }, { status: 503 });
      }
      return Response.json(stalePayload);
    });

    const app = mountApp({
      endpoint: "data/products.json",
      fetchImpl: fetchMock,
      initialNowMs: now
    });
    activeApps.push(app);
    await flushUi(app);

    // 1) Initial 503 surfaces honest error panel (never fake data) & yesterday's sessionStorage visits ignored
    expect(document.querySelector("[data-error-panel]")?.textContent).toContain("HTTP 503");
    expect(document.querySelector("[data-visit-stat]")).toBeNull();

    // 2) Overlapping non-forced refresh calls share the same in-flight request!
    failInitial = false;
    const beforeDedup = fetchCount;
    const [r1, r2] = [app.store.refreshSnapshot(), app.store.refreshSnapshot()];
    await Promise.all([r1, r2]);
    await nextTick();
    expect(fetchCount - beforeDedup).toBe(1);

    // 3) Stale (>30m) snapshot triggers StatusBanner warning & preserves MB/s byte unit
    expect(document.querySelector("[data-status-banner]")?.textContent).toContain("已超过 30 分钟");
    expect(document.querySelector("tr[data-product-id='dc-native']")?.textContent).toContain("50 MB/s");

    // 4) Budget presets and custom min/max price replace each other cleanly without leaving hidden constraints
    document.querySelector("[data-action='toggle-specs-expand']").click();
    await nextTick();
    app.store.updateFilters({ budget: "60" });
    await nextTick();
    const minInput = document.querySelector("[data-filter-dock] [data-price-min]");
    minInput.value = "30";
    minInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(app.store.state.filters.budget).toBe("all");
    expect(app.store.state.filters.minPrice).toBe("30");

    const budgetSelectTrigger = document.querySelector(
      "[data-filter-dock] [data-filter-select='budget'] .el-select__wrapper"
    );
    expect(budgetSelectTrigger).not.toBeNull();
    budgetSelectTrigger.click();
    await nextTick();
    const budgetOption = [...document.querySelectorAll(".radar-select-popper .el-select-dropdown__item")].find(
      (el) => el.textContent?.includes("50–100") || el.textContent?.includes("50-100")
    );
    expect(budgetOption).not.toBeUndefined();
    budgetOption.click();
    await nextTick();
    expect(app.store.state.filters.budget).toBe("50-100");
    expect(app.store.state.filters.minPrice).toBe("");

    // 5) Visit counter strictly hides at <= 1000 and reveals at >= 1001, skipping pop class under reduced motion
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: true,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {}
    }));
    await app.refreshVisitStats(true);
    await nextTick();
    expect(document.querySelector("[data-visit-stat]")).toBeNull();

    currentPv = 1001;
    await app.refreshVisitStats(true);
    await nextTick();
    expect(document.querySelector("[data-visit-stat]")).not.toBeNull();
    expect(document.querySelector("[data-stat-visits]")?.textContent).toBe("1001");
    expect(
      document.querySelector("[data-stat-visits]")?.classList.contains("is-visit-num-pop")
    ).toBe(false);

    // 6) Defense-in-depth: if pulse returns 404 AND latest.json is >25m old while products.json is newer, auto-switches to v1!
    app.dispose();
    activeApps.pop();

    setupHostDom("https://vpsld.com/");
    const oldV2Payload = makeBasePayload(now - 40 * 60_000);
    const {
      snapshotId: staleSnapId,
      pointer: stalePointer,
      snapshot: staleCompact
    } = makeCompactBundle(oldV2Payload);
    const newerV1Payload = makeBasePayload(now);
    newerV1Payload.products[0].name = "Fresh V1 After Forgotten Pointer";

    const app2 = mountApp({
      initialNowMs: now,
      statsEndpoint: "",
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.endsWith("/api/v1/pulse")) return new Response("Not Found", { status: 404 });
        if (u.endsWith("/data/v2/latest.json")) {
          return Response.json(stalePointer);
        }
        if (u.endsWith(`/${staleSnapId}/snapshot.json`)) return Response.json(staleCompact);
        if (u.endsWith("/data/products.json")) return Response.json(newerV1Payload);
        return new Response("Not Found", { status: 404 });
      }
    });
    activeApps.push(app2);
    await flushUi(app2);

    expect(app2.store.state.protocolMode).toBe("v1");
    expect(document.body.textContent).toContain("Fresh V1 After Forgotten Pointer");
  });

  it("upgrades selects, segmented toggles, switches, inputs, drawers/dialogs, and dark theme class via Element Plus", async () => {
    setupHostDom("https://vpsld.com/");
    const now = Date.parse("2026-11-25T12:00:00.000Z");
    const payload = makeBasePayload(now);

    const app = mountApp({
      endpoint: "data/products.json",
      fetchImpl: async () => Response.json(payload),
      initialNowMs: now,
      statsEndpoint: ""
    });
    activeApps.push(app);
    await flushUi(app);

    // 1) Theme toggle synchronizes both data-theme="dark" and html.dark for Element Plus
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    document.querySelector("[data-action='toggle-theme']").click();
    await nextTick();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    document.querySelector("[data-action='toggle-theme']").click();
    await nextTick();
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    // 2) Region filter uses Element Plus ElSelect (RadarSelect) and updates filters on option click
    const regionSelect = document.querySelector("[data-filter-dock] [data-filter-select='region']");
    expect(regionSelect?.classList.contains("el-select")).toBe(true);
    regionSelect.querySelector(".el-select__wrapper").click();
    await nextTick();
    const jpOpt = [...document.querySelectorAll(".radar-select-popper .el-select-dropdown__item")].find(
      (el) => el.textContent?.includes("日本")
    );
    expect(jpOpt).not.toBeUndefined();
    jpOpt.click();
    await nextTick();
    expect(app.store.state.filters.region).toBe("JP");
    expect(regionSelect.classList.contains("is-filtered")).toBe(true);

    // 3) Desktop layout toggle uses Element Plus ElSegmented
    const layoutSegmented = document.querySelector(".layout-view-toggle");
    expect(layoutSegmented?.classList.contains("el-segmented")).toBe(true);
    layoutSegmented.querySelector("[data-layout='grid']").click();
    await nextTick();
    expect(app.store.state.layout).toBe("grid");

    // 4) Radar view uses ElSegmented for window, RadarSelect for region, and ElSwitch for savedOnly
    document.querySelector("[data-nav-view='radar']").click();
    await nextTick();
    expect(document.querySelector(".radar-window-toggle")?.classList.contains("el-segmented")).toBe(true);
    expect(document.querySelector("[data-radar-select='region']")?.classList.contains("el-select")).toBe(true);
    expect(document.querySelector("[data-radar-toggle='savedOnly']")?.classList.contains("el-switch")).toBe(true);

    // 5) Providers view uses ElInput and RadarSelect
    document.querySelector("[data-nav-view='providers']").click();
    await nextTick();
    expect(document.querySelector("[data-provider-select='tag']")?.classList.contains("el-select")).toBe(true);
    expect(document.querySelector("[data-provider-sort]")?.classList.contains("el-select")).toBe(true);

    // 6) SavedDrawer opens as Element Plus ElDrawer with accessible dialog name
    document.querySelector("[data-action='open-saved']").click();
    await nextTick();
    expect(document.querySelector("[data-saved-backdrop]")?.hidden).toBe(false);
    expect(document.querySelector("[data-saved-backdrop] .el-drawer")).not.toBeNull();
    expect(
      document.querySelector("[data-saved-backdrop] [role='dialog']")?.getAttribute("aria-label")
    ).toBe("本地收藏夹");
    document.querySelector("[data-action='close-saved']").click();
    await nextTick();
    expect(document.querySelector("[data-saved-backdrop]")?.hidden).toBe(true);

    // 7) CommandPalette exposes accessible dialog name, focuses search input once, and does not steal focus when user moves away before opened
    document.querySelector("[data-action='open-palette']").click();
    await flushUi();
    expect(
      document.querySelector("[data-palette-backdrop] [role='dialog']")?.getAttribute("aria-label")
    ).toBe("全局快速检索");
    const paletteInput = document.querySelector("[data-palette-input]");
    const paletteCloseBtn = document.querySelector("[data-palette-backdrop] [data-action='close-palette']");
    expect(paletteInput).not.toBeNull();
    expect(paletteCloseBtn).not.toBeNull();
    expect(document.activeElement).toBe(paletteInput);
    paletteCloseBtn.focus();
    expect(document.activeElement).toBe(paletteCloseBtn);
    await flushUi();
    expect(document.activeElement).toBe(paletteCloseBtn);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(document.querySelector("[data-palette-backdrop]")?.hidden).toBe(true);

    // 8) CompareModal exposes accessible dialog name on actual role="dialog" node
    document.querySelector("[data-nav-view='terminal']").click();
    await nextTick();
    document.querySelector(".layout-view-toggle [data-layout='table']").click();
    await nextTick();
    document.querySelector("[data-filter-dock] [data-action='reset-filters']").click();
    await nextTick();
    document.querySelector("tr[data-product-id='bwh-ams-hit'] [data-action='toggle-compare']").click();
    await nextTick();
    document.querySelector("[data-action='open-compare']").click();
    await nextTick();
    expect(
      document.querySelector("[data-compare-modal] [role='dialog']")?.getAttribute("aria-label")
    ).toBe("多方案关键指标横向对比");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(document.querySelector("[data-compare-modal]")?.hidden).toBe(true);
    app.store.clearCompare();
    await nextTick();

    // 9) Tag HUD triggered inside InspectorDrawer via real keyboard focus uses z-index above ElDrawer and follows layered Escape priority + focus restore
    const targetRowEl = document.querySelector("tr[data-product-id='bwh-ams-hit']");
    const focusBeforeDrawer = targetRowEl?.querySelector("button[data-action='toggle-save']");
    expect(targetRowEl).not.toBeNull();
    expect(focusBeforeDrawer).not.toBeNull();
    focusBeforeDrawer.focus();
    expect(document.activeElement).toBe(focusBeforeDrawer);
    targetRowEl.click();
    await flushUi();
    expect(
      document.querySelector("[data-inspector-backdrop] [role='dialog']")?.getAttribute("aria-label")
    ).toBe("套餐解析证据与定价解剖");
    const drawerOverlay = document.querySelector("[data-inspector-backdrop] .el-overlay");
    const drawerTag = document.querySelector("[data-inspector-backdrop] [data-tag-tip]");
    expect(drawerOverlay).not.toBeNull();
    expect(drawerTag).not.toBeNull();
    expect(drawerTag.tabIndex).toBe(0);
    drawerTag.focus();
    drawerTag.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await flushUi();
    expect(document.activeElement).toBe(drawerTag);
    expect(drawerTag.getAttribute("aria-describedby")).toContain("radar-tag-hud");
    const hudEl = document.querySelector("[data-tag-hud]");
    expect(hudEl?.hidden).toBe(false);
    const drawerZ = Number.parseInt(drawerOverlay.style.zIndex || "2000", 10);
    const hudZ = Number.parseInt(hudEl.style.zIndex || "0", 10);
    expect(hudZ).toBeGreaterThan(drawerZ);

    // First Escape closes ONLY the HUD; InspectorDrawer must stay open!
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(hudEl.hidden).toBe(true);
    expect(app.store.state.inspectId).toBe("bwh-ams-hit");
    expect(document.querySelector("[data-inspector-backdrop]")?.hidden).toBe(false);

    // Second Escape closes InspectorDrawer and restores focus to the element focused before opening!
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(app.store.state.inspectId).toBeNull();
    expect(document.querySelector("[data-inspector-backdrop]")?.hidden).toBe(true);
    expect(document.activeElement).toBe(focusBeforeDrawer);

    // 10) Single accessible toast region on save (no duplicate alert + status announcements)
    document.querySelector("tr[data-product-id='home-att'] button[data-action='toggle-save']").click();
    await nextTick();
    const announcements = document.querySelectorAll("[role='alert'], [role='status']");
    expect(announcements.length).toBe(1);
    expect(announcements[0].textContent).toContain("收藏");

    // 11) CompareDock exposes per-plan accessible remove buttons & nested overlay Escape closes topmost Inspector first
    document.querySelector("tr[data-product-id='bwh-ams-hit'] button[data-action='toggle-compare']").click();
    document.querySelector("tr[data-product-id='home-att'] button[data-action='toggle-compare']").click();
    await nextTick();
    const removeBwhBtn = document.querySelector(
      "[data-compare-dock] button[aria-label='移出 The Amsterdam Plan']"
    );
    const removeHomeBtn = document.querySelector(
      "[data-compare-dock] button[aria-label='移出 加州 AT&T 双ISP 家宽']"
    );
    expect(removeBwhBtn).not.toBeNull();
    expect(removeHomeBtn).not.toBeNull();
    removeHomeBtn.click();
    await nextTick();
    expect(app.store.state.compareKeys.length).toBe(1);

    // Re-add second plan, open Compare -> Ctrl+K Palette -> pick plan to stack Inspector above Compare
    document.querySelector("tr[data-product-id='home-att'] button[data-action='toggle-compare']").click();
    await nextTick();
    document.querySelector("[data-compare-dock] [data-action='open-compare']").click();
    await nextTick();
    expect(app.store.state.compareOpen).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    await flushUi();
    expect(app.store.state.paletteOpen).toBe(true);
    const palPlanBtn = document.querySelector("[data-palette-backdrop] button[data-action='palette-plan']");
    expect(palPlanBtn).not.toBeNull();
    palPlanBtn.click();
    await flushUi();
    expect(app.store.state.compareOpen).toBe(true);
    expect(app.store.state.inspectId).not.toBeNull();

    // First Escape closes topmost Inspector while keeping CompareModal open and returning focus into CompareModal
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    await nextTick();
    expect(app.store.state.inspectId).toBeNull();
    expect(app.store.state.compareOpen).toBe(true);
    expect(
      document.querySelector("[data-compare-modal]")?.contains(document.activeElement)
    ).toBe(true);

    // Second Escape closes CompareModal
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(app.store.state.compareOpen).toBe(false);

    // 12) Mobile filter drawer Escape closes rail when focused on collapsed ElSelect
    const openRailBtn = document.querySelector("[data-action='open-mobile-rail']");
    openRailBtn.focus();
    openRailBtn.click();
    await nextTick();
    expect(app.store.state.mobileRailOpen).toBe(true);
    const mobileProvCombo = document.querySelector(
      "[data-mobile-filter-sheet] [data-filter-select='provider'] [role='combobox']"
    );
    expect(mobileProvCombo).not.toBeNull();
    mobileProvCombo.focus();
    expect(mobileProvCombo.getAttribute("aria-expanded")).toBe("false");
    mobileProvCombo.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    await nextTick();
    expect(app.store.state.mobileRailOpen).toBe(false);
    expect(document.activeElement).toBe(openRailBtn);

    // 13) Desktop FilterDock Escape from collapsed ElSelect closes expanded shop picker & restores focus
    document.querySelector("[data-filter-dock] [data-action='toggle-shops-expand']").click();
    await nextTick();
    expect(app.store.state.shopsExpanded).toBe(true);
    const desktopCycleCombo = document.querySelector(
      "[data-filter-dock] [data-filter-select='cycle'] [role='combobox']"
    );
    expect(desktopCycleCombo).not.toBeNull();
    desktopCycleCombo.focus();
    expect(desktopCycleCombo.getAttribute("aria-expanded")).toBe("false");
    desktopCycleCombo.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    await nextTick();
    expect(app.store.state.shopsExpanded).toBe(false);
    expect(document.activeElement?.getAttribute("data-action")).toBe("toggle-shops-expand");

    // 14) GuideView ElProgress exposes accessible name via aria-labelledby and updates aria-valuenow
    document.querySelector("[data-nav-view='guide']").click();
    await nextTick();
    const guideBar = document.querySelector("[data-view-panel='guide'] [role='progressbar']");
    expect(guideBar).not.toBeNull();
    const labelledBy = guideBar.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy)?.textContent).toContain("4 步验真自检表");
    expect(guideBar.getAttribute("aria-valuenow")).toBe("0");
    document.querySelector("[data-action='toggle-guide-check'][data-check-id='chk-nat']").click();
    await nextTick();
    expect(guideBar.getAttribute("aria-valuenow")).toBe("25");
    document.querySelector("[data-nav-view='terminal']").click();
    await nextTick();

    // 15) CommandPalette Enter during IME composition must not preventDefault or prematurely submit stale query
    app.store.setPaletteOpen(true, "香港");
    await nextTick();
    await nextTick();
    const imePaletteInput = document.querySelector("[data-palette-input]");
    expect(imePaletteInput).not.toBeNull();
    imePaletteInput.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    imePaletteInput.value = "香港双";
    const imeEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true
    });
    imePaletteInput.dispatchEvent(imeEnter);
    await nextTick();
    expect(imeEnter.defaultPrevented).toBe(false);
    expect(app.store.state.paletteOpen).toBe(true);
    expect(app.store.state.filters.q).toBe("");
    imePaletteInput.dispatchEvent(new Event("compositionend", { bubbles: true }));
    imePaletteInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    const submitEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true
    });
    imePaletteInput.dispatchEvent(submitEnter);
    await nextTick();
    expect(submitEnter.defaultPrevented).toBe(true);
    expect(app.store.state.paletteOpen).toBe(false);
    expect(app.store.state.filters.q).toBe("香港双");

    // 16) `/` shortcut opens CommandPalette even when focused on ElSegmented radio inputs,
    // and Escape from CompareModal opened via CompareDock restores focus to CompareDock's open-compare button
    app.store.resetFilters();
    await nextTick();
    const layoutRadio = document.querySelector(".layout-view-toggle input[type='radio']");
    expect(layoutRadio).not.toBeNull();
    layoutRadio.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true }));
    await nextTick();
    expect(app.store.state.paletteOpen).toBe(true);
    app.store.setPaletteOpen(false);
    await nextTick();

    const firstPlanKey = app.store.plans.value[0]?._key;
    app.store.toggleCompare(firstPlanKey);
    await nextTick();
    const dockOpenBtn = document.querySelector("[data-compare-dock] [data-action='open-compare']");
    expect(dockOpenBtn).not.toBeNull();
    dockOpenBtn.focus();
    dockOpenBtn.click();
    await nextTick();
    expect(app.store.state.compareOpen).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    await nextTick();
    expect(app.store.state.compareOpen).toBe(false);
    expect(document.activeElement).toBe(
      document.querySelector("[data-compare-dock] [data-action='open-compare']")
    );
    app.store.clearCompare();
    await nextTick();

    // 17) Adding a 5th plan to Compare triggers a warning-type ElMessage (not success)
    for (let i = 0; i < 4; i += 1) {
      app.store.toggleCompare(`fake-key-${i}`);
    }
    const fifthRes = app.store.toggleCompare("fake-key-4");
    expect(fifthRes).toEqual({ changed: false, reason: "limit" });
    await nextTick();
    expect(app.store.state.toastType).toBe("warning");
    expect(document.querySelector(".el-message.radar-el-message.el-message--warning")).not.toBeNull();
    app.store.clearCompare();
    await nextTick();

    // 18) TerminalView zero-results renders ElEmpty
    app.store.updateFilters({ q: "no-such-plan-xyz-999" });
    await nextTick();
    expect(document.querySelector("[data-zero-results] .el-empty")).not.toBeNull();
  }, 15_000);

  it("renews ElMessage toast lifetime across consecutive identical-text saves via single store timer", async () => {
    vi.useFakeTimers();
    try {
      setupHostDom("https://vpsld.com/");
      const now = Date.parse("2026-11-25T12:00:00.000Z");
      const payload = makeBasePayload(now);
      const app = mountApp({
        endpoint: "data/products.json",
        fetchImpl: async () => Response.json(payload),
        initialNowMs: now,
        statsEndpoint: ""
      });
      activeApps.push(app);
      await app.refresh(false);
      await nextTick();

      const visibleToasts = () =>
        [...document.querySelectorAll(".el-message.radar-el-message")].filter(
          (el) => el.style.display !== "none"
        );

      // First save at t = 0
      document.querySelector("tr[data-product-id='home-att'] button[data-action='toggle-save']").click();
      await nextTick();
      expect(visibleToasts().length).toBe(1);

      // Advance 1500ms, then save a second distinct plan with identical toast wording
      vi.advanceTimersByTime(1500);
      await nextTick();
      document.querySelector("tr[data-product-id='dc-native'] button[data-action='toggle-save']").click();
      await nextTick();
      expect(visibleToasts().length).toBe(1);

      // At t = 2600ms (past the first 2400ms timer, but only 1100ms after the second save), toast MUST remain visible!
      vi.advanceTimersByTime(1100);
      await nextTick();
      expect(app.store.state.toastMessage).toBeTruthy();
      expect(visibleToasts().length).toBe(1);

      // At t = 4000ms (2500ms after the second save), store timer clears and closes the toast cleanly
      vi.advanceTimersByTime(1400);
      await nextTick();
      // Flush Vue <Transition> requestAnimationFrame leave ticks under fake timers
      vi.advanceTimersByTime(100);
      await nextTick();
      expect(app.store.state.toastMessage).toBe("");
      expect(visibleToasts().length).toBe(0);

      // If a toast is dismissed early via Escape, a subsequent identical-text save must still render a new toast
      document.querySelector("tr[data-product-id='home-att'] button[data-action='toggle-save']").click();
      await nextTick();
      expect(visibleToasts().length).toBe(1);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      await nextTick();
      vi.advanceTimersByTime(100);
      await nextTick();
      expect(visibleToasts().length).toBe(0);

      document.querySelector("tr[data-product-id='dc-native'] button[data-action='toggle-save']").click();
      await nextTick();
      expect(visibleToasts().length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders ElSkeleton while loading and ElEmpty on empty results in both TerminalView and ReviewLiveBox", async () => {
    setupHostDom("https://vpsld.com/");
    const now = Date.parse("2026-11-25T12:00:00.000Z");
    const payload = makeBasePayload(now);

    let releaseSlowFetch = null;
    const slowApp = mountApp({
      endpoint: "data/products.json",
      fetchImpl: () =>
        new Promise((resolve) => {
          releaseSlowFetch = () => resolve(Response.json(payload));
        }),
      initialNowMs: now,
      statsEndpoint: ""
    });
    activeApps.push(slowApp);
    await nextTick();
    expect(document.querySelector("[data-skeleton-grid] .el-skeleton")).not.toBeNull();
    releaseSlowFetch();
    await flushUi(slowApp);

    // ReviewLiveBox loading ElSkeleton and empty-provider ElEmpty
    document.body.innerHTML = `<div data-review-live-box data-provider-id="nonexistent-provider"></div>`;
    let releaseReviewFetch = null;
    const reviewPromise = mountReviewDossier({
      endpoint: "data/products.json",
      initialNowMs: now,
      fetchImpl: () =>
        new Promise((resolve) => {
          releaseReviewFetch = () => resolve(Response.json(payload));
        })
    });
    await nextTick();
    expect(document.querySelector("[data-review-live-box] .el-skeleton")).not.toBeNull();
    releaseReviewFetch();
    const reviewInst = await reviewPromise;
    activeApps.push(reviewInst);
    await flushUi();
    expect(document.querySelector("[data-review-live-box] .el-empty")).not.toBeNull();
  });

  it("preserves searchbox roles, passes collapsed RadarSelect Escape to tag HUD, and traps focus inside mobile filter sheet", async () => {
    setupHostDom("https://vpsld.com/?status=all");
    const now = Date.parse("2026-11-25T12:00:00.000Z");
    const payload = makeBasePayload(now);
    const app = mountApp({
      endpoint: "data/products.json",
      fetchImpl: async () => Response.json(payload),
      initialNowMs: now,
      statsEndpoint: ""
    });
    activeApps.push(app);
    await flushUi(app);

    // 1) Collapsed desktop RadarSelect Escape must close open [data-tag-hud]
    const cycleCombo = document.querySelector("[data-filter-select='cycle'] [role='combobox']");
    expect(cycleCombo).not.toBeNull();
    cycleCombo.focus();
    const dealTipBtn = document.querySelector("[data-filter-dock] [data-tag-tip]");
    expect(dealTipBtn).not.toBeNull();
    const PointerEvt = globalThis.PointerEvent || MouseEvent;
    dealTipBtn.dispatchEvent(new PointerEvt("pointerover", { bubbles: true, pointerType: "mouse" }));
    await new Promise((resolve) => setTimeout(resolve, 110));
    await nextTick();
    expect(document.querySelector("[data-tag-hud]")?.hidden).toBe(false);
    expect(cycleCombo.getAttribute("aria-expanded")).not.toBe("true");
    cycleCombo.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await nextTick();
    expect(document.querySelector("[data-tag-hud]")?.hidden).toBe(true);

    // 2) Mobile filter sheet moves focus in on open, traps Tab/Shift+Tab, and restores trigger focus on close
    const openRailBtn = document.querySelector("button[data-action='open-mobile-rail']");
    expect(openRailBtn).not.toBeNull();
    openRailBtn.focus();
    openRailBtn.click();
    await nextTick();
    await nextTick();
    const sheet = document.querySelector("[data-mobile-filter-sheet]");
    expect(sheet?.classList.contains("is-mobile-open")).toBe(true);
    expect(sheet?.contains(document.activeElement)).toBe(true);
    const firstCloseBtn = sheet.querySelector("[data-action='close-mobile-rail']");
    expect(document.activeElement).toBe(firstCloseBtn);
    // Shift+Tab from first control wraps to last control inside sheet
    document.activeElement.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })
    );
    expect(sheet.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(firstCloseBtn);
    // Tab from last control wraps back to first control inside sheet
    document.activeElement.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: false, bubbles: true, cancelable: true })
    );
    expect(document.activeElement).toBe(firstCloseBtn);
    // Escape closes mobile filter sheet and restores focus to trigger button
    document.activeElement.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
    await nextTick();
    await nextTick();
    expect(sheet.classList.contains("is-mobile-open")).toBe(false);
    expect(document.activeElement).toBe(openRailBtn);

    // 3) Migrated search inputs keep input[type=search] (searchbox role) and accessible names
    app.store.setView("providers");
    await nextTick();
    const provSearch = document.querySelector("input[data-provider-search][type='search']");
    expect(provSearch).not.toBeNull();
    expect(provSearch.getAttribute("aria-label")).toBe("搜索商家");

    app.store.setView("radar");
    await nextTick();
    const radarSearch = document.querySelector("input[data-radar-search][type='search']");
    expect(radarSearch).not.toBeNull();
    expect(radarSearch.getAttribute("aria-label")).toBe("搜索异动事件");

    // 4) Non-searchable RadarSelect supports Spacebar open + ArrowDown + Spacebar confirm without scrolling
    app.store.setView("terminal");
    await nextTick();
    const cycleSelectCombo = document.querySelector("[data-filter-select='cycle'] [role='combobox']");
    expect(cycleSelectCombo).not.toBeNull();
    cycleSelectCombo.focus();
    const openSpaceEv = new KeyboardEvent("keydown", {
      key: " ",
      code: "Space",
      bubbles: true,
      cancelable: true
    });
    cycleSelectCombo.dispatchEvent(openSpaceEv);
    await nextTick();
    await nextTick();
    expect(openSpaceEv.defaultPrevented).toBe(true);
    expect(cycleSelectCombo.getAttribute("aria-expanded")).toBe("true");
    cycleSelectCombo.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true, cancelable: true })
    );
    await nextTick();
    const commitSpaceEv = new KeyboardEvent("keydown", {
      key: " ",
      code: "Space",
      bubbles: true,
      cancelable: true
    });
    cycleSelectCombo.dispatchEvent(commitSpaceEv);
    await nextTick();
    expect(commitSpaceEv.defaultPrevented).toBe(true);
    expect(cycleSelectCombo.getAttribute("aria-expanded")).toBe("false");
    expect(app.store.state.filters.cycle).not.toBe("all");

    // 5) Stacked overlay jumps from focused header open-compare button close obstructing overlays without Vue handler errors and focus #main-workspace
    const vueErrors = [];
    app.app.config.errorHandler = (err) => {
      vueErrors.push(err);
    };
    const firstPlan = app.store.plans.value[0];
    app.store.toggleCompare(firstPlan._key);
    await nextTick();
    const headerCompareBtn = document.querySelector("[data-app-header] [data-action='open-compare']");
    expect(headerCompareBtn).not.toBeNull();
    headerCompareBtn.focus();
    headerCompareBtn.click();
    await nextTick();
    expect(app.store.state.compareOpen).toBe(true);

    // Jump from InspectorDrawer stacked over CompareModal -> drill-provider
    app.store.openInspector(firstPlan.id);
    await nextTick();
    await nextTick();
    const drillBtn = document.querySelector("[data-inspector-backdrop] [data-action='drill-provider']");
    expect(drillBtn).not.toBeNull();
    drillBtn.click();
    await nextTick();
    await nextTick();
    expect(app.store.state.compareOpen).toBe(false);
    expect(app.store.state.inspectId).toBeNull();
    expect(app.store.state.compareKeys).toContain(firstPlan._key);
    expect(document.activeElement?.id).toBe("main-workspace");

    // Jump from InspectorDrawer stacked over CompareModal -> jump-radar ("全部异动")
    headerCompareBtn.focus();
    headerCompareBtn.click();
    await nextTick();
    app.store.openInspector(firstPlan.id);
    await nextTick();
    await nextTick();
    const radarJumpBtn = document.querySelector("[data-inspector-backdrop] [data-action='jump-radar-from-inspector']");
    expect(radarJumpBtn).not.toBeNull();
    radarJumpBtn.click();
    await nextTick();
    await nextTick();
    expect(app.store.state.view).toBe("radar");
    expect(app.store.state.compareOpen).toBe(false);
    expect(app.store.state.inspectId).toBeNull();
    expect(document.activeElement?.id).toBe("main-workspace");

    // CommandPalette Enter filter while CompareModal is open closes both and focuses #main-workspace
    headerCompareBtn.focus();
    headerCompareBtn.click();
    await nextTick();
    app.store.setPaletteOpen(true, "BWH");
    await nextTick();
    await nextTick();
    const palInput = document.querySelector("input[data-palette-input]");
    expect(palInput).not.toBeNull();
    palInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await nextTick();
    await nextTick();
    expect(app.store.state.view).toBe("terminal");
    expect(app.store.state.filters.q).toBe("BWH");
    expect(app.store.state.compareOpen).toBe(false);
    expect(app.store.state.paletteOpen).toBe(false);
    expect(document.activeElement?.id).toBe("main-workspace");

    // 6) Drilling from ProvidersView (no overlay open) must NOT hijack subsequent SavedDrawer Escape returnFocus
    app.store.setView("providers");
    await nextTick();
    const provDrillBtn = document.querySelector("[data-view-panel='providers'] [data-action='drill-provider']:not(:disabled)");
    expect(provDrillBtn).not.toBeNull();
    provDrillBtn.click();
    await nextTick();
    expect(app.store.state.view).toBe("terminal");
    const openSavedBtn = document.querySelector("[data-app-header] [data-action='open-saved']");
    expect(openSavedBtn).not.toBeNull();
    openSavedBtn.focus();
    openSavedBtn.click();
    await nextTick();
    await nextTick();
    expect(app.store.state.savedDrawerOpen).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await nextTick();
    await nextTick();
    expect(app.store.state.savedDrawerOpen).toBe(false);
    expect(document.activeElement).toBe(openSavedBtn);
    expect(vueErrors).toEqual([]);
  });
});
