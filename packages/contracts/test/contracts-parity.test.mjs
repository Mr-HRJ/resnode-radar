import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import {
  assertLosslessParity,
  buildEventIndex,
  decodeCompactSnapshot,
  decodeEvidenceLevel,
  decodeRiskTags,
  evaluateProviderTags,
  formatSnapshotId,
  matchesRoute,
  monthlyCny,
  normalizeProduct,
  parseUrlState,
  priceQuote,
  projectToCompact,
  resolveSiteAssetUrl,
  savedKey,
  serializeUrlState
} from "../src/index.js";

test("v2 CompactSnapshot achieves 100% lossless business parity on real full snapshot", () => {
  const rawBytes = readFileSync(new URL("../../../data/products.json", import.meta.url));
  const fullPayload = JSON.parse(rawBytes.toString("utf8"));
  const v1Sha256 = createHash("sha256").update(rawBytes).digest("hex");
  const snapId = formatSnapshotId(fullPayload.generatedAt, v1Sha256);

  const { snapshot, audits } = projectToCompact(fullPayload, { v1Sha256, snapshotId: snapId });
  const serialized = JSON.stringify(snapshot);
  const gz = gzipSync(Buffer.from(serialized), { level: 9 });

  assert.ok(Buffer.byteLength(serialized) < 20 * 1024 * 1024, "Compact JSON stays well under safety ceiling");
  assert.ok(gz.length < 700 * 1024, `Compact gzip-9 (${gz.length}B) fits soft budget`);
  assert.equal(audits.size, fullPayload.sourceCount);

  assert.equal(assertLosslessParity(fullPayload, serialized), true);
});

test("lossless projection preserves configurable baseOnly, billingDays conflict, Lagom savedKey, features route/search, and historical rank", () => {
  const generatedAt = "2026-11-25T12:00:00.000Z";
  const fx = { base: "CNY", date: "2026-11-24", rates: { USD: 7.2, EUR: 7.6 } };
  const samplePayload = {
    schemaVersion: 1,
    generatedAt,
    publishedAt: generatedAt,
    sourceCount: 2,
    summary: { total: 3, available: 2, unavailable: 0, unknown: 1, blocked: 0, error: 0 },
    eventTracking: { startedAt: generatedAt, retentionDays: 7, limit: 300 },
    events: [],
    exchangeRates: fx,
    products: [
      {
        id: "lagom-demo-card:3",
        sourceId: "lagom-demo",
        provider: "DemoHost",
        providerId: "bwh",
        category: "vps",
        adapter: "lagom_product_list",
        sourceUrl: "https://example.com/store",
        fetchedAt: generatedAt,
        status: "available",
        statusLabel: "可订购",
        stockCount: 3,
        price: "$36.00 / Year",
        priceValue: 36,
        currency: "USD",
        name: "Special Plan",
        region: "Los Angeles",
        hardware: "2 vCPU / 4 GB RAM / 40 GB NVMe",
        bandwidth: "1 Gbps / 1000 GB",
        orderUrl: "https://example.com/cart.php?a=add&pid=99",
        evidence: "exact stock 3",
        evidenceLevel: { value: "stock-count", label: "精确库存 3", className: "is-count", rank: 1 },
        riskTags: [{ value: "no-extra-risk", label: "未见额外风险", severity: "low" }],
        raw: {
          sourceCardIndex: 2,
          billingDays: 30,
          features: { 线路: "CN2 GIA", OS: "FreeBSD 14" },
          attempts: [{ url: "https://example.com/store", status: 200 }]
        }
      },
      {
        id: "whmcs-cfg-1",
        sourceId: "lagom-demo",
        provider: "DemoHost",
        providerId: "bwh",
        category: "vps",
        adapter: "whmcs_group",
        sourceUrl: "https://example.com/store",
        fetchedAt: generatedAt,
        status: "available",
        statusLabel: "可订购",
        price: "$5.00 / Month",
        priceValue: 5,
        currency: "USD",
        name: "Configurable Plan",
        region: "Tokyo",
        hardware: "2 vCPU / 4 GB RAM / 40 GB SSD",
        bandwidth: "1 Gbps / 1 TB",
        orderUrl: "https://example.com/cart.php?a=add&pid=100",
        evidence: "order button",
        evidenceLevel: { value: "official-order", label: "官方订购入口", className: "is-official", rank: 2 },
        riskTags: [{ value: "order-only", label: "仅证明可下单", severity: "medium" }],
        raw: {
          configurable: true
        }
      },
      {
        id: "hist-1",
        sourceId: "hist-src",
        provider: "DMIT",
        providerId: "dmit",
        category: "vps",
        adapter: "public_catalog",
        sourceUrl: "https://www.dmit.io/pages/pricing",
        fetchedAt: generatedAt,
        status: "unknown",
        statusLabel: "历史资料·本轮未核验",
        price: "$36.90 / Year",
        priceValue: 36.9,
        currency: "USD",
        name: "LAX.Pro.WEE",
        region: "Los Angeles",
        evidence: "保留历史套餐资料",
        evidenceLevel: { value: "unverified", label: "历史资料·库存待核验", className: "is-unknown", rank: 6 },
        riskTags: [{ value: "unknown-status", label: "状态未知", severity: "medium" }],
        verification: { state: "historical", priceKind: "historical", observedAt: "2026-11-24T00:00:00.000Z" },
        collection: { failedPages: 1, retainedHistory: true },
        raw: { historical: true, referencePrice: true }
      }
    ]
  };

  const v1Sha256 = createHash("sha256").update(JSON.stringify(samplePayload)).digest("hex");
  const { snapshot, audits } = projectToCompact(samplePayload, { v1Sha256 });
  const serialized = JSON.stringify(snapshot);

  assert.equal(assertLosslessParity(samplePayload, serialized, Date.parse(generatedAt)), true);

  // Verify raw.attempts was stripped from compact snapshot and moved to audit
  assert.equal(snapshot.products[0].raw, undefined);
  assert.equal(audits.get("lagom-demo").records["lagom-demo-card:3"].raw.attempts.length, 1);

  const decoded = decodeCompactSnapshot(JSON.parse(serialized));
  const [p0, p1, p2] = decoded.products;

  // Lagom positional savedKey must stay fallback:...
  const expectedKey = savedKey(samplePayload.products[0]);
  assert.match(expectedKey, /^fallback:/);
  assert.equal(savedKey({ ...p0, savedKey: undefined }), expectedKey);

  // ?cmp= URL round-trip uses savedKey while ?inspect= uses product.id
  const href = serializeUrlState({
    view: "terminal",
    layout: "table",
    compareKeys: [expectedKey],
    compareOpen: true,
    inspectId: p0.id
  });
  const urlState = parseUrlState(href);
  assert.deepEqual(urlState.compareKeys, [expectedKey]);
  assert.equal(urlState.inspectId, p0.id);

  // billingDays=30 vs Year conflict -> 周期待核对, unconvertible
  assert.equal(priceQuote(p0).period, "周期待核对");
  assert.equal(priceQuote(p0).monthly, null);

  // configurable=true -> baseOnly: true, unconvertible
  assert.equal(priceQuote(p1).baseOnly, true);
  assert.equal(monthlyCny(p1, fx, Date.parse(generatedAt)), null);

  // features route & search preserved
  const norm0 = normalizeProduct(p0, 0, fx, buildEventIndex([]), Date.parse(generatedAt));
  assert.equal(matchesRoute(norm0, "cn2"), true);
  assert.equal(norm0._search.includes("freebsd"), true);

  // historical evidenceLevel label & rank preserved
  assert.equal(p2.evidenceLevel.label, "历史资料·库存待核验");
  assert.equal(p2.evidenceLevel.rank, 6);
});

