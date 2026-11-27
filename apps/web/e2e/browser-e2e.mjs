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

    // 2. Seed deterministic fixture-backed snapshot (preserving repo snapshot timestamps & FX intact!)
    const dataDir = join(workDir, "data");
    mkdirSync(dataDir, { recursive: true });
    const repoProducts = JSON.parse(readFileSync(join(repoRoot, "data/products.json"), "utf8"));
    const snapGenIso = repoProducts.generatedAt;
    const snapGenMs = Date.parse(snapGenIso);
    // Anchor valid-FX scenario & clocks strictly to snapGenMs so stale repo FX never backdates deterministic events
    const effectiveExchangeRates = {
      base: "CNY",
      date: snapGenIso.slice(0, 10),
      fetchedAt: snapGenIso,
      source: repoProducts.exchangeRates?.source || "Frankfurter / ECB",
      sourceUrl:
        repoProducts.exchangeRates?.sourceUrl || "https://api.frankfurter.dev/v1/latest?base=CNY",
      rates: repoProducts.exchangeRates?.rates || {
        CNY: 1,
        USD: 7.25,
        EUR: 7.85,
        GBP: 9.15,
        HKD: 0.93,
        JPY: 0.048
      }
    };
    // Normal scenario runs 2 min after snapGenMs (fresh <30m snapshot + fresh <7d FX); expired scenario runs +9 days later (>7d FX fuse)
    const FIXED_NOW_MS = snapGenMs + 2 * 60_000;
    const EXPIRED_NOW_MS = snapGenMs + 9 * 86_400_000;

    const deterministicTaggedPlan = {
      id: "e2e-fixed-tagged-bwh-ams",
      sourceId: "bwh-limited-pids",
      providerId: "bwh",
      provider: "搬瓦工(BWH)",
      category: "vps",
      adapter: "whmcs_pid",
      sourceUrl: "https://bwh81.net/",
      fetchedAt: snapGenIso,
      region: "荷兰阿姆斯特丹",
      route: "CN2 GIA / 9929 / CMIN2",
      name: "The Amsterdam E2E Deterministic Long Plan Name",
      hardware: "2 vCPU / 4 GB RAM / 40 GB SSD",
      bandwidth: "2.5 Gbps / 1000 GB",
      price: "$39/year",
      priceValue: 39,
      currency: "USD",
      status: "available",
      statusLabel: "库存 4",
      stockCount: 4,
      orderUrl: "https://bwh81.net/cart.php?a=add&pid=151",
      evidence: "Deterministic E2E tagged plan",
      evidenceLevel: { value: "stock-count", label: "精确库存 4", className: "is-count", rank: 1 },
      riskTags: [{ value: "no-extra-risk", label: "未见额外风险", severity: "low" }]
    };
    const aaitrSourceId =
      repoProducts.sources?.find((s) => s.providerId === "aaitr")?.id ||
      repoProducts.products?.find((p) => p.providerId === "aaitr")?.sourceId ||
      "aaitr-store";
    const deterministicAaitrPlan = {
      id: "e2e-fixed-aaitr-hk",
      sourceId: aaitrSourceId,
      providerId: "aaitr",
      provider: "AaITR",
      category: "vps",
      adapter: "aaitr_store",
      sourceUrl: "https://www.aaitr.com/",
      fetchedAt: snapGenIso,
      region: "中国香港",
      route: "香港双ISP家宽",
      name: "AaITR E2E Deterministic HK Residential",
      hardware: "1 vCPU / 1 GB RAM / 20 GB SSD",
      bandwidth: "300 Mbps / 1000 GB",
      price: "$18/month",
      priceValue: 18,
      currency: "USD",
      status: "available",
      statusLabel: "库存 6",
      stockCount: 6,
      orderUrl: "https://www.aaitr.com/",
      evidence: "Deterministic E2E AaITR dossier plan",
      evidenceLevel: { value: "stock-count", label: "精确库存 6", className: "is-count", rank: 1 },
      riskTags: [{ value: "no-extra-risk", label: "未见额外风险", severity: "low" }]
    };
    const deterministicEventAt = snapGenIso;
    const deterministicTaggedEvent = {
      id: `${deterministicEventAt}|restock|e2e-fixed-tagged-bwh-ams`,
      type: "restock",
      at: deterministicEventAt,
      productId: "e2e-fixed-tagged-bwh-ams",
      provider: "搬瓦工(BWH)",
      providerId: "bwh",
      name: "The Amsterdam E2E Deterministic Long Plan Name",
      region: "荷兰阿姆斯特丹",
      price: "$39/year",
      priceValue: 39,
      currency: "USD",
      stockCount: 4,
      orderUrl: "https://bwh81.net/cart.php?a=add&pid=151"
    };
    const baseSeededProducts = [deterministicTaggedPlan, deterministicAaitrPlan, ...repoProducts.products];
    const existingPlanCount = baseSeededProducts.filter(
      (p) => !p.diagnostic && p.status !== "blocked" && p.status !== "error"
    ).length;
    const minVirtualPlans = 3720;
    const padCount = Math.max(0, minVirtualPlans - existingPlanCount);
    const deterministicPaddingPlans = Array.from({ length: padCount }, (_, idx) => ({
      ...deterministicTaggedPlan,
      id: `e2e-pad-plan-${String(idx + 1).padStart(4, "0")}`,
      name: `BWH E2E Virtual Scale Plan ${String(idx + 1).padStart(4, "0")}`,
      priceValue: 49 + (idx % 20),
      price: `$${49 + (idx % 20)}/year`,
      orderUrl: `https://bwh81.net/cart.php?a=add&pid=${9000 + idx}`
    }));
    const seededProducts = [...baseSeededProducts, ...deterministicPaddingPlans];
    const seededEvents = [
      deterministicTaggedEvent,
      ...(repoProducts.events || []).filter((e) => e.id !== deterministicTaggedEvent.id)
    ]
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, 300);
    assert.ok(
      seededEvents.some((e) => e.id === deterministicTaggedEvent.id),
      "Deterministic 24h evidence event must remain in final seededEvents after truncation"
    );
    const seededProductsPayload = {
      ...repoProducts,
      exchangeRates: effectiveExchangeRates,
      events: seededEvents,
      summary: {
        total: seededProducts.length,
        available: seededProducts.filter((p) => p.status === "available").length,
        unavailable: seededProducts.filter((p) => p.status === "unavailable").length,
        unknown: seededProducts.filter((p) => p.status === "unknown").length,
        blocked: seededProducts.filter((p) => p.status === "blocked").length,
        error: seededProducts.filter((p) => p.status === "error").length
      },
      products: seededProducts
    };
    writeFileSync(join(dataDir, "products.json"), `${JSON.stringify(seededProductsPayload)}\n`);
    writeFileSync(join(dataDir, "fx.json"), `${JSON.stringify(effectiveExchangeRates)}\n`);

    const seedRes = await seedV2FromV1({ dataDir });
    assert.ok(seedRes.snapshotId, "Expected initial v2 snapshotId from seedV2FromV1");

    function installFixedClock(ctx, targetNowMs) {
      return ctx.addInitScript((fixedStart) => {
        const RealDate = Date;
        const realStart = RealDate.now();
        const shiftedNow = () => fixedStart + (RealDate.now() - realStart);
        class ShiftedDate extends RealDate {
          constructor(...args) {
            if (args.length === 0) super(shiftedNow());
            else super(...args);
          }
          static now() {
            return shiftedNow();
          }
        }
        ShiftedDate.parse = RealDate.parse;
        ShiftedDate.UTC = RealDate.UTC;
        globalThis.Date = ShiftedDate;
      }, targetNowMs);
    }

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
    await installFixedClock(desktopCtx, FIXED_NOW_MS);
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
    assert.ok(totalDomNodes < 4000, `Expected bounded total DOM nodes < 4000 (got ${totalDomNodes})`);

    const firstTopRowId = await page
      .locator(".terminal-table tr[data-product-id]")
      .first()
      .getAttribute("data-product-id");

    // Scroll deep down to verify @tanstack/vue-virtual recycles rows smoothly
    await page.evaluate(() => window.scrollTo(0, 24000));
    await page.waitForFunction(
      (prevId) => {
        const el = document.querySelector(".terminal-table tr[data-product-id]");
        return Boolean(el && el.getAttribute("data-product-id") !== prevId);
      },
      firstTopRowId,
      { timeout: 5000 }
    );
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
    // Verify keyboard Command Palette (Meta+K -> accessible role="dialog" name -> direct keyboard.type -> Tab not stolen by opened -> Escape)
    await page.keyboard.press("Meta+k");
    await page.waitForFunction(() => !document.querySelector("[data-palette-backdrop]")?.hidden);
    await page.getByRole("dialog", { name: "全局快速检索" }).waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const input = document.querySelector("[data-palette-input]");
      return Boolean(input && document.activeElement === input);
    });
    // Tab away during open transition and verify @opened fallback does NOT steal focus back to input
    await page.keyboard.press("Tab");
    await page.waitForTimeout(380);
    const focusStayedMoved = await page.evaluate(
      () => document.activeElement !== document.querySelector("[data-palette-input]")
    );
    assert.equal(focusStayedMoved, true, "CommandPalette @opened must not steal focus after user Tabbed away");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => Boolean(document.querySelector("[data-palette-backdrop]")?.hidden));

    // Re-open CommandPalette to verify direct keyboard.type() + IME composition Enter guard
    await page.keyboard.press("Meta+k");
    await page.waitForFunction(() => {
      const input = document.querySelector("[data-palette-input]");
      return Boolean(input && document.activeElement === input);
    });
    await page.keyboard.type("香港");
    await page.waitForFunction(
      () => document.querySelector("[data-palette-input]")?.value === "香港"
    );
    // Enter during active IME composition must NOT preventDefault or prematurely submit stale "香港"
    const imeCheck = await page.evaluate(() => {
      const input = document.querySelector("[data-palette-input]");
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "双" }));
      input.value = "香港双";
      const composingEnter = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
        isComposing: true
      });
      input.dispatchEvent(composingEnter);
      return {
        defaultPrevented: composingEnter.defaultPrevented,
        paletteStillOpen: !document.querySelector("[data-palette-backdrop]")?.hidden,
        urlSearch: window.location.search
      };
    });
    assert.equal(imeCheck.defaultPrevented, false, "IME composing Enter must not call preventDefault");
    assert.equal(imeCheck.paletteStillOpen, true, "IME composing Enter must keep CommandPalette open");
    assert.doesNotMatch(imeCheck.urlSearch, /q=/, "IME composing Enter must not prematurely submit stale query");
    // Finish IME composition and press standalone Enter -> submits full "香港双"
    await page.evaluate(() => {
      const input = document.querySelector("[data-palette-input]");
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "香港双" }));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => Boolean(document.querySelector("[data-palette-backdrop]")?.hidden));
    assert.equal(
      new URL(page.url()).searchParams.get("q"),
      "香港双",
      "Standalone Enter after IME compositionend must submit full composed query"
    );
    await page.locator("[data-filter-dock] [data-action='reset-filters']").click();
    await page.waitForFunction(() => !new URL(window.location.href).searchParams.get("q"));

    // Verify `/` shortcut works when focused on ElSegmented radio controls (both layout toggle & radar window toggle)
    // AND verify light-mode search placeholder contrast >= 4.5:1
    await page.locator(".layout-view-toggle input[type='radio']").first().focus();
    await page.keyboard.press("/");
    await page.waitForFunction(() => !document.querySelector("[data-palette-backdrop]")?.hidden);
    const lightPlaceholderContrast = await page.evaluate(() => {
      const input = document.querySelector("[data-palette-input]");
      const dialog = document.querySelector("[data-palette-backdrop] .el-dialog");
      const parseRgba = (str) => {
        const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : null;
      };
      const fg = parseRgba(getComputedStyle(input, "::placeholder").color);
      const bg = parseRgba(getComputedStyle(dialog).backgroundColor);
      const lum = ([r, g, b]) =>
        [r, g, b]
          .map((c) => {
            const s = c / 255;
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
          })
          .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
      const ratio = fg && bg ? (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05) : 0;
      return {
        color: getComputedStyle(input, "::placeholder").color,
        bg: getComputedStyle(dialog).backgroundColor,
        contrast: Number(ratio.toFixed(2))
      };
    });
    assert.ok(
      lightPlaceholderContrast.contrast >= 4.5,
      `Light search input ::placeholder contrast must be >= 4.5:1: ${JSON.stringify(lightPlaceholderContrast)}`
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => Boolean(document.querySelector("[data-palette-backdrop]")?.hidden));

    await page.locator(".ws-nav [data-nav-view='radar']").click();
    await page.waitForSelector(".radar-window-toggle");
    await page.locator(".radar-window-toggle input[type='radio']").first().focus();
    await page.keyboard.press("/");
    await page.waitForFunction(() => !document.querySelector("[data-palette-backdrop]")?.hidden);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => Boolean(document.querySelector("[data-palette-backdrop]")?.hidden));
    await page.locator(".ws-nav [data-nav-view='terminal']").click();
    await page.waitForSelector(".terminal-table tr[data-product-id]");

    // Verify desktop FilterDock ElSelect layered Escape when shop picker is expanded
    await page.locator("[data-filter-dock] [data-action='toggle-shops-expand']").click();
    await page.waitForFunction(() => !document.querySelector("[data-shop-picker]")?.hidden);
    await page.locator("[data-filter-dock] [data-filter-select='cycle'] .el-select__wrapper").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector("[data-filter-dock] [data-filter-select='cycle'] [role='combobox']")
          ?.getAttribute("aria-expanded") === "true"
    );
    // First Escape collapses cycle dropdown while keeping shop picker open
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () =>
        document
          .querySelector("[data-filter-dock] [data-filter-select='cycle'] [role='combobox']")
          ?.getAttribute("aria-expanded") === "false"
    );
    assert.equal(
      await page.evaluate(() => Boolean(document.querySelector("[data-shop-picker]")?.hidden)),
      false,
      "First Escape on expanded desktop ElSelect must close dropdown only"
    );
    // Second Escape from collapsed desktop ElSelect closes shop picker & restores focus to expand button
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => Boolean(document.querySelector("[data-shop-picker]")?.hidden));
    const shopToggleFocus = await page.evaluate(
      () => document.activeElement?.getAttribute?.("data-action") || ""
    );
    assert.equal(
      shopToggleFocus,
      "toggle-shops-expand",
      `Second Escape from collapsed desktop ElSelect must restore focus to toggle-shops-expand (got ${shopToggleFocus})`
    );

    // Verify filtered RadarSelect retains a distinct visible focus ring when focused via keyboard Tab
    await page.locator("[data-filter-dock] [data-filter-select='cycle'] .el-select__wrapper").click();
    await page.locator(".radar-select-popper .el-select-dropdown__item", { hasText: "年付+" }).first().click();
    await page.waitForFunction(() =>
      document.querySelector("[data-filter-dock] [data-filter-select='cycle']")?.classList.contains("is-filtered")
    );
    // Move focus to preceding quick-saved switch so cycle select is blurred, then Tab into cycle select
    await page.locator("[data-filter-dock] [data-action='toggle-quick-saved'] input[role='switch']").focus();
    await page.waitForFunction(() => {
      const w = document.querySelector("[data-filter-dock] [data-filter-select='cycle'] .el-select__wrapper");
      if (!w) return false;
      const cs = getComputedStyle(w);
      return (
        !w.classList.contains("is-focused") &&
        !cs.boxShadow.includes("3px") &&
        cs.backgroundColor === "rgb(239, 246, 255)"
      );
    });
    const cycleUnfocusedStyle = await page.evaluate(() => {
      const w = document.querySelector("[data-filter-dock] [data-filter-select='cycle'] .el-select__wrapper");
      const cs = getComputedStyle(w);
      return {
        isFocused: w.classList.contains("is-focused"),
        boxShadow: cs.boxShadow,
        backgroundColor: cs.backgroundColor
      };
    });
    assert.equal(cycleUnfocusedStyle.isFocused, false);
    await page.keyboard.press("Tab");
    await page.waitForFunction(() => {
      const w = document.querySelector("[data-filter-dock] [data-filter-select='cycle'] .el-select__wrapper");
      return Boolean(w && w.classList.contains("is-focused") && getComputedStyle(w).boxShadow.includes("3px"));
    });
    const cycleFocusedStyle = await page.evaluate(() => {
      const w = document.querySelector("[data-filter-dock] [data-filter-select='cycle'] .el-select__wrapper");
      const cs = getComputedStyle(w);
      return {
        isFocused: w.classList.contains("is-focused"),
        boxShadow: cs.boxShadow,
        backgroundColor: cs.backgroundColor
      };
    });
    assert.equal(cycleFocusedStyle.isFocused, true);
    assert.notEqual(
      cycleFocusedStyle.boxShadow,
      cycleUnfocusedStyle.boxShadow,
      `Filtered RadarSelect must display a distinct focus ring on Tab: unfocused=${cycleUnfocusedStyle.boxShadow} focused=${cycleFocusedStyle.boxShadow}`
    );
    assert.equal(
      cycleFocusedStyle.backgroundColor,
      cycleUnfocusedStyle.backgroundColor,
      "Filtered RadarSelect must retain filtered fill when focused"
    );
    await page.locator("[data-filter-dock] [data-action='reset-filters']").click();
    await page.waitForFunction(
      () => !document.querySelector("[data-filter-dock] [data-filter-select='cycle']")?.classList.contains("is-filtered")
    );

    // Verify filterable RadarSelect keyboard search + Enter (zero-match Enter must NOT submit hidden option; matching search + Enter selects visible match!)
    await page.locator("[data-filter-dock] [data-filter-select='region'] .el-select__wrapper").click();
    await page.waitForSelector(".radar-select-popper .el-select-dropdown__item");
    const regionCombo = page.locator("[data-filter-dock] [data-filter-select='region'] [role='combobox']");
    await regionCombo.fill("不存在地区XYZ");
    await page.keyboard.press("Enter");
    assert.doesNotMatch(
      page.url(),
      /region=/,
      "Zero-match Enter in filterable RadarSelect must not submit a hidden option"
    );
    assert.equal(
      await regionCombo.getAttribute("aria-expanded"),
      "true",
      "Zero-match Enter in filterable RadarSelect must keep empty-state dropdown open"
    );
    await regionCombo.fill("日本");
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".radar-select-popper .el-select-dropdown__item:not([style*='display: none'])")
          .length >= 1
    );
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.location.search.includes("region=JP"));
    assert.match(
      (await page.locator("[data-filter-dock] [data-filter-select='region']").textContent()) || "",
      /日本/,
      "Enter after filtering RadarSelect must commit the visible matching region"
    );

    // Verify Element Plus RadarSelect (ElSelect) mouse dropdown selection, plain primary button contrast in light & dark themes, and html.dark sync
    await page.locator("[data-filter-dock] [data-filter-select='region'] .el-select__wrapper").click();
    await page.waitForSelector(".radar-select-popper[aria-hidden='false'] .el-select-dropdown__item");
    await page
      .locator(".radar-select-popper[aria-hidden='false'] .el-select-dropdown__item", { hasText: "美国" })
      .first()
      .click();
    await page.waitForFunction(() => window.location.search.includes("region=US"));

    const measurePairContrast = async (fgSelector, bgSelector = fgSelector) =>
      page.evaluate(
        ({ fSel, bSel }) => {
          const fgEl = document.querySelector(fSel);
          const bgEl = document.querySelector(bSel);
          if (!fgEl || !bgEl) return null;
          const parseRgb = (str) => {
            const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
          };
          const lum = ([r, g, b]) =>
            [r, g, b]
              .map((c) => {
                const s = c / 255;
                return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
              })
              .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
          const csFg = getComputedStyle(fgEl);
          const csBg = getComputedStyle(bgEl);
          const fg = parseRgb(csFg.color);
          const bg = parseRgb(csBg.backgroundColor);
          const ratio =
            fg && bg
              ? (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05)
              : 0;
          return {
            theme: document.documentElement.getAttribute("data-theme"),
            color: csFg.color,
            backgroundColor: csBg.backgroundColor,
            backgroundImage: csBg.backgroundImage,
            focusVisible: fgEl.matches(":focus-visible"),
            contrast: Number(ratio.toFixed(2))
          };
        },
        { fSel: fgSelector, bSel: bgSelector }
      );

    const lightPlain = await measurePairContrast("[data-filter-dock] [data-action='reset-filters']");
    assert.ok(lightPlain, "Expected visible plain primary reset button");
    assert.equal(lightPlain.backgroundImage, "none", `Plain primary button must not inherit dark gradient: ${JSON.stringify(lightPlain)}`);
    assert.ok(lightPlain.contrast >= 4.5, `Light plain primary button contrast < 4.5: ${JSON.stringify(lightPlain)}`);

    await page.locator("[data-app-header] [data-action='toggle-theme']").click();
    await page.waitForFunction(
      () =>
        document.documentElement.getAttribute("data-theme") === "dark" &&
        document.documentElement.classList.contains("dark")
    );
    const darkPlain = await measurePairContrast("[data-filter-dock] [data-action='reset-filters']");
    assert.equal(darkPlain.backgroundImage, "none", `Dark plain primary button must not inherit gradient: ${JSON.stringify(darkPlain)}`);
    assert.ok(darkPlain.contrast >= 4.5, `Dark plain primary button contrast < 4.5: ${JSON.stringify(darkPlain)}`);

    // Verify dark-mode StatusBanner refresh-failure danger plain retry button contrast >= 4.5:1 in normal, hover, AND keyboard :focus-visible states
    const failRefreshRoute = async (route) => {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "e2e-503" }) });
    };
    await page.route("**/api/v1/pulse*", failRefreshRoute);
    await page.route("**/data/v2/latest.json*", failRefreshRoute);
    await page.route("**/data/products.json*", failRefreshRoute);
    await page.locator("[data-app-header] [data-action='refresh-snapshot']").click();
    await page.waitForSelector("[data-status-banner] [data-action='refresh-snapshot']");
    const darkDangerNormal = await measurePairContrast("[data-status-banner] [data-action='refresh-snapshot']");
    assert.ok(
      darkDangerNormal && darkDangerNormal.contrast >= 4.5,
      `Dark error banner retry button normal contrast must be >= 4.5:1: ${JSON.stringify(darkDangerNormal)}`
    );
    await page.locator("[data-status-banner] [data-action='refresh-snapshot']").hover();
    const darkDangerHover = await measurePairContrast("[data-status-banner] [data-action='refresh-snapshot']");
    assert.ok(
      darkDangerHover && darkDangerHover.contrast >= 4.5,
      `Dark error banner retry button hover contrast must be >= 4.5:1: ${JSON.stringify(darkDangerHover)}`
    );
    // Move mouse away and reach retry button via keyboard Tab to test real :focus-visible styling
    await page.mouse.move(1, 1);
    await page.locator("[data-app-header] [data-stat='blocked']").focus();
    let reachedRetryViaTab = false;
    for (let step = 0; step < 5; step += 1) {
      await page.keyboard.press("Tab");
      reachedRetryViaTab = await page.evaluate(
        () =>
          document.activeElement ===
          document.querySelector("[data-status-banner] [data-action='refresh-snapshot']")
      );
      if (reachedRetryViaTab) break;
    }
    assert.equal(reachedRetryViaTab, true, "Keyboard Tab must reach StatusBanner retry button");
    const darkDangerFocus = await measurePairContrast("[data-status-banner] [data-action='refresh-snapshot']");
    assert.equal(darkDangerFocus.focusVisible, true, "Retry button must match :focus-visible after keyboard Tab");
    assert.ok(
      darkDangerFocus && darkDangerFocus.contrast >= 4.5,
      `Dark error banner retry button :focus-visible contrast must be >= 4.5:1: ${JSON.stringify(darkDangerFocus)}`
    );
    // Recover from simulated refresh failure cleanly
    await page.unroute("**/api/v1/pulse*", failRefreshRoute);
    await page.unroute("**/data/v2/latest.json*", failRefreshRoute);
    await page.unroute("**/data/products.json*", failRefreshRoute);
    await page.locator("[data-status-banner] [data-action='refresh-snapshot']").click();
    await page.waitForFunction(() => Boolean(document.querySelector("[data-app-banner]")?.hidden));

    // Verify dark-mode filtered RadarSelect selected-value text contrast >= 4.5:1 (composited over toolbar bg) AND keyboard focus ring + persistent=false label retention
    await page.locator("[data-filter-dock] [data-filter-select='cycle'] .el-select__wrapper").click();
    await page.locator(".radar-select-popper .el-select-dropdown__item", { hasText: "年付+" }).first().click();
    await page.waitForFunction(() =>
      document.querySelector("[data-filter-dock] [data-filter-select='cycle']")?.classList.contains("is-filtered")
    );
    await page.locator("[data-filter-dock] [data-action='toggle-quick-saved'] input[role='switch']").focus();
    await page.waitForFunction(() => {
      const w = document.querySelector("[data-filter-dock] [data-filter-select='cycle'] .el-select__wrapper");
      return Boolean(w && !w.classList.contains("is-focused") && !getComputedStyle(w).boxShadow.includes("3px"));
    });
    const darkCycleCheck = await page.evaluate(() => {
      const selectEl = document.querySelector("[data-filter-dock] [data-filter-select='cycle']");
      const wrapper = selectEl?.querySelector(".el-select__wrapper");
      const labelEl = selectEl?.querySelector(".el-select__placeholder span") || selectEl?.querySelector(".el-select__selected-item");
      const parseRgba = (str) => {
        const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : null;
      };
      const compositeOver = (fg, bg) => {
        const a = fg[3];
        return [
          Math.round(fg[0] * a + bg[0] * (1 - a)),
          Math.round(fg[1] * a + bg[1] * (1 - a)),
          Math.round(fg[2] * a + bg[2] * (1 - a)),
          1
        ];
      };
      // Walk up ancestors to compute actual opaque backdrop behind wrapper
      const layers = [];
      for (let el = wrapper; el; el = el.parentElement) {
        const bg = parseRgba(getComputedStyle(el).backgroundColor);
        if (bg && bg[3] > 0) {
          layers.push(bg);
          if (bg[3] >= 1) break;
        }
      }
      let effectiveBg = [11, 18, 32, 1];
      for (let i = layers.length - 1; i >= 0; i -= 1) {
        effectiveBg = compositeOver(layers[i], effectiveBg);
      }
      const fg = parseRgba(getComputedStyle(labelEl).color);
      const lum = ([r, g, b]) =>
        [r, g, b]
          .map((c) => {
            const s = c / 255;
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
          })
          .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
      const ratio = fg ? (Math.max(lum(fg), lum(effectiveBg)) + 0.05) / (Math.min(lum(fg), lum(effectiveBg)) + 0.05) : 0;
      return {
        labelText: labelEl?.textContent?.trim() || "",
        color: getComputedStyle(labelEl).color,
        effectiveBg: `rgb(${effectiveBg[0]}, ${effectiveBg[1]}, ${effectiveBg[2]})`,
        boxShadow: getComputedStyle(wrapper).boxShadow,
        contrast: Number(ratio.toFixed(2))
      };
    });
    assert.match(darkCycleCheck.labelText, /年付\+/);
    assert.ok(
      darkCycleCheck.contrast >= 4.5,
      `Dark filtered RadarSelect label contrast must be >= 4.5:1 over composited toolbar bg: ${JSON.stringify(darkCycleCheck)}`
    );
    await page.keyboard.press("Tab");
    await page.waitForFunction(() => {
      const w = document.querySelector("[data-filter-dock] [data-filter-select='cycle'] .el-select__wrapper");
      return Boolean(w && w.classList.contains("is-focused") && getComputedStyle(w).boxShadow.includes("3px"));
    });
    const darkCycleFocusedShadow = await page.evaluate(
      () => getComputedStyle(document.querySelector("[data-filter-dock] [data-filter-select='cycle'] .el-select__wrapper")).boxShadow
    );
    assert.notEqual(
      darkCycleFocusedShadow,
      darkCycleCheck.boxShadow,
      "Dark filtered RadarSelect must preserve distinct keyboard focus ring"
    );

    // Re-open cycle dropdown in dark mode and verify expanded .el-select-dropdown__item.is-selected text contrast >= 4.5:1
    await page.locator("[data-filter-dock] [data-filter-select='cycle'] .el-select__wrapper").click();
    await page.waitForSelector(".radar-select-popper .el-select-dropdown__item.is-selected");
    const darkSelectedOptionCheck = await page.evaluate(() => {
      const item = document.querySelector(".radar-select-popper .el-select-dropdown__item.is-selected");
      const parseRgba = (str) => {
        const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : null;
      };
      const compositeOver = (fg, bg) => {
        const a = fg[3];
        return [
          Math.round(fg[0] * a + bg[0] * (1 - a)),
          Math.round(fg[1] * a + bg[1] * (1 - a)),
          Math.round(fg[2] * a + bg[2] * (1 - a)),
          1
        ];
      };
      const layers = [];
      for (let el = item; el; el = el.parentElement) {
        const bg = parseRgba(getComputedStyle(el).backgroundColor);
        if (bg && bg[3] > 0) {
          layers.push(bg);
          if (bg[3] >= 1) break;
        }
      }
      let effectiveBg = [17, 24, 39, 1];
      for (let i = layers.length - 1; i >= 0; i -= 1) {
        effectiveBg = compositeOver(layers[i], effectiveBg);
      }
      const fg = parseRgba(getComputedStyle(item).color);
      const lum = ([r, g, b]) =>
        [r, g, b]
          .map((c) => {
            const s = c / 255;
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
          })
          .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
      const ratio = fg ? (Math.max(lum(fg), lum(effectiveBg)) + 0.05) / (Math.min(lum(fg), lum(effectiveBg)) + 0.05) : 0;
      return {
        color: getComputedStyle(item).color,
        effectiveBg: `rgb(${effectiveBg[0]}, ${effectiveBg[1]}, ${effectiveBg[2]})`,
        contrast: Number(ratio.toFixed(2))
      };
    });
    assert.ok(
      darkSelectedOptionCheck.contrast >= 4.5,
      `Dark dropdown selected option contrast must be >= 4.5:1: ${JSON.stringify(darkSelectedOptionCheck)}`
    );
    await page.keyboard.press("Escape");

    // Verify dark-mode search input ::placeholder contrast >= 4.5:1
    await page.keyboard.press("Meta+k");
    await page.waitForFunction(() => !document.querySelector("[data-palette-backdrop]")?.hidden);
    const darkPlaceholderContrast = await page.evaluate(() => {
      const input = document.querySelector("[data-palette-input]");
      const dialog = document.querySelector("[data-palette-backdrop] .el-dialog");
      const parseRgba = (str) => {
        const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : null;
      };
      const fg = parseRgba(getComputedStyle(input, "::placeholder").color);
      const bg = parseRgba(getComputedStyle(dialog).backgroundColor);
      const lum = ([r, g, b]) =>
        [r, g, b]
          .map((c) => {
            const s = c / 255;
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
          })
          .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
      const ratio = fg && bg ? (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05) : 0;
      return {
        color: getComputedStyle(input, "::placeholder").color,
        bg: getComputedStyle(dialog).backgroundColor,
        contrast: Number(ratio.toFixed(2))
      };
    });
    assert.ok(
      darkPlaceholderContrast.contrast >= 4.5,
      `Dark search input ::placeholder contrast must be >= 4.5:1: ${JSON.stringify(darkPlaceholderContrast)}`
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => Boolean(document.querySelector("[data-palette-backdrop]")?.hidden));

    await page.locator("[data-app-header] [data-action='toggle-theme']").click();
    await page.waitForFunction(
      () =>
        document.documentElement.getAttribute("data-theme") === "light" &&
        !document.documentElement.classList.contains("dark")
    );
    await page.locator("[data-filter-dock] [data-action='reset-filters']").click();
    await page.waitForFunction(() => !window.location.search.includes("region=US"));

    // Helper: locate deterministic fixture plan via business search so E2E never depends on live catalog top-40 ranking
    const searchInTerminal = async (query) => {
      await page.keyboard.press("Meta+k");
      await page.waitForFunction(() => document.activeElement === document.querySelector("[data-palette-input]"));
      await page.locator("[data-palette-input]").fill(query);
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => Boolean(document.querySelector("[data-palette-backdrop]")?.hidden));
    };

    // Open deterministic tagged plan in InspectorDrawer, and verify:
    // 1) Real keyboard Tab reaches focusable [data-tag-tip] inside InspectorDrawer & sets aria-describedby
    // 2) [data-tag-hud] renders ABOVE ElDrawer & within viewport
    // 3) First Escape closes ONLY the HUD (drawer stays open)
    // 4) Second Escape closes the drawer AND restores focus
    await searchInTerminal("Amsterdam E2E Deterministic");
    const targetRow = page.locator(".terminal-table tr[data-product-id='e2e-fixed-tagged-bwh-ams']");
    await targetRow.waitFor({ state: "visible" });
    // Verify PlanTagBadge & ShopTagBadge render via ElTag and VirtualPlanTable action buttons render via ElButton without bubbling to InspectorDrawer
    assert.ok(
      (await targetRow.locator(".plan-tag.el-tag").count()) > 0,
      "Deterministic fixture plan must render PlanTagBadge as ElTag under valid FX clock"
    );
    assert.ok(
      (await page.locator("[data-filter-dock] .shop-tag.el-tag").count()) > 0,
      "ShopTagBadge in FilterDock must render as ElTag"
    );
    const tableSaveBtn = targetRow.locator("button.el-button[data-action='toggle-save']").first();
    const tableCompareBtn = targetRow.locator("button.el-button[data-action='toggle-compare']").first();
    await tableSaveBtn.click();
    assert.equal(await tableSaveBtn.getAttribute("aria-pressed"), "true");
    assert.equal(
      await page.evaluate(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden)),
      true,
      "Clicking table ElButton toggle-save must not open InspectorDrawer"
    );
    await tableSaveBtn.click();
    assert.equal(await tableSaveBtn.getAttribute("aria-pressed"), "false");
    await tableCompareBtn.click();
    assert.equal(await tableCompareBtn.getAttribute("aria-pressed"), "true");
    assert.equal(
      await page.evaluate(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden)),
      true,
      "Clicking table ElButton toggle-compare must not open InspectorDrawer"
    );
    await tableCompareBtn.click();
    assert.equal(await tableCompareBtn.getAttribute("aria-pressed"), "false");
    await targetRow.click();
    await page.waitForFunction(() => !document.querySelector("[data-inspector-backdrop]")?.hidden);
    await page.getByRole("dialog", { name: "套餐解析证据与定价解剖" }).waitFor({ state: "visible" });
    await page.waitForSelector("[data-inspector-backdrop] .el-drawer");
    await page.waitForFunction(() => {
      const d = document.querySelector("[data-inspector-backdrop] .el-drawer");
      if (!d) return false;
      const r = d.getBoundingClientRect();
      return r.width > 300 && r.right <= 1441;
    });
    let reachedDrawerTag = false;
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press("Tab");
      reachedDrawerTag = await page.evaluate(() => {
        const active = document.activeElement;
        return Boolean(
          active?.closest?.("[data-inspector-backdrop]") && active?.hasAttribute?.("data-tag-tip")
        );
      });
      if (reachedDrawerTag) break;
    }
    assert.equal(reachedDrawerTag, true, "Keyboard Tab must reach focusable [data-tag-tip] inside InspectorDrawer");
    await page.waitForFunction(() => !document.querySelector("[data-tag-hud]")?.hidden);
    const hudLayerCheck = await page.evaluate(() => {
      const hud = document.querySelector("[data-tag-hud]");
      const overlay = document.querySelector("[data-inspector-backdrop] .el-overlay");
      const active = document.activeElement;
      const rect = hud.getBoundingClientRect();
      return {
        describedBy: active?.getAttribute?.("aria-describedby") || "",
        tabIndex: active?.tabIndex ?? -1,
        hudZ: Number.parseInt(getComputedStyle(hud).zIndex || "0", 10),
        overlayZ: Number.parseInt(getComputedStyle(overlay).zIndex || "0", 10),
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom
      };
    });
    assert.equal(hudLayerCheck.tabIndex, 0, "Drawer tag badge must have tabIndex=0");
    assert.match(hudLayerCheck.describedBy, /radar-tag-hud/);
    assert.ok(
      hudLayerCheck.hudZ > hudLayerCheck.overlayZ,
      `Tag HUD z-index must exceed ElDrawer overlay: ${JSON.stringify(hudLayerCheck)}`
    );
    assert.ok(
      hudLayerCheck.left >= 0 &&
        hudLayerCheck.top >= 0 &&
        hudLayerCheck.right <= 1440 &&
        hudLayerCheck.bottom <= 900,
      `In-drawer Tag HUD exceeded viewport: ${JSON.stringify(hudLayerCheck)}`
    );
    // First Escape: must close ONLY the Tag HUD and keep InspectorDrawer open
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => Boolean(document.querySelector("[data-tag-hud]")?.hidden));
    const drawerStillOpenAfterFirstEsc = await page.evaluate(
      () =>
        !document.querySelector("[data-inspector-backdrop]")?.hidden &&
        Boolean(document.querySelector("[data-inspector-backdrop] .el-drawer"))
    );
    assert.equal(
      drawerStillOpenAfterFirstEsc,
      true,
      "First Escape while HUD is open must close only the HUD and keep InspectorDrawer open"
    );
    // Wait for lazy SourceAudit fetch to settle, then second Escape closes drawer and restores focus
    await page.waitForFunction(() => !document.querySelector("[data-audit-loading]"));
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));
    const drawerRestoredFocus = await page.evaluate(() => document.activeElement?.id || "");
    assert.equal(
      drawerRestoredFocus,
      "main-workspace",
      `Second Escape must restore focus to main workspace after row-click drawer close (got ${drawerRestoredFocus})`
    );

    // Also verify button-triggered ElDrawer, CompareDock named remove buttons, and nested Compare -> Palette -> Inspector Escape stack!
    await page.locator("[data-app-header] [data-action='open-saved']").click();
    await page.waitForFunction(() => !document.querySelector("[data-saved-backdrop]")?.hidden);
    await page.getByRole("dialog", { name: "本地收藏夹" }).waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => Boolean(document.querySelector("[data-saved-backdrop]")?.hidden));
    const savedBtnFocus = await page.evaluate(
      () => document.activeElement?.getAttribute?.("data-action") || ""
    );
    assert.equal(
      savedBtnFocus,
      "open-saved",
      `Escape on SavedDrawer must restore focus to open-saved button (got ${savedBtnFocus})`
    );

    // Add deterministic plan first (currently filtered to it), then reset to full catalog and pick a guaranteed-distinct second plan
    await targetRow.locator("button[data-action='toggle-compare']").first().click();
    await page.locator("[data-filter-dock] [data-action='reset-filters']").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".terminal-table tr[data-product-id]").length >= 12
    );
    const secondDistinctRow = page
      .locator(".terminal-table tr[data-product-id]:not([data-product-id='e2e-fixed-tagged-bwh-ams'])")
      .first();
    await secondDistinctRow.waitFor({ state: "visible" });
    await secondDistinctRow.locator("button[data-action='toggle-compare']").first().click();
    const namedRemoveBtn = page.getByRole("button", {
      name: "移出 The Amsterdam E2E Deterministic Long Plan Name"
    });
    await namedRemoveBtn.waitFor({ state: "visible" });
    assert.equal(
      await namedRemoveBtn.evaluate((el) =>
        el.matches("button.el-button.dock-pill-close[data-action='toggle-compare']")
      ),
      true,
      "CompareDock per-item remove control must render as ElButton"
    );
    await namedRemoveBtn.click();
    await page.waitForFunction(
      () => document.querySelectorAll("[data-compare-dock] .dock-pill").length === 1
    );
    await searchInTerminal("Amsterdam E2E Deterministic");
    await targetRow.waitFor({ state: "visible" });
    await targetRow.locator("button[data-action='toggle-compare']").first().click();

    await page.locator("[data-app-header] [data-action='open-compare']").click();
    await page.waitForFunction(() => !document.querySelector("[data-compare-modal]")?.hidden);
    await page.getByRole("dialog", { name: "多方案关键指标横向对比" }).waitFor({ state: "visible" });

    // Stack CommandPalette -> InspectorDrawer on top of CompareModal
    await page.keyboard.press("Meta+k");
    await page.getByRole("dialog", { name: "全局快速检索" }).waitFor({ state: "visible" });
    await page.locator("[data-palette-backdrop] button[data-action='palette-plan']").first().click();
    await page.getByRole("dialog", { name: "套餐解析证据与定价解剖" }).waitFor({ state: "visible" });
    assert.match(page.url(), /inspect=/);
    assert.match(page.url(), /compareOpen=1/);

    // Open the shared stacked URL (?compare=...&compareOpen=1&inspect=...) in a fresh page:
    // InspectorDrawer MUST open ON TOP of CompareModal with higher z-index, active focus, and Escape closes Inspector FIRST then CompareModal!
    const sharedStackedUrl = page.url();
    const sharedPage = await desktopCtx.newPage();
    const sharedErrors = [];
    sharedPage.on("pageerror", (err) => sharedErrors.push(err.message));
    await sharedPage.goto(sharedStackedUrl, { waitUntil: "networkidle" });
    await sharedPage.waitForSelector("[data-compare-modal] .el-overlay");
    await sharedPage.waitForSelector("[data-inspector-backdrop] .el-overlay");
    await sharedPage.waitForFunction(() =>
      Boolean(document.querySelector("[data-inspector-backdrop]")?.contains(document.activeElement))
    );
    const sharedLayerOrder = await sharedPage.evaluate(() => {
      const compOverlay = document.querySelector("[data-compare-modal] .el-overlay");
      const inspOverlay = document.querySelector("[data-inspector-backdrop] .el-overlay");
      return {
        compareZ: Number.parseInt(getComputedStyle(compOverlay).zIndex || "0", 10),
        inspectorZ: Number.parseInt(getComputedStyle(inspOverlay).zIndex || "0", 10),
        focusInInspector: Boolean(
          document.querySelector("[data-inspector-backdrop]")?.contains(document.activeElement)
        )
      };
    });
    assert.ok(
      sharedLayerOrder.inspectorZ > sharedLayerOrder.compareZ,
      `Shared URL InspectorDrawer must stack above CompareModal: ${JSON.stringify(sharedLayerOrder)}`
    );
    assert.equal(sharedLayerOrder.focusInInspector, true, "Shared URL must focus InspectorDrawer on top");
    await sharedPage.keyboard.press("Escape");
    await sharedPage.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));
    assert.doesNotMatch(sharedPage.url(), /inspect=/);
    assert.match(sharedPage.url(), /compareOpen=1/);
    const sharedAfterFirstEsc = await sharedPage.evaluate(() => {
      const modal = document.querySelector("[data-compare-modal]");
      return {
        compareOpen: Boolean(modal && !modal.hidden),
        focusInCompare: Boolean(modal?.contains(document.activeElement))
      };
    });
    assert.equal(sharedAfterFirstEsc.compareOpen, true, "First Escape on shared URL must keep CompareModal open");
    assert.equal(
      sharedAfterFirstEsc.focusInCompare,
      true,
      `First Escape on shared URL must return focus inside CompareModal: ${JSON.stringify(sharedAfterFirstEsc)}`
    );
    await sharedPage.keyboard.press("Escape");
    await sharedPage.waitForFunction(() => Boolean(document.querySelector("[data-compare-modal]")?.hidden));
    assert.deepEqual(sharedErrors, [], `Unexpected shared-URL page errors: ${sharedErrors.join("; ")}`);
    await sharedPage.close();

    // Slow-snapshot CommandPalette regression: user clicks header search ElButton & starts typing BEFORE slow snapshot returns;
    // arriving snapshot must NOT mount CompareModal/InspectorDrawer above CommandPalette or steal typing focus;
    // first Escape closes CommandPalette ONLY and then reveals CompareModal + InspectorDrawer (preserving compareOpen & inspect).
    const slowPalettePage = await desktopCtx.newPage();
    const slowPaletteErrors = [];
    slowPalettePage.on("pageerror", (err) => slowPaletteErrors.push(err.message));
    let releaseSlowSnapshot = null;
    const slowSnapshotGate = new Promise((resolve) => {
      releaseSlowSnapshot = resolve;
    });
    const holdSlowSnapshotHandler = async (route) => {
      await slowSnapshotGate;
      await route.continue().catch(() => {});
    };
    await slowPalettePage.route("**/api/v1/pulse*", holdSlowSnapshotHandler);
    await slowPalettePage.route("**/data/v2/latest.json*", holdSlowSnapshotHandler);
    await slowPalettePage.goto(sharedStackedUrl, { waitUntil: "domcontentloaded" });
    const headerSearchElBtn = slowPalettePage.locator("[data-app-header] button.el-button.cmd-search-trigger[data-action='open-palette']");
    await headerSearchElBtn.waitFor({ state: "visible" });
    await headerSearchElBtn.click();
    await slowPalettePage.getByRole("dialog", { name: "全局快速检索" }).waitFor({ state: "visible" });
    await slowPalettePage.waitForFunction(
      () => document.activeElement === document.querySelector("[data-palette-input]")
    );
    await slowPalettePage.keyboard.type("香港");
    releaseSlowSnapshot();
    await slowPalettePage.waitForFunction(
      () =>
        document.querySelectorAll(".terminal-table tr[data-product-id]").length >= 1 &&
        document.querySelectorAll("[data-palette-backdrop] [data-action='palette-plan']").length >= 1
    );
    await slowPalettePage.unroute("**/api/v1/pulse*", holdSlowSnapshotHandler);
    await slowPalettePage.unroute("**/data/v2/latest.json*", holdSlowSnapshotHandler);
    // Allow multiple ticks/animation frames to confirm deferred CompareModal/InspectorDrawer never preempt CommandPalette
    await slowPalettePage.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    await slowPalettePage.keyboard.type("家宽");
    const slowPaletteState = await slowPalettePage.evaluate(() => ({
      paletteOpen: !document.querySelector("[data-palette-backdrop]")?.hidden,
      compareHidden: Boolean(document.querySelector("[data-compare-modal]")?.hidden),
      inspectorHidden: Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden),
      inputFocused: document.activeElement === document.querySelector("[data-palette-input]"),
      inputValue: document.querySelector("[data-palette-input]")?.value || ""
    }));
    assert.deepEqual(
      slowPaletteState,
      {
        paletteOpen: true,
        compareHidden: true,
        inspectorHidden: true,
        inputFocused: true,
        inputValue: "香港家宽"
      },
      `Slow snapshot arrival must preserve CommandPalette top layer and typing focus: ${JSON.stringify(slowPaletteState)}`
    );
    await slowPalettePage.keyboard.press("Escape");
    await slowPalettePage.waitForFunction(() => Boolean(document.querySelector("[data-palette-backdrop]")?.hidden));
    await slowPalettePage.waitForSelector("[data-compare-modal] .el-overlay");
    await slowPalettePage.waitForSelector("[data-inspector-backdrop] .el-overlay");
    await slowPalettePage.waitForFunction(() =>
      Boolean(document.querySelector("[data-inspector-backdrop]")?.contains(document.activeElement))
    );
    assert.match(slowPalettePage.url(), /compareOpen=1/);
    assert.match(slowPalettePage.url(), /inspect=/);
    const afterPaletteLayerOrder = await slowPalettePage.evaluate(() => {
      const compOverlay = document.querySelector("[data-compare-modal] .el-overlay");
      const inspOverlay = document.querySelector("[data-inspector-backdrop] .el-overlay");
      return {
        compareZ: Number.parseInt(getComputedStyle(compOverlay).zIndex || "0", 10),
        inspectorZ: Number.parseInt(getComputedStyle(inspOverlay).zIndex || "0", 10)
      };
    });
    assert.ok(
      afterPaletteLayerOrder.inspectorZ > afterPaletteLayerOrder.compareZ,
      `After closing CommandPalette, InspectorDrawer must stack above CompareModal: ${JSON.stringify(afterPaletteLayerOrder)}`
    );
    await slowPalettePage.keyboard.press("Escape");
    await slowPalettePage.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));
    await slowPalettePage.keyboard.press("Escape");
    await slowPalettePage.waitForFunction(() => Boolean(document.querySelector("[data-compare-modal]")?.hidden));
    // Verify header manual refresh button renders as ElButton, disables during refresh, and completes cleanly
    const headerRefreshBtn = slowPalettePage.locator("[data-app-header] button.el-button.tele-pill-btn[data-action='refresh-snapshot']");
    await headerRefreshBtn.waitFor({ state: "visible" });
    let releaseManualRefresh = null;
    const manualRefreshGate = new Promise((resolve) => {
      releaseManualRefresh = resolve;
    });
    const holdRefreshHandler = async (route) => {
      await manualRefreshGate;
      await route.continue().catch(() => {});
    };
    await slowPalettePage.route("**/api/v1/pulse*", holdRefreshHandler);
    await headerRefreshBtn.click();
    await slowPalettePage.waitForFunction(
      () => Boolean(document.querySelector("[data-app-header] button.el-button.tele-pill-btn[data-action='refresh-snapshot']")?.disabled)
    );
    releaseManualRefresh();
    await slowPalettePage.waitForFunction(
      () => !document.querySelector("[data-app-header] button.el-button.tele-pill-btn[data-action='refresh-snapshot']")?.disabled
    );
    await slowPalettePage.unroute("**/api/v1/pulse*", holdRefreshHandler);
    assert.deepEqual(slowPaletteErrors, [], `Unexpected slow-palette page errors: ${slowPaletteErrors.join("; ")}`);
    await slowPalettePage.close();

    // Slow-snapshot SavedDrawer & idle-Escape regression:
    // 1. Before snapshot returns (no visible overlay), pressing Escape must NOT strip pending inspect/compareOpen from URL
    //    and must still collapse visible page controls such as expanded shop list.
    // 2. Opening SavedDrawer before snapshot returns must keep SavedDrawer on top & focused when snapshot arrives;
    //    Escape closes SavedDrawer ONLY, then reveals CompareModal underneath InspectorDrawer with both URL params intact.
    const slowSavedPage = await desktopCtx.newPage();
    const slowSavedErrors = [];
    slowSavedPage.on("pageerror", (err) => slowSavedErrors.push(err.message));
    let releaseSlowSavedSnapshot = null;
    const slowSavedGate = new Promise((resolve) => {
      releaseSlowSavedSnapshot = resolve;
    });
    const holdSlowSavedHandler = async (route) => {
      await slowSavedGate;
      await route.continue().catch(() => {});
    };
    await slowSavedPage.route("**/api/v1/pulse*", holdSlowSavedHandler);
    await slowSavedPage.route("**/data/v2/latest.json*", holdSlowSavedHandler);
    await slowSavedPage.goto(sharedStackedUrl, { waitUntil: "domcontentloaded" });
    await slowSavedPage.waitForSelector("[data-app-header] [data-action='open-saved']");
    const preSnapshotHidden = await slowSavedPage.evaluate(() => ({
      compareHidden: Boolean(document.querySelector("[data-compare-modal]")?.hidden),
      inspectorHidden: Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden),
      savedHidden: Boolean(document.querySelector("[data-saved-backdrop]")?.hidden)
    }));
    assert.deepEqual(
      preSnapshotHidden,
      { compareHidden: true, inspectorHidden: true, savedHidden: true },
      `Pending shared-URL overlays must remain hidden before slow snapshot returns: ${JSON.stringify(preSnapshotHidden)}`
    );
    // Before first snapshot resolves comparedPlans, header compare button must stay disabled and interacting with it
    // must preserve compareOpen=1 in URL without prematurely opening InspectorDrawer.
    const slowHeaderCompareBtn = slowSavedPage.locator("[data-app-header] [data-action='open-compare']");
    await slowHeaderCompareBtn.waitFor({ state: "visible" });
    assert.equal(
      await slowHeaderCompareBtn.isDisabled(),
      true,
      "Header compare button must be disabled before initial snapshot resolves comparedPlans"
    );
    await slowHeaderCompareBtn.click({ force: true });
    assert.match(slowSavedPage.url(), /compareOpen=1/, "Clicking disabled header compare during loading must keep compareOpen=1");
    assert.equal(
      await slowSavedPage.evaluate(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden)),
      true,
      "Clicking header compare during loading must not prematurely reveal InspectorDrawer"
    );
    // Pressing Escape while no overlay is visible must keep inspect & compareOpen in URL intact
    await slowSavedPage.keyboard.press("Escape");
    assert.match(slowSavedPage.url(), /inspect=/, "Idle Escape during loading must preserve pending inspect URL param");
    assert.match(slowSavedPage.url(), /compareOpen=1/, "Idle Escape during loading must preserve pending compareOpen URL param");
    // Expand shops list during loading & verify Escape collapses shops list without stripping pending inspect/compareOpen
    const slowToggleShopsBtn = slowSavedPage.locator("[data-action='toggle-shops-expand']").first();
    if (await slowToggleShopsBtn.isVisible()) {
      await slowToggleShopsBtn.click();
      await slowSavedPage.waitForFunction(
        () => document.querySelector("[data-action='toggle-shops-expand']")?.getAttribute("aria-expanded") === "true"
      );
      await slowSavedPage.keyboard.press("Escape");
      await slowSavedPage.waitForFunction(
        () => document.querySelector("[data-action='toggle-shops-expand']")?.getAttribute("aria-expanded") === "false"
      );
      assert.match(slowSavedPage.url(), /inspect=/, "Shop-collapse Escape during loading must preserve inspect URL param");
      assert.match(slowSavedPage.url(), /compareOpen=1/, "Shop-collapse Escape during loading must preserve compareOpen URL param");
    }
    // Open SavedDrawer before snapshot returns
    await slowSavedPage.locator("[data-app-header] [data-action='open-saved']").click();
    await slowSavedPage.getByRole("dialog", { name: "本地收藏夹" }).waitFor({ state: "visible" });
    await slowSavedPage.waitForFunction(() =>
      Boolean(document.querySelector("[data-saved-backdrop]")?.contains(document.activeElement))
    );
    releaseSlowSavedSnapshot();
    await slowSavedPage.waitForFunction(
      () => document.querySelectorAll(".terminal-table tr[data-product-id]").length >= 1
    );
    await slowSavedPage.unroute("**/api/v1/pulse*", holdSlowSavedHandler);
    await slowSavedPage.unroute("**/data/v2/latest.json*", holdSlowSavedHandler);
    await slowSavedPage.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    const slowSavedState = await slowSavedPage.evaluate(() => ({
      savedOpen: !document.querySelector("[data-saved-backdrop]")?.hidden,
      compareHidden: Boolean(document.querySelector("[data-compare-modal]")?.hidden),
      inspectorHidden: Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden),
      focusInSaved: Boolean(document.querySelector("[data-saved-backdrop]")?.contains(document.activeElement))
    }));
    assert.deepEqual(
      slowSavedState,
      { savedOpen: true, compareHidden: true, inspectorHidden: true, focusInSaved: true },
      `Slow snapshot arrival must preserve SavedDrawer top layer and focus: ${JSON.stringify(slowSavedState)}`
    );
    // First Escape closes SavedDrawer ONLY, preserving inspect & compareOpen, then reveals CompareModal + InspectorDrawer
    await slowSavedPage.keyboard.press("Escape");
    await slowSavedPage.waitForFunction(() => Boolean(document.querySelector("[data-saved-backdrop]")?.hidden));
    await slowSavedPage.waitForSelector("[data-compare-modal] .el-overlay");
    await slowSavedPage.waitForSelector("[data-inspector-backdrop] .el-overlay");
    await slowSavedPage.waitForFunction(() =>
      Boolean(document.querySelector("[data-inspector-backdrop]")?.contains(document.activeElement))
    );
    assert.match(slowSavedPage.url(), /compareOpen=1/);
    assert.match(slowSavedPage.url(), /inspect=/);
    const afterSavedLayerOrder = await slowSavedPage.evaluate(() => {
      const compOverlay = document.querySelector("[data-compare-modal] .el-overlay");
      const inspOverlay = document.querySelector("[data-inspector-backdrop] .el-overlay");
      return {
        compareZ: Number.parseInt(getComputedStyle(compOverlay).zIndex || "0", 10),
        inspectorZ: Number.parseInt(getComputedStyle(inspOverlay).zIndex || "0", 10)
      };
    });
    assert.ok(
      afterSavedLayerOrder.inspectorZ > afterSavedLayerOrder.compareZ,
      `After closing SavedDrawer, InspectorDrawer must stack above CompareModal: ${JSON.stringify(afterSavedLayerOrder)}`
    );
    await slowSavedPage.keyboard.press("Escape");
    await slowSavedPage.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));
    await slowSavedPage.keyboard.press("Escape");
    await slowSavedPage.waitForFunction(() => Boolean(document.querySelector("[data-compare-modal]")?.hidden));
    assert.deepEqual(slowSavedErrors, [], `Unexpected slow-saved page errors: ${slowSavedErrors.join("; ")}`);
    await slowSavedPage.close();

    // Regression 1: On ready page, opening SavedDrawer -> Ctrl+K -> selecting a plan MUST immediately mount
    // InspectorDrawer on top of SavedDrawer with focus (must NOT stay hidden behind SavedDrawer).
    const savedPalettePage = await desktopCtx.newPage();
    const savedPaletteErrors = [];
    savedPalettePage.on("pageerror", (err) => savedPaletteErrors.push(err.message));
    await savedPalettePage.goto(baseUrl, { waitUntil: "networkidle" });
    await savedPalettePage.waitForSelector(".terminal-table tr[data-product-id]");
    await savedPalettePage.locator("[data-app-header] [data-action='open-saved']").click();
    await savedPalettePage.getByRole("dialog", { name: "本地收藏夹" }).waitFor({ state: "visible" });
    await savedPalettePage.keyboard.press("Control+k");
    await savedPalettePage.getByRole("dialog", { name: "全局快速检索" }).waitFor({ state: "visible" });
    await savedPalettePage.locator("[data-palette-backdrop] button[data-action='palette-plan']").first().click();
    await savedPalettePage.getByRole("dialog", { name: "套餐解析证据与定价解剖" }).waitFor({ state: "visible" });
    await savedPalettePage.waitForFunction(() =>
      Boolean(document.querySelector("[data-inspector-backdrop]")?.contains(document.activeElement))
    );
    const savedToInspectorCheck = await savedPalettePage.evaluate(() => {
      const savedOverlay = document.querySelector("[data-saved-backdrop] .el-overlay");
      const inspOverlay = document.querySelector("[data-inspector-backdrop] .el-overlay");
      return {
        paletteHidden: Boolean(document.querySelector("[data-palette-backdrop]")?.hidden),
        savedVisible: !document.querySelector("[data-saved-backdrop]")?.hidden,
        inspectorVisible: !document.querySelector("[data-inspector-backdrop]")?.hidden,
        savedZ: Number.parseInt(getComputedStyle(savedOverlay).zIndex || "0", 10),
        inspectorZ: Number.parseInt(getComputedStyle(inspOverlay).zIndex || "0", 10),
        focusInInspector: Boolean(document.querySelector("[data-inspector-backdrop]")?.contains(document.activeElement))
      };
    });
    assert.equal(savedToInspectorCheck.paletteHidden, true);
    assert.equal(savedToInspectorCheck.savedVisible, true);
    assert.equal(savedToInspectorCheck.inspectorVisible, true);
    assert.ok(
      savedToInspectorCheck.inspectorZ > savedToInspectorCheck.savedZ,
      `InspectorDrawer selected from CommandPalette must stack above SavedDrawer: ${JSON.stringify(savedToInspectorCheck)}`
    );
    assert.equal(savedToInspectorCheck.focusInInspector, true);
    assert.match(savedPalettePage.url(), /inspect=/);
    await savedPalettePage.keyboard.press("Escape");
    await savedPalettePage.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));
    await savedPalettePage.waitForFunction(() =>
      Boolean(document.querySelector("[data-saved-backdrop]")?.contains(document.activeElement))
    );
    await savedPalettePage.keyboard.press("Escape");
    await savedPalettePage.waitForFunction(() => Boolean(document.querySelector("[data-saved-backdrop]")?.hidden));

    // Regression 2: In "未找到对应套餐" InspectorDrawer, focus body "返回列表" button -> Ctrl+K -> select valid plan
    // (which unmounts the previous "返回列表" button); focus MUST recover onto a real focusable control inside
    // InspectorDrawer (e.g. close-inspector) and Tab / Shift+Tab MUST stay trapped inside InspectorDrawer.
    await savedPalettePage.goto(`${baseUrl}/?inspect=e2e-nonexistent-plan-id`, { waitUntil: "networkidle" });
    await savedPalettePage.getByRole("dialog", { name: "套餐证据抽屉" }).waitFor({ state: "visible" });
    const notFoundBackBtn = savedPalettePage.locator("[data-inspector-backdrop] .el-drawer__body [data-action='close-inspector']");
    await notFoundBackBtn.waitFor({ state: "visible" });
    await notFoundBackBtn.focus();
    await savedPalettePage.keyboard.press("Control+k");
    await savedPalettePage.getByRole("dialog", { name: "全局快速检索" }).waitFor({ state: "visible" });
    await savedPalettePage.locator("[data-palette-backdrop] button[data-action='palette-plan']").first().click();
    await savedPalettePage.getByRole("dialog", { name: "套餐解析证据与定价解剖" }).waitFor({ state: "visible" });
    await savedPalettePage.waitForFunction(() => {
      const insp = document.querySelector("[data-inspector-backdrop]");
      const active = document.activeElement;
      return Boolean(insp && active && insp.contains(active) && active.tagName !== "DIV");
    });
    const recoveredFocusTag = await savedPalettePage.evaluate(() => ({
      tag: document.activeElement?.tagName || "",
      action: document.activeElement?.getAttribute?.("data-action") || ""
    }));
    assert.equal(
      recoveredFocusTag.action,
      "close-inspector",
      `Fallback focus after unmounted body button must land on close-inspector button: ${JSON.stringify(recoveredFocusTag)}`
    );
    await savedPalettePage.keyboard.press("Shift+Tab");
    assert.equal(
      await savedPalettePage.evaluate(() =>
        Boolean(document.querySelector("[data-inspector-backdrop]")?.contains(document.activeElement))
      ),
      true,
      "Shift+Tab after unmounted-button focus recovery must stay trapped inside InspectorDrawer"
    );
    await savedPalettePage.keyboard.press("Tab");
    assert.equal(
      await savedPalettePage.evaluate(() =>
        Boolean(document.querySelector("[data-inspector-backdrop]")?.contains(document.activeElement))
      ),
      true,
      "Tab after unmounted-button focus recovery must stay trapped inside InspectorDrawer"
    );
    assert.deepEqual(savedPaletteErrors, [], `Unexpected saved-palette page errors: ${savedPaletteErrors.join("; ")}`);
    await savedPalettePage.close();

    // Regression 3: Slow shared URL (?cmp=...&compareOpen=1&inspect=<sameId>) + open SavedDrawer before snapshot arrives;
    // once snapshot is ready, press Ctrl+K and explicitly pick the EXACT SAME <sameId> plan -> InspectorDrawer MUST
    // immediately un-defer on top of SavedDrawer with focus; 1st Escape closes InspectorDrawer & clears inspect while
    // keeping SavedDrawer open; 2nd Escape closes SavedDrawer & reveals CompareModal.
    const sameInspectUrlObj = new URL(sharedStackedUrl);
    sameInspectUrlObj.searchParams.set("inspect", "e2e-fixed-tagged-bwh-ams");
    const sameInspectPage = await desktopCtx.newPage();
    const sameInspectErrors = [];
    sameInspectPage.on("pageerror", (err) => sameInspectErrors.push(err.message));
    let releaseSameInspectSnap = null;
    const sameInspectGate = new Promise((resolve) => {
      releaseSameInspectSnap = resolve;
    });
    const holdSameInspectHandler = async (route) => {
      await sameInspectGate;
      await route.continue().catch(() => {});
    };
    await sameInspectPage.route("**/api/v1/pulse*", holdSameInspectHandler);
    await sameInspectPage.route("**/data/v2/latest.json*", holdSameInspectHandler);
    await sameInspectPage.goto(sameInspectUrlObj.toString(), { waitUntil: "domcontentloaded" });
    await sameInspectPage.locator("[data-app-header] [data-action='open-saved']").click();
    await sameInspectPage.getByRole("dialog", { name: "本地收藏夹" }).waitFor({ state: "visible" });
    releaseSameInspectSnap();
    await sameInspectPage.waitForFunction(
      () => document.querySelectorAll(".terminal-table tr[data-product-id]").length >= 1
    );
    await sameInspectPage.unroute("**/api/v1/pulse*", holdSameInspectHandler);
    await sameInspectPage.unroute("**/data/v2/latest.json*", holdSameInspectHandler);
    await sameInspectPage.keyboard.press("Control+k");
    await sameInspectPage.getByRole("dialog", { name: "全局快速检索" }).waitFor({ state: "visible" });
    await sameInspectPage.waitForFunction(
      () => document.activeElement === document.querySelector("[data-palette-input]")
    );
    await sameInspectPage.keyboard.type("Amsterdam E2E Deterministic");
    const samePlanPaletteBtn = sameInspectPage.locator(
      "[data-palette-backdrop] button[data-action='palette-plan'][data-product-id='e2e-fixed-tagged-bwh-ams']"
    );
    await samePlanPaletteBtn.waitFor({ state: "visible" });
    await samePlanPaletteBtn.click();
    await sameInspectPage.getByRole("dialog", { name: "套餐解析证据与定价解剖" }).waitFor({ state: "visible" });
    await sameInspectPage.waitForFunction(() =>
      Boolean(document.querySelector("[data-inspector-backdrop]")?.contains(document.activeElement))
    );
    const sameInspectCheck = await sameInspectPage.evaluate(() => {
      const savedOverlay = document.querySelector("[data-saved-backdrop] .el-overlay");
      const inspOverlay = document.querySelector("[data-inspector-backdrop] .el-overlay");
      return {
        paletteHidden: Boolean(document.querySelector("[data-palette-backdrop]")?.hidden),
        savedVisible: !document.querySelector("[data-saved-backdrop]")?.hidden,
        inspectorVisible: !document.querySelector("[data-inspector-backdrop]")?.hidden,
        savedZ: Number.parseInt(getComputedStyle(savedOverlay).zIndex || "0", 10),
        inspectorZ: Number.parseInt(getComputedStyle(inspOverlay).zIndex || "0", 10),
        focusInInspector: Boolean(document.querySelector("[data-inspector-backdrop]")?.contains(document.activeElement))
      };
    });
    assert.equal(sameInspectCheck.paletteHidden, true);
    assert.equal(sameInspectCheck.savedVisible, true);
    assert.equal(sameInspectCheck.inspectorVisible, true);
    assert.ok(
      sameInspectCheck.inspectorZ > sameInspectCheck.savedZ,
      `Explicitly picking same deferred inspectId from CommandPalette must stack InspectorDrawer above SavedDrawer: ${JSON.stringify(sameInspectCheck)}`
    );
    assert.equal(sameInspectCheck.focusInInspector, true);
    assert.match(sameInspectPage.url(), /inspect=e2e-fixed-tagged-bwh-ams/);
    await sameInspectPage.keyboard.press("Escape");
    await sameInspectPage.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));
    assert.doesNotMatch(sameInspectPage.url(), /inspect=/);
    await sameInspectPage.waitForFunction(() =>
      Boolean(document.querySelector("[data-saved-backdrop]")?.contains(document.activeElement))
    );
    await sameInspectPage.keyboard.press("Escape");
    await sameInspectPage.waitForFunction(() => Boolean(document.querySelector("[data-saved-backdrop]")?.hidden));
    await sameInspectPage.waitForSelector("[data-compare-modal] .el-overlay");
    assert.deepEqual(sameInspectErrors, [], `Unexpected same-inspect page errors: ${sameInspectErrors.join("; ")}`);
    await sameInspectPage.close();

    // Regression 4: Browser back (popstate) restoring a standalone ?inspect= entry while user is typing inside
    // CommandPalette MUST keep CommandPalette on top & focused with InspectorDrawer deferred; 1st Escape closes
    // CommandPalette ONLY (preserving ?inspect= in URL) and then reveals InspectorDrawer with focus.
    const popstatePalettePage = await desktopCtx.newPage();
    const popstatePaletteErrors = [];
    popstatePalettePage.on("pageerror", (err) => popstatePaletteErrors.push(err.message));
    await popstatePalettePage.goto(`${baseUrl}/?inspect=e2e-fixed-tagged-bwh-ams`, { waitUntil: "networkidle" });
    await popstatePalettePage.getByRole("dialog", { name: "套餐解析证据与定价解剖" }).waitFor({ state: "visible" });
    await popstatePalettePage.evaluate(() => {
      window.history.pushState(null, "", "/?provider=bwh");
    });
    await popstatePalettePage.locator("[data-inspector-backdrop] [data-action='close-inspector']").first().click();
    await popstatePalettePage.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));
    assert.doesNotMatch(popstatePalettePage.url(), /inspect=/);
    await popstatePalettePage.keyboard.press("Control+k");
    await popstatePalettePage.getByRole("dialog", { name: "全局快速检索" }).waitFor({ state: "visible" });
    await popstatePalettePage.waitForFunction(
      () => document.activeElement === document.querySelector("[data-palette-input]")
    );
    await popstatePalettePage.keyboard.type("香港");
    await popstatePalettePage.goBack();
    await popstatePalettePage.waitForFunction(() => window.location.href.includes("inspect=e2e-fixed-tagged-bwh-ams"));
    await popstatePalettePage.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    await popstatePalettePage.keyboard.type("家宽");
    const popstatePaletteCheck = await popstatePalettePage.evaluate(() => ({
      paletteVisible: !document.querySelector("[data-palette-backdrop]")?.hidden,
      inspectorHidden: Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden),
      inputFocused: document.activeElement === document.querySelector("[data-palette-input]"),
      inputValue: document.querySelector("[data-palette-input]")?.value || ""
    }));
    assert.deepEqual(
      popstatePaletteCheck,
      { paletteVisible: true, inspectorHidden: true, inputFocused: true, inputValue: "香港家宽" },
      `Popstate restoring standalone inspect must not steal CommandPalette focus: ${JSON.stringify(popstatePaletteCheck)}`
    );
    await popstatePalettePage.keyboard.press("Escape");
    await popstatePalettePage.waitForFunction(() => Boolean(document.querySelector("[data-palette-backdrop]")?.hidden));
    assert.match(popstatePalettePage.url(), /inspect=e2e-fixed-tagged-bwh-ams/);
    await popstatePalettePage.getByRole("dialog", { name: "套餐解析证据与定价解剖" }).waitFor({ state: "visible" });
    await popstatePalettePage.waitForFunction(() =>
      Boolean(document.querySelector("[data-inspector-backdrop]")?.contains(document.activeElement))
    );
    await popstatePalettePage.keyboard.press("Escape");
    await popstatePalettePage.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));
    assert.doesNotMatch(popstatePalettePage.url(), /inspect=/);
    assert.deepEqual(popstatePaletteErrors, [], `Unexpected popstate-palette page errors: ${popstatePaletteErrors.join("; ")}`);
    await popstatePalettePage.close();

    // Regression 5: Slow snapshot replacing a focused placeholder button inside InspectorDrawer ("返回列表")
    // or SavedDrawer ("移除" -> "取消收藏") MUST retain focus inside the topmost drawer (NOT drop to BODY)
    // and keep Tab / Shift+Tab trapped inside the drawer.
    const slowSwapPage = await desktopCtx.newPage();
    const slowSwapErrors = [];
    const slowSwapWarnings = [];
    slowSwapPage.on("pageerror", (err) => slowSwapErrors.push(err.message));
    slowSwapPage.on("console", (msg) => {
      if (msg.type() === "warning" || msg.type() === "error") {
        slowSwapWarnings.push(msg.text());
      }
    });
    let releaseSwapInspSnap = null;
    const swapInspGate = new Promise((resolve) => {
      releaseSwapInspSnap = resolve;
    });
    const holdSwapInspHandler = async (route) => {
      await swapInspGate;
      await route.continue().catch(() => {});
    };
    await slowSwapPage.route("**/api/v1/pulse*", holdSwapInspHandler);
    await slowSwapPage.route("**/data/v2/latest.json*", holdSwapInspHandler);
    await slowSwapPage.goto(`${baseUrl}/?inspect=e2e-fixed-tagged-bwh-ams`, { waitUntil: "domcontentloaded" });
    await slowSwapPage.getByRole("dialog", { name: "套餐证据抽屉" }).waitFor({ state: "visible" });
    await slowSwapPage.waitForSelector("[data-inspector-backdrop] .el-skeleton");
    const inspLoadingText = await slowSwapPage.locator("[data-inspector-backdrop]").textContent();
    assert.match(inspLoadingText || "", /正在加载套餐快照/);
    assert.doesNotMatch(
      inspLoadingText || "",
      /未找到对应套餐/,
      `InspectorDrawer must NOT report missing plan while initial snapshot is loading: ${inspLoadingText}`
    );
    const pendingBackBtn = slowSwapPage.locator("[data-inspector-backdrop] .el-drawer__body [data-action='close-inspector']");
    await pendingBackBtn.waitFor({ state: "visible" });
    await pendingBackBtn.focus();
    releaseSwapInspSnap();
    await slowSwapPage.getByRole("dialog", { name: "套餐解析证据与定价解剖" }).waitFor({ state: "visible" });
    await slowSwapPage.unroute("**/api/v1/pulse*", holdSwapInspHandler);
    await slowSwapPage.unroute("**/data/v2/latest.json*", holdSwapInspHandler);
    await slowSwapPage.waitForFunction(() => {
      const insp = document.querySelector("[data-inspector-backdrop]");
      const active = document.activeElement;
      return Boolean(insp && active && insp.contains(active) && active.tagName !== "BODY");
    });
    await slowSwapPage.keyboard.press("Shift+Tab");
    assert.equal(
      await slowSwapPage.evaluate(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.contains(document.activeElement))),
      true,
      "Shift+Tab after slow-snapshot InspectorDrawer button swap must stay trapped inside drawer"
    );
    await slowSwapPage.keyboard.press("Tab");
    assert.equal(
      await slowSwapPage.evaluate(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.contains(document.activeElement))),
      true,
      "Tab after slow-snapshot InspectorDrawer button swap must stay trapped inside drawer"
    );
    // Save TWO distinct plans so multi-item SavedDrawer loading & 503 states are distinguishable
    await slowSwapPage.locator("[data-inspector-backdrop] [data-action='toggle-save']").click();
    await slowSwapPage.keyboard.press("Escape");
    await slowSwapPage.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));
    await slowSwapPage.goto(`${baseUrl}/?inspect=e2e-fixed-aaitr-hk`, { waitUntil: "networkidle" });
    await slowSwapPage.getByRole("dialog", { name: "套餐解析证据与定价解剖" }).waitFor({ state: "visible" });
    await slowSwapPage.locator("[data-inspector-backdrop] [data-action='toggle-save']").click();
    await slowSwapPage.keyboard.press("Escape");
    await slowSwapPage.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));
    const twoSavedKeys = await slowSwapPage.evaluate(() =>
      JSON.parse(window.localStorage.getItem("resnode-radar:saved:v1") || "[]")
    );
    assert.ok(twoSavedKeys.length >= 2, `Expected at least 2 saved keys for multi-item drawer check: ${JSON.stringify(twoSavedKeys)}`);
    const [savedKeyFirst, savedKeySecond] = twoSavedKeys.slice(-2);

    let releaseSwapSavedSnap = null;
    const swapSavedGate = new Promise((resolve) => {
      releaseSwapSavedSnap = resolve;
    });
    const holdSwapSavedHandler = async (route) => {
      await swapSavedGate;
      await route.continue().catch(() => {});
    };
    await slowSwapPage.route("**/api/v1/pulse*", holdSwapSavedHandler);
    await slowSwapPage.route("**/data/v2/latest.json*", holdSwapSavedHandler);
    await slowSwapPage.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await slowSwapPage.locator("[data-app-header] [data-action='open-saved']").click();
    await slowSwapPage.getByRole("dialog", { name: "本地收藏夹" }).waitFor({ state: "visible" });
    await slowSwapPage.waitForSelector("[data-saved-backdrop] .el-skeleton");
    const savedLoadingCards = await slowSwapPage.evaluate(() => {
      const cards = [...document.querySelectorAll("[data-saved-backdrop] .insp-card")];
      return cards.map((card) => ({
        text: card.textContent || "",
        removeLabel: card.querySelector("button[data-action='toggle-save']")?.getAttribute("aria-label") || ""
      }));
    });
    assert.ok(savedLoadingCards.length >= 2, `Expected >=2 loading saved cards: ${JSON.stringify(savedLoadingCards)}`);
    assert.ok(
      savedLoadingCards.some((c) => c.text.includes(savedKeyFirst) && c.removeLabel === `移除收藏 ${savedKeyFirst}`),
      `First saved card must expose visible key & distinct remove aria-label during loading: ${JSON.stringify(savedLoadingCards)}`
    );
    assert.ok(
      savedLoadingCards.some((c) => c.text.includes(savedKeySecond) && c.removeLabel === `移除收藏 ${savedKeySecond}`),
      `Second saved card must expose visible key & distinct remove aria-label during loading: ${JSON.stringify(savedLoadingCards)}`
    );
    assert.ok(
      savedLoadingCards.every((c) => c.text.includes("正在加载快照") && !c.text.includes("当前快照未包含")),
      `SavedDrawer loading cards must show loading state without missing-plan copy: ${JSON.stringify(savedLoadingCards)}`
    );
    const pendingSavedRemoveBtn = slowSwapPage.locator("[data-saved-backdrop] button[data-action='toggle-save']").first();
    await pendingSavedRemoveBtn.waitFor({ state: "visible" });
    await pendingSavedRemoveBtn.focus();
    releaseSwapSavedSnap();
    await slowSwapPage.waitForFunction(() => {
      const btn = document.querySelector("[data-saved-backdrop] button[data-action='toggle-save']");
      return Boolean(btn && btn.textContent?.includes("取消收藏"));
    });
    await slowSwapPage.unroute("**/api/v1/pulse*", holdSwapSavedHandler);
    await slowSwapPage.unroute("**/data/v2/latest.json*", holdSwapSavedHandler);
    await slowSwapPage.waitForFunction(() => {
      const saved = document.querySelector("[data-saved-backdrop]");
      const active = document.activeElement;
      return Boolean(saved && active && saved.contains(active) && active.getAttribute?.("data-action") === "toggle-save");
    });
    await slowSwapPage.keyboard.press("Tab");
    assert.equal(
      await slowSwapPage.evaluate(() => Boolean(document.querySelector("[data-saved-backdrop]")?.contains(document.activeElement))),
      true,
      "Tab after slow-snapshot SavedDrawer button swap must stay trapped inside drawer"
    );
    await slowSwapPage.keyboard.press("Shift+Tab");
    assert.equal(
      await slowSwapPage.evaluate(() => Boolean(document.querySelector("[data-saved-backdrop]")?.contains(document.activeElement))),
      true,
      "Shift+Tab after slow-snapshot SavedDrawer button swap must stay trapped inside drawer"
    );

    // Verify initial snapshot 503 error shows honest readable string description (NOT JSON object & ZERO Vue prop warnings)
    // in BOTH InspectorDrawer and SavedDrawer, keeps saved rows distinguishable so removing 2nd removes ONLY 2nd,
    // and recovers cleanly on retry; then verify loaded snapshot genuinely missing plans DO show missing-plan copy.
    const failInitialDrawerRoute = (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "e2e-drawer-503" }) });
    await slowSwapPage.route("**/api/v1/pulse*", failInitialDrawerRoute);
    await slowSwapPage.route("**/data/v2/latest.json*", failInitialDrawerRoute);
    await slowSwapPage.route("**/data/products.json*", failInitialDrawerRoute);
    await slowSwapPage.goto(`${baseUrl}/?inspect=e2e-fixed-tagged-bwh-ams`, { waitUntil: "networkidle" });
    await slowSwapPage.waitForSelector("[data-inspector-backdrop] .el-alert__description");
    const inspErrorCheck = await slowSwapPage.evaluate(() => ({
      fullText: document.querySelector("[data-inspector-backdrop]")?.textContent || "",
      alertDesc: document.querySelector("[data-inspector-backdrop] .el-alert__description")?.textContent?.trim() || ""
    }));
    assert.match(inspErrorCheck.fullText, /暂无法读取套餐快照/);
    assert.doesNotMatch(inspErrorCheck.fullText, /未找到对应套餐/);
    assert.ok(inspErrorCheck.alertDesc.length > 0, "InspectorDrawer 503 alert description must be non-empty");
    assert.doesNotMatch(
      inspErrorCheck.alertDesc,
      /^\s*\{/,
      `InspectorDrawer 503 alert description must be readable string, not raw JSON: ${inspErrorCheck.alertDesc}`
    );
    await slowSwapPage.keyboard.press("Escape");
    await slowSwapPage.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));
    await slowSwapPage.locator("[data-app-header] [data-action='open-saved']").click();
    await slowSwapPage.waitForSelector("[data-saved-backdrop] .el-alert__description");
    const savedErrorCards = await slowSwapPage.evaluate(() =>
      [...document.querySelectorAll("[data-saved-backdrop] .insp-card")].map((card) => ({
        text: card.textContent || "",
        alertDesc: card.querySelector(".el-alert__description")?.textContent?.trim() || "",
        removeLabel: card.querySelector("button[data-action='toggle-save']")?.getAttribute("aria-label") || ""
      }))
    );
    assert.ok(savedErrorCards.length >= 2, `Expected >=2 error saved cards: ${JSON.stringify(savedErrorCards)}`);
    assert.ok(
      savedErrorCards.every(
        (c) =>
          c.text.includes("快照读取失败") &&
          !c.text.includes("当前快照未包含") &&
          c.alertDesc.length > 0 &&
          !/^\s*\{/.test(c.alertDesc)
      ),
      `SavedDrawer 503 cards must render readable error text without raw JSON or missing-plan copy: ${JSON.stringify(savedErrorCards)}`
    );
    // Remove ONLY the second saved key via its distinguishable accessible name during 503 state
    await slowSwapPage.getByRole("button", { name: `移除收藏 ${savedKeySecond}` }).click();
    await slowSwapPage.waitForFunction(
      (removedKey) =>
        !JSON.parse(window.localStorage.getItem("resnode-radar:saved:v1") || "[]").includes(removedKey),
      savedKeySecond
    );
    const remainingAfterSecondRemove = await slowSwapPage.evaluate(() =>
      JSON.parse(window.localStorage.getItem("resnode-radar:saved:v1") || "[]")
    );
    assert.equal(
      remainingAfterSecondRemove.includes(savedKeyFirst),
      true,
      `Removing second saved key must preserve first saved key: ${JSON.stringify(remainingAfterSecondRemove)}`
    );
    assert.equal(
      remainingAfterSecondRemove.includes(savedKeySecond),
      false,
      `Second saved key must be removed: ${JSON.stringify(remainingAfterSecondRemove)}`
    );
    await slowSwapPage.unroute("**/api/v1/pulse*", failInitialDrawerRoute);
    await slowSwapPage.unroute("**/data/v2/latest.json*", failInitialDrawerRoute);
    await slowSwapPage.unroute("**/data/products.json*", failInitialDrawerRoute);
    await slowSwapPage.locator("[data-saved-backdrop] [data-action='refresh-snapshot']").first().click();
    await slowSwapPage.waitForFunction(() => {
      const btn = document.querySelector("[data-saved-backdrop] button[data-action='toggle-save']");
      return Boolean(btn && btn.textContent?.includes("取消收藏"));
    });
    assert.equal(await slowSwapPage.locator("[data-saved-backdrop] .el-alert").count(), 0);
    // Verify loaded snapshot genuinely missing saved key & inspect ID DO show missing copy
    await slowSwapPage.evaluate(() => {
      const raw = window.localStorage.getItem("resnode-radar:saved:v1") || "[]";
      const arr = JSON.parse(raw);
      if (!arr.includes("missing-provider::e2e-gone-key")) arr.push("missing-provider::e2e-gone-key");
      window.localStorage.setItem("resnode-radar:saved:v1", JSON.stringify(arr));
    });
    await slowSwapPage.goto(`${baseUrl}/?inspect=e2e-nonexistent-plan-id`, { waitUntil: "networkidle" });
    await slowSwapPage.waitForFunction(() =>
      Boolean(document.querySelector("[data-inspector-backdrop]")?.textContent?.includes("未找到对应套餐"))
    );
    await slowSwapPage.keyboard.press("Escape");
    await slowSwapPage.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));
    await slowSwapPage.locator("[data-app-header] [data-action='open-saved']").click();
    await slowSwapPage.waitForFunction(() =>
      Boolean(document.querySelector("[data-saved-backdrop]")?.textContent?.includes("当前快照未包含"))
    );
    await slowSwapPage.evaluate(() => {
      const raw = window.localStorage.getItem("resnode-radar:saved:v1") || "[]";
      const arr = JSON.parse(raw).filter((k) => k !== "missing-provider::e2e-gone-key");
      window.localStorage.setItem("resnode-radar:saved:v1", JSON.stringify(arr));
    });
    const propTypeWarnings = slowSwapWarnings.filter((w) => /Invalid prop|type check failed/i.test(w));
    assert.deepEqual(propTypeWarnings, [], `Unexpected Vue prop warnings in drawers: ${propTypeWarnings.join("; ")}`);
    assert.deepEqual(slowSwapErrors, [], `Unexpected slow-swap page errors: ${slowSwapErrors.join("; ")}`);
    await slowSwapPage.close();

    // Regression 8: Shared URL with 4 unmatched cmp keys MUST clear compareOpen=1, expose operable CompareDock with
    // removable missing-item tags + clear button so user can release slots & add a real catalog plan cleanly.
    const staleCmpPage = await desktopCtx.newPage();
    const staleCmpErrors = [];
    staleCmpPage.on("pageerror", (err) => staleCmpErrors.push(err.message));
    await staleCmpPage.goto(
      `${baseUrl}/?cmp=stale::1&cmp=stale::2&cmp=stale::3&cmp=stale::4&compareOpen=1`,
      { waitUntil: "networkidle" }
    );
    await staleCmpPage.waitForSelector(".terminal-table tr[data-product-id]");
    assert.doesNotMatch(staleCmpPage.url(), /compareOpen=1/, `compareOpen=1 must clear when 0 cmp keys match: ${staleCmpPage.url()}`);
    assert.equal(
      new URL(staleCmpPage.url()).searchParams.getAll("cmp").length,
      4,
      `Unmatched shared cmp keys must remain inspectable/removable in URL until user clears: ${staleCmpPage.url()}`
    );
    await staleCmpPage.waitForFunction(() => !document.querySelector("[data-compare-dock]")?.hidden);
    assert.equal(
      await staleCmpPage.locator("[data-compare-dock] .dock-pill-missing").count(),
      4,
      "CompareDock must render 4 removable missing-item tags for unmatched cmp keys"
    );
    await staleCmpPage.locator("[data-compare-dock] [data-action='clear-compare']").click();
    await staleCmpPage.waitForFunction(() => Boolean(document.querySelector("[data-compare-dock]")?.hidden));
    assert.doesNotMatch(staleCmpPage.url(), /[?&]cmp=/, `Clearing CompareDock must remove all cmp keys from URL: ${staleCmpPage.url()}`);
    assert.equal(
      await staleCmpPage.locator("[data-app-header] [data-action='open-compare']").count(),
      0,
      "Header compare button must disappear after clearing unmatched cmp keys"
    );
    await staleCmpPage
      .locator(".terminal-table tr[data-product-id] button.el-button[data-action='toggle-compare']")
      .first()
      .click();
    await staleCmpPage.waitForFunction(() => !document.querySelector("[data-compare-dock]")?.hidden);
    assert.equal(
      await staleCmpPage.locator("[data-compare-dock] [data-compare-badge]").textContent().then((s) => s?.trim()),
      "1/4",
      "Adding a real plan after clearing unmatched cmp keys must occupy slot 1/4 instead of hitting 4-plan limit"
    );
    assert.equal(
      await staleCmpPage.locator("[data-app-header] [data-action='open-compare']").isDisabled(),
      false,
      "Header compare button must be enabled for valid compared plan"
    );

    // Regression 9: Searchable region RadarSelect Chinese IME composition Enter & post-compositionend keyCode=229
    // must NOT commit a highlighted option or preventDefault IME confirmation; subsequent normal Enter selects JP.
    const regionSelectWrapper = staleCmpPage.locator("[data-filter-dock] [data-filter-select='region'] .el-select__wrapper");
    await regionSelectWrapper.click();
    await staleCmpPage.waitForFunction(
      () =>
        document
          .querySelector("[data-filter-dock] [data-filter-select='region'] [role='combobox']")
          ?.getAttribute("aria-expanded") === "true"
    );
    const imeRegionCheck = await staleCmpPage.evaluate(() => {
      const input = document.querySelector("[data-filter-dock] [data-filter-select='region'] input[role='combobox']");
      input.focus();
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      input.value = "日本";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "日本", isComposing: true }));
      const compArrowDown = new KeyboardEvent("keydown", {
        key: "ArrowDown",
        code: "ArrowDown",
        bubbles: true,
        cancelable: true,
        isComposing: true
      });
      Object.defineProperty(compArrowDown, "keyCode", { value: 229 });
      input.dispatchEvent(compArrowDown);

      const compPageDown = new KeyboardEvent("keydown", {
        key: "PageDown",
        code: "PageDown",
        bubbles: true,
        cancelable: true,
        isComposing: true
      });
      Object.defineProperty(compPageDown, "keyCode", { value: 229 });
      input.dispatchEvent(compPageDown);

      const compEscape = new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        bubbles: true,
        cancelable: true,
        isComposing: true
      });
      Object.defineProperty(compEscape, "keyCode", { value: 229 });
      input.dispatchEvent(compEscape);
      const valueAfterCompEscape = input.value;
      const expandedAfterCompEscape = input.getAttribute("aria-expanded");

      const compEnter = new KeyboardEvent("keydown", {
        key: "Process",
        code: "Enter",
        bubbles: true,
        cancelable: true,
        isComposing: true
      });
      Object.defineProperty(compEnter, "keyCode", { value: 229 });
      input.dispatchEvent(compEnter);
      const afterCompEnterExpanded = input.getAttribute("aria-expanded");

      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本" }));
      const post229Enter = new KeyboardEvent("keydown", {
        key: "Process",
        code: "Enter",
        bubbles: true,
        cancelable: true,
        isComposing: false
      });
      Object.defineProperty(post229Enter, "keyCode", { value: 229 });
      input.dispatchEvent(post229Enter);
      const after229Expanded = input.getAttribute("aria-expanded");

      const numpad229Enter = new KeyboardEvent("keydown", {
        key: "Process",
        code: "NumpadEnter",
        bubbles: true,
        cancelable: true,
        isComposing: false
      });
      Object.defineProperty(numpad229Enter, "keyCode", { value: 229 });
      input.dispatchEvent(numpad229Enter);
      const afterNumpad229Expanded = input.getAttribute("aria-expanded");

      return {
        compArrowDownPrevented: compArrowDown.defaultPrevented,
        compPageDownPrevented: compPageDown.defaultPrevented,
        compEscapePrevented: compEscape.defaultPrevented,
        valueAfterCompEscape,
        expandedAfterCompEscape,
        compEnterDefaultPrevented: compEnter.defaultPrevented,
        post229DefaultPrevented: post229Enter.defaultPrevented,
        numpad229DefaultPrevented: numpad229Enter.defaultPrevented,
        afterCompEnterExpanded,
        after229Expanded,
        afterNumpad229Expanded,
        urlAfterIme: window.location.href
      };
    });
    assert.deepEqual(
      imeRegionCheck,
      {
        compArrowDownPrevented: false,
        compPageDownPrevented: false,
        compEscapePrevented: false,
        valueAfterCompEscape: "日本",
        expandedAfterCompEscape: "true",
        compEnterDefaultPrevented: false,
        post229DefaultPrevented: false,
        numpad229DefaultPrevented: false,
        afterCompEnterExpanded: "true",
        after229Expanded: "true",
        afterNumpad229Expanded: "true",
        urlAfterIme: staleCmpPage.url()
      },
      `IME composition navigation/cancel/confirm keys must keep default behavior & input value intact: ${JSON.stringify(imeRegionCheck)}`
    );
    assert.doesNotMatch(staleCmpPage.url(), /region=/);
    await staleCmpPage.keyboard.press("ArrowDown");
    await staleCmpPage.keyboard.press("Enter");
    await staleCmpPage.waitForFunction(() => window.location.href.includes("region=JP"));
    assert.equal(
      await staleCmpPage.evaluate(
        () =>
          document
            .querySelector("[data-filter-dock] [data-filter-select='region'] [role='combobox']")
            ?.getAttribute("aria-expanded")
      ),
      "false",
      "Subsequent normal Enter must commit JP region and close dropdown"
    );

    // Collapsed desktop region RadarSelect IME Escape must keep default behavior & keep expanded shop panel open;
    // subsequent normal Escape after compositionend collapses shopsExpanded cleanly.
    const desktopToggleShops = staleCmpPage.locator("[data-action='toggle-shops-expand']").first();
    await desktopToggleShops.waitFor({ state: "visible" });
    await desktopToggleShops.click();
    await staleCmpPage.waitForFunction(
      () => document.querySelector("[data-action='toggle-shops-expand']")?.getAttribute("aria-expanded") === "true"
    );
    const collapsedDesktopImeEsc = await staleCmpPage.evaluate(() => {
      const input = document.querySelector("[data-filter-dock] [data-filter-select='region'] input[role='combobox']");
      input.focus();
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      const esc = new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        bubbles: true,
        cancelable: true,
        isComposing: true
      });
      Object.defineProperty(esc, "keyCode", { value: 229 });
      input.dispatchEvent(esc);
      const shopsExpandedDuringIme = document
        .querySelector("[data-action='toggle-shops-expand']")
        ?.getAttribute("aria-expanded");
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
      return { defaultPrevented: esc.defaultPrevented, shopsExpandedDuringIme };
    });
    assert.deepEqual(
      collapsedDesktopImeEsc,
      { defaultPrevented: false, shopsExpandedDuringIme: "true" },
      `Composing Escape on collapsed desktop RadarSelect must not preventDefault or close shops panel: ${JSON.stringify(collapsedDesktopImeEsc)}`
    );
    await staleCmpPage.keyboard.press("Escape");
    await staleCmpPage.waitForFunction(
      () => document.querySelector("[data-action='toggle-shops-expand']")?.getAttribute("aria-expanded") === "false"
    );

    // Regression 10: Popstate target containing BOTH unmatched cmp + compareOpen=1 AND a different inspectId must restore
    // the target inspectId BEFORE clearing compareOpen=1 so replaceState drops compareOpen=1 while keeping cmp & target inspectId.
    await staleCmpPage.goto(`${baseUrl}/?inspect=e2e-fixed-tagged-bwh-ams`, { waitUntil: "networkidle" });
    await staleCmpPage.waitForFunction(() =>
      Boolean(
        document
          .querySelector("[data-inspector-backdrop]")
          ?.textContent?.includes("The Amsterdam E2E Deterministic Long Plan Name")
      )
    );
    await staleCmpPage.evaluate(() => {
      window.history.pushState(null, "", "/?cmp=stale::pop-only&compareOpen=1&inspect=e2e-fixed-aaitr-hk");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await staleCmpPage.waitForFunction(() =>
      Boolean(
        document
          .querySelector("[data-inspector-backdrop]")
          ?.textContent?.includes("AaITR E2E Deterministic HK Residential")
      )
    );
    assert.doesNotMatch(
      staleCmpPage.url(),
      /compareOpen=1/,
      `Popstate to unmatched compare entry must clear compareOpen=1 from address bar: ${staleCmpPage.url()}`
    );
    assert.match(staleCmpPage.url(), /[?&]cmp=stale%3A%3Apop-only|cmp=stale::pop-only/);
    assert.match(
      staleCmpPage.url(),
      /inspect=e2e-fixed-aaitr-hk/,
      `Popstate reconciling compareOpen must preserve target inspectId in address bar: ${staleCmpPage.url()}`
    );
    await staleCmpPage.reload({ waitUntil: "networkidle" });
    await staleCmpPage.waitForFunction(() =>
      Boolean(
        document
          .querySelector("[data-inspector-backdrop]")
          ?.textContent?.includes("AaITR E2E Deterministic HK Residential")
      )
    );

    // Regression 11: Triggering compositionstart inside a view-scoped input (ProvidersView search) and then unmounting
    // that input via popstate view switch to Radar MUST clear stale composition tracking so Ctrl+K and Escape still work.
    await staleCmpPage.goto(`${baseUrl}/?view=providers`, { waitUntil: "networkidle" });
    await staleCmpPage.waitForSelector("[data-view-panel='providers'] .el-input__inner");
    await staleCmpPage.evaluate(() => {
      const provInput = document.querySelector("[data-view-panel='providers'] .el-input__inner");
      provInput.focus();
      provInput.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "搬" }));
      window.history.pushState(null, "", "/?view=radar");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await staleCmpPage.waitForFunction(() => !document.querySelector("[data-view-panel='radar']")?.hidden);
    await staleCmpPage.waitForSelector("[data-view-panel='radar'] .el-input__inner");
    await staleCmpPage.locator("[data-view-panel='radar'] .el-input__inner").first().focus();
    await staleCmpPage.keyboard.press("Control+k");
    await staleCmpPage.getByRole("dialog", { name: "全局快速检索" }).waitFor({ state: "visible" });
    await staleCmpPage.keyboard.press("Escape");
    await staleCmpPage.waitForFunction(() => Boolean(document.querySelector("[data-palette-backdrop]")?.hidden));

    // Regression 12: Transient snapshot omission of a user-selected compared plan MUST preserve both compareKeys and
    // URL cmp params so the plan automatically reappears in CompareDock once a subsequent snapshot restores it!
    await staleCmpPage.goto(`${baseUrl}/?q=E2E+Deterministic`, { waitUntil: "networkidle" });
    await staleCmpPage.waitForSelector(".terminal-table tr[data-product-id='e2e-fixed-tagged-bwh-ams']");
    await staleCmpPage.waitForSelector(".terminal-table tr[data-product-id='e2e-fixed-aaitr-hk']");
    await staleCmpPage
      .locator(".terminal-table tr[data-product-id='e2e-fixed-tagged-bwh-ams'] button[data-action='toggle-compare']")
      .first()
      .click();
    await staleCmpPage
      .locator(".terminal-table tr[data-product-id='e2e-fixed-aaitr-hk'] button[data-action='toggle-compare']")
      .first()
      .click();
    await staleCmpPage.waitForFunction(
      () => document.querySelectorAll("[data-compare-dock] .dock-pill").length === 2
    );
    const twoCmpUrlBeforeOmission = staleCmpPage.url();
    const cmpCountBeforeOmission = new URL(twoCmpUrlBeforeOmission).searchParams.getAll("cmp").length;
    assert.equal(cmpCountBeforeOmission, 2, `Expected 2 cmp params before transient omission: ${twoCmpUrlBeforeOmission}`);

    let transientMode = "omit"; // "omit" -> "restore" -> "omit-all"
    const transientPulseHandler = async (route) => {
      const resp = await route.fetch();
      const body = await resp.json();
      if (transientMode === "omit") {
        body.snapshotId = `${body.snapshotId}_transient_omit`;
        body.snapshotPath = "data/snapshots/e2e_transient_omit/snapshot.json";
      } else if (transientMode === "omit-all") {
        body.snapshotId = `${body.snapshotId}_transient_omit_all`;
        body.snapshotPath = "data/snapshots/e2e_transient_omit_all/snapshot.json";
      } else {
        body.snapshotId = `${body.snapshotId}_transient_restore`;
        body.snapshotPath = "data/snapshots/e2e_transient_restore/snapshot.json";
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body)
      });
    };
    const originalCompactSnap = JSON.parse(
      readFileSync(join(dataDir, "snapshots", seedRes.snapshotId, "snapshot.json"), "utf8")
    );
    const omittedCompactSnap = {
      ...originalCompactSnap,
      snapshotId: `${originalCompactSnap.snapshotId}_transient_omit`,
      products: originalCompactSnap.products.filter((p) => p.id !== "e2e-fixed-aaitr-hk")
    };
    const omittedAllCompactSnap = {
      ...originalCompactSnap,
      snapshotId: `${originalCompactSnap.snapshotId}_transient_omit_all`,
      products: originalCompactSnap.products.filter(
        (p) => p.id !== "e2e-fixed-aaitr-hk" && p.id !== "e2e-fixed-tagged-bwh-ams"
      )
    };
    const restoredCompactSnap = {
      ...originalCompactSnap,
      snapshotId: `${originalCompactSnap.snapshotId}_transient_restore`
    };
    await staleCmpPage.route("**/api/v1/pulse*", transientPulseHandler);
    await staleCmpPage.route("**/data/snapshots/e2e_transient_omit/snapshot.json*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(omittedCompactSnap)
      })
    );
    await staleCmpPage.route("**/data/snapshots/e2e_transient_omit_all/snapshot.json*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(omittedAllCompactSnap)
      })
    );
    await staleCmpPage.route("**/data/snapshots/e2e_transient_restore/snapshot.json*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(restoredCompactSnap)
      })
    );
    // Snapshot 2: e2e-fixed-aaitr-hk transiently missing -> CompareDock shows 1 pill, URL STILL retains BOTH cmp params!
    await staleCmpPage.locator("[data-app-header] [data-action='refresh-snapshot']").click();
    await staleCmpPage.waitForFunction(
      () => document.querySelectorAll("[data-compare-dock] .dock-pill").length === 1
    );
    assert.equal(
      new URL(staleCmpPage.url()).searchParams.getAll("cmp").length,
      2,
      `Transient snapshot omission must retain both user-selected cmp params in URL: ${staleCmpPage.url()}`
    );
    // Snapshot 3: e2e-fixed-aaitr-hk restored -> CompareDock automatically shows BOTH pills again!
    transientMode = "restore";
    await staleCmpPage.locator("[data-app-header] [data-action='refresh-snapshot']").click();
    await staleCmpPage.waitForFunction(
      () => document.querySelectorAll("[data-compare-dock] .dock-pill").length === 2
    );
    assert.equal(
      new URL(staleCmpPage.url()).searchParams.getAll("cmp").length,
      2,
      `Restored snapshot must keep both cmp params in URL: ${staleCmpPage.url()}`
    );

    // Snapshot 4: Open CompareModal, then omit ALL selected compared plans -> CompareModal MUST close & clear compareOpen=1
    // (while retaining both cmp keys), CompareDock MUST stay operable so user can clear slots & add another plan without reopening modal!
    await staleCmpPage.locator("[data-compare-dock] [data-action='open-compare']").click();
    await staleCmpPage.getByRole("dialog", { name: "多方案关键指标横向对比" }).waitFor({ state: "visible" });
    assert.match(staleCmpPage.url(), /compareOpen=1/);
    transientMode = "omit-all";
    // Trigger snapshot refresh directly via header button (force click through modal or close? Wait: use programmatic refresh via visibilitychange/button)
    await staleCmpPage.evaluate(() => {
      document.querySelector("[data-app-header] [data-action='refresh-snapshot']")?.click?.();
    });
    await staleCmpPage.waitForFunction(
      () =>
        Boolean(document.querySelector("[data-compare-modal]")?.hidden) &&
        !document.body.classList.contains("scroll-locked") &&
        !document.querySelector("[data-compare-dock]")?.hidden
    );
    assert.doesNotMatch(
      staleCmpPage.url(),
      /compareOpen=1/,
      `All-omitted compare snapshot must clear compareOpen=1 from URL: ${staleCmpPage.url()}`
    );
    assert.equal(
      new URL(staleCmpPage.url()).searchParams.getAll("cmp").length,
      2,
      `All-omitted compare snapshot must still retain session-selected cmp keys until user clears: ${staleCmpPage.url()}`
    );
    assert.equal(
      await staleCmpPage.locator("[data-compare-dock] [data-action='open-compare']").isDisabled(),
      true,
      "CompareDock open button must be disabled when 0 selected plans match current snapshot"
    );
    await staleCmpPage.locator("[data-compare-dock] [data-action='clear-compare']").click();
    await staleCmpPage.waitForFunction(() => Boolean(document.querySelector("[data-compare-dock]")?.hidden));
    assert.equal(
      new URL(staleCmpPage.url()).searchParams.getAll("cmp").length,
      0,
      "Clearing CompareDock must release all absent compare slots from URL"
    );
    await staleCmpPage.locator("[data-filter-dock] [data-action='reset-filters']").click();
    await staleCmpPage.waitForSelector(".terminal-table tr[data-product-id] button[data-action='toggle-compare']");
    await staleCmpPage
      .locator(".terminal-table tr[data-product-id] button[data-action='toggle-compare']")
      .first()
      .click();
    await staleCmpPage.waitForFunction(() => !document.querySelector("[data-compare-dock]")?.hidden);
    assert.equal(
      await staleCmpPage.evaluate(() => Boolean(document.querySelector("[data-compare-modal]")?.hidden)),
      true,
      "Adding a new plan after all-omitted compare close must NOT auto-reopen CompareModal"
    );
    assert.equal(
      await staleCmpPage.evaluate(() => document.body.classList.contains("scroll-locked")),
      false
    );

    // Regression 13: Partial omission (A absent, B matched) inside open CompareModal -> manually remove last visible
    // item B -> CompareModal MUST close & clear compareOpen=1 (keeping A), CompareDock MUST stay visible for A,
    // and adding C must NOT auto-reopen CompareModal!
    transientMode = "restore";
    await staleCmpPage.goto(`${baseUrl}/?q=E2E+Deterministic`, { waitUntil: "networkidle" });
    await staleCmpPage.waitForSelector(".terminal-table tr[data-product-id='e2e-fixed-tagged-bwh-ams']");
    await staleCmpPage.waitForSelector(".terminal-table tr[data-product-id='e2e-fixed-aaitr-hk']");
    await staleCmpPage
      .locator(".terminal-table tr[data-product-id='e2e-fixed-tagged-bwh-ams'] button[data-action='toggle-compare']")
      .first()
      .click();
    await staleCmpPage
      .locator(".terminal-table tr[data-product-id='e2e-fixed-aaitr-hk'] button[data-action='toggle-compare']")
      .first()
      .click();
    await staleCmpPage.waitForFunction(
      () => document.querySelectorAll("[data-compare-dock] .dock-pill").length === 2
    );
    const aaitrCmpKey = await staleCmpPage
      .locator(".terminal-table tr[data-product-id='e2e-fixed-aaitr-hk'] button[data-action='toggle-compare']")
      .first()
      .getAttribute("data-key");
    await staleCmpPage.locator("[data-compare-dock] [data-action='open-compare']").click();
    await staleCmpPage.getByRole("dialog", { name: "多方案关键指标横向对比" }).waitFor({ state: "visible" });
    transientMode = "omit"; // omits e2e-fixed-aaitr-hk, leaves e2e-fixed-tagged-bwh-ams visible inside CompareModal
    await staleCmpPage.evaluate(() => {
      document.querySelector("[data-app-header] [data-action='refresh-snapshot']")?.click?.();
    });
    await staleCmpPage.waitForFunction(
      () => document.querySelectorAll("[data-compare-modal] [data-action='toggle-compare']").length === 1
    );
    // Remove the last visible plan (bwh) while aaitr is transiently absent -> modal MUST close & drop compareOpen=1!
    await staleCmpPage.locator("[data-compare-modal] [data-action='toggle-compare']").first().click();
    await staleCmpPage.waitForFunction(
      () =>
        Boolean(document.querySelector("[data-compare-modal]")?.hidden) &&
        !document.body.classList.contains("scroll-locked") &&
        !document.querySelector("[data-compare-dock]")?.hidden
    );
    assert.doesNotMatch(
      staleCmpPage.url(),
      /compareOpen=1/,
      `Removing last visible item while another key is absent must clear compareOpen=1: ${staleCmpPage.url()}`
    );
    assert.equal(
      new URL(staleCmpPage.url()).searchParams.getAll("cmp").includes(aaitrCmpKey),
      true,
      "Absent key must remain preserved in URL and CompareDock"
    );
    // Adding another plan C (bwh) must NOT auto-reopen CompareModal!
    await staleCmpPage
      .locator(".terminal-table tr[data-product-id='e2e-fixed-tagged-bwh-ams'] button[data-action='toggle-compare']")
      .first()
      .click();
    await staleCmpPage.waitForFunction(
      () => document.querySelectorAll("[data-compare-dock] .dock-pill").length === 1
    );
    assert.equal(
      await staleCmpPage.evaluate(() => Boolean(document.querySelector("[data-compare-modal]")?.hidden)),
      true,
      "Adding another plan after removing last visible item must NOT auto-reopen CompareModal"
    );

    // Regression 14: Fresh page opening a shared link (?cmp=<aaitrCmpKey>&compareOpen=1) while that plan is transiently
    // absent MUST keep cmp in URL, clear compareOpen=1, show missing pill in CompareDock, and auto-match when restored!
    transientMode = "omit";
    await staleCmpPage.goto(`${baseUrl}/?cmp=${encodeURIComponent(aaitrCmpKey)}&compareOpen=1`, {
      waitUntil: "networkidle"
    });
    await staleCmpPage.waitForFunction(() => !document.querySelector("[data-compare-dock]")?.hidden);
    assert.doesNotMatch(staleCmpPage.url(), /compareOpen=1/);
    assert.equal(
      new URL(staleCmpPage.url()).searchParams.getAll("cmp").includes(aaitrCmpKey),
      true,
      `Re-opening shared link during transient omission must preserve cmp key: ${staleCmpPage.url()}`
    );
    assert.equal(await staleCmpPage.locator("[data-compare-dock] .dock-pill-missing").count(), 1);
    transientMode = "restore";
    await staleCmpPage.locator("[data-app-header] [data-action='refresh-snapshot']").click();
    await staleCmpPage.waitForFunction(
      () =>
        document.querySelectorAll("[data-compare-dock] .dock-pill").length === 1 &&
        document.querySelectorAll("[data-compare-dock] .dock-pill-missing").length === 0
    );
    assert.equal(
      await staleCmpPage.locator("[data-compare-dock] [data-action='open-compare']").isDisabled(),
      false,
      "Restored shared cmp key must automatically become openable in CompareDock"
    );

    await staleCmpPage.unroute("**/api/v1/pulse*", transientPulseHandler);

    assert.deepEqual(staleCmpErrors, [], `Unexpected stale-cmp/IME page errors: ${staleCmpErrors.join("; ")}`);
    await staleCmpPage.close();

    // Regression 6: Browser Back/Forward replacing focused controls inside InspectorDrawer ("返回列表" -> valid plan)
    // and inside CompareModal ("移出对比" -> different compareKeys set) MUST keep focus inside the topmost overlay
    // and preserve Tab / Shift+Tab focus trapping.
    const historyFocusPage = await desktopCtx.newPage();
    const historyFocusErrors = [];
    historyFocusPage.on("pageerror", (err) => historyFocusErrors.push(err.message));
    await historyFocusPage.goto(`${baseUrl}/?inspect=e2e-fixed-tagged-bwh-ams`, { waitUntil: "networkidle" });
    await historyFocusPage.getByRole("dialog", { name: "套餐解析证据与定价解剖" }).waitFor({ state: "visible" });
    const distinctCompareKeys = await historyFocusPage.evaluate(() => {
      const btns = [...document.querySelectorAll(".terminal-table tr[data-product-id] button[data-action='toggle-compare']")];
      const keys = [];
      for (const b of btns) {
        const k = b.getAttribute("data-key");
        if (k && !keys.includes(k)) keys.push(k);
        if (keys.length >= 3) break;
      }
      return keys;
    });
    assert.ok(distinctCompareKeys.length >= 3, `Need 3 distinct compare keys for history replacement test: ${JSON.stringify(distinctCompareKeys)}`);
    await historyFocusPage.evaluate(() => {
      window.history.pushState(null, "", "/?inspect=e2e-nonexistent-plan-id");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await historyFocusPage.getByRole("dialog", { name: "套餐证据抽屉" }).waitFor({ state: "visible" });
    const historyNotFoundBack = historyFocusPage.locator("[data-inspector-backdrop] .el-drawer__body [data-action='close-inspector']");
    await historyNotFoundBack.waitFor({ state: "visible" });
    await historyNotFoundBack.focus();
    await historyFocusPage.goBack();
    await historyFocusPage.getByRole("dialog", { name: "套餐解析证据与定价解剖" }).waitFor({ state: "visible" });
    await historyFocusPage.waitForFunction(() => {
      const insp = document.querySelector("[data-inspector-backdrop]");
      const active = document.activeElement;
      return Boolean(insp && active && insp.contains(active) && active.tagName !== "BODY");
    });
    await historyFocusPage.keyboard.press("Shift+Tab");
    assert.equal(
      await historyFocusPage.evaluate(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.contains(document.activeElement))),
      true,
      "Shift+Tab after history-replaced InspectorDrawer must stay trapped inside drawer"
    );
    await historyFocusPage.keyboard.press("Tab");
    assert.equal(
      await historyFocusPage.evaluate(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.contains(document.activeElement))),
      true,
      "Tab after history-replaced InspectorDrawer must stay trapped inside drawer"
    );

    const [cmpKeyA, cmpKeyB, cmpKeyC] = distinctCompareKeys;
    await historyFocusPage.goto(`${baseUrl}/?cmp=${encodeURIComponent(cmpKeyC)}&compareOpen=1`, {
      waitUntil: "networkidle"
    });
    await historyFocusPage.getByRole("dialog", { name: "多方案关键指标横向对比" }).waitFor({ state: "visible" });
    await historyFocusPage.evaluate(
      ({ a, b }) => {
        window.history.pushState(
          null,
          "",
          `/?cmp=${encodeURIComponent(a)}&cmp=${encodeURIComponent(b)}&compareOpen=1`
        );
        window.dispatchEvent(new PopStateEvent("popstate"));
      },
      { a: cmpKeyA, b: cmpKeyB }
    );
    await historyFocusPage.waitForFunction(
      () => document.querySelectorAll("[data-compare-modal] [data-action='toggle-compare']").length === 2
    );
    const historyCompareRemove = historyFocusPage.locator("[data-compare-modal] [data-action='toggle-compare']").first();
    await historyCompareRemove.focus();
    await historyFocusPage.goBack();
    await historyFocusPage.waitForFunction(
      (expectedKey) => {
        const btns = [...document.querySelectorAll("[data-compare-modal] [data-action='toggle-compare']")];
        return btns.length === 1 && btns[0].getAttribute("data-key") === expectedKey;
      },
      cmpKeyC
    );
    await historyFocusPage.waitForFunction(() => {
      const modal = document.querySelector("[data-compare-modal]");
      const active = document.activeElement;
      return Boolean(modal && active && modal.contains(active) && active.tagName !== "BODY");
    });
    await historyFocusPage.keyboard.press("Tab");
    assert.equal(
      await historyFocusPage.evaluate(() => Boolean(document.querySelector("[data-compare-modal]")?.contains(document.activeElement))),
      true,
      "Tab after history-replaced CompareModal must stay trapped inside modal"
    );
    await historyFocusPage.keyboard.press("Shift+Tab");
    assert.equal(
      await historyFocusPage.evaluate(() => Boolean(document.querySelector("[data-compare-modal]")?.contains(document.activeElement))),
      true,
      "Shift+Tab after history-replaced CompareModal must stay trapped inside modal"
    );
    assert.deepEqual(historyFocusErrors, [], `Unexpected history-focus page errors: ${historyFocusErrors.join("; ")}`);
    await historyFocusPage.close();

    // Regression 7: Backdrop click followed immediately by popstate history navigation MUST NOT allow a stale
    // leave-animation update:modelValue(false) callback to clear the newly restored InspectorDrawer or CompareModal.
    const backdropRacePage = await desktopCtx.newPage();
    const backdropRaceErrors = [];
    backdropRacePage.on("pageerror", (err) => backdropRaceErrors.push(err.message));
    await backdropRacePage.goto(`${baseUrl}/?inspect=e2e-fixed-aaitr-hk`, { waitUntil: "networkidle" });
    await backdropRacePage.getByRole("dialog", { name: "套餐解析证据与定价解剖" }).waitFor({ state: "visible" });
    await backdropRacePage.evaluate(() => {
      window.history.pushState(null, "", "/?inspect=e2e-fixed-tagged-bwh-ams");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await backdropRacePage.waitForFunction(() =>
      Boolean(
        document
          .querySelector("[data-inspector-backdrop]")
          ?.textContent?.includes("The Amsterdam E2E Deterministic Long Plan Name")
      )
    );
    // Click InspectorDrawer backdrop outside the right-hand drawer, then immediately navigate back to AaITR inspect
    await backdropRacePage.locator("[data-inspector-backdrop] .el-overlay").click({ position: { x: 20, y: 20 } });
    await backdropRacePage.goBack();
    await backdropRacePage.waitForTimeout(450);
    const inspBackdropRace = await backdropRacePage.evaluate(() => ({
      url: window.location.href,
      visible: !document.querySelector("[data-inspector-backdrop]")?.hidden,
      hasAaitr: Boolean(
        document
          .querySelector("[data-inspector-backdrop]")
          ?.textContent?.includes("AaITR E2E Deterministic HK Residential")
      ),
      focusInInspector: Boolean(
        document.querySelector("[data-inspector-backdrop]")?.contains(document.activeElement)
      )
    }));
    assert.equal(inspBackdropRace.visible, true, `Restored InspectorDrawer must stay open after backdrop race: ${JSON.stringify(inspBackdropRace)}`);
    assert.equal(inspBackdropRace.hasAaitr, true, `Restored InspectorDrawer must show AaITR plan: ${JSON.stringify(inspBackdropRace)}`);
    assert.match(inspBackdropRace.url, /inspect=e2e-fixed-aaitr-hk/);
    assert.equal(inspBackdropRace.focusInInspector, true, `Focus must remain inside restored InspectorDrawer: ${JSON.stringify(inspBackdropRace)}`);
    // Verify normal backdrop click without navigation closes InspectorDrawer cleanly
    await backdropRacePage.locator("[data-inspector-backdrop] .el-overlay").click({ position: { x: 20, y: 20 } });
    await backdropRacePage.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));
    assert.doesNotMatch(backdropRacePage.url(), /inspect=/);

    // Same backdrop-click + immediate popstate check for CompareModal
    await backdropRacePage.goto(`${baseUrl}/?cmp=${encodeURIComponent(cmpKeyC)}&compareOpen=1`, {
      waitUntil: "networkidle"
    });
    await backdropRacePage.getByRole("dialog", { name: "多方案关键指标横向对比" }).waitFor({ state: "visible" });
    await backdropRacePage.evaluate(
      ({ a, b }) => {
        window.history.pushState(
          null,
          "",
          `/?cmp=${encodeURIComponent(a)}&cmp=${encodeURIComponent(b)}&compareOpen=1`
        );
        window.dispatchEvent(new PopStateEvent("popstate"));
      },
      { a: cmpKeyA, b: cmpKeyB }
    );
    await backdropRacePage.waitForFunction(
      () => document.querySelectorAll("[data-compare-modal] [data-action='toggle-compare']").length === 2
    );
    await backdropRacePage.locator("[data-compare-modal] .el-overlay-dialog").click({ position: { x: 10, y: 10 } });
    await backdropRacePage.goBack();
    await backdropRacePage.waitForTimeout(450);
    const cmpBackdropRace = await backdropRacePage.evaluate((expectedKey) => {
      const btns = [...document.querySelectorAll("[data-compare-modal] [data-action='toggle-compare']")];
      return {
        url: window.location.href,
        visible: !document.querySelector("[data-compare-modal]")?.hidden,
        restoredCount: btns.length,
        restoredKey: btns[0]?.getAttribute("data-key") || "",
        expectedKey,
        focusInCompare: Boolean(
          document.querySelector("[data-compare-modal]")?.contains(document.activeElement)
        )
      };
    }, cmpKeyC);
    assert.equal(cmpBackdropRace.visible, true, `Restored CompareModal must stay open after backdrop race: ${JSON.stringify(cmpBackdropRace)}`);
    assert.equal(cmpBackdropRace.restoredCount, 1);
    assert.equal(cmpBackdropRace.restoredKey, cmpKeyC);
    assert.match(cmpBackdropRace.url, /compareOpen=1/);
    assert.equal(cmpBackdropRace.focusInCompare, true, `Focus must remain inside restored CompareModal: ${JSON.stringify(cmpBackdropRace)}`);
    await backdropRacePage.locator("[data-compare-modal] .el-overlay-dialog").click({ position: { x: 10, y: 10 } });
    await backdropRacePage.waitForFunction(() => Boolean(document.querySelector("[data-compare-modal]")?.hidden));
    assert.doesNotMatch(backdropRacePage.url(), /compareOpen=1/);
    assert.deepEqual(backdropRaceErrors, [], `Unexpected backdrop-race page errors: ${backdropRaceErrors.join("; ")}`);
    await backdropRacePage.close();

    // Shared URL recovery after initial 503 error + retry: InspectorDrawer must STILL stack above CompareModal with focus & Escape order
    const retrySharedPage = await desktopCtx.newPage();
    const retrySharedErrors = [];
    retrySharedPage.on("pageerror", (err) => retrySharedErrors.push(err.message));
    let failInitialSharedLoad = true;
    const initialFailHandler = async (route) => {
      if (failInitialSharedLoad) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "e2e-initial-503" }) });
      } else {
        await route.continue();
      }
    };
    await retrySharedPage.route("**/api/v1/pulse*", initialFailHandler);
    await retrySharedPage.route("**/data/v2/latest.json*", initialFailHandler);
    await retrySharedPage.route("**/data/products.json*", initialFailHandler);
    await retrySharedPage.goto(sharedStackedUrl, { waitUntil: "networkidle" });
    await retrySharedPage.waitForSelector("[data-view-panel='terminal'] [data-action='refresh-snapshot']");
    failInitialSharedLoad = false;
    await retrySharedPage.locator("[data-view-panel='terminal'] [data-action='refresh-snapshot']").click();
    await retrySharedPage.waitForSelector("[data-compare-modal] .el-overlay");
    await retrySharedPage.waitForSelector("[data-inspector-backdrop] .el-overlay");
    await retrySharedPage.waitForFunction(() =>
      Boolean(document.querySelector("[data-inspector-backdrop]")?.contains(document.activeElement))
    );
    const retryLayerOrder = await retrySharedPage.evaluate(() => {
      const compOverlay = document.querySelector("[data-compare-modal] .el-overlay");
      const inspOverlay = document.querySelector("[data-inspector-backdrop] .el-overlay");
      return {
        compareZ: Number.parseInt(getComputedStyle(compOverlay).zIndex || "0", 10),
        inspectorZ: Number.parseInt(getComputedStyle(inspOverlay).zIndex || "0", 10),
        focusInInspector: Boolean(
          document.querySelector("[data-inspector-backdrop]")?.contains(document.activeElement)
        )
      };
    });
    assert.ok(
      retryLayerOrder.inspectorZ > retryLayerOrder.compareZ,
      `After 503 retry, InspectorDrawer must stack above CompareModal: ${JSON.stringify(retryLayerOrder)}`
    );
    assert.equal(retryLayerOrder.focusInInspector, true, "After 503 retry, focus must land inside InspectorDrawer");
    await retrySharedPage.keyboard.press("Escape");
    await retrySharedPage.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));
    assert.doesNotMatch(retrySharedPage.url(), /inspect=/);
    assert.match(retrySharedPage.url(), /compareOpen=1/);
    await retrySharedPage.keyboard.press("Escape");
    await retrySharedPage.waitForFunction(() => Boolean(document.querySelector("[data-compare-modal]")?.hidden));

    // History navigation (popstate) from an already-open InspectorDrawer to the shared stacked URL:
    // InspectorDrawer must stay on top with active focus and first Escape must clear inspect while keeping CompareModal open!
    const inspectOnlyUrl = new URL(sharedStackedUrl);
    inspectOnlyUrl.searchParams.delete("compareOpen");
    inspectOnlyUrl.searchParams.delete("compare");
    inspectOnlyUrl.searchParams.delete("cmp");
    await retrySharedPage.goto(inspectOnlyUrl.toString(), { waitUntil: "networkidle" });
    await retrySharedPage.waitForSelector("[data-inspector-backdrop] .el-overlay");
    await retrySharedPage.evaluate((targetUrl) => {
      window.history.pushState(null, "", targetUrl);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, sharedStackedUrl);
    await retrySharedPage.waitForSelector("[data-compare-modal] .el-overlay");
    await retrySharedPage.waitForSelector("[data-inspector-backdrop] .el-overlay");
    await retrySharedPage.waitForFunction(() => {
      const comp = document.querySelector("[data-compare-modal] .el-overlay");
      const insp = document.querySelector("[data-inspector-backdrop] .el-overlay");
      if (!comp || !insp) return false;
      const cz = Number.parseInt(getComputedStyle(comp).zIndex || "0", 10);
      const iz = Number.parseInt(getComputedStyle(insp).zIndex || "0", 10);
      return iz > cz && Boolean(document.querySelector("[data-inspector-backdrop]")?.contains(document.activeElement));
    });
    await retrySharedPage.keyboard.press("Escape");
    await retrySharedPage.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));
    assert.doesNotMatch(retrySharedPage.url(), /inspect=/);
    assert.match(retrySharedPage.url(), /compareOpen=1/);
    await retrySharedPage.keyboard.press("Escape");
    await retrySharedPage.waitForFunction(() => Boolean(document.querySelector("[data-compare-modal]")?.hidden));

    // Delayed initial snapshot + popstate BEFORE data arrives:
    // restoring shared stacked URL during loading must still open both CompareModal & InspectorDrawer with Inspector on top!
    let releaseDelayedPulse = null;
    const delayedPulsePromise = new Promise((resolve) => {
      releaseDelayedPulse = resolve;
    });
    const delayInitialPulseHandler = async (route) => {
      await delayedPulsePromise;
      await route.continue();
    };
    await retrySharedPage.route("**/api/v1/pulse*", delayInitialPulseHandler);
    const loadingNavPromise = retrySharedPage.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
    await loadingNavPromise;
    await retrySharedPage.waitForSelector("[data-skeleton-grid]");
    await retrySharedPage.evaluate((targetUrl) => {
      window.history.pushState(null, "", targetUrl);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, sharedStackedUrl);
    releaseDelayedPulse();
    await retrySharedPage.unroute("**/api/v1/pulse*", delayInitialPulseHandler);
    await retrySharedPage.waitForSelector("[data-compare-modal] .el-overlay");
    await retrySharedPage.waitForSelector("[data-inspector-backdrop] .el-overlay");
    await retrySharedPage.waitForFunction(() => {
      const comp = document.querySelector("[data-compare-modal] .el-overlay");
      const insp = document.querySelector("[data-inspector-backdrop] .el-overlay");
      if (!comp || !insp) return false;
      const cz = Number.parseInt(getComputedStyle(comp).zIndex || "0", 10);
      const iz = Number.parseInt(getComputedStyle(insp).zIndex || "0", 10);
      return iz > cz && Boolean(document.querySelector("[data-inspector-backdrop]")?.contains(document.activeElement));
    });
    await retrySharedPage.keyboard.press("Escape");
    await retrySharedPage.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));
    assert.doesNotMatch(retrySharedPage.url(), /inspect=/);
    assert.match(retrySharedPage.url(), /compareOpen=1/);
    await retrySharedPage.keyboard.press("Escape");
    await retrySharedPage.waitForFunction(() => Boolean(document.querySelector("[data-compare-modal]")?.hidden));

    // Underlying CompareModal closes via popstate while CommandPalette is open on top:
    // focus MUST remain in CommandPalette input and typing MUST go into CommandPalette (never background header)!
    await retrySharedPage.locator("[data-app-header] [data-action='open-compare']").click();
    await retrySharedPage.waitForSelector("[data-compare-modal] .el-overlay");
    await retrySharedPage.keyboard.press("Meta+k");
    await retrySharedPage.waitForFunction(
      () => document.activeElement === document.querySelector("[data-palette-input]")
    );
    await retrySharedPage.evaluate(() => {
      const u = new URL(window.location.href);
      u.searchParams.delete("compareOpen");
      window.history.pushState(null, "", u.toString());
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await retrySharedPage.waitForFunction(() => Boolean(document.querySelector("[data-compare-modal]")?.hidden));
    await retrySharedPage.waitForTimeout(80);
    const paletteFocusRetained = await retrySharedPage.evaluate(
      () =>
        !document.querySelector("[data-palette-backdrop]")?.hidden &&
        document.activeElement === document.querySelector("[data-palette-input]")
    );
    assert.equal(
      paletteFocusRetained,
      true,
      "Closing underlying CompareModal via popstate must keep focus inside active CommandPalette input"
    );
    await retrySharedPage.keyboard.type("HK");
    await retrySharedPage.waitForFunction(
      () => document.querySelector("[data-palette-input]")?.value === "HK"
    );
    await retrySharedPage.keyboard.press("Escape");
    await retrySharedPage.waitForFunction(() => Boolean(document.querySelector("[data-palette-backdrop]")?.hidden));
    await retrySharedPage.waitForFunction(
      () =>
        document.activeElement ===
        document.querySelector("[data-app-header] [data-action='open-compare']")
    );

    // 3-layer stack (CompareModal -> InspectorDrawer -> CommandPalette): popstate closes BOTH CompareModal & InspectorDrawer
    // while CommandPalette stays open; then Escape on CommandPalette MUST restore focus back to original header open-compare button!
    await retrySharedPage.locator("[data-app-header] [data-action='open-compare']").click();
    await retrySharedPage.waitForSelector("[data-compare-modal] .el-overlay");
    await retrySharedPage.keyboard.press("Meta+k");
    await retrySharedPage.getByRole("dialog", { name: "全局快速检索" }).waitFor({ state: "visible" });
    await retrySharedPage.locator("[data-palette-backdrop] button[data-action='palette-plan']").first().click();
    await retrySharedPage.waitForSelector("[data-inspector-backdrop] .el-overlay");
    await retrySharedPage.keyboard.press("Meta+k");
    await retrySharedPage.waitForFunction(
      () => document.activeElement === document.querySelector("[data-palette-input]")
    );
    await retrySharedPage.evaluate(() => {
      const u = new URL(window.location.href);
      u.searchParams.delete("compareOpen");
      u.searchParams.delete("inspect");
      window.history.pushState(null, "", u.toString());
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await retrySharedPage.waitForFunction(
      () =>
        Boolean(document.querySelector("[data-compare-modal]")?.hidden) &&
        Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden)
    );
    const threeLayerPaletteFocused = await retrySharedPage.evaluate(
      () =>
        !document.querySelector("[data-palette-backdrop]")?.hidden &&
        document.activeElement === document.querySelector("[data-palette-input]")
    );
    assert.equal(
      threeLayerPaletteFocused,
      true,
      "Closing BOTH underlying CompareModal & InspectorDrawer must keep CommandPalette focused"
    );
    await retrySharedPage.keyboard.press("Escape");
    await retrySharedPage.waitForFunction(() => Boolean(document.querySelector("[data-palette-backdrop]")?.hidden));
    await retrySharedPage.waitForFunction(
      () =>
        document.activeElement ===
        document.querySelector("[data-app-header] [data-action='open-compare']")
    );

    // Verify InspectorDrawer slow audit loading accessible status text + ElSkeleton AND failed audit ElAlert
    await retrySharedPage.locator("[data-filter-dock] [data-action='reset-filters']").click();
    await retrySharedPage.waitForFunction(
      () => document.querySelectorAll(".terminal-table tr[data-product-id]").length >= 5
    );
    let releaseSlowAudit = null;
    const slowAuditGate = new Promise((resolve) => {
      releaseSlowAudit = resolve;
    });
    const slowAuditHandler = async (route) => {
      await slowAuditGate;
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "e2e-audit-500" }) });
    };
    await retrySharedPage.route("**/audit/*", slowAuditHandler);
    await retrySharedPage.locator(".terminal-table tr[data-product-id]").nth(3).click();
    await retrySharedPage.waitForSelector("[data-audit-loading]");
    const auditLoadingCheck = await retrySharedPage.evaluate(() => {
      const sec = document.querySelector("[data-audit-loading]");
      return {
        role: sec?.getAttribute("role") || "",
        text: sec?.textContent?.trim() || "",
        hasSkeleton: Boolean(sec?.querySelector(".el-skeleton"))
      };
    });
    assert.equal(auditLoadingCheck.role, "status");
    assert.match(auditLoadingCheck.text, /正在按需读取源站 HTTP 抓取审计分片/);
    assert.equal(auditLoadingCheck.hasSkeleton, true);
    releaseSlowAudit();
    await retrySharedPage.waitForSelector("[data-audit-notice].el-alert");
    const auditErrorCheck = await retrySharedPage.evaluate(() => {
      const alert = document.querySelector("[data-audit-notice]");
      return {
        isElAlert: Boolean(alert?.classList?.contains("el-alert")),
        role: alert?.getAttribute("role") || "",
        text: alert?.textContent?.trim() || ""
      };
    });
    assert.equal(auditErrorCheck.isElAlert, true);
    assert.equal(auditErrorCheck.role, "status");
    assert.ok(auditErrorCheck.text.length > 0, "Audit failure ElAlert must render error text");
    await retrySharedPage.unroute("**/audit/*", slowAuditHandler);
    await retrySharedPage.keyboard.press("Escape");
    await retrySharedPage.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));

    assert.deepEqual(retrySharedErrors, [], `Unexpected retry/popstate shared-URL errors: ${retrySharedErrors.join("; ")}`);
    await retrySharedPage.close();

    // Short-viewport CommandPalette independent results scroll: input row & Esc button stay visible while scrolling to last result
    const shortPalettePage = await desktopCtx.newPage();
    await shortPalettePage.setViewportSize({ width: 1280, height: 480 });
    await shortPalettePage.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await shortPalettePage.waitForSelector(".terminal-table tr[data-product-id]");
    await shortPalettePage.keyboard.press("Meta+k");
    await shortPalettePage.waitForFunction(() => !document.querySelector("[data-palette-backdrop]")?.hidden);
    const shortScrollCheck = await shortPalettePage.evaluate(() => {
      const results = document.querySelector("[data-palette-backdrop] .palette-results");
      const items = [...document.querySelectorAll("[data-palette-backdrop] .palette-item")];
      const lastItem = items.at(-1);
      results.scrollTop = results.scrollHeight;
      const inputRect = document.querySelector("[data-palette-input]").getBoundingClientRect();
      const closeRect = document.querySelector("[data-palette-backdrop] [data-action='close-palette']").getBoundingClientRect();
      const lastRect = lastItem.getBoundingClientRect();
      return {
        itemCount: items.length,
        canScroll: results.scrollHeight > results.clientHeight,
        scrollTop: results.scrollTop,
        inputInView: inputRect.top >= 0 && inputRect.bottom <= 480,
        closeInView: closeRect.top >= 0 && closeRect.bottom <= 480,
        lastInView: lastRect.top >= 0 && lastRect.bottom <= 480
      };
    });
    assert.equal(shortScrollCheck.canScroll, true, `Short viewport .palette-results must scroll independently: ${JSON.stringify(shortScrollCheck)}`);
    assert.ok(shortScrollCheck.scrollTop > 0, `Short viewport .palette-results must actually scroll: ${JSON.stringify(shortScrollCheck)}`);
    assert.equal(shortScrollCheck.inputInView, true, `Search input must stay visible in short viewport: ${JSON.stringify(shortScrollCheck)}`);
    assert.equal(shortScrollCheck.closeInView, true, `Esc close button must stay visible in short viewport: ${JSON.stringify(shortScrollCheck)}`);
    assert.equal(shortScrollCheck.lastInView, true, `Last command item must be visible & operable after scrolling: ${JSON.stringify(shortScrollCheck)}`);
    await shortPalettePage.locator("[data-palette-backdrop] .palette-item").last().click();
    await shortPalettePage.waitForFunction(() => Boolean(document.querySelector("[data-palette-backdrop]")?.hidden));
    await shortPalettePage.close();

    // First Escape closes topmost InspectorDrawer, keeps CompareModal open, clears ?inspect=, and returns focus to CompareModal!
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));
    assert.doesNotMatch(page.url(), /inspect=/);
    const compareStillOpenAndFocused = await page.evaluate(() => {
      const modal = document.querySelector("[data-compare-modal]");
      return {
        open: Boolean(modal && !modal.hidden),
        focusInsideCompare: Boolean(modal?.contains(document.activeElement))
      };
    });
    assert.equal(compareStillOpenAndFocused.open, true, "CompareModal must remain open after closing stacked InspectorDrawer");
    assert.equal(
      compareStillOpenAndFocused.focusInsideCompare,
      true,
      `Focus must return inside CompareModal after closing stacked InspectorDrawer: ${JSON.stringify(compareStillOpenAndFocused)}`
    );

    // Second Escape closes CompareModal — first verify per-item ElButton actions and focus retention when removing 1 of 2 items!
    const modalRemoveBtns = page.locator("[data-compare-modal] button.el-button[data-action='toggle-compare']");
    const modalInspectBtns = page.locator("[data-compare-modal] button.el-button[data-action='inspect-from-compare']");
    assert.equal(await modalRemoveBtns.count(), 2, "CompareModal per-item remove buttons must render as ElButton");
    assert.equal(await modalInspectBtns.count(), 2, "CompareModal per-item inspect buttons must render as ElButton");
    await modalRemoveBtns.first().focus();
    await modalRemoveBtns.first().click();
    await page.waitForFunction(
      () => document.querySelectorAll("[data-compare-modal] [data-action='toggle-compare']").length === 1
    );
    const compareAfterRemoveFocus = await page.evaluate(() => ({
      inModal: Boolean(document.querySelector("[data-compare-modal]")?.contains(document.activeElement)),
      action: document.activeElement?.getAttribute?.("data-action") || ""
    }));
    assert.equal(
      compareAfterRemoveFocus.inModal,
      true,
      `Removing focused item from 2-item CompareModal must keep focus inside modal: ${JSON.stringify(compareAfterRemoveFocus)}`
    );
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() => Boolean(document.querySelector("[data-compare-modal]")?.contains(document.activeElement))),
      true,
      "Tab must stay trapped inside CompareModal after removing focused item"
    );
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await page.evaluate(() => Boolean(document.querySelector("[data-compare-modal]")?.contains(document.activeElement))),
      true,
      "Shift+Tab must stay trapped inside CompareModal after removing focused item"
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => Boolean(document.querySelector("[data-compare-modal]")?.hidden));
    await page.waitForFunction(
      () =>
        document.activeElement ===
        document.querySelector("[data-app-header] [data-action='open-compare']")
    );
    await page.locator("[data-compare-dock] [data-action='clear-compare']").click();
    await page.waitForFunction(() => Boolean(document.querySelector("[data-compare-dock]")?.hidden));

    // Verify removing the LAST compared item inside 1-item CompareModal restores focus to #main-workspace (NOT BODY) when original header trigger unmounts
    await page.locator(".terminal-table tr[data-product-id] button.el-button[data-action='toggle-compare']").first().click();
    await page.waitForSelector("[data-app-header] [data-action='open-compare']");
    const singleHeaderCompareBtn = page.locator("[data-app-header] [data-action='open-compare']");
    await singleHeaderCompareBtn.focus();
    await singleHeaderCompareBtn.click();
    await page.getByRole("dialog", { name: "多方案关键指标横向对比" }).waitFor({ state: "visible" });
    const singleRemoveBtn = page.locator("[data-compare-modal] [data-action='toggle-compare']").first();
    await singleRemoveBtn.focus();
    await singleRemoveBtn.click();
    await page.waitForFunction(
      () =>
        Boolean(document.querySelector("[data-compare-modal]")?.hidden) &&
        !document.querySelector("[data-app-header] [data-action='open-compare']")
    );
    await page.waitForFunction(() => document.activeElement?.id === "main-workspace");
    await page.keyboard.press("Tab");
    const desktopPostLastRemoveTab = await page.evaluate(() => {
      const el = document.activeElement;
      const rect = el?.getBoundingClientRect?.();
      return {
        tag: el?.tagName || "",
        id: el?.id || "",
        visible: Boolean(rect && rect.width > 0 && rect.height > 0)
      };
    });
    assert.ok(
      desktopPostLastRemoveTab.tag !== "BODY" &&
        desktopPostLastRemoveTab.id !== "main-workspace" &&
        desktopPostLastRemoveTab.visible,
      `Tab after desktop last-compare removal must enter visible page controls: ${JSON.stringify(desktopPostLastRemoveTab)}`
    );

    // Verify ProvidersView sample inspect-plan and drill-provider buttons render as ElButton and execute real actions
    await page.locator(".ws-nav [data-nav-view='providers']").click();
    await page.waitForSelector("[data-view-panel='providers'] .provider-card");
    const providersButtonCheck = await page.evaluate(() => {
      const panel = document.querySelector("[data-view-panel='providers']");
      const allInspect = panel.querySelectorAll("button[data-action='inspect-plan']").length;
      const elInspect = panel.querySelectorAll("button.el-button.prov-sample-item[data-action='inspect-plan']").length;
      const allDrill = panel.querySelectorAll("button[data-action='drill-provider']").length;
      const elDrill = panel.querySelectorAll("button.el-button[data-action='drill-provider']").length;
      const disabledDrill = panel.querySelectorAll("button.el-button[data-action='drill-provider']:disabled").length;
      const enabledDrill = panel.querySelectorAll("button.el-button[data-action='drill-provider']:not(:disabled)").length;
      return { allInspect, elInspect, allDrill, elDrill, disabledDrill, enabledDrill };
    });
    assert.ok(providersButtonCheck.elInspect >= 1, `ProvidersView must render sample ElButtons: ${JSON.stringify(providersButtonCheck)}`);
    assert.equal(providersButtonCheck.elInspect, providersButtonCheck.allInspect, "All ProvidersView inspect-plan buttons must render as ElButton");
    assert.ok(providersButtonCheck.enabledDrill >= 1, `ProvidersView must render enabled drill-provider ElButtons: ${JSON.stringify(providersButtonCheck)}`);
    assert.equal(providersButtonCheck.elDrill, providersButtonCheck.allDrill, "All ProvidersView drill-provider buttons must render as ElButton");
    const firstProvSampleBtn = page.locator("[data-view-panel='providers'] button.el-button.prov-sample-item[data-action='inspect-plan']").first();
    const provSampleProductId = await firstProvSampleBtn.getAttribute("data-product-id");
    assert.ok(provSampleProductId, "ProvidersView sample button must carry data-product-id");
    await firstProvSampleBtn.click();
    await page.getByRole("dialog", { name: "套餐解析证据与定价解剖" }).waitFor({ state: "visible" });
    assert.ok(
      page.url().includes(`inspect=${encodeURIComponent(provSampleProductId)}`),
      `ProvidersView sample ElButton click must open matching InspectorDrawer (${provSampleProductId}, url=${page.url()})`
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));
    const firstProvDrillBtn = page.locator("[data-view-panel='providers'] button.el-button[data-action='drill-provider']:not(:disabled)").first();
    const drilledProviderId = await firstProvDrillBtn.getAttribute("data-provider-id");
    assert.ok(drilledProviderId, "ProvidersView drill button must carry data-provider-id");
    await firstProvDrillBtn.click();
    await page.waitForFunction(() => !document.querySelector("[data-view-panel='terminal']")?.hidden);
    assert.ok(
      page.url().includes(`provider=${encodeURIComponent(drilledProviderId)}`),
      `ProvidersView drill-provider ElButton must filter terminal view (${drilledProviderId}, url=${page.url()})`
    );
    await page.locator("[data-filter-dock] [data-action='reset-filters']").click();
    await page.waitForFunction(() => !window.location.href.includes("provider="));

    // Verify GuideView route-ladder and IP-tier jump buttons render as ElButton and navigate cleanly to filtered terminal
    await page.locator(".ws-nav [data-nav-view='guide']").click();
    await page.waitForSelector("[data-view-panel='guide'] .route-ladder-row");
    const guideButtonCheck = await page.evaluate(() => {
      const panel = document.querySelector("[data-view-panel='guide']");
      const allRoute = panel.querySelectorAll("button[data-action='guide-jump-route']").length;
      const elRoute = panel.querySelectorAll("button.el-button[data-action='guide-jump-route']").length;
      const allTierJump = panel.querySelectorAll(
        "button[data-action='guide-jump-track'], button[data-action='guide-jump-opt'], button[data-action='guide-jump-nonat']"
      ).length;
      const elTierJump = panel.querySelectorAll(
        "button.el-button[data-action='guide-jump-track'], button.el-button[data-action='guide-jump-opt'], button.el-button[data-action='guide-jump-nonat']"
      ).length;
      return { allRoute, elRoute, allTierJump, elTierJump };
    });
    assert.equal(guideButtonCheck.allRoute, 7, `GuideView must render 7 route ladder buttons: ${JSON.stringify(guideButtonCheck)}`);
    assert.equal(guideButtonCheck.elRoute, 7, `All 7 GuideView route ladder buttons must render as ElButton: ${JSON.stringify(guideButtonCheck)}`);
    assert.equal(guideButtonCheck.elTierJump, guideButtonCheck.allTierJump, "All GuideView IP-tier/NAT jump buttons must render as ElButton");
    await page.locator("[data-view-panel='guide'] button.el-button[data-action='guide-jump-route'][data-route='cn2']").click();
    await page.waitForFunction(() => !document.querySelector("[data-view-panel='terminal']")?.hidden);
    assert.match(page.url(), /route=cn2/);
    await page.locator("[data-filter-dock] [data-action='reset-filters']").click();
    await page.waitForFunction(() => !window.location.href.includes("route="));

    // Verify TerminalView zero-results uses ElEmpty
    await searchInTerminal("no-such-plan-e2e-zero-result");
    await page.waitForSelector("[data-zero-results] .el-empty");
    await page.locator("[data-zero-results] [data-action='reset-filters']").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".terminal-table tr[data-product-id]").length >= 12
    );

    // Verify light-theme contrast >= 4.5:1 for ElMessage success toast text & header warning plain saved button (normal + hover)
    const firstCatalogRow = page.locator(".terminal-table tr[data-product-id]").first();
    await firstCatalogRow.locator("button[data-action='toggle-save']").first().click();
    await page.waitForSelector(".el-message.radar-el-message .el-message__content");
    const toastContrast = await measurePairContrast(
      ".el-message.radar-el-message .el-message__content",
      ".el-message.radar-el-message"
    );
    assert.ok(
      toastContrast && toastContrast.contrast >= 4.5,
      `Light ElMessage success text contrast must be >= 4.5:1: ${JSON.stringify(toastContrast)}`
    );
    const savedBtnNormalContrast = await measurePairContrast(
      "[data-app-header] [data-action='open-saved']"
    );
    assert.ok(
      savedBtnNormalContrast && savedBtnNormalContrast.contrast >= 4.5,
      `Light header warning plain saved button normal contrast must be >= 4.5:1: ${JSON.stringify(savedBtnNormalContrast)}`
    );
    await page.locator("[data-app-header] [data-action='open-saved']").hover();
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector("[data-app-header] [data-action='open-saved']")).color ===
        "rgb(255, 255, 255)"
    );
    const savedBtnHoverContrast = await measurePairContrast(
      "[data-app-header] [data-action='open-saved']"
    );
    assert.ok(
      savedBtnHoverContrast && savedBtnHoverContrast.contrast >= 4.5,
      `Light header warning plain saved button hover contrast must be >= 4.5:1: ${JSON.stringify(savedBtnHoverContrast)}`
    );
    // Verify terminal savedOnly ElSwitch keyboard toggle, saved count, filtered row count, and share URL sync
    const savedSwitchInput = page.locator("[data-filter-dock] [data-action='toggle-quick-saved'] input[role='switch']");
    await savedSwitchInput.waitFor({ state: "attached" });
    assert.match(
      (await savedSwitchInput.getAttribute("aria-label")) || "",
      /收藏.*1/,
      "Terminal savedOnly ElSwitch must expose accessible name with live saved count"
    );
    assert.match(
      (await page.locator("[data-terminal-saved-count]").textContent()) || "",
      /★ 收藏 \(1\)/
    );
    await savedSwitchInput.focus();
    await page.keyboard.press("Space");
    await page.waitForFunction(() => window.location.search.includes("saved=1"));
    assert.equal(await savedSwitchInput.getAttribute("aria-checked"), "true");
    assert.equal(
      await page.locator(".terminal-table tr[data-product-id]").count(),
      1,
      "Toggling terminal savedOnly ElSwitch ON must filter table to only the 1 saved plan"
    );
    await page.keyboard.press("Space");
    await page.waitForFunction(() => !window.location.search.includes("saved=1"));
    assert.equal(await savedSwitchInput.getAttribute("aria-checked"), "false");
    await page.waitForFunction(
      () => document.querySelectorAll(".terminal-table tr[data-product-id]").length >= 12
    );
    // Clean up saved state via SavedDrawer per-item ElButton actions (compare toggle with aria-pressed, inspect-plan, and remove)
    await page.locator("[data-app-header] [data-action='open-saved']").click();
    await page.waitForFunction(() => !document.querySelector("[data-saved-backdrop]")?.hidden);
    const savedInspectBtn = page.locator("[data-saved-backdrop] button.el-button[data-action='inspect-plan']").first();
    const savedCompareBtn = page.locator("[data-saved-backdrop] button.el-button[data-action='toggle-compare']").first();
    const savedRemoveBtn = page.locator("[data-saved-backdrop] button.el-button[data-action='toggle-save']").first();
    await savedInspectBtn.waitFor({ state: "visible" });
    assert.equal(await savedCompareBtn.getAttribute("aria-pressed"), "false");
    await savedCompareBtn.click();
    assert.equal(await savedCompareBtn.getAttribute("aria-pressed"), "true");
    assert.match((await savedCompareBtn.textContent()) || "", /已加对比/);
    await savedCompareBtn.click();
    assert.equal(await savedCompareBtn.getAttribute("aria-pressed"), "false");
    // Verify 查证据 button closes SavedDrawer and opens InspectorDrawer
    await savedInspectBtn.click();
    await page.waitForFunction(() => Boolean(document.querySelector("[data-saved-backdrop]")?.hidden));
    await page.waitForFunction(() => !document.querySelector("[data-inspector-backdrop]")?.hidden);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));
    // Re-open SavedDrawer, focus & remove the last saved item via ElButton 取消收藏, verify focus stays inside drawer (close-saved) & Tab/Shift+Tab stay trapped, then Escape returns focus to open-saved
    await page.locator("[data-app-header] [data-action='open-saved']").click();
    await page.waitForFunction(() => !document.querySelector("[data-saved-backdrop]")?.hidden);
    await savedRemoveBtn.focus();
    await savedRemoveBtn.click();
    await page.waitForSelector("[data-saved-backdrop] .el-empty");
    const savedAfterRemoveFocus = await page.evaluate(() => ({
      inDrawer: Boolean(document.querySelector("[data-saved-backdrop]")?.contains(document.activeElement)),
      action: document.activeElement?.getAttribute?.("data-action") || ""
    }));
    assert.equal(
      savedAfterRemoveFocus.inDrawer,
      true,
      `Removing last item from SavedDrawer must keep focus inside drawer: ${JSON.stringify(savedAfterRemoveFocus)}`
    );
    assert.equal(savedAfterRemoveFocus.action, "close-saved");
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() => Boolean(document.querySelector("[data-saved-backdrop]")?.contains(document.activeElement))),
      true,
      "Tab must stay trapped inside empty SavedDrawer"
    );
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await page.evaluate(() => Boolean(document.querySelector("[data-saved-backdrop]")?.contains(document.activeElement))),
      true,
      "Shift+Tab must stay trapped inside empty SavedDrawer"
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => Boolean(document.querySelector("[data-saved-backdrop]")?.hidden));
    await page.waitForFunction(
      () =>
        document.activeElement ===
        document.querySelector("[data-app-header] [data-action='open-saved']")
    );

    // Verify GuideView checklist ElProgress exposes accessible name and updates aria-valuenow
    await page.locator(".ws-nav [data-nav-view='guide']").click();
    const guideProgress = page.getByRole("progressbar", { name: "买前 & 交付后 4 步验真自检表" });
    await guideProgress.waitFor({ state: "visible" });
    assert.equal(await guideProgress.getAttribute("aria-valuenow"), "0");
    await page.locator("[data-action='toggle-guide-check'][data-check-id='chk-nat']").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector("[data-view-panel='guide'] [role='progressbar']")
          ?.getAttribute("aria-valuenow") === "25"
    );
    await page.locator(".ws-nav [data-nav-view='terminal']").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".terminal-table tr[data-product-id]").length >= 12
    );

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

    // Scenario A.6: Full-list (>= 3,700 filterable plans with shops & specs expanded) 1920x1080 BOTH table & grid mode DOM < 4000 + deep scroll
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.locator("[data-filter-dock] [data-action='toggle-quick-available']").click();
    await page.locator("[data-filter-dock] [data-action='toggle-shops-expand']").click();
    await page.locator("[data-filter-dock] [data-action='toggle-specs-expand']").click();

    const matchedFullCatalogCount = await page.evaluate(() =>
      Number.parseInt(document.querySelector(".result-summary strong")?.textContent?.trim() || "0", 10)
    );
    assert.ok(
      matchedFullCatalogCount >= 3700,
      `Full-catalog virtual scroll acceptance must cover >= 3,700 filterable plans (got ${matchedFullCatalogCount})`
    );

    // 0) 1920x1080 desktop TABLE mode deep scroll & bounded DOM (< 4000) on >= 3,700 plans
    await page.waitForSelector(".terminal-table tr[data-product-id]");
    const table1920Check = await page.evaluate(() => ({
      rowCount: document.querySelectorAll(".terminal-table tr[data-product-id]").length,
      scrollHeight: document.documentElement.scrollHeight,
      domNodes: document.querySelectorAll("*").length
    }));
    assert.ok(table1920Check.rowCount >= 8, `Expected virtualized table rows >= 8 (got ${table1920Check.rowCount})`);
    assert.ok(
      table1920Check.scrollHeight > 80000,
      `Expected >=3700-plan table scrollHeight > 80000px (got ${table1920Check.scrollHeight})`
    );
    assert.ok(
      table1920Check.domNodes < 4000,
      `1920px full-catalog table with shops & specs expanded must keep total DOM < 4000 (got ${table1920Check.domNodes})`
    );
    for (const targetY of [15000, 45000, 90000]) {
      await page.evaluate((y) => window.scrollTo(0, y), targetY);
      await page.waitForTimeout(140);
      const tableProbe = await page.evaluate(() => {
        const rows = [...document.querySelectorAll(".terminal-table tr[data-product-id]")];
        const rects = rows.map((r) => r.getBoundingClientRect());
        let overlaps = 0;
        for (let i = 1; i < rects.length; i += 1) {
          if (rects[i].top < rects[i - 1].bottom - 2) overlaps += 1;
        }
        const visibleCount = rects.filter((r) => r.bottom > 80 && r.top < window.innerHeight).length;
        return {
          scrollY: window.scrollY,
          visibleCount,
          overlaps,
          domNodes: document.querySelectorAll("*").length
        };
      });
      assert.ok(tableProbe.scrollY >= targetY - 1500, `Expected real table deep scroll near ${targetY}, got ${tableProbe.scrollY}`);
      assert.ok(tableProbe.visibleCount >= 4, `Expected >=4 visible table rows at scrollY=${tableProbe.scrollY}, got ${tableProbe.visibleCount}`);
      assert.equal(tableProbe.overlaps, 0, `Detected overlapping virtual table rows at scrollY=${tableProbe.scrollY}`);
      assert.ok(
        tableProbe.domNodes < 4000,
        `1920px full-catalog table deep scroll at ${targetY} must keep total DOM < 4000 (got ${tableProbe.domNodes})`
      );
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(100);

    // 1) 1920x1080 desktop grid mode: container max-width caps columns to 4 (never 6 wrapping into 2 rows!) & total DOM stays < 4,000 even with shops + specs expanded on all inventory!
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
      return {
        cols,
        rowCount: rows.length,
        scrollHeight,
        wrappedRows,
        domNodes: document.querySelectorAll("*").length
      };
    });
    assert.equal(grid1920Check.cols, 4, `1920px container must resolve to 4 columns (got ${grid1920Check.cols})`);
    assert.ok(grid1920Check.rowCount >= 4, `Expected multi-row virtualized grid (got ${grid1920Check.rowCount})`);
    assert.ok(grid1920Check.scrollHeight > 25000, `Expected full-catalog scrollHeight > 25000px (got ${grid1920Check.scrollHeight})`);
    assert.equal(grid1920Check.wrappedRows, 0, "1920px virtual grid rows must NEVER wrap into multiple lines");
    assert.ok(
      grid1920Check.domNodes < 4000,
      `1920px full-catalog grid with shops & specs expanded must keep total DOM < 4000 (got ${grid1920Check.domNodes})`
    );

    // Deep continuous scroll across multiple positions in 1920px grid mode -> rendered virtual rows stay aligned, non-overlapping & DOM < 4000!
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
        return {
          scrollY: window.scrollY,
          visibleCount,
          overlaps,
          domNodes: document.querySelectorAll("*").length
        };
      });
      assert.ok(probe.scrollY >= targetY - 1500, `Expected real deep scroll near ${targetY}, got ${probe.scrollY}`);
      assert.ok(probe.visibleCount >= 2, `Expected >=2 visible grid rows at scrollY=${probe.scrollY}, got ${probe.visibleCount}`);
      assert.equal(probe.overlaps, 0, `Detected overlapping virtual rows at scrollY=${probe.scrollY}`);
      assert.ok(
        probe.domNodes < 4000,
        `1920px full-catalog deep scroll at ${targetY} must keep total DOM < 4000 (got ${probe.domNodes})`
      );
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(100);
    // Restore collapsed filter dock & available-only default before desktop Escape/searchbox and 640px checks
    await page.locator("[data-filter-dock] [data-action='toggle-specs-expand']").first().click();
    await page.locator("[data-filter-dock] [data-action='toggle-shops-expand']").first().click();
    await page.locator("[data-filter-dock] [data-action='toggle-quick-available']").click();

    // Switch back to default table layout
    await page.locator(".layout-view-toggle [data-layout='table']").click();
    await page.waitForSelector(".terminal-table tr[data-product-id]");

    // Verify collapsed desktop RadarSelect passes Escape through to close open [data-tag-hud]
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForSelector("[data-filter-dock] [data-filter-select='cycle'] [role='combobox']");
    const desktopCycleCombo = page.locator("[data-filter-dock] [data-filter-select='cycle'] [role='combobox']");
    await desktopCycleCombo.focus();
    await page.mouse.move(1, 1);
    await page.locator("[data-filter-dock] button[data-tag-tip]").first().hover();
    await page.waitForFunction(() => !document.querySelector("[data-tag-hud]")?.hidden);
    assert.equal(
      await page.evaluate(
        () =>
          document.activeElement ===
          document.querySelector("[data-filter-dock] [data-filter-select='cycle'] [role='combobox']")
      ),
      true,
      "Focus must remain on collapsed desktop cycle RadarSelect while tag HUD is hovered open"
    );
    assert.notEqual(
      await desktopCycleCombo.getAttribute("aria-expanded"),
      "true",
      "Desktop cycle RadarSelect must be collapsed before testing Escape passthrough to HUD"
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => Boolean(document.querySelector("[data-tag-hud]")?.hidden));

    // Verify non-searchable RadarSelect supports Spacebar open + ArrowDown + Spacebar confirm (no page scroll),
    // while searchable RadarSelect preserves literal Spacebar input in filter query!
    await page.evaluate(() => window.scrollTo(0, 0));
    await desktopCycleCombo.focus();
    await page.keyboard.press("Space");
    await page.waitForFunction(
      () =>
        document
          .querySelector("[data-filter-dock] [data-filter-select='cycle'] [role='combobox']")
          ?.getAttribute("aria-expanded") === "true"
    );
    assert.equal(await page.evaluate(() => window.scrollY), 0, "Spacebar opening non-searchable RadarSelect must not scroll page");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Space");
    await page.waitForFunction(
      () =>
        document
          .querySelector("[data-filter-dock] [data-filter-select='cycle'] [role='combobox']")
          ?.getAttribute("aria-expanded") === "false" &&
        new URL(window.location.href).searchParams.get("cycle") !== null
    );
    const selectedCycleBySpace = new URL(page.url()).searchParams.get("cycle");
    assert.ok(selectedCycleBySpace && selectedCycleBySpace !== "all", `Spacebar confirm must commit highlighted cycle option (got ${selectedCycleBySpace})`);
    assert.equal(await page.evaluate(() => window.scrollY), 0, "Spacebar confirming non-searchable RadarSelect must not scroll page");
    // Reset cycle back to default before subsequent assertions
    await page.locator("[data-filter-dock] [data-action='reset-filters']").click();
    await page.waitForFunction(() => !new URL(window.location.href).searchParams.has("cycle"));

    const desktopRegionCombo = page.locator("[data-filter-dock] [data-filter-select='region'] [role='combobox']");
    await desktopRegionCombo.click();
    await page.waitForFunction(
      () =>
        document
          .querySelector("[data-filter-dock] [data-filter-select='region'] [role='combobox']")
          ?.getAttribute("aria-expanded") === "true"
    );
    await page.keyboard.type("US ");
    assert.equal(
      await desktopRegionCombo.inputValue(),
      "US ",
      "Searchable RadarSelect must preserve literal Spacebar typing inside filter query"
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () =>
        document
          .querySelector("[data-filter-dock] [data-filter-select='region'] [role='combobox']")
          ?.getAttribute("aria-expanded") === "false"
    );

    // Verify jumping from real focused-header-button stacked overlays (header open-compare -> CompareModal -> Ctrl+K -> InspectorDrawer / CommandPalette):
    // 1) drill-provider, 2) jump-deal ("同款"), 3) jump-radar ("全部异动"), 4) CommandPalette Enter filter.
    // All 4 MUST close obstructing overlays, unlock scroll, focus #main-workspace (NOT open-compare), preserve cmp while dropping compareOpen,
    // leave target workspace directly operable, and produce ZERO pageerror / console.error (Vue handler ReferenceError).
    const stackedJumpPage = await desktopCtx.newPage();
    const stackedJumpErrors = [];
    const stackedJumpConsoleErrors = [];
    stackedJumpPage.on("pageerror", (err) => stackedJumpErrors.push(err.message));
    stackedJumpPage.on("console", (msg) => {
      if (msg.type() === "error") stackedJumpConsoleErrors.push(msg.text());
    });
    await stackedJumpPage.goto(`${baseUrl}/?q=E2E+Deterministic`, { waitUntil: "networkidle" });
    await stackedJumpPage.waitForSelector(".terminal-table tr[data-product-id='e2e-fixed-tagged-bwh-ams']");
    const bwhToggleBtn = stackedJumpPage
      .locator(".terminal-table tr[data-product-id='e2e-fixed-tagged-bwh-ams'] button[data-action='toggle-compare']")
      .first();
    const aaitrToggleBtn = stackedJumpPage
      .locator(".terminal-table tr[data-product-id='e2e-fixed-aaitr-hk'] button[data-action='toggle-compare']")
      .first();
    const bwhCmpKeyForJump = await bwhToggleBtn.getAttribute("data-key");
    const aaitrCmpKeyForJump = await aaitrToggleBtn.getAttribute("data-key");
    await bwhToggleBtn.click();
    await aaitrToggleBtn.click();
    await stackedJumpPage.waitForFunction(
      () => document.querySelectorAll("[data-compare-dock] .dock-pill").length === 2
    );

    const openStackedInspectorFromHeader = async () => {
      const headerCompare = stackedJumpPage.locator("[data-app-header] [data-action='open-compare']");
      await headerCompare.waitFor({ state: "visible" });
      await headerCompare.focus();
      await headerCompare.click();
      await stackedJumpPage.waitForSelector("[data-compare-modal] .el-overlay");
      await stackedJumpPage.keyboard.press("Control+k");
      const palInput = stackedJumpPage.locator("[data-palette-input]");
      await palInput.waitFor({ state: "visible" });
      await palInput.fill("Amsterdam E2E Deterministic");
      const planHit = stackedJumpPage
        .locator("[data-palette-backdrop] [data-action='palette-plan'][data-product-id='e2e-fixed-tagged-bwh-ams']")
        .first();
      await planHit.waitFor({ state: "visible" });
      await planHit.click();
      await stackedJumpPage.waitForSelector("[data-inspector-backdrop] .el-overlay");
      await stackedJumpPage.waitForSelector("[data-compare-modal] .el-overlay");
    };

    // Case 1: drill-provider from stacked InspectorDrawer opened via focused header compare button
    await openStackedInspectorFromHeader();
    await stackedJumpPage.locator("[data-inspector-backdrop] [data-action='drill-provider']").click();
    await stackedJumpPage.waitForFunction(
      () =>
        Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden) &&
        Boolean(document.querySelector("[data-compare-modal]")?.hidden) &&
        !document.body.classList.contains("scroll-locked") &&
        !document.querySelector("[data-view-panel='terminal']")?.hidden
    );
    await stackedJumpPage.waitForFunction(() => document.activeElement?.id === "main-workspace");
    const afterDrillUrl = new URL(stackedJumpPage.url());
    assert.equal(afterDrillUrl.searchParams.get("provider"), "bwh", `Expected provider=bwh after drill: ${stackedJumpPage.url()}`);
    assert.equal(afterDrillUrl.searchParams.has("compareOpen"), false, `compareOpen must be cleared after drill: ${stackedJumpPage.url()}`);
    assert.equal(afterDrillUrl.searchParams.has("inspect"), false, `inspect must be cleared after drill: ${stackedJumpPage.url()}`);
    assert.deepEqual(
      afterDrillUrl.searchParams.getAll("cmp"),
      [bwhCmpKeyForJump, aaitrCmpKeyForJump],
      `cmp keys must be preserved after drill: ${stackedJumpPage.url()}`
    );
    await stackedJumpPage.locator(".terminal-table tr[data-product-id]").first().click();
    await stackedJumpPage.waitForSelector("[data-inspector-backdrop] .el-overlay");
    await stackedJumpPage.keyboard.press("Escape");
    await stackedJumpPage.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));

    // Case 2: jump-deal ("同款") from stacked InspectorDrawer opened via focused header compare button
    await openStackedInspectorFromHeader();
    const jumpDealBtn = stackedJumpPage.locator("[data-inspector-backdrop] [data-action='jump-deal-from-inspector']").first();
    await jumpDealBtn.waitFor({ state: "visible" });
    await jumpDealBtn.click();
    await stackedJumpPage.waitForFunction(
      () =>
        Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden) &&
        Boolean(document.querySelector("[data-compare-modal]")?.hidden) &&
        !document.body.classList.contains("scroll-locked") &&
        !document.querySelector("[data-view-panel='terminal']")?.hidden
    );
    await stackedJumpPage.waitForFunction(() => document.activeElement?.id === "main-workspace");
    const afterJumpDealUrl = new URL(stackedJumpPage.url());
    assert.ok(afterJumpDealUrl.searchParams.get("deal"), `Expected deal filter after jump-deal: ${stackedJumpPage.url()}`);
    assert.equal(afterJumpDealUrl.searchParams.has("compareOpen"), false, `compareOpen must be cleared after jump-deal: ${stackedJumpPage.url()}`);
    assert.equal(afterJumpDealUrl.searchParams.has("inspect"), false, `inspect must be cleared after jump-deal: ${stackedJumpPage.url()}`);
    assert.deepEqual(
      afterJumpDealUrl.searchParams.getAll("cmp"),
      [bwhCmpKeyForJump, aaitrCmpKeyForJump],
      `cmp keys must be preserved after jump-deal: ${stackedJumpPage.url()}`
    );
    await stackedJumpPage.locator(".terminal-table tr[data-product-id]").first().click();
    await stackedJumpPage.waitForSelector("[data-inspector-backdrop] .el-overlay");
    await stackedJumpPage.keyboard.press("Escape");
    await stackedJumpPage.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));

    // Case 3: jump-radar ("全部异动") from stacked InspectorDrawer opened via focused header compare button
    await openStackedInspectorFromHeader();
    const jumpRadarBtn = stackedJumpPage.locator("[data-inspector-backdrop] [data-action='jump-radar-from-inspector']");
    await jumpRadarBtn.waitFor({ state: "visible" });
    await jumpRadarBtn.click();
    await stackedJumpPage.waitForFunction(
      () =>
        Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden) &&
        Boolean(document.querySelector("[data-compare-modal]")?.hidden) &&
        !document.body.classList.contains("scroll-locked") &&
        !document.querySelector("[data-view-panel='radar']")?.hidden
    );
    await stackedJumpPage.waitForFunction(() => document.activeElement?.id === "main-workspace");
    const afterJumpRadarUrl = new URL(stackedJumpPage.url());
    assert.equal(afterJumpRadarUrl.searchParams.get("view"), "radar", `Expected view=radar after jump-radar: ${stackedJumpPage.url()}`);
    assert.equal(afterJumpRadarUrl.searchParams.has("compareOpen"), false, `compareOpen must be cleared after jump-radar: ${stackedJumpPage.url()}`);
    assert.equal(afterJumpRadarUrl.searchParams.has("inspect"), false, `inspect must be cleared after jump-radar: ${stackedJumpPage.url()}`);
    assert.deepEqual(
      afterJumpRadarUrl.searchParams.getAll("cmp"),
      [bwhCmpKeyForJump, aaitrCmpKeyForJump],
      `cmp keys must be preserved after jump-radar: ${stackedJumpPage.url()}`
    );
    await stackedJumpPage.locator("[data-view-panel='radar'] .radar-window-toggle [data-window='24h']").click();
    await stackedJumpPage.waitForFunction(() => new URL(window.location.href).searchParams.get("radarWin") === "24h");

    // Case 4: CommandPalette Enter filter from CompareModal opened via focused header compare button
    const headerCompareForPalette = stackedJumpPage.locator("[data-app-header] [data-action='open-compare']");
    await headerCompareForPalette.focus();
    await headerCompareForPalette.click();
    await stackedJumpPage.waitForSelector("[data-compare-modal] .el-overlay");
    await stackedJumpPage.keyboard.press("Control+k");
    const palFilterInput = stackedJumpPage.locator("[data-palette-input]");
    await palFilterInput.waitFor({ state: "visible" });
    await palFilterInput.fill("BWH");
    await stackedJumpPage.keyboard.press("Enter");
    await stackedJumpPage.waitForFunction(
      () =>
        Boolean(document.querySelector("[data-palette-backdrop]")?.hidden) &&
        Boolean(document.querySelector("[data-compare-modal]")?.hidden) &&
        !document.body.classList.contains("scroll-locked") &&
        !document.querySelector("[data-view-panel='terminal']")?.hidden
    );
    await stackedJumpPage.waitForFunction(() => document.activeElement?.id === "main-workspace");
    const afterPaletteFilterUrl = new URL(stackedJumpPage.url());
    assert.equal(afterPaletteFilterUrl.searchParams.get("q"), "BWH", `Expected q=BWH after palette Enter filter: ${stackedJumpPage.url()}`);
    assert.equal(afterPaletteFilterUrl.searchParams.has("compareOpen"), false, `compareOpen must be cleared after palette filter: ${stackedJumpPage.url()}`);
    assert.deepEqual(
      afterPaletteFilterUrl.searchParams.getAll("cmp"),
      [bwhCmpKeyForJump, aaitrCmpKeyForJump],
      `cmp keys must be preserved after palette filter: ${stackedJumpPage.url()}`
    );
    await stackedJumpPage.locator(".terminal-table tr[data-product-id]").first().click();
    await stackedJumpPage.waitForSelector("[data-inspector-backdrop] .el-overlay");
    await stackedJumpPage.keyboard.press("Escape");
    await stackedJumpPage.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));

    // Case 5: Drilling from ProvidersView (no overlay open) must NOT leave a stale workspaceFocusSeq that steals
    // first-close Escape returnFocus from a subsequently opened SavedDrawer!
    await stackedJumpPage.locator("[data-app-header] .ws-tab[data-nav-view='providers']").click();
    const providerDrillBtn = stackedJumpPage
      .locator("[data-view-panel='providers'] button[data-action='drill-provider']:not(:disabled)")
      .first();
    await providerDrillBtn.waitFor({ state: "visible" });
    await providerDrillBtn.click();
    await stackedJumpPage.waitForSelector(".terminal-table tr[data-product-id]");
    const headerSavedBtn = stackedJumpPage.locator("[data-app-header] [data-action='open-saved']");
    await headerSavedBtn.waitFor({ state: "visible" });
    await headerSavedBtn.focus();
    await headerSavedBtn.click();
    await stackedJumpPage.waitForSelector("[data-saved-backdrop] .el-overlay");
    await stackedJumpPage.keyboard.press("Escape");
    await stackedJumpPage.waitForFunction(() => Boolean(document.querySelector("[data-saved-backdrop]")?.hidden));
    await stackedJumpPage.waitForFunction(
      () =>
        document.activeElement ===
        document.querySelector("[data-app-header] [data-action='open-saved']")
    );

    assert.deepEqual(stackedJumpErrors, [], `Unexpected stacked-jump page errors: ${stackedJumpErrors.join("; ")}`);
    assert.deepEqual(
      stackedJumpConsoleErrors,
      [],
      `Unexpected stacked-jump console/Vue errors: ${stackedJumpConsoleErrors.join("; ")}`
    );
    await stackedJumpPage.close();

    // Verify ProvidersView and RadarView migrated search inputs retain searchbox role, filter list, and sync URL on clear
    await page.locator("[data-app-header] [data-nav-view='providers']").click();
    const providerSearchbox = page.getByRole("searchbox", { name: "搜索商家" });
    await providerSearchbox.waitFor({ state: "visible" });
    const initialProviderCards = await page.locator("[data-view-panel='providers'] .provider-card").count();
    assert.ok(initialProviderCards >= 10, `Expected full provider list before search (got ${initialProviderCards})`);
    await providerSearchbox.fill("搬瓦工");
    await page.waitForFunction(() => new URL(window.location.href).searchParams.get("provQ") === "搬瓦工");
    const filteredProviderCards = await page.locator("[data-view-panel='providers'] .provider-card").count();
    assert.ok(
      filteredProviderCards >= 1 && filteredProviderCards < initialProviderCards,
      `Provider searchbox must filter cards (initial=${initialProviderCards}, filtered=${filteredProviderCards})`
    );
    await providerSearchbox.hover();
    const providerClearBtn = page.locator("[data-view-panel='providers'] .radar-el-input .el-input__clear");
    await providerClearBtn.waitFor({ state: "visible" });
    await providerClearBtn.click();
    await page.waitForFunction(
      (minCount) =>
        !new URL(window.location.href).searchParams.has("provQ") &&
        document.querySelectorAll("[data-view-panel='providers'] .provider-card").length === minCount,
      initialProviderCards
    );
    assert.equal(await providerSearchbox.inputValue(), "");

    await page.locator("[data-app-header] .ws-tab[data-nav-view='radar']").click();
    const radarSearchbox = page.getByRole("searchbox", { name: "搜索异动事件" });
    await radarSearchbox.waitFor({ state: "visible" });
    const initialRadarRows = await page.locator("[data-view-panel='radar'] .radar-tape-table tbody tr").count();
    assert.ok(initialRadarRows >= 1, "Expected radar event rows before search");
    await radarSearchbox.fill("Amsterdam");
    await page.waitForFunction(() => new URL(window.location.href).searchParams.get("radarQ") === "Amsterdam");
    const filteredRadarRows = await page.locator("[data-view-panel='radar'] .radar-tape-table tbody tr").count();
    assert.ok(
      filteredRadarRows >= 1 && filteredRadarRows <= initialRadarRows,
      `Radar searchbox must filter event rows (initial=${initialRadarRows}, filtered=${filteredRadarRows})`
    );
    await radarSearchbox.hover();
    const radarClearBtn = page.locator("[data-view-panel='radar'] .radar-el-input .el-input__clear");
    await radarClearBtn.waitFor({ state: "visible" });
    await radarClearBtn.click();
    await page.waitForFunction(
      (expectedCount) =>
        !new URL(window.location.href).searchParams.has("radarQ") &&
        document.querySelectorAll("[data-view-panel='radar'] .radar-tape-table tbody tr").length === expectedCount,
      initialRadarRows
    );
    assert.equal(await radarSearchbox.inputValue(), "");
    await page.locator("[data-app-header] .ws-tab[data-nav-view='terminal']").click();
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
    // Scenario B: Expired FX Clock (+9 days) on same snapshot — 7-day fuse removes tags & ElAlert contrast >= 4.5:1 + ElSkeleton slow load
    // =========================================================================
    const expiredCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await installFixedClock(expiredCtx, EXPIRED_NOW_MS);
    const expiredPage = await expiredCtx.newPage();
    const expiredErrors = [];
    expiredPage.on("pageerror", (err) => expiredErrors.push(err.message));
    await expiredPage.route("**/api/v1/pulse", async (route) => {
      await new Promise((r) => setTimeout(r, 180));
      await route.continue();
    });
    await expiredPage.goto(`${baseUrl}/?q=Amsterdam+E2E+Deterministic`, {
      waitUntil: "domcontentloaded"
    });
    await expiredPage.waitForSelector("[data-skeleton-grid] .el-skeleton");
    await expiredPage.waitForSelector(".terminal-table tr[data-product-id='e2e-fixed-tagged-bwh-ams']");
    await expiredPage.waitForSelector("[data-status-banner] .el-alert__description");
    const expiredCheck = await expiredPage.evaluate(() => {
      const alertEl = document.querySelector("[data-status-banner]");
      const descEl = document.querySelector("[data-status-banner] .el-alert__description");
      const parseRgb = (str) => {
        const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
      };
      const lum = ([r, g, b]) =>
        [r, g, b]
          .map((c) => {
            const s = c / 255;
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
          })
          .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
      const fg = parseRgb(getComputedStyle(descEl).color);
      const bg = parseRgb(getComputedStyle(alertEl).backgroundColor);
      const ratio =
        fg && bg
          ? (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05)
          : 0;
      const fixedRow = document.querySelector("tr[data-product-id='e2e-fixed-tagged-bwh-ams']");
      return {
        alertText: descEl.textContent || "",
        color: getComputedStyle(descEl).color,
        backgroundColor: getComputedStyle(alertEl).backgroundColor,
        contrast: Number(ratio.toFixed(2)),
        planTagCount: fixedRow ? fixedRow.querySelectorAll(".plan-tag").length : -1
      };
    });
    assert.match(expiredCheck.alertText, /已超 7 天有效期/);
    assert.ok(
      expiredCheck.contrast >= 4.5,
      `Light warning ElAlert description contrast must be >= 4.5:1 (got ${JSON.stringify(expiredCheck)})`
    );
    assert.equal(
      expiredCheck.planTagCount,
      0,
      `7-day FX expiration must suppress PlanTagBadge on fixed USD plan (got ${expiredCheck.planTagCount})`
    );
    assert.deepEqual(expiredErrors, [], `Unexpected expired-FX page errors: ${expiredErrors.join("; ")}`);
    await expiredCtx.close();

    // =========================================================================
    // Scenario C: Mobile 390x844 + prefers-reduced-motion + CompareDock narrow collapse + Mobile ElSelect Escape + Review Dossier Page
    // =========================================================================
    const mobileCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce"
    });
    await installFixedClock(mobileCtx, FIXED_NOW_MS);
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

    // Narrow 390px CompareDock with 2 plans must hide header compare button, show mobile summary & clickable bottom action while collapsing all .dock-pill tags
    // Also verify PlanCard action buttons render via ElButton and clicking save/compare does NOT open InspectorDrawer
    const mobileCardSave = mobilePage.locator(".plan-card[data-product-id] button.el-button[data-action='toggle-save']").first();
    await mobileCardSave.click();
    assert.equal(await mobileCardSave.getAttribute("aria-pressed"), "true");
    assert.equal(
      await mobilePage.evaluate(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden)),
      true,
      "Clicking PlanCard ElButton toggle-save must not open InspectorDrawer"
    );
    await mobileCardSave.click();
    await mobilePage.locator(".plan-card[data-product-id] button.el-button[data-action='toggle-compare']").nth(0).click();
    await mobilePage.locator(".plan-card[data-product-id] button.el-button[data-action='toggle-compare']").nth(1).click();
    assert.equal(
      await mobilePage.evaluate(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden)),
      true,
      "Clicking PlanCard ElButton toggle-compare must not open InspectorDrawer"
    );
    await mobilePage.waitForFunction(() => !document.querySelector("[data-compare-dock]")?.hidden);
    const narrowDockCheck = await mobilePage.evaluate(() => {
      const headerCompareBtn = document.querySelector("[data-app-header] .header-compare-btn");
      const label = document.querySelector("[data-compare-dock] .dock-mobile-label");
      const openBtn = document.querySelector("[data-compare-dock] [data-action='open-compare']");
      const pills = [...document.querySelectorAll("[data-compare-dock] .dock-pill")];
      return {
        headerCompareDisplay: headerCompareBtn ? getComputedStyle(headerCompareBtn).display : "missing",
        pillCount: pills.length,
        pillDisplays: pills.map((p) => getComputedStyle(p).display),
        labelDisplay: label ? getComputedStyle(label).display : "missing",
        openBtnVisible: Boolean(openBtn && openBtn.getBoundingClientRect().width > 0)
      };
    });
    assert.equal(
      narrowDockCheck.headerCompareDisplay,
      "none",
      `Narrow 390px header compare button must stay hidden: ${JSON.stringify(narrowDockCheck)}`
    );
    assert.equal(narrowDockCheck.pillCount, 2);
    assert.deepEqual(narrowDockCheck.pillDisplays, ["none", "none"], `Narrow CompareDock must hide ElTag pills: ${JSON.stringify(narrowDockCheck)}`);
    assert.notEqual(narrowDockCheck.labelDisplay, "none");
    assert.equal(narrowDockCheck.openBtnVisible, true);
    // Verify bottom CompareDock action is genuinely clickable on 390px, opens CompareModal, and Escape restores focus to the bottom compare button (not BODY)
    const dockOpenCompareBtn = mobilePage.locator("[data-compare-dock] [data-action='open-compare']");
    await dockOpenCompareBtn.focus();
    await dockOpenCompareBtn.click();
    await mobilePage.getByRole("dialog", { name: "多方案关键指标横向对比" }).waitFor({ state: "visible" });
    await mobilePage.keyboard.press("Escape");
    await mobilePage.waitForFunction(() => Boolean(document.querySelector("[data-compare-modal]")?.hidden));
    await mobilePage.waitForFunction(
      () =>
        document.activeElement ===
        document.querySelector("[data-compare-dock] [data-action='open-compare']")
    );
    await mobilePage.locator("[data-compare-dock] [data-action='clear-compare']").click();
    await mobilePage.waitForFunction(() => Boolean(document.querySelector("[data-compare-dock]")?.hidden));

    // Verify 390px single-item CompareModal last-item removal restores focus to #main-workspace (NOT BODY) when CompareDock unmounts
    await mobilePage.locator(".plan-card[data-product-id] button.el-button[data-action='toggle-compare']").first().click();
    await mobilePage.waitForFunction(() => !document.querySelector("[data-compare-dock]")?.hidden);
    const mobileSingleOpenBtn = mobilePage.locator("[data-compare-dock] [data-action='open-compare']");
    await mobileSingleOpenBtn.focus();
    await mobileSingleOpenBtn.click();
    await mobilePage.getByRole("dialog", { name: "多方案关键指标横向对比" }).waitFor({ state: "visible" });
    const mobileSingleRemoveBtn = mobilePage.locator("[data-compare-modal] [data-action='toggle-compare']").first();
    await mobileSingleRemoveBtn.focus();
    await mobileSingleRemoveBtn.click();
    await mobilePage.waitForFunction(
      () =>
        Boolean(document.querySelector("[data-compare-modal]")?.hidden) &&
        Boolean(document.querySelector("[data-compare-dock]")?.hidden)
    );
    await mobilePage.waitForFunction(() => document.activeElement?.id === "main-workspace");
    await mobilePage.keyboard.press("Tab");
    const mobilePostLastRemoveTab = await mobilePage.evaluate(() => {
      const el = document.activeElement;
      const rect = el?.getBoundingClientRect?.();
      return {
        tag: el?.tagName || "",
        id: el?.id || "",
        visible: Boolean(rect && rect.width > 0 && rect.height > 0)
      };
    });
    assert.ok(
      mobilePostLastRemoveTab.tag !== "BODY" &&
        mobilePostLastRemoveTab.id !== "main-workspace" &&
        mobilePostLastRemoveTab.visible,
      `Tab after 390px last-compare removal must enter visible page controls: ${JSON.stringify(mobilePostLastRemoveTab)}`
    );

    // Regression: 390px narrow screen with 4 selected compare items where 1 becomes transiently absent ->
    // absent item MUST remain individually removable from CompareDock (and CompareModal) without clearing the other 3,
    // freeing the 4th slot so a new plan can be added and URL cmp keeps the remaining 3 + new plan.
    const mobileMissingCmpPage = await mobileCtx.newPage();
    const mobileMissingCmpErrors = [];
    mobileMissingCmpPage.on("pageerror", (err) => mobileMissingCmpErrors.push(err.message));
    await mobileMissingCmpPage.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await mobileMissingCmpPage.waitForSelector(".plan-card[data-product-id]");
    const mobileFivePlans = await mobileMissingCmpPage.evaluate(() => {
      const seen = new Set();
      const out = [];
      for (const card of document.querySelectorAll(".plan-card[data-product-id]")) {
        const productId = card.getAttribute("data-product-id");
        const btn = card.querySelector("button.el-button[data-action='toggle-compare']");
        const key = btn?.getAttribute("data-key");
        if (productId && key && !seen.has(key)) {
          seen.add(key);
          out.push({ productId, key });
        }
        if (out.length === 5) break;
      }
      return out;
    });
    assert.equal(
      mobileFivePlans.length,
      5,
      `Expected at least 5 distinct rendered mobile cards for 390px compare slot test (got ${mobileFivePlans.length})`
    );
    const [mPlan0, mPlan1, mPlan2, mPlan3, mPlan4] = mobileFivePlans;
    for (const plan of [mPlan0, mPlan1, mPlan2, mPlan3]) {
      await mobileMissingCmpPage
        .locator(`.plan-card[data-product-id='${plan.productId}'] button.el-button[data-action='toggle-compare']`)
        .first()
        .click();
    }
    await mobileMissingCmpPage.waitForFunction(
      () => document.querySelector("[data-compare-dock] [data-compare-badge]")?.textContent?.trim() === "4/4"
    );
    assert.deepEqual(
      new URL(mobileMissingCmpPage.url()).searchParams.getAll("cmp"),
      [mPlan0.key, mPlan1.key, mPlan2.key, mPlan3.key],
      `Expected 4 selected cmp keys in URL on 390px: ${mobileMissingCmpPage.url()}`
    );

    const mobileOmitGen = new Date(Date.parse(rollbackPayload.generatedAt) + 60_000).toISOString();
    const mobileOmitOnePayload = {
      ...rollbackPayload,
      generatedAt: mobileOmitGen,
      publishedAt: mobileOmitGen,
      products: rollbackPayload.products.filter((p) => p.id !== mPlan1.productId)
    };
    const mobileOmitPulseHandler = async (route) => {
      const resp = await route.fetch();
      const body = await resp.json();
      body.generatedAt = mobileOmitGen;
      body.publishedAt = mobileOmitGen;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body)
      });
    };
    await mobileMissingCmpPage.route("**/api/v1/pulse*", mobileOmitPulseHandler);
    await mobileMissingCmpPage.route("**/data/products.json*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mobileOmitOnePayload)
      })
    );
    await mobileMissingCmpPage.locator("[data-app-header] [data-action='refresh-snapshot']").click();
    await mobileMissingCmpPage.waitForFunction(
      () => document.querySelectorAll("[data-compare-dock] .dock-pill-missing").length === 1
    );
    const mobileMissingDockCheck = await mobileMissingCmpPage.evaluate(() => {
      const dock = document.querySelector("[data-compare-dock]");
      const matchedPills = [...(dock?.querySelectorAll(".dock-pill") || [])];
      const missingPill = dock?.querySelector(".dock-pill-missing");
      const removeBtn = missingPill?.querySelector("button[data-action='toggle-compare']");
      const pillRect = missingPill?.getBoundingClientRect?.();
      const btnRect = removeBtn?.getBoundingClientRect?.();
      return {
        badge: dock?.querySelector("[data-compare-badge]")?.textContent?.trim() || "",
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        matchedDisplays: matchedPills.map((p) => getComputedStyle(p).display),
        missingDisplay: missingPill ? getComputedStyle(missingPill).display : "missing",
        missingVisible: Boolean(pillRect && pillRect.width > 0 && pillRect.height > 0),
        removeBtnVisible: Boolean(btnRect && btnRect.width > 0 && btnRect.height > 0),
        removeBtnKey: removeBtn?.getAttribute("data-key") || ""
      };
    });
    assert.equal(mobileMissingDockCheck.badge, "4/4");
    assert.ok(
      mobileMissingDockCheck.scrollWidth <= 390,
      `390px CompareDock with missing pill must not cause horizontal overflow: ${JSON.stringify(mobileMissingDockCheck)}`
    );
    assert.deepEqual(
      mobileMissingDockCheck.matchedDisplays,
      ["none", "none", "none"],
      `Matched pills stay compactly hidden on 390px: ${JSON.stringify(mobileMissingDockCheck)}`
    );
    assert.notEqual(
      mobileMissingDockCheck.missingDisplay,
      "none",
      `Absent compare pill MUST stay visible on 390px: ${JSON.stringify(mobileMissingDockCheck)}`
    );
    assert.equal(mobileMissingDockCheck.missingVisible, true);
    assert.equal(mobileMissingDockCheck.removeBtnVisible, true);
    assert.equal(mobileMissingDockCheck.removeBtnKey, mPlan1.key);

    // Before removing the absent item, trying to add a 5th plan hits the 4-plan limit
    await mobileMissingCmpPage
      .locator(`.plan-card[data-product-id='${mPlan4.productId}'] button.el-button[data-action='toggle-compare']`)
      .first()
      .click();
    assert.deepEqual(
      new URL(mobileMissingCmpPage.url()).searchParams.getAll("cmp"),
      [mPlan0.key, mPlan1.key, mPlan2.key, mPlan3.key],
      `5th plan must be blocked while absent slot is still occupied: ${mobileMissingCmpPage.url()}`
    );

    // Verify CompareModal also surfaces the absent item strip on 390px, then close it
    await mobileMissingCmpPage.locator("[data-compare-dock] [data-action='open-compare']").click();
    await mobileMissingCmpPage.getByRole("dialog", { name: "多方案关键指标横向对比" }).waitFor({ state: "visible" });
    assert.equal(
      await mobileMissingCmpPage.locator("[data-compare-modal] [data-compare-missing-strip] .dock-pill-missing").count(),
      1,
      "CompareModal must display removable absent-item strip when an absent key is selected"
    );
    await mobileMissingCmpPage.keyboard.press("Escape");
    await mobileMissingCmpPage.waitForFunction(() => Boolean(document.querySelector("[data-compare-modal]")?.hidden));

    // Remove ONLY the absent item from 390px CompareDock via its visible individual remove button
    const mobileMissingRemoveBtn = mobileMissingCmpPage.getByRole("button", {
      name: `移出暂缺对比项 ${mPlan1.key}`
    });
    await mobileMissingRemoveBtn.waitFor({ state: "visible" });
    await mobileMissingRemoveBtn.click();
    await mobileMissingCmpPage.waitForFunction(
      () =>
        document.querySelectorAll("[data-compare-dock] .dock-pill-missing").length === 0 &&
        document.querySelector("[data-compare-dock] [data-compare-badge]")?.textContent?.trim() === "3/4"
    );
    assert.deepEqual(
      new URL(mobileMissingCmpPage.url()).searchParams.getAll("cmp"),
      [mPlan0.key, mPlan2.key, mPlan3.key],
      `Removing absent compare item on 390px must preserve the other 3 cmp keys in URL: ${mobileMissingCmpPage.url()}`
    );

    // Now adding the 5th plan succeeds into slot 4/4 and preserves the other 3 cmp keys!
    await mobileMissingCmpPage
      .locator(`.plan-card[data-product-id='${mPlan4.productId}'] button.el-button[data-action='toggle-compare']`)
      .first()
      .click();
    await mobileMissingCmpPage.waitForFunction(
      () => document.querySelector("[data-compare-dock] [data-compare-badge]")?.textContent?.trim() === "4/4"
    );
    assert.deepEqual(
      new URL(mobileMissingCmpPage.url()).searchParams.getAll("cmp"),
      [mPlan0.key, mPlan2.key, mPlan3.key, mPlan4.key],
      `Adding new plan after removing absent item on 390px must preserve remaining 3 + new plan: ${mobileMissingCmpPage.url()}`
    );
    assert.deepEqual(
      mobileMissingCmpErrors,
      [],
      `Unexpected 390px missing-compare page errors: ${mobileMissingCmpErrors.join("; ")}`
    );
    await mobileMissingCmpPage.close();

    // Mobile filter drawer full keyboard focus path: keyboard open -> auto-focus inside sheet -> Shift+Tab / Tab loop -> Escape restores trigger focus & releases trap
    const openRailTrigger = mobilePage.locator("button.el-button[data-action='open-mobile-rail']");
    await openRailTrigger.waitFor({ state: "visible" });
    await openRailTrigger.focus();
    await mobilePage.keyboard.press("Enter");
    await mobilePage.waitForSelector(".mobile-filter-sheet.is-mobile-open");
    await mobilePage.waitForFunction(() => {
      const sheet = document.querySelector("[data-mobile-filter-sheet]");
      return Boolean(sheet && document.activeElement && sheet.contains(document.activeElement));
    });
    const mobileInitialFocusAction = await mobilePage.evaluate(
      () => document.activeElement?.getAttribute?.("data-action") || ""
    );
    assert.equal(
      mobileInitialFocusAction,
      "close-mobile-rail",
      `Opening mobile filter sheet by keyboard must focus header close button (got ${mobileInitialFocusAction})`
    );
    // Shift+Tab from first control wraps to last focusable control inside mobile filter sheet (footer close button)
    await mobilePage.keyboard.press("Shift+Tab");
    const mobileShiftTabWrap = await mobilePage.evaluate(() => {
      const sheet = document.querySelector("[data-mobile-filter-sheet]");
      const el = document.activeElement;
      return {
        insideSheet: Boolean(sheet && el && sheet.contains(el)),
        action: el?.getAttribute?.("data-action") || "",
        inFooter: Boolean(el?.closest?.(".mobile-rail-footer"))
      };
    });
    assert.deepEqual(
      mobileShiftTabWrap,
      { insideSheet: true, action: "close-mobile-rail", inFooter: true },
      `Shift+Tab on first mobile filter control must wrap to footer button inside sheet: ${JSON.stringify(mobileShiftTabWrap)}`
    );
    // Tab from last control wraps back to first control inside sheet (header close button)
    await mobilePage.keyboard.press("Tab");
    const mobileTabWrap = await mobilePage.evaluate(() => {
      const sheet = document.querySelector("[data-mobile-filter-sheet]");
      const el = document.activeElement;
      return {
        insideSheet: Boolean(sheet && el && sheet.contains(el)),
        action: el?.getAttribute?.("data-action") || "",
        inHeader: Boolean(el?.closest?.(".mobile-rail-header"))
      };
    });
    assert.deepEqual(
      mobileTabWrap,
      { insideSheet: true, action: "close-mobile-rail", inHeader: true },
      `Tab on last mobile filter control must wrap back to header close button: ${JSON.stringify(mobileTabWrap)}`
    );
    // Escape closes mobile filter sheet, restores focus to trigger, and releases Tab trap
    await mobilePage.keyboard.press("Escape");
    await mobilePage.waitForFunction(() => !document.querySelector(".mobile-filter-sheet.is-mobile-open"));
    await mobilePage.waitForFunction(
      () => document.activeElement?.getAttribute?.("data-action") === "open-mobile-rail"
    );
    await mobilePage.keyboard.press("Tab");
    const afterCloseTab = await mobilePage.evaluate(() => {
      const sheet = document.querySelector("[data-mobile-filter-sheet]");
      const el = document.activeElement;
      return {
        insideSheet: Boolean(sheet && el && sheet.contains(el)),
        tag: el?.tagName || ""
      };
    });
    assert.equal(
      afterCloseTab.insideSheet,
      false,
      `After closing mobile filter sheet, Tab must NOT remain trapped in closed sheet: ${JSON.stringify(afterCloseTab)}`
    );

    // Mobile filter drawer keyboard Escape behavior on ElSelect (open dropdown -> 1st Escape closes dropdown only; collapsed select -> 2nd Escape closes rail & restores focus)
    await openRailTrigger.focus();
    await openRailTrigger.click();
    await mobilePage.waitForSelector(".mobile-filter-sheet.is-mobile-open");
    assert.equal(
      await mobilePage.locator("[data-mobile-filter-sheet] button.el-button[data-action='close-mobile-rail']").count(),
      2,
      "Mobile filter drawer header and footer close controls must both render as ElButton"
    );
    const mobileSelectWrapper = mobilePage.locator(
      "[data-mobile-filter-sheet] [data-filter-select='provider'] .el-select__wrapper"
    );
    await mobileSelectWrapper.click();
    await mobilePage.waitForFunction(
      () =>
        document
          .querySelector("[data-mobile-filter-sheet] [data-filter-select='provider'] [role='combobox']")
          ?.getAttribute("aria-expanded") === "true"
    );
    // Type a non-empty search query into mobile ElSelect: 1st Escape MUST still collapse dropdown directly (not require 3 Escapes)
    await mobilePage
      .locator("[data-mobile-filter-sheet] [data-filter-select='provider'] input[role='combobox']")
      .fill("搬瓦工");
    // First Escape closes the expanded ElSelect dropdown (even with non-empty query) while keeping mobile filter sheet open
    await mobilePage.keyboard.press("Escape");
    await mobilePage.waitForFunction(
      () =>
        document
          .querySelector("[data-mobile-filter-sheet] [data-filter-select='provider'] [role='combobox']")
          ?.getAttribute("aria-expanded") === "false"
    );
    assert.equal(
      await mobilePage.locator(".mobile-filter-sheet.is-mobile-open").count(),
      1,
      "First Escape on expanded mobile ElSelect must close dropdown only"
    );
    // Composing Escape while mobile ElSelect is collapsed must keep default behavior & keep mobile filter sheet open
    const collapsedMobileImeEsc = await mobilePage.evaluate(() => {
      const input = document.querySelector(
        "[data-mobile-filter-sheet] [data-filter-select='provider'] [role='combobox']"
      );
      input.focus();
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      const esc = new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        bubbles: true,
        cancelable: true,
        isComposing: true
      });
      Object.defineProperty(esc, "keyCode", { value: 229 });
      input.dispatchEvent(esc);
      const sheetOpenDuringIme = Boolean(document.querySelector(".mobile-filter-sheet.is-mobile-open"));
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
      return { defaultPrevented: esc.defaultPrevented, sheetOpenDuringIme };
    });
    assert.deepEqual(
      collapsedMobileImeEsc,
      { defaultPrevented: false, sheetOpenDuringIme: true },
      `Composing Escape on collapsed mobile RadarSelect must not preventDefault or close mobile filter sheet: ${JSON.stringify(collapsedMobileImeEsc)}`
    );
    // Second Escape with focus still on collapsed ElSelect closes mobile filter sheet & restores focus to trigger
    await mobilePage.keyboard.press("Escape");
    await mobilePage.waitForFunction(
      () => !document.querySelector(".mobile-filter-sheet.is-mobile-open")
    );
    const mobileRestoredFocus = await mobilePage.evaluate(
      () => document.activeElement?.getAttribute?.("data-action") || ""
    );
    assert.equal(
      mobileRestoredFocus,
      "open-mobile-rail",
      `Escape from collapsed mobile ElSelect must restore focus to open-mobile-rail (got ${mobileRestoredFocus})`
    );

    // Cross-view mobile popstate regression: navigating back from Terminal (with mobile filter sheet open) to
    // Radar + ?inspect= MUST close mobileRail & hide [data-sheet-backdrop] automatically and reveal InspectorDrawer with focus!
    const mobilePopstatePage = await mobileCtx.newPage();
    const mobilePopstateErrors = [];
    mobilePopstatePage.on("pageerror", (err) => mobilePopstateErrors.push(err.message));
    await mobilePopstatePage.goto(`${baseUrl}/?view=radar&inspect=e2e-fixed-tagged-bwh-ams`, {
      waitUntil: "networkidle"
    });
    await mobilePopstatePage.getByRole("dialog", { name: "套餐解析证据与定价解剖" }).waitFor({ state: "visible" });
    // Push a terminal view entry right after the radar+inspect history entry and switch SPA into terminal view
    await mobilePopstatePage.evaluate(() => {
      window.history.pushState(null, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await mobilePopstatePage.waitForFunction(
      () =>
        !document.querySelector("[data-view-panel='terminal']")?.hidden &&
        Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden)
    );
    await mobilePopstatePage.locator("button.el-button[data-action='open-mobile-rail']").click();
    await mobilePopstatePage.waitForSelector(".mobile-filter-sheet.is-mobile-open");
    await mobilePopstatePage.waitForFunction(() => !document.querySelector("[data-sheet-backdrop]")?.hidden);
    // Browser back restores /?view=radar&inspect=e2e-fixed-tagged-bwh-ams while mobileRail was open on terminal
    await mobilePopstatePage.goBack();
    await mobilePopstatePage.waitForFunction(() => !document.querySelector("[data-view-panel='radar']")?.hidden);
    await mobilePopstatePage.getByRole("dialog", { name: "套餐解析证据与定价解剖" }).waitFor({ state: "visible" });
    await mobilePopstatePage.waitForFunction(() =>
      Boolean(document.querySelector("[data-inspector-backdrop]")?.contains(document.activeElement))
    );
    const mobilePopstateCheck = await mobilePopstatePage.evaluate(() => ({
      sheetBackdropHidden: Boolean(document.querySelector("[data-sheet-backdrop]")?.hidden),
      mobileSheetCount: document.querySelectorAll(".mobile-filter-sheet.is-mobile-open").length,
      inspectorVisible: !document.querySelector("[data-inspector-backdrop]")?.hidden,
      focusInInspector: Boolean(document.querySelector("[data-inspector-backdrop]")?.contains(document.activeElement))
    }));
    assert.deepEqual(
      mobilePopstateCheck,
      { sheetBackdropHidden: true, mobileSheetCount: 0, inspectorVisible: true, focusInInspector: true },
      `Cross-view mobile popstate must close mobileRail/backdrop and auto-reveal InspectorDrawer with focus: ${JSON.stringify(mobilePopstateCheck)}`
    );
    await mobilePopstatePage.keyboard.press("Escape");
    await mobilePopstatePage.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));
    assert.equal(
      await mobilePopstatePage.evaluate(() => document.body.classList.contains("scroll-locked")),
      false,
      "Body scroll-locked must clear after closing InspectorDrawer following cross-view mobile popstate"
    );
    assert.deepEqual(mobilePopstateErrors, [], `Unexpected mobile-popstate page errors: ${mobilePopstateErrors.join("; ")}`);
    await mobilePopstatePage.close();

    // Mobile->Desktop resize regression: opening mobile filter sheet at 390px and resizing across 860px to 1024px
    // MUST close mobileRail, hide [data-sheet-backdrop], release body.scroll-locked, and allow popstate inspect to reveal immediately.
    const mobileResizePage = await mobileCtx.newPage();
    const mobileResizeErrors = [];
    mobileResizePage.on("pageerror", (err) => mobileResizeErrors.push(err.message));
    await mobileResizePage.goto(`${baseUrl}/?inspect=e2e-fixed-tagged-bwh-ams`, { waitUntil: "networkidle" });
    await mobileResizePage.getByRole("dialog", { name: "套餐解析证据与定价解剖" }).waitFor({ state: "visible" });
    await mobileResizePage.evaluate(() => {
      window.history.pushState(null, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await mobileResizePage.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));
    await mobileResizePage.locator("button.el-button[data-action='open-mobile-rail']").click();
    await mobileResizePage.waitForSelector(".mobile-filter-sheet.is-mobile-open");
    await mobileResizePage.waitForFunction(
      () => !document.querySelector("[data-sheet-backdrop]")?.hidden && document.body.classList.contains("scroll-locked")
    );
    await mobileResizePage.setViewportSize({ width: 1024, height: 800 });
    await mobileResizePage.waitForFunction(
      () =>
        Boolean(document.querySelector("[data-sheet-backdrop]")?.hidden) &&
        !document.body.classList.contains("scroll-locked") &&
        document.querySelectorAll(".mobile-filter-sheet.is-mobile-open").length === 0
    );
    await mobileResizePage.goBack();
    await mobileResizePage.getByRole("dialog", { name: "套餐解析证据与定价解剖" }).waitFor({ state: "visible" });
    await mobileResizePage.waitForFunction(() =>
      Boolean(document.querySelector("[data-inspector-backdrop]")?.contains(document.activeElement))
    );
    assert.deepEqual(mobileResizeErrors, [], `Unexpected mobile-resize page errors: ${mobileResizeErrors.join("; ")}`);
    await mobileResizePage.close();

    // Verify 860px breakpoint hides desktop .layout-view-toggle while keeping Radar window toggle (24h / 72h / 7天) visible & fully interactive
    await mobilePage.setViewportSize({ width: 860, height: 900 });
    const breakpoint860LayoutDisplay = await mobilePage.evaluate(() => {
      const toggle = document.querySelector(".layout-view-toggle");
      return toggle ? getComputedStyle(toggle).display : "missing";
    });
    assert.equal(
      breakpoint860LayoutDisplay,
      "none",
      `860px breakpoint must hide desktop .layout-view-toggle (got ${breakpoint860LayoutDisplay})`
    );
    await mobilePage.locator(".ws-nav [data-nav-view='radar']").click();
    const win24Btn = mobilePage.locator(".radar-window-toggle [data-window='24h']");
    const win72Btn = mobilePage.locator(".radar-window-toggle [data-window='72h']");
    const win7dBtn = mobilePage.locator(".radar-window-toggle [data-window='7d']");
    assert.equal(await win24Btn.isVisible(), true, "Radar 24h window button must stay visible at 860px");
    assert.equal(await win72Btn.isVisible(), true, "Radar 72h window button must stay visible at 860px");
    assert.equal(await win7dBtn.isVisible(), true, "Radar 7d window button must stay visible at 860px");
    await win24Btn.click();
    assert.match(mobilePage.url(), /radarWin=24h/);
    assert.equal(
      await mobilePage.evaluate(() =>
        Boolean(document.querySelector(".radar-window-toggle [data-window='24h']")?.closest(".el-segmented__item")?.classList.contains("is-selected"))
      ),
      true,
      "24h segmented option must reflect selected state"
    );
    await win72Btn.click();
    assert.match(mobilePage.url(), /radarWin=72h/);
    assert.equal(
      await mobilePage.evaluate(() =>
        Boolean(document.querySelector(".radar-window-toggle [data-window='72h']")?.closest(".el-segmented__item")?.classList.contains("is-selected"))
      ),
      true,
      "72h segmented option must reflect selected state"
    );
    await win7dBtn.click();
    assert.doesNotMatch(mobilePage.url(), /radarWin=/, "Switching back to default 7天 must remove radarWin from URL");
    assert.equal(
      await mobilePage.evaluate(() =>
        Boolean(document.querySelector(".radar-window-toggle [data-window='7d']")?.closest(".el-segmented__item")?.classList.contains("is-selected"))
      ),
      true,
      "7d segmented option must reflect selected state"
    );
    await win24Btn.click();
    assert.match(mobilePage.url(), /radarWin=24h/);
    await mobilePage.setViewportSize({ width: 390, height: 844 });
    // Verify RadarView deterministic 24h event tape 证据 button renders as ElButton and opens matching InspectorDrawer
    const radarInspectBtn = mobilePage
      .locator("[data-view-panel='radar'] button.el-button[data-action='inspect-plan'][data-product-id='e2e-fixed-tagged-bwh-ams']")
      .first();
    await radarInspectBtn.waitFor({ state: "visible" });
    const radarInspectCount = await mobilePage.locator("[data-view-panel='radar'] button.el-button[data-action='inspect-plan']").count();
    const radarAnyInspectCount = await mobilePage.locator("[data-view-panel='radar'] button[data-action='inspect-plan']").count();
    assert.ok(radarInspectCount >= 1, `RadarView 24h tape must render at least one ElButton inspect-plan (got ${radarInspectCount})`);
    assert.equal(radarInspectCount, radarAnyInspectCount, "All RadarView inspect-plan buttons must render as ElButton");
    await radarInspectBtn.click();
    await mobilePage.getByRole("dialog", { name: "套餐解析证据与定价解剖" }).waitFor({ state: "visible" });
    assert.match(mobilePage.url(), /inspect=e2e-fixed-tagged-bwh-ams/);
    await mobilePage.keyboard.press("Escape");
    await mobilePage.waitForFunction(() => Boolean(document.querySelector("[data-inspector-backdrop]")?.hidden));

    // Verify standalone Review Dossier page shows ElSkeleton while loading, then hydrates deterministic AaITR plan into .dossier-live-row with ZERO error banners
    let releaseDossierPulse = null;
    const dossierPulseGate = new Promise((resolve) => {
      releaseDossierPulse = resolve;
    });
    const holdDossierHandler = async (route) => {
      await dossierPulseGate;
      await route.continue();
    };
    await mobilePage.route("**/api/v1/pulse*", holdDossierHandler);
    await mobilePage.route("**/data/v2/latest.json*", holdDossierHandler);
    await mobilePage.goto(`${baseUrl}/reviews/aaitr.html`, { waitUntil: "domcontentloaded" });
    await mobilePage.waitForSelector("[data-review-live-box] .el-skeleton");
    releaseDossierPulse();
    await mobilePage.unroute("**/api/v1/pulse*", holdDossierHandler);
    await mobilePage.unroute("**/data/v2/latest.json*", holdDossierHandler);
    await mobilePage.waitForSelector("[data-review-live-box] .dossier-live-row");
    const dossierCheck = await mobilePage.evaluate(() => {
      const box = document.querySelector("[data-review-live-box]");
      const rows = [...(box?.querySelectorAll(".dossier-live-row") || [])];
      return {
        skeletonCount: box?.querySelectorAll(".el-skeleton, .skel").length || 0,
        errorBannerCount: box?.querySelectorAll(".el-alert").length || 0,
        rowCount: rows.length,
        rowTexts: rows.map((r) => r.textContent || "")
      };
    });
    assert.equal(dossierCheck.skeletonCount, 0, "Review dossier ElSkeleton must clear after hydration");
    assert.equal(dossierCheck.errorBannerCount, 0, `Review dossier must have zero error banners: ${JSON.stringify(dossierCheck)}`);
    assert.ok(dossierCheck.rowCount >= 1, "Review dossier must render at least one .dossier-live-row");
    assert.ok(
      dossierCheck.rowTexts.some((t) => t.includes("AaITR E2E Deterministic HK Residential")),
      `Review dossier must render deterministic AaITR plan row: ${JSON.stringify(dossierCheck)}`
    );

    assert.deepEqual(mobileErrors, [], `Unexpected mobile page errors: ${mobileErrors.join("; ")}`);
    await mobileCtx.close();

    // =========================================================================
    // Scenario D: Optional exchangeRates omitted — valid snapshot graceful degradation
    // =========================================================================
    const missingFxWorkDir = mkdtempSync(join(tmpdir(), "resnode-e2e-nofx-"));
    let missingFxServer = null;
    try {
      cpSync(distDir, join(missingFxWorkDir, "dist"), { recursive: true });
      cpSync(join(repoRoot, "LICENSE"), join(missingFxWorkDir, "LICENSE"));
      const missingFxDataDir = join(missingFxWorkDir, "data");
      mkdirSync(missingFxDataDir, { recursive: true });
      const { exchangeRates: _omittedFx, ...missingFxPayload } = seededProductsPayload;
      writeFileSync(join(missingFxDataDir, "products.json"), `${JSON.stringify(missingFxPayload)}\n`);
      const missingFxSeed = await seedV2FromV1({ dataDir: missingFxDataDir });
      assert.ok(missingFxSeed.snapshotId, "Snapshot without optional exchangeRates must seed with 0 errors");

      missingFxServer = createStaticServer(missingFxWorkDir);
      await new Promise((res) => missingFxServer.listen(0, "127.0.0.1", res));
      const missingFxUrl = `http://127.0.0.1:${missingFxServer.address().port}`;
      const missingFxCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await installFixedClock(missingFxCtx, FIXED_NOW_MS);
      const missingFxPage = await missingFxCtx.newPage();
      const missingFxErrors = [];
      missingFxPage.on("pageerror", (err) => missingFxErrors.push(err.message));

      await missingFxPage.goto(`${missingFxUrl}/?q=Amsterdam+E2E+Deterministic`, {
        waitUntil: "networkidle"
      });
      await missingFxPage.waitForSelector(".terminal-table tr[data-product-id='e2e-fixed-tagged-bwh-ams']");
      await missingFxPage.waitForSelector("[data-status-banner] .el-alert__description");
      const missingFxCheck = await missingFxPage.evaluate(() => {
        const desc = document.querySelector("[data-status-banner] .el-alert__description")?.textContent || "";
        const row = document.querySelector("tr[data-product-id='e2e-fixed-tagged-bwh-ams']");
        return {
          bannerText: desc,
          planTagCount: row ? row.querySelectorAll(".plan-tag").length : -1
        };
      });
      assert.match(missingFxCheck.bannerText, /参考汇率快照缺失或异常/);
      assert.equal(
        missingFxCheck.planTagCount,
        0,
        `Missing FX must suspend USD PlanTagBadge cleanly (got ${missingFxCheck.planTagCount})`
      );
      assert.deepEqual(missingFxErrors, [], `Unexpected missing-FX page errors: ${missingFxErrors.join("; ")}`);
      await missingFxCtx.close();
    } finally {
      if (missingFxServer) {
        await new Promise((res) => missingFxServer.close(res));
      }
      rmSync(missingFxWorkDir, { recursive: true, force: true });
    }

    console.log(
      "Browser E2E passed: desktop virtual scroll, [data-tag-hud] viewport clamping, keyboard focus, 404 audit refresh, live v2->v1 rollback, mobile reduced-motion cards, missing-FX degradation, and review dossier hydration."
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
