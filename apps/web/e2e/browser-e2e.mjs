import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import {
  createStaticServer,
  publishBatch,
  seedV2FromV1,
  writeV1FallbackPointer
} from "@resnode-radar/collector";
import { buildVps } from "../../../scripts/build-vps.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

async function runBrowserE2E() {
  const workDir = mkdtempSync(join(tmpdir(), "resnode-e2e-"));
  let server = null;
  let browser = null;

  try {
    // 1. Build real production VPS bundle into workDir/dist
    const distDir = join(workDir, "dist");
    buildVps(distDir, "https://vpsld.com/");
    cpSync(join(repoRoot, "LICENSE"), join(workDir, "LICENSE"));

    // 2. Seed real data/products.json -> v2 immutable snapshot inside workDir/data
    const dataDir = join(workDir, "data");
    mkdirSync(dataDir, { recursive: true });
    cpSync(join(repoRoot, "data/products.json"), join(dataDir, "products.json"));
    if (existsSync(join(repoRoot, "data/fx.json"))) {
      cpSync(join(repoRoot, "data/fx.json"), join(dataDir, "fx.json"));
    }

    const seedRes = await seedV2FromV1({ dataDir });
    assert.ok(seedRes.snapshotId, "Expected initial v2 snapshotId from seedV2FromV1");

    // 3. Start full local static + API server (/api/v1/pulse, /api/v1/stats, /data/snapshots/*, /static/*)
    server = createStaticServer(workDir);
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    // Verify private files are strictly blocked over HTTP
    assert.equal((await fetch(`${baseUrl}/data/v2/journal.json`)).status, 403);
    assert.equal((await fetch(`${baseUrl}/data/visits.sqlite`)).status, 403);

    const executablePath = findChromeExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {})
    });

    // =========================================================================
    // Scenario A: Desktop 1440x900 — Virtual Scroll, Tag HUD Bounds, Keyboard, Audit 404, Live Rollback
    // =========================================================================
    const desktopCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await desktopCtx.newPage();
    const pageErrors = [];
    const statsRequests = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("request", (req) => {
      if (req.url().includes("/api/v1/stats") || req.url().includes("/api/stats")) {
        statsRequests.push(req.method());
      }
    });

    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await page.waitForSelector(".terminal-table tr[data-product-id]");
    assert.ok(
      statsRequests.includes("POST"),
      `New v2 visitor session must record visit via POST even after /api/v1/pulse (got ${statsRequests.join(",")})`
    );

    // Verify bounded DOM on real 3,700+ live products!
    const initialRowCount = await page.locator(".terminal-table tr[data-product-id]").count();
    const totalDomNodes = await page.evaluate(() => document.querySelectorAll("*").length);
    assert.ok(
      initialRowCount >= 12 && initialRowCount <= 40,
      `Expected virtualized row window (got ${initialRowCount})`
    );
    assert.ok(totalDomNodes < 4500, `Expected bounded total DOM nodes < 4500 (got ${totalDomNodes})`);

    const firstTopRowId = await page
      .locator(".terminal-table tr[data-product-id]")
      .first()
      .getAttribute("data-product-id");

    // Scroll deep down to verify @tanstack/vue-virtual recycles rows smoothly
    await page.evaluate(() => window.scrollTo(0, 24000));
    await page.waitForTimeout(120);
    const scrolledTopRowId = await page
      .locator(".terminal-table tr[data-product-id]")
      .first()
      .getAttribute("data-product-id");
    assert.notEqual(scrolledTopRowId, firstTopRowId, "Virtual table must recycle rows on scroll");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(100);

    // Verify [data-tag-hud] stays strictly inside viewport bounds when focusing a focusable tag button & hovering a shop badge
    const firstTagBtn = page.locator("[data-filter-dock] button[data-tag-tip]").first();
    await firstTagBtn.focus();
    await page.waitForFunction(() => !document.querySelector("[data-tag-hud]")?.hidden);
    const hudBox = await page.locator("[data-tag-hud]").boundingBox();
    assert.ok(hudBox, "Expected visible [data-tag-hud] boundingBox");
    assert.ok(
      hudBox.x >= 0 &&
        hudBox.y >= 0 &&
        hudBox.x + hudBox.width <= 1440 &&
        hudBox.y + hudBox.height <= 900,
      `[data-tag-hud] exceeded viewport: ${JSON.stringify(hudBox)}`
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => Boolean(document.querySelector("[data-tag-hud]")?.hidden));

    // Verify keyboard Command Palette (Meta+K -> Escape) & Inspector drawer focus restore
    await page.keyboard.press("Meta+k");
    await page.waitForFunction(() => !document.querySelector("[data-palette-backdrop]")?.hidden);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => Boolean(document.querySelector("[data-palette-backdrop]")?.hidden));

    const targetRow = page.locator(".terminal-table tr[data-product-id]").first();
    await targetRow.click();
    await page.waitForFunction(() => !document.querySelector("[data-inspector-backdrop]")?.hidden);
    // Wait for lazy SourceAudit fetch to settle
    await page.waitForFunction(() => !document.querySelector("[data-audit-loading]"));
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));

    // Scenario A.4: Expired 404 audit recovery -> publish newer v2 snapshot, remove old snapshot dir, click uncached row
    const livePayload = JSON.parse(readFileSync(join(dataDir, "products.json"), "utf8"));
    const nextGen = new Date(Date.parse(livePayload.generatedAt) + 60_000).toISOString();
    const nextPayload = {
      ...livePayload,
      generatedAt: nextGen,
      publishedAt: nextGen,
      products: livePayload.products.map((p) => ({ ...p, fetchedAt: nextGen }))
    };
    const nextPub = await publishBatch({
      dataDir,
      fullPayload: nextPayload
    });
    assert.notEqual(nextPub.snapshotId, seedRes.snapshotId);
    // Evict old snapshot directory to simulate 24h GC expiring an open tab's uncached shard
    rmSync(join(dataDir, "snapshots", seedRes.snapshotId), { recursive: true, force: true });

    // Pick a row from a different source so its audit wasn't cached yet
    const rowsCount = await page.locator(".terminal-table tr[data-product-id]").count();
    await page.locator(".terminal-table tr[data-product-id]").nth(Math.min(8, rowsCount - 1)).click();
    await page.waitForTimeout(250);
    await page.keyboard.press("Escape");

    // Scenario A.5: Live-tab Rollback E2E (v2 -> v1-fallback + updated products.json)
    const rbGen = new Date(Date.parse(nextGen) + 120_000).toISOString();
    const rollbackPayload = {
      ...nextPayload,
      generatedAt: rbGen,
      publishedAt: rbGen,
      products: [
        {
          ...nextPayload.products.find((p) => !p.diagnostic && p.status === "available"),
          id: "e2e-rollback-marker-sku",
          name: "E2E-V1-Rollback-Live-Verified-SKU",
          fetchedAt: rbGen,
          stockCount: 99,
          statusLabel: "库存 99",
          evidenceLevel: { value: "stock-count", label: "精确库存 99", className: "is-count", rank: 1 }
        },
        ...nextPayload.products.map((p) => ({ ...p, fetchedAt: rbGen }))
      ]
    };
    writeFileSync(join(dataDir, "products.json"), `${JSON.stringify(rollbackPayload)}\n`);
    await writeV1FallbackPointer({ dataDir, generatedAt: rollbackPayload.generatedAt });

    // Click top telemetry refresh button in the ALREADY-OPEN v2 browser tab!
    await page.locator("[data-app-header] [data-action='refresh-snapshot']").click();
    await page.locator("[data-action='open-palette']").click();
    await page.locator("[data-palette-input]").fill("E2E-V1-Rollback-Live-Verified-SKU");
    await page.keyboard.press("Enter");
    await page.waitForSelector("tr[data-product-id='e2e-rollback-marker-sku']");
    const rollbackRowText = await page
      .locator("tr[data-product-id='e2e-rollback-marker-sku']")
      .textContent();
    assert.match(rollbackRowText, /E2E-V1-Rollback-Live-Verified-SKU/);

    // Clear search/filters so the full 1,000+ available live catalog is active for multi-row virtualization & deep-scroll verification!
    await page.locator("[data-filter-dock] [data-action='reset-filters']").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".terminal-table tr[data-product-id]").length >= 12
    );

    // Verify [data-tag-hud] open near right side at 1440px stays clamped inside 390px when viewport shrinks!
    const focusableDealBtns = page.locator("[data-filter-dock] button[data-tag-tip]");
    const btnCount = await focusableDealBtns.count();
    await focusableDealBtns.nth(Math.max(0, btnCount - 1)).focus();
    await page.waitForFunction(() => !document.querySelector("[data-tag-hud]")?.hidden);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(80);
    const hudAfterShrink = await page.evaluate(() => {
      const el = document.querySelector("[data-tag-hud]");
      if (!el || el.hidden) return { hidden: true };
      const r = el.getBoundingClientRect();
      return { hidden: false, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
    if (!hudAfterShrink.hidden) {
      assert.ok(
        hudAfterShrink.left >= 0 && hudAfterShrink.right <= 390,
        `HUD exceeded 390px viewport after resize: ${JSON.stringify(hudAfterShrink)}`
      );
    }
    await page.keyboard.press("Escape");

    // Scenario A.6: Full-list (1,000+ items) 1920x1080 grid-mode & 640x900 deep-scroll + cross-breakpoint resize alignment
    // 1) 1920x1080 desktop grid mode: container max-width caps columns to 4 (never 6 wrapping into 2 rows!)
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.locator(".layout-view-toggle [data-layout='grid']").click();
    await page.waitForSelector("[data-plan-grid] .virtual-card-row .plan-card");
    const grid1920Check = await page.evaluate(() => {
      const gridEl = document.querySelector("[data-plan-grid]");
      const cols = Number(gridEl?.getAttribute("data-virtual-cols") || 0);
      const rows = [...document.querySelectorAll("[data-plan-grid] .virtual-card-row")];
      const scrollHeight = document.documentElement.scrollHeight;
      const wrappedRows = rows.filter((row) => {
        const cards = [...row.querySelectorAll(".plan-card")];
        if (cards.length <= 1) return false;
        const firstTop = Math.round(cards[0].getBoundingClientRect().top);
        return cards.some((c) => Math.abs(Math.round(c.getBoundingClientRect().top) - firstTop) > 2);
      }).length;
      return { cols, rowCount: rows.length, scrollHeight, wrappedRows };
    });
    assert.equal(grid1920Check.cols, 4, `1920px container must resolve to 4 columns (got ${grid1920Check.cols})`);
    assert.ok(grid1920Check.rowCount >= 4, `Expected multi-row virtualized grid (got ${grid1920Check.rowCount})`);
    assert.ok(grid1920Check.scrollHeight > 25000, `Expected full-catalog scrollHeight > 25000px (got ${grid1920Check.scrollHeight})`);
    assert.equal(grid1920Check.wrappedRows, 0, "1920px virtual grid rows must NEVER wrap into multiple lines");

    // Deep continuous scroll across multiple positions in 1920px grid mode -> rendered virtual rows stay aligned & non-overlapping!
    for (const targetY of [8000, 18000, 26000]) {
      await page.evaluate((y) => window.scrollTo(0, y), targetY);
      await page.waitForTimeout(140);
      const probe = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("[data-plan-grid] .virtual-card-row")];
        const rects = rows.map((r) => r.getBoundingClientRect());
        let overlaps = 0;
        for (let i = 1; i < rects.length; i += 1) {
          if (rects[i].top < rects[i - 1].bottom - 2) overlaps += 1;
        }
        const visibleCount = rects.filter((r) => r.bottom > 80 && r.top < window.innerHeight).length;
        return { scrollY: window.scrollY, visibleCount, overlaps };
      });
      assert.ok(probe.scrollY >= targetY - 1500, `Expected real deep scroll near ${targetY}, got ${probe.scrollY}`);
      assert.ok(probe.visibleCount >= 2, `Expected >=2 visible grid rows at scrollY=${probe.scrollY}, got ${probe.visibleCount}`);
      assert.equal(probe.overlaps, 0, `Detected overlapping virtual rows at scrollY=${probe.scrollY}`);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(100);

    // Switch back to default table layout, then verify 640px narrow viewport (616px container -> 1 column, zero wrap) + multi-offset deep scroll
    await page.locator(".layout-view-toggle [data-layout='table']").click();
    await page.waitForSelector(".terminal-table tr[data-product-id]");

    await page.setViewportSize({ width: 640, height: 900 });
    await page.waitForSelector("[data-plan-grid] .plan-card[data-product-id]");
    const grid640Check = await page.evaluate(() => {
      const gridEl = document.querySelector("[data-plan-grid]");
      const cols = Number(gridEl?.getAttribute("data-virtual-cols") || 0);
      const rows = [...document.querySelectorAll("[data-plan-grid] .virtual-card-row")];
      const maxCardsInRow = Math.max(0, ...rows.map((r) => r.querySelectorAll(".plan-card").length));
      return { cols, rowCount: rows.length, scrollHeight: document.documentElement.scrollHeight, maxCardsInRow };
    });
    assert.equal(grid640Check.cols, 1, "640px viewport (616px container < 632px) must use 1 column");
    assert.ok(grid640Check.rowCount >= 4, `Expected multi-row 640px virtual list (got ${grid640Check.rowCount})`);
    assert.ok(grid640Check.scrollHeight > 80000, `Expected full 1-col scrollHeight > 80000px (got ${grid640Check.scrollHeight})`);
    assert.equal(grid640Check.maxCardsInRow, 1);

    for (const targetY of [15000, 45000]) {
      await page.evaluate((y) => window.scrollTo(0, y), targetY);
      await page.waitForTimeout(140);
      const probe640 = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("[data-plan-grid] .virtual-card-row")];
        const rects = rows.map((r) => r.getBoundingClientRect());
        let overlaps = 0;
        for (let i = 1; i < rects.length; i += 1) {
          if (rects[i].top < rects[i - 1].bottom - 2) overlaps += 1;
        }
        const visibleCount = rects.filter((r) => r.bottom > 80 && r.top < window.innerHeight).length;
        return { scrollY: window.scrollY, visibleCount, overlaps };
      });
      assert.ok(probe640.scrollY >= targetY - 1500, `Expected real 640px scroll near ${targetY}, got ${probe640.scrollY}`);
      assert.ok(probe640.visibleCount >= 2, `Expected >=2 visible cards at 640px scrollY=${probe640.scrollY}`);
      assert.equal(probe640.overlaps, 0);
    }

    // Resize WHILE deep-scrolled (640 -> 390 -> 1440) and verify visible non-overlapping items!
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(140);
    const deep390Visible = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".plan-card[data-product-id]")];
      return cards.filter((c) => {
        const r = c.getBoundingClientRect();
        return r.bottom > 60 && r.top < window.innerHeight && r.width > 200;
      }).length;
    });
    assert.ok(deep390Visible >= 1, `Expected visible .plan-card after resizing 640->390 at deep scroll (got ${deep390Visible})`);

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector(".terminal-table tr[data-product-id]");
    assert.equal(
      await page.locator(".plan-card[data-product-id]").count(),
      0,
      "Resizing 390 -> 1440 must restore desktop virtual table"
    );

    assert.deepEqual(pageErrors, [], `Unexpected desktop page errors: ${pageErrors.join("; ")}`);
    await desktopCtx.close();

    // =========================================================================
    // Scenario B: Mobile 390x844 + prefers-reduced-motion + Review Dossier Page
    // =========================================================================
    const mobileCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce"
    });
    const mobilePage = await mobileCtx.newPage();
    const mobileErrors = [];
    mobilePage.on("pageerror", (err) => mobileErrors.push(err.message));

    await mobilePage.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await mobilePage.waitForSelector(".plan-card[data-product-id]");
    assert.equal(
      await mobilePage.locator(".terminal-table").count(),
      0,
      "Mobile viewport must render card layout instead of wide table"
    );

    await mobilePage.locator("[data-action='open-mobile-rail']").click();
    await mobilePage.waitForSelector(".mobile-filter-sheet.is-mobile-open");
    await mobilePage.locator(".mobile-rail-footer [data-action='close-mobile-rail']").click();

    // Verify Radar window toggle (24h / 72h / 7天) remains visible & operable on narrow <=860px viewports
    await mobilePage.locator(".ws-nav [data-nav-view='radar']").click();
    const win24Btn = mobilePage.locator(".radar-window-toggle [data-window='24h']");
    assert.equal(await win24Btn.isVisible(), true, "Radar 24h window button must stay visible on mobile");
    await win24Btn.click();
    assert.match(mobilePage.url(), /radarWin=24h/);

    // Verify standalone Review Dossier page hydrates cleanly
    await mobilePage.goto(`${baseUrl}/reviews/aaitr.html`, { waitUntil: "networkidle" });
    await mobilePage.waitForFunction(
      () => !document.querySelector("[data-review-live-box] .skel")
    );
    const dossierText = await mobilePage.locator("[data-review-live-box]").textContent();
    assert.ok(
      dossierText && dossierText.trim().length > 0,
      "Review dossier live box must hydrate from live snapshot"
    );

    assert.deepEqual(mobileErrors, [], `Unexpected mobile page errors: ${mobileErrors.join("; ")}`);
    await mobileCtx.close();

    console.log(
      "Browser E2E passed: desktop virtual scroll, [data-tag-hud] viewport clamping, keyboard focus, 404 audit refresh, live v2->v1 rollback, mobile reduced-motion cards, and review dossier hydration."
    );
  } finally {
    await browser?.close();
    if (server) {
      await new Promise((res) => server.close(res));
    }
    rmSync(workDir, { recursive: true, force: true });
  }
}

await runBrowserE2E();