test("unknown schemaVersion, dictVersion, or dictionary code (including Object.prototype properties) fails closed", () => {
  assert.throws(() => decodeCompactSnapshot({ schemaVersion: 99, dictVersion: 1 }), /Unsupported CompactSnapshot schemaVersion/);
  assert.throws(() => decodeCompactSnapshot({ schemaVersion: 2, dictVersion: 99 }), /Unsupported CompactSnapshot dictVersion/);

  const generatedAt = "2026-11-25T12:00:00.000Z";
  const basePayload = {
    schemaVersion: 1,
    generatedAt,
    publishedAt: generatedAt,
    sourceCount: 1,
    summary: { total: 1, available: 1, unavailable: 0, unknown: 0, blocked: 0, error: 0 },
    eventTracking: { startedAt: generatedAt, retentionDays: 7, limit: 300 },
    events: [],
    products: [
      {
        id: "p-1",
        sourceId: "s-1",
        provider: "Demo",
        providerId: "dmit",
        category: "vps",
        adapter: "public_catalog",
        sourceUrl: "https://www.dmit.io/",
        fetchedAt: generatedAt,
        status: "available",
        statusLabel: "有货",
        evidence: "official",
        evidenceLevel: { value: "official-order", label: "官方订购入口", className: "is-official", rank: 2 },
        riskTags: [{ value: "no-extra-risk", label: "未见额外风险", severity: "low" }]
      }
    ]
  };
  const v1Sha256 = createHash("sha256").update(JSON.stringify(basePayload)).digest("hex");
  const { snapshot } = projectToCompact(basePayload, { v1Sha256 });

  for (const badCode of ["zz_unknown", "constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    assert.throws(() => decodeEvidenceLevel(badCode), /Unknown evidenceLevel dictionary code/);
    assert.throws(() => decodeRiskTags([badCode]), /Unknown riskTag dictionary code/);

    const badEvSnap = structuredClone(snapshot);
    badEvSnap.products[0].ev = badCode;
    assert.throws(() => decodeCompactSnapshot(badEvSnap), /Unknown evidenceLevel dictionary code/);

    const badRkSnap = structuredClone(snapshot);
    badRkSnap.products[0].rk = [badCode];
    assert.throws(() => decodeCompactSnapshot(badRkSnap), /Unknown riskTag dictionary code/);

    const badSrcSnap = structuredClone(snapshot);
    badSrcSnap.products[0].sourceId = badCode;
    assert.throws(() => decodeCompactSnapshot(badSrcSnap), /references missing source/);
  }
});

test("advancing clock past 7-day ECB FX window with fixed snapshotId trips foreign FX fuse while preserving CNY plans", () => {
  const fx = { base: "CNY", date: "2026-11-18", rates: { USD: 7.2 } };
  const usdPlan = {
    id: "dmit-wee",
    sourceId: "catalog-dmit",
    provider: "DMIT",
    providerId: "dmit",
    category: "vps",
    adapter: "public_catalog",
    sourceUrl: "https://www.dmit.io/",
    fetchedAt: "2026-11-24T00:00:00.000Z",
    status: "available",
    statusLabel: "有货",
    stockCount: 2,
    price: "$36.90 / Year",
    priceValue: 36.9,
    currency: "USD",
    name: "LAX.Pro.WEE",
    region: "Los Angeles",
    route: "CN2 GIA",
    hardware: "1 vCPU / 1 GB RAM / 20 GB SSD",
    bandwidth: "500 Mbps / 500 GB",
    orderUrl: "https://www.dmit.io/cart.php?a=add&pid=1",
    evidence: "exact stock",
    evidenceLevel: { value: "stock-count", label: "精确库存 2", className: "is-count", rank: 1 },
    riskTags: [{ value: "no-extra-risk", label: "未见额外风险", severity: "low" }]
  };
  const cnyPlan = {
    ...usdPlan,
    id: "lisa-cny",
    provider: "LisaHost",
    providerId: "lisahost",
    category: "home",
    price: "¥199 / 年",
    priceValue: 199,
    currency: "CNY",
    name: "美西特价年付双ISP家宽"
  };

  // Within 7 days (day 6): USD converts and earns blockbuster/scarce tags
  const day6 = Date.parse("2026-11-24T12:00:00Z");
  const normUsdFresh = normalizeProduct(usdPlan, 0, fx, new Map(), day6);
  assert.ok(Number.isFinite(normUsdFresh._pricing.cnyMonthly));
  assert.ok(normUsdFresh._planTags.length > 0);

  // Past 7 days (day 7 + 1s) or missing FX: USD conversion fuses to null, CNY keeps original cnyMonthly display,
  // and BOTH USD & CNY lose all price-based product/shop tags uniformly under the <=7d ECB FX admission rule!
  const day8 = Date.parse("2026-11-25T00:00:01Z");
  const normUsdExpired = normalizeProduct(usdPlan, 0, fx, new Map(), day8);
  assert.equal(normUsdExpired._pricing.cnyMonthly, null);
  assert.equal(normUsdExpired._planTags.length, 0);
  const shopTagsExpired = evaluateProviderTags("dmit", [normUsdExpired, normUsdExpired]);
  assert.equal(shopTagsExpired.tags.some((t) => t.key === "value" || t.key === "budget"), false);

  const normCnyExpired = normalizeProduct(cnyPlan, 1, fx, new Map(), day8);
  assert.ok(Number.isFinite(normCnyExpired._pricing.cnyMonthly), "CNY original monthly quote display stays preserved");
  assert.deepEqual(normCnyExpired._planTags, [], "CNY plans must also pause deal tags when ECB FX > 7 days");
  const cnyShopExpired = evaluateProviderTags("dpnet", [normCnyExpired, normCnyExpired]);
  assert.deepEqual(cnyShopExpired.tags, [], "CNY shops must also pause live value/budget tags when ECB FX > 7 days");

  const normCnyMissingFx = normalizeProduct(cnyPlan, 2, null, new Map(), day6);
  assert.ok(Number.isFinite(normCnyMissingFx._pricing.cnyMonthly));
  assert.deepEqual(normCnyMissingFx._planTags, []);
  assert.deepEqual(evaluateProviderTags("dpnet", [normCnyMissingFx, normCnyMissingFx]).tags, []);
});

test("resolveSiteAssetUrl resolves root, /reviews/*.html, and subpath deployments while blocking traversal", () => {
  const rootDoc = { querySelector: () => ({ getAttribute: () => "./" }) };
  const reviewDoc = { querySelector: () => ({ getAttribute: () => "../" }) };

  assert.equal(
    resolveSiteAssetUrl("data/v2/latest.json", { doc: rootDoc, locationHref: "https://vpsld.com/?view=radar" }),
    "https://vpsld.com/data/v2/latest.json"
  );
  assert.equal(
    resolveSiteAssetUrl("data/snapshots/snap_1/snapshot.json", {
      doc: reviewDoc,
      locationHref: "https://vpsld.com/reviews/aaitr.html"
    }),
    "https://vpsld.com/data/snapshots/snap_1/snapshot.json"
  );
  assert.equal(
    resolveSiteAssetUrl("data/products.json", {
      doc: reviewDoc,
      locationHref: "https://example.github.io/resnode-radar/reviews/lisahost.html"
    }),
    "https://example.github.io/resnode-radar/data/products.json"
  );
  assert.throws(
    () => resolveSiteAssetUrl("../etc/passwd", { doc: rootDoc, locationHref: "https://vpsld.com/" }),
    /Disallowed site asset path/
  );
});
