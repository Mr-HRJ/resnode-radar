import { DEFAULT_FILTERS } from "./domain/catalog.js";
import { escapeHtml, monitorFreshness } from "./domain/format.js";
import { REFRESH_INTERVAL_MS, fetchSnapshot } from "./services/snapshot.js";
import { fetchVisitStats } from "./services/visits.js";
import { applyTheme, createStore } from "./state/store.js";
import { renderCompareDock, renderCompareModal } from "./components/compare.js";
import { renderGuideView } from "./components/guide.js";
import { computeSyncProgressRatio, renderCommandPalette, formatLiveClockText, renderHeader, renderStatusBanner } from "./components/header.js";
import { renderInspectorDrawer } from "./components/inspector.js";
import { renderProvidersView } from "./components/providers.js";
import { renderRadarView } from "./components/radar.js";
import { renderSavedDrawer } from "./components/saved-drawer.js";
import { renderPlanCard, renderTableRow, renderTerminalView, selectTerminalPlans, terminalListOptions } from "./components/terminal.js";
import { renderTagSvg } from "./components/tag-icons.js";
import { mountVirtualList } from "./components/virtual-list.js";

const PRESETS = {
  "us-home-dedicated": { ...DEFAULT_FILTERS, track: "home", region: "US", noNat: true, status: "available" },
  "cn2-opt": { ...DEFAULT_FILTERS, route: "cn2", status: "available" },
  "budget-monthly": { ...DEFAULT_FILTERS, budget: "60", cycle: "monthly", fixedPriceOnly: true, status: "available" },
  "exact-stock": { ...DEFAULT_FILTERS, exactOnly: true, status: "available" },
  "deal-blockbuster": { ...DEFAULT_FILTERS, deal: "blockbuster", status: "available" },
  "deal-generous": { ...DEFAULT_FILTERS, deal: "generous", status: "available" },
  "deal-annual": { ...DEFAULT_FILTERS, deal: "annual", status: "available" },
  "deal-home-opt": { ...DEFAULT_FILTERS, deal: "home-opt", status: "available" },
  "deal-scarce": { ...DEFAULT_FILTERS, deal: "scarce", status: "available" }
};

export function mountApp(options = {}) {
  const doc = globalThis.document;
  const endpoint = options.endpoint || "data/products.json";
  const statsEndpoint = options.statsEndpoint ?? "api/stats";
  const store = createStore(globalThis.window?.location?.href);
  applyTheme(store.getState().theme);

  const elHeader = doc.querySelector("[data-app-header]");
  const elBanner = doc.querySelector("[data-app-banner]");
  const elTerminal = doc.querySelector("[data-view-panel='terminal']");
  const elRadar = doc.querySelector("[data-view-panel='radar']");
  const elProviders = doc.querySelector("[data-view-panel='providers']");
  const elGuide = doc.querySelector("[data-view-panel='guide']");
  const elDock = doc.querySelector("[data-compare-dock]");
  const elCompareModal = doc.querySelector("[data-compare-modal]");
  const elInspector = doc.querySelector("[data-inspector-backdrop]");
  const elSaved = doc.querySelector("[data-saved-backdrop]");
  const elPalette = doc.querySelector("[data-palette-backdrop]");
  const elSheetBackdrop = doc.querySelector("[data-sheet-backdrop]");
  const elTagHud = doc.querySelector("[data-tag-hud]");
  const elToast = doc.querySelector("[data-toast-region]");

  let lastFocusBeforeOverlay = null;
  let toastTimer = null;
  let tagHudTimer = null;
  let activeTagTipEl = null;
  let pendingRefresh = null;
  let refreshController = null;
  let statsTimer = null;
  let statsController = null;
  let pendingStats = null;
  let disposed = false;
  let capsuleStep = 0;
  let terminalList = null;
  let terminalInputs = [];
  let terminalWidth = 0;
  let resizeFrame = 0;

  // Motion & non-flicker transition tracking
  let prevView = null;
  let prevLoadState = null;
  let prevFilterSig = "";
  let prevSpecsExpanded = store.getState().specsExpanded;
  let prevInspectorOpen = false;
  let prevSavedOpen = false;
  let prevCompareOpen = false;
  let prevPaletteOpen = false;
  let prevDockVisible = false;
  const prevNumericMap = new Map();
  let lastAnimatedVisitPv = store.getState().visitStats?.todayPv ?? null;
  let liveVisitStatsSynced = false;
  let visitTweenRaf = 0;
  const activeNumberTweens = new Set();

  function cancelNumberTweens() {
    const cancelRaf = globalThis.window?.cancelAnimationFrame;
    if (typeof cancelRaf === "function") {
      for (const id of activeNumberTweens) cancelRaf(id);
    }
    activeNumberTweens.clear();
  }

  function cancelVisitTween() {
    const cancelRaf = globalThis.window?.cancelAnimationFrame;
    if (visitTweenRaf && typeof cancelRaf === "function") {
      cancelRaf(visitTweenRaf);
    }
    visitTweenRaf = 0;
  }

  function animateVisitCounter(state) {
    const node = doc.querySelector("[data-stat-visits]");
    if (!node) {
      cancelVisitTween();
      lastAnimatedVisitPv = null;
      return;
    }
    if (!liveVisitStatsSynced || !state.visitStats) return;
    const targetVal = Number(state.visitStats.todayPv);
    if (!Number.isFinite(targetVal)) return;
    if (lastAnimatedVisitPv === targetVal) return;

    const startVal = lastAnimatedVisitPv !== null ? lastAnimatedVisitPv : targetVal;
    lastAnimatedVisitPv = targetVal;
    cancelVisitTween();
    const reducedMotion = Boolean(globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
    if (targetVal <= 0 || reducedMotion) {
      node.textContent = String(targetVal);
      return;
    }

    node.classList?.remove?.("is-visit-num-pop");
    void node.offsetWidth;
    node.classList?.add?.("is-visit-num-pop");

    if (typeof node.animate === "function") {
      try {
        node.animate(
          [
            { transform: "scale(1)", offset: 0 },
            { transform: "scale(1.14)", color: "#4f46e5", offset: 0.45 },
            { transform: "scale(1)", offset: 1 }
          ],
          { duration: 420, easing: "cubic-bezier(0.4, 0, 0.2, 1)" }
        );
      } catch {
        // ignore WAAPI errors in restricted environments
      }
    }

    const raf = globalThis.window?.requestAnimationFrame;
    if (typeof raf === "function" && startVal !== targetVal) {
      const duration = 260;
      let startTs = null;
      const step = (ts) => {
        visitTweenRaf = 0;
        if (disposed) return;
        if (startTs === null) startTs = ts;
        const progress = Math.min(1, (ts - startTs) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        const cur = Math.round(startVal + (targetVal - startVal) * eased);
        node.textContent = String(cur);
        if (progress < 1) {
          visitTweenRaf = raf(step);
        } else {
          node.textContent = String(targetVal);
        }
      };
      visitTweenRaf = raf(step);
    } else {
      node.textContent = String(targetVal);
    }
  }

  function animateTelemetryCounters(justLoaded) {
    cancelNumberTweens();
    const raf = globalThis.window?.requestAnimationFrame;
    const reducedMotion = Boolean(globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
    const targets = [
      ["stat-avail", doc.querySelector("[data-stat-available]")],
      ["stat-home", doc.querySelector("[data-stat-home]")],
      ["stat-exact", doc.querySelector("[data-stat-exact]")],
      ["stat-blocked", doc.querySelector("[data-stat-blocked]")],
      ["res-summary", doc.querySelector(".result-summary strong")],
      ...Array.from(doc.querySelectorAll(".market-mini-val") || []).map((el, i) => [`market-mini-${i}`, el]),
      ...Array.from(doc.querySelectorAll(".kpi-val") || []).map((el, i) => [`kpi-${store.getState().view}-${i}`, el])
    ];

    for (const [key, node] of targets) {
      if (!node) continue;
      const raw = (node.textContent || "").trim();
      const m = raw.match(/^([+-]?)(\d+)(.*)$/);
      if (!m) continue;
      const [, prefix, digits, suffix] = m;
      const targetVal = Number(digits);
      if (!Number.isFinite(targetVal)) continue;

      const prevVal = prevNumericMap.get(key);
      prevNumericMap.set(key, targetVal);

      const shouldAnimate = justLoaded ? targetVal > 0 : prevVal !== undefined && prevVal !== targetVal;
      if (!shouldAnimate) continue;

      node.classList?.add?.("is-num-tick");
      if (typeof raf === "function" && !reducedMotion) {
        const startVal = justLoaded ? 0 : prevVal;
        const duration = 340;
        let startTs = null;
        let rafId = 0;
        const step = (ts) => {
          activeNumberTweens.delete(rafId);
          if (disposed) return;
          if (startTs === null) startTs = ts;
          const progress = Math.min(1, (ts - startTs) / duration);
          const eased = 1 - Math.pow(1 - progress, 4);
          const cur = Math.round(startVal + (targetVal - startVal) * eased);
          node.textContent = `${prefix}${cur}${suffix}`;
          if (progress < 1) {
            rafId = raf(step);
            activeNumberTweens.add(rafId);
          } else {
            node.textContent = raw;
          }
        };
        rafId = raf(step);
        activeNumberTweens.add(rafId);
      }
    }
  }

  function showToast(message) {
    if (!elToast) return;
    elToast.innerHTML = `<div class="toast-item" role="status">${escapeHtml(message)}</div>`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (elToast) elToast.innerHTML = "";
    }, 2400);
  }

  function rememberFocus() {
    if (!lastFocusBeforeOverlay && document.activeElement && document.activeElement !== document.body) {
      lastFocusBeforeOverlay = document.activeElement;
    }
  }

  function restoreFocusIfClear(state) {
    const anyOpen =
      state.paletteOpen ||
      state.compareOpen ||
      Boolean(state.inspectId) ||
      state.savedDrawerOpen ||
      state.mobileRailOpen;
    if (!anyOpen && lastFocusBeforeOverlay) {
      try {
        lastFocusBeforeOverlay.focus?.();
      } catch {
        // ignore detached node focus errors
      }
      lastFocusBeforeOverlay = null;
    }
  }

  function captureActiveInput() {
    const active = doc.activeElement;
    if (!active || active.tagName?.toLowerCase() !== "input") return null;
    for (const attr of ["data-price-min", "data-price-max"]) {
      if (active.hasAttribute?.(attr)) {
        const scope = active.closest?.("[data-filter-dock]") ? "[data-filter-dock] " : "[data-mobile-filter-sheet] ";
        return { selector: `${scope}[${attr}]`, start: null, end: null };
      }
    }
    for (const attr of ["data-radar-search", "data-provider-search", "data-palette-input", "data-shop-search"]) {
      if (active.hasAttribute?.(attr)) {
        return {
          selector: `[${attr}]`,
          start: active.selectionStart ?? active.value?.length ?? 0,
          end: active.selectionEnd ?? active.value?.length ?? 0
        };
      }
    }
    return null;
  }

  function restoreActiveInput(snapshot) {
    if (!snapshot) return;
    const node = doc.querySelector(snapshot.selector);
    if (node) {
      node.focus?.();
      if (snapshot.start !== null) {
        try {
          node.setSelectionRange?.(snapshot.start, snapshot.end);
        } catch {
          // ignore non-selectable inputs
        }
      }
    }
  }

  function terminalViewportTop() {
    return Math.max(0, elHeader?.getBoundingClientRect?.().bottom || 0) + 8;
  }

  function captureTerminalAnchor() {
    const viewportTop = terminalViewportTop();
    for (const row of elTerminal.querySelectorAll("tr[data-product-id], article[data-product-id]")) {
      const rect = row.getBoundingClientRect?.();
      if (rect && rect.bottom > viewportTop && rect.top < globalThis.window.innerHeight) {
        return { id: row.getAttribute("data-product-id"), top: rect.top };
      }
    }
    return null;
  }

  function updateTerminalSelection(state) {
    for (const button of elTerminal.querySelectorAll("[data-action='toggle-save'], [data-action='toggle-compare']")) {
      const save = button.getAttribute("data-action") === "toggle-save";
      const key = button.getAttribute("data-key");
      const active = save ? state.savedKeys.has(key) : state.compareKeys.includes(key);
      const label = save ? (active ? "取消收藏" : "收藏套餐") : (active ? "移出对比" : "加入对比");
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
    }
    for (const row of elTerminal.querySelectorAll("tr[data-product-id], article[data-product-id]")) {
      row.classList.toggle("is-inspected", row.getAttribute("data-product-id") === state.inspectId);
    }
    const count = elTerminal.querySelector("[data-terminal-saved-count]");
    if (count) count.textContent = `★ 收藏 (${state.savedKeys.size})`;
  }

  function onResize() {
    const win = globalThis.window;
    if (resizeFrame || typeof win?.requestAnimationFrame !== "function") return;
    resizeFrame = win.requestAnimationFrame(() => {
      resizeFrame = 0;
      if (disposed || store.getState().view !== "terminal") return;
      const width = elTerminal?.clientWidth || win.innerWidth;
      if (width !== terminalWidth) {
        terminalInputs = [];
        render(store.getState());
      }
    });
  }

  function render(state) {
    hideTagHud();
    const inputSnap = captureActiveInput();
    const now = Date.now();
    const viewChanged = prevView !== null && prevView !== state.view;
    const justBecameReady = prevLoadState !== "ready" && state.loadState === "ready";
    const enterView = prevView === null || viewChanged || justBecameReady;
    const filterSig = `${state.layout}|${JSON.stringify(state.filters)}`;
    const filtersChangedInTerminal =
      !enterView && state.view === "terminal" && state.loadState === "ready" && prevFilterSig !== "" && prevFilterSig !== filterSig;
    const specsJustOpened = !prevSpecsExpanded && state.specsExpanded;

    if (elHeader) {
      elHeader.innerHTML = renderHeader(state, now);
      capsuleStep = 0;
    }

    if (elBanner) {
      const bannerHtml = renderStatusBanner(state, now);
      elBanner.innerHTML = bannerHtml;
      elBanner.hidden = !bannerHtml;
    }

    if (elTerminal) {
      elTerminal.hidden = state.view !== "terminal";
      elTerminal.classList?.toggle?.("is-view-entering", state.view === "terminal" && enterView);
      if (state.view === "terminal") {
        const inputs = [state.loadState, state.errorDetail, state.payload, state.plans, state.filters,
          state.layout, state.shopsExpanded, state.shopQuery, state.shopTab, state.specsExpanded,
          state.mobileRailOpen, state.filters.savedOnly ? state.savedKeys : null];
        const rebuild = enterView || inputs.some((value, index) => value !== terminalInputs[index]);
        if (rebuild) {
          const canvasTop = elTerminal.querySelector("[data-terminal-canvas]")?.getBoundingClientRect?.().top;
          const filtersChanged = terminalInputs[4] && terminalInputs[4] !== state.filters;
          const anchor = !filtersChanged && captureTerminalAnchor();
          terminalList?.dispose();
          const items = state.loadState === "ready" ? selectTerminalPlans(state) : [];
          terminalWidth = elTerminal.clientWidth || globalThis.window?.innerWidth || 1280;
          const options = terminalListOptions(state, terminalWidth);
          elTerminal.innerHTML = renderTerminalView(state, now, { items, options });
          terminalList = mountVirtualList(elTerminal, {
            items, ...options,
            renderItem: (plan, index) => (options.table ? renderTableRow : renderPlanCard)(plan, store.getState(), Date.now(), index)
          });
          terminalInputs = inputs;
          if (anchor) {
            const index = items.findIndex(plan => plan.id === anchor.id);
            if (index >= 0) {
              terminalList.reveal(index);
              const node = Array.from(elTerminal.querySelectorAll("tr[data-product-id], article[data-product-id]"))
                .find(row => row.getAttribute("data-product-id") === anchor.id);
              if (node?.getBoundingClientRect) globalThis.window?.scrollBy?.({ top: node.getBoundingClientRect().top - anchor.top, behavior: "instant" });
            }
          } else if (filtersChanged && canvasTop < terminalViewportTop()) {
            const top = elTerminal.querySelector("[data-terminal-canvas]")?.getBoundingClientRect?.().top;
            if (Number.isFinite(top)) globalThis.window?.scrollBy?.({ top: top - terminalViewportTop(), behavior: "instant" });
          }
          if (filtersChangedInTerminal) {
            elTerminal.querySelector?.("[data-terminal-canvas]")?.classList?.add?.("is-refreshing");
          }
          if (specsJustOpened) {
            elTerminal.querySelector?.("[data-specs-panel]")?.classList?.add?.("is-unfurling");
          }
        }
        updateTerminalSelection(state);
      } else {
        terminalList?.dispose();
        terminalList = null;
        elTerminal.innerHTML = "";
        terminalInputs = [];
      }
    }
    if (elRadar) {
      elRadar.hidden = state.view !== "radar";
      elRadar.classList?.toggle?.("is-view-entering", state.view === "radar" && enterView);
      if (state.view === "radar") elRadar.innerHTML = renderRadarView(state, now);
    }
    if (elProviders) {
      elProviders.hidden = state.view !== "providers";
      elProviders.classList?.toggle?.("is-view-entering", state.view === "providers" && enterView);
      if (state.view === "providers") elProviders.innerHTML = renderProvidersView(state);
    }
    if (elGuide) {
      elGuide.hidden = state.view !== "guide";
      elGuide.classList?.toggle?.("is-view-entering", state.view === "guide" && enterView);
      if (state.view === "guide") elGuide.innerHTML = renderGuideView(state);
    }

    const isDockVisible = Boolean(state.compareKeys.length > 0 && !state.compareOpen);
    if (elDock) {
      const dockHtml = renderCompareDock(state);
      elDock.innerHTML = dockHtml;
      const showDock = Boolean(dockHtml) && !state.compareOpen;
      elDock.hidden = !showDock;
      elDock.classList?.toggle?.("is-entering", showDock && !prevDockVisible);
      prevDockVisible = showDock;
    } else {
      prevDockVisible = isDockVisible;
    }

    if (elCompareModal) {
      const modalHtml = renderCompareModal(state);
      const showModal = Boolean(modalHtml);
      elCompareModal.innerHTML = modalHtml;
      elCompareModal.hidden = !showModal;
      elCompareModal.classList?.toggle?.("is-entering", showModal && !prevCompareOpen);
      prevCompareOpen = showModal;
    }

    if (elInspector) {
      const inspHtml = renderInspectorDrawer(state, now);
      const showInsp = Boolean(inspHtml);
      elInspector.innerHTML = inspHtml;
      elInspector.hidden = !showInsp;
      elInspector.classList?.toggle?.("is-entering", showInsp && !prevInspectorOpen);
      prevInspectorOpen = showInsp;
    }

    if (elSaved) {
      const savedHtml = renderSavedDrawer(state);
      const showSaved = Boolean(savedHtml);
      elSaved.innerHTML = savedHtml;
      elSaved.hidden = !showSaved;
      elSaved.classList?.toggle?.("is-entering", showSaved && !prevSavedOpen);
      prevSavedOpen = showSaved;
    }

    if (elPalette) {
      const palHtml = renderCommandPalette(state);
      const showPal = Boolean(palHtml);
      elPalette.innerHTML = palHtml;
      elPalette.hidden = !showPal;
      elPalette.classList?.toggle?.("is-entering", showPal && !prevPaletteOpen);
      prevPaletteOpen = showPal;
    }

    if (elSheetBackdrop) {
      elSheetBackdrop.hidden = !state.mobileRailOpen;
    }

    const anyModal =
      state.paletteOpen ||
      state.compareOpen ||
      Boolean(state.inspectId) ||
      state.savedDrawerOpen ||
      state.mobileRailOpen;
    document.body?.classList?.toggle("scroll-locked", anyModal);

    prevView = state.view;
    prevLoadState = state.loadState;
    prevFilterSig = filterSig;
    prevSpecsExpanded = state.specsExpanded;

    animateTelemetryCounters(justBecameReady);
    animateVisitCounter(state);
    restoreActiveInput(inputSnap);
    restoreFocusIfClear(state);
    hideTagHud();
  }

  const unsubscribe = store.subscribe(render);

  function refreshVisitStats(record = false) {
    if (disposed || !statsEndpoint) return Promise.resolve(null);
    if (pendingStats) return pendingStats;
    const ctrl = new AbortController();
    statsController = ctrl;
    pendingStats = fetchVisitStats(statsEndpoint, { record, signal: ctrl.signal })
      .then((stats) => {
        if (!disposed && !ctrl.signal.aborted && stats) {
          liveVisitStatsSynced = true;
          store.setVisitStats(stats);
        }
        return stats;
      })
      .finally(() => {
        if (statsController === ctrl) {
          statsController = null;
          pendingStats = null;
        }
      });
    return pendingStats;
  }

  function scheduleVisitStatsAfterRefresh(record = false) {
    if (statsTimer) clearTimeout(statsTimer);
    statsTimer = setTimeout(() => {
      statsTimer = null;
      refreshVisitStats(record);
    }, 45);
  }

  function refresh(isInitial = false) {
    if (disposed) return Promise.resolve();
    if (pendingRefresh) return pendingRefresh;
    refreshController = new AbortController();
    store.setSnapshotLoading(isInitial);
    pendingRefresh = (async () => {
      try {
        const data = await fetchSnapshot(endpoint, { signal: refreshController.signal });
        if (!disposed) store.setSnapshotReady(data);
      } catch (err) {
        if (!disposed) store.setSnapshotError(err);
      } finally {
        pendingRefresh = null;
        refreshController = null;
      }
    })();
    return pendingRefresh;
  }

  function copyShareLink() {
    const url = store.shareUrl();
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard?.writeText) {
      clipboard.writeText(url).then(
        () => showToast("已复制带完整状态的分享链接"),
        () => showToast("链接已同步到浏览器地址栏")
      );
    } else {
      showToast("链接已同步到浏览器地址栏");
    }
  }

  function applyPreset(presetId) {
    const preset = PRESETS[presetId];
    if (!preset) return;
    store.setView("terminal");
    store.patchFilters(preset);
    store.setMobileRailOpen(false);
    store.setPaletteOpen(false);
  }

  function onClick(event) {
    const target = event.target;
    if (!target || typeof target.closest !== "function") return;

    // Clicking backdrop closes corresponding overlay
    if (target === elPalette) {
      store.setPaletteOpen(false);
      return;
    }
    if (target === elCompareModal) {
      store.setCompareOpen(false);
      return;
    }
    if (target === elInspector) {
      store.setInspectId(null);
      return;
    }
    if (target === elSaved) {
      store.setSavedDrawerOpen(false);
      return;
    }
    if (target === elSheetBackdrop) {
      store.setMobileRailOpen(false);
      return;
    }

    // Nav workspace tabs
    const navBtn = target.closest("[data-nav-view]");
    if (navBtn) {
      store.setView(navBtn.getAttribute("data-nav-view"));
      return;
    }

    // Action dispatchers
    const actNode = target.closest("[data-action]");
    if (!actNode) return;

    const action = actNode.getAttribute("data-action");

    // Prevent row click from firing when clicking nested links inside [data-stop-row]
    if (action === "inspect-plan" && target.closest("[data-stop-row]") && target.closest("a")) {
      return;
    }

    switch (action) {
      case "go-home":
        event.preventDefault?.();
        store.setView("terminal");
        store.resetFilters();
        break;
      case "refresh-snapshot":
        refresh(store.getState().loadState !== "ready").finally(() => {
          if (!disposed) scheduleVisitStatsAfterRefresh(true);
        });
        break;
      case "toggle-theme":
        store.toggleTheme();
        break;
      case "open-palette":
        rememberFocus();
        store.setPaletteOpen(true, "");
        document.querySelector("[data-palette-input]")?.focus?.();
        break;
      case "close-palette":
        store.setPaletteOpen(false);
        break;
      case "palette-provider": {
        const pid = actNode.getAttribute("data-provider-id");
        store.setPaletteOpen(false);
        store.setView("terminal");
        store.patchFilters({ ...DEFAULT_FILTERS, status: "all", provider: pid });
        break;
      }
      case "palette-filter-q": {
        const qVal = actNode.getAttribute("data-query") || "";
        store.setPaletteOpen(false);
        store.setView("terminal");
        store.patchFilters({ q: qVal });
        break;
      }
      case "market-jump-cnopt":
        store.setView("terminal");
        store.patchFilters({ ...DEFAULT_FILTERS, track: "cn-opt", status: "available" });
        break;
      case "market-jump-region": {
        const reg = actNode.getAttribute("data-region") || "all";
        store.setView("terminal");
        store.patchFilters({ ...DEFAULT_FILTERS, region: reg, status: "available" });
        break;
      }
      case "palette-plan": {
        const id = actNode.getAttribute("data-product-id");
        store.setPaletteOpen(false);
        store.setInspectId(id);
        break;
      }
      case "palette-cmd": {
        const cmd = actNode.getAttribute("data-cmd");
        store.setPaletteOpen(false);
        if (cmd === "preset-us-home") applyPreset("us-home-dedicated");
        else if (cmd === "preset-cn2") applyPreset("cn2-opt");
        else if (cmd === "preset-blockbuster") applyPreset("deal-blockbuster");
        else if (cmd === "preset-generous") applyPreset("deal-generous");
        else if (cmd === "preset-annual") applyPreset("deal-annual");
        else if (cmd === "preset-home-opt") applyPreset("deal-home-opt");
        else if (cmd === "preset-scarce") applyPreset("deal-scarce");
        else if (cmd === "go-radar") store.setView("radar");
        else if (cmd === "go-providers") store.setView("providers");
        else if (cmd === "copy-share") copyShareLink();
        else if (cmd === "toggle-theme") store.toggleTheme();
        break;
      }
      case "quick-stat": {
        const stat = actNode.getAttribute("data-stat");
        if (stat === "blocked") {
          store.setView("providers");
          store.patchProviders({ health: "issue" });
        } else if (stat === "home") {
          store.setView("terminal");
          store.patchFilters({ ...DEFAULT_FILTERS, track: "home", status: "available" });
        } else if (stat === "exact") {
          store.setView("terminal");
          store.patchFilters({ ...DEFAULT_FILTERS, exactOnly: true, status: "available" });
        } else {
          store.setView("terminal");
          store.patchFilters({ ...DEFAULT_FILTERS, status: "available" });
        }
        break;
      }
      case "set-track":
        store.patchFilters({ track: actNode.getAttribute("data-track") || "all" });
        break;
      case "set-provider": {
        const p = actNode.getAttribute("data-provider") || "all";
        const cur = store.getState().filters.provider;
        store.patchFilters({ provider: p !== "all" && cur === p ? "all" : p });
        if (store.getState().shopsExpanded) {
          store.toggleShopsExpanded();
          doc.querySelector("[data-action='toggle-shops-expand']")?.focus?.();
        }
        break;
      }
      case "toggle-shops-expand":
        store.toggleShopsExpanded();
        doc.querySelector(store.getState().shopsExpanded ? "[data-shop-search]" : "[data-action='toggle-shops-expand']")?.focus?.();
        break;
      case "clear-shop-search":
        store.setShopQuery("");
        doc.querySelector("[data-shop-search]")?.focus?.();
        break;
      case "toggle-specs-expand":
        store.toggleSpecsExpanded();
        break;
      case "set-opt": {
        const o = actNode.getAttribute("data-opt") || "all";
        const cur = store.getState().filters.opt;
        store.patchFilters({ opt: o !== "all" && cur === o ? "all" : o });
        break;
      }
      case "set-deal": {
        const d = actNode.getAttribute("data-deal") || "all";
        const cur = store.getState().filters.deal;
        store.patchFilters({ deal: d !== "all" && cur === d ? "all" : d });
        break;
      }
      case "set-spec": {
        const sk = actNode.getAttribute("data-spec-key");
        const sv = actNode.getAttribute("data-spec-val") || "all";
        if (sk && Object.hasOwn(DEFAULT_FILTERS, sk)) {
          const cur = store.getState().filters[sk];
          store.patchFilters({ [sk]: sv !== "all" && cur === sv ? "all" : sv });
        }
        break;
      }
      case "set-region": {
        const reg = actNode.getAttribute("data-region");
        const cur = store.getState().filters.region;
        store.patchFilters({ region: cur === reg ? "all" : reg });
        break;
      }
      case "set-route": {
        const rt = actNode.getAttribute("data-route");
        const cur = store.getState().filters.route;
        store.patchFilters({ route: rt !== "all" && cur === rt ? "all" : rt });
        break;
      }
      case "set-budget": {
        const b = actNode.getAttribute("data-budget") || "all";
        const cur = store.getState().filters.budget;
        store.patchFilters({
          budget: b !== "all" && cur === b && !store.getState().filters.minPrice && !store.getState().filters.maxPrice ? "all" : b,
          minPrice: "",
          maxPrice: ""
        });
        break;
      }
      case "set-cycle":
        store.patchFilters({ cycle: actNode.getAttribute("data-cycle") || "all" });
        break;
      case "toggle-quick-available":
        store.patchFilters({ status: store.getState().filters.status === "available" ? "all" : "available" });
        break;
      case "toggle-quick-exact":
        store.patchFilters({ exactOnly: !store.getState().filters.exactOnly });
        break;
      case "toggle-quick-nonat":
        store.patchFilters({ noNat: !store.getState().filters.noNat });
        break;
      case "toggle-quick-nosnap":
        store.patchFilters({ noSnapshot: !store.getState().filters.noSnapshot });
        break;
      case "toggle-quick-saved":
        store.patchFilters({ savedOnly: !store.getState().filters.savedOnly });
        break;
      case "sort-col": {
        const col = actNode.getAttribute("data-sort-col");
        const cur = store.getState().filters.sort;
        if (col === "price") {
          store.patchFilters({ sort: cur === "cny-asc" ? "cny-desc" : "cny-asc" });
        } else if (col === "stock") {
          store.patchFilters({ sort: cur === "stock-desc" ? "recommended" : "stock-desc" });
        }
        break;
      }
      case "clear-search":
        store.patchFilters({ q: "" });
        break;
      case "remove-filter": {
        const key = actNode.getAttribute("data-filter-key");
        if (key === "priceRange") {
          store.patchFilters({ minPrice: "", maxPrice: "", budget: "all" });
        } else if (key && Object.hasOwn(DEFAULT_FILTERS, key)) {
          store.patchFilters({ [key]: DEFAULT_FILTERS[key] });
        }
        break;
      }
      case "reset-filters":
        store.resetFilters();
        break;
      case "apply-relaxation": {
        try {
          const patch = JSON.parse(actNode.getAttribute("data-relax-patch") || "{}");
          store.patchFilters(patch);
        } catch {
          store.resetFilters();
        }
        break;
      }
      case "apply-preset":
        applyPreset(actNode.getAttribute("data-preset"));
        break;
      case "set-layout":
        store.setLayout(actNode.getAttribute("data-layout"));
        break;
      case "inspect-plan":
      case "inspect-event": {
        const id = actNode.getAttribute("data-product-id");
        if (id) {
          rememberFocus();
          store.setInspectId(id);
        }
        break;
      }
      case "inspect-ticker-event": {
        const id = actNode.getAttribute("data-ticker-product-id");
        if (id) {
          rememberFocus();
          store.setInspectId(id);
        }
        break;
      }
      case "inspect-from-compare": {
        const id = actNode.getAttribute("data-product-id");
        store.setCompareOpen(false);
        if (id) store.setInspectId(id);
        break;
      }
      case "close-inspector":
        store.setInspectId(null);
        break;
      case "toggle-save": {
        const key = actNode.getAttribute("data-key");
        const added = store.toggleSaved(key);
        showToast(added ? "已加入本地收藏夹" : "已从本地收藏夹移除");
        break;
      }
      case "open-saved":
        rememberFocus();
        store.setSavedDrawerOpen(true);
        break;
      case "close-saved":
        store.setSavedDrawerOpen(false);
        break;
      case "filter-saved-only":
        store.setSavedDrawerOpen(false);
        store.setView("terminal");
        store.patchFilters({ savedOnly: true, status: "all" });
        break;
      case "clear-saved":
        store.clearSaved();
        showToast("已清空本地收藏夹");
        break;
      case "toggle-compare": {
        const key = actNode.getAttribute("data-key");
        const res = store.toggleCompare(key);
        if (!res.changed && res.reason === "limit") {
          showToast("横向对比最多同时选择 4 款套餐");
        }
        break;
      }
      case "clear-compare":
        store.clearCompare();
        break;
      case "open-compare":
        rememberFocus();
        store.setCompareOpen(true);
        break;
      case "close-compare":
        store.setCompareOpen(false);
        break;
      case "toggle-compare-diff":
        store.toggleCompareDiffOnly();
        break;
      case "open-mobile-rail":
        rememberFocus();
        store.setMobileRailOpen(true);
        break;
      case "close-mobile-rail":
        store.setMobileRailOpen(false);
        break;
      case "copy-share-url":
        copyShareLink();
        break;
      case "drill-provider": {
        const pid = actNode.getAttribute("data-provider-id");
        store.setInspectId(null);
        store.setView("terminal");
        store.patchFilters({ ...DEFAULT_FILTERS, status: "all", provider: pid });
        break;
      }
      case "set-radar-type":
        store.patchRadar({ type: actNode.getAttribute("data-radar-type") || "all" });
        break;
      case "set-radar-window":
        store.patchRadar({ window: actNode.getAttribute("data-window") || "7d" });
        break;
      case "reset-radar":
        store.resetRadar();
        break;
      case "set-prov-health":
        store.patchProviders({ health: actNode.getAttribute("data-health") || "all" });
        break;
      case "set-prov-region": {
        const reg = actNode.getAttribute("data-prov-region") || "all";
        const cur = store.getState().providersFilter.region;
        store.patchProviders({ region: reg !== "all" && cur === reg ? "all" : reg });
        break;
      }
      case "filter-prov-tag": {
        const tg = actNode.getAttribute("data-prov-tag") || "all";
        const cur = store.getState().providersFilter.tag;
        store.patchProviders({ tag: tg !== "all" && cur === tg ? "all" : tg });
        break;
      }
      case "jump-deal-from-inspector": {
        const d = actNode.getAttribute("data-deal") || "all";
        store.setInspectId(null);
        store.setView("terminal");
        store.patchFilters({ deal: d, status: "available" });
        break;
      }
      case "reset-providers":
        store.resetProviders();
        break;
      case "set-shop-tab":
        store.setShopTab(actNode.getAttribute("data-shop-tab") || "all");
        break;
      case "set-guide-route-tab":
        store.setGuideRouteTab(actNode.getAttribute("data-route-tab") || "all");
        break;
      case "toggle-guide-check":
        store.toggleGuideCheck(actNode.getAttribute("data-check-id"));
        break;
      case "guide-jump-route": {
        const rt = actNode.getAttribute("data-route") || "all";
        store.setView("terminal");
        store.patchFilters({ ...DEFAULT_FILTERS, route: rt, status: "available" });
        break;
      }
      case "guide-jump-track": {
        const tr = actNode.getAttribute("data-track") || "all";
        store.setView("terminal");
        store.patchFilters({ ...DEFAULT_FILTERS, track: tr, status: "available" });
        break;
      }
      case "guide-jump-opt": {
        const opt = actNode.getAttribute("data-opt") || "all";
        const track = actNode.getAttribute("data-track") || "all";
        store.setView("terminal");
        store.patchFilters({ ...DEFAULT_FILTERS, opt, track, status: "available" });
        break;
      }
      case "guide-jump-nonat":
        store.setView("terminal");
        store.patchFilters({ ...DEFAULT_FILTERS, noNat: true, status: "available" });
        break;
      default:
        break;
    }
  }

  function onChange(event) {
    const target = event.target;
    if (!target || typeof target.getAttribute !== "function") return;

    const toggleKey = target.getAttribute("data-filter-toggle");
    if (toggleKey) {
      if (toggleKey === "availableOnly") {
        store.patchFilters({ status: target.checked ? "available" : "all" });
      } else {
        store.patchFilters({ [toggleKey]: Boolean(target.checked) });
      }
      return;
    }

    const selectKey = target.getAttribute("data-filter-select");
    if (selectKey) {
      store.patchFilters({
        [selectKey]: target.value,
        ...(selectKey === "budget" ? { minPrice: "", maxPrice: "" } : {})
      });
      return;
    }

    const radarSelect = target.getAttribute("data-radar-select");
    if (radarSelect) {
      store.patchRadar({ [radarSelect]: target.value });
      return;
    }

    const radarToggle = target.getAttribute("data-radar-toggle");
    if (radarToggle) {
      store.patchRadar({ [radarToggle]: Boolean(target.checked) });
      return;
    }

    const provSelect = target.getAttribute("data-provider-select");
    if (provSelect) {
      store.patchProviders({ [provSelect]: target.value });
      return;
    }

    if (target.hasAttribute?.("data-provider-sort")) {
      store.setProvidersSort(target.value);
    }
  }

  function onInput(event) {
    const target = event.target;
    if (!target || typeof target.hasAttribute !== "function") return;

    if (target.hasAttribute("data-price-min")) {
      store.patchFilters({ minPrice: target.value, budget: "all" });
      return;
    }
    if (target.hasAttribute("data-price-max")) {
      store.patchFilters({ maxPrice: target.value, budget: "all" });
      return;
    }
    if (target.hasAttribute("data-radar-search")) {
      store.patchRadar({ q: target.value });
      return;
    }
    if (target.hasAttribute("data-provider-search")) {
      store.patchProviders({ q: target.value });
      return;
    }
    if (target.hasAttribute("data-shop-search")) {
      store.setShopQuery(target.value);
      return;
    }
    if (target.hasAttribute("data-palette-input")) {
      store.setPaletteQuery(target.value);
    }
  }

  let activeHudDescribedEl = null;

  function clearHudAriaDescribedBy() {
    if (!activeHudDescribedEl) return;
    const hudId = elTagHud?.id || "radar-tag-hud";
    const cur = activeHudDescribedEl.getAttribute?.("aria-describedby") || "";
    const next = cur
      .split(/\s+/)
      .filter((token) => token && token !== hudId)
      .join(" ");
    if (next) activeHudDescribedEl.setAttribute?.("aria-describedby", next);
    else activeHudDescribedEl.removeAttribute?.("aria-describedby");
    activeHudDescribedEl = null;
  }

  function bindHudAriaDescribedBy(hostEl) {
    if (!hostEl || !elTagHud) return;
    if (!elTagHud.id) elTagHud.id = "radar-tag-hud";
    if (activeHudDescribedEl && activeHudDescribedEl !== hostEl) {
      clearHudAriaDescribedBy();
    }
    const cur = hostEl.getAttribute?.("aria-describedby") || "";
    const tokens = cur.split(/\s+/).filter(Boolean);
    if (!tokens.includes(elTagHud.id)) tokens.push(elTagHud.id);
    hostEl.setAttribute?.("aria-describedby", tokens.join(" "));
    activeHudDescribedEl = hostEl;
  }

  function resolveTagTipFromFocus(node) {
    if (!node || typeof node.closest !== "function") return null;
    const directTip = node.closest("[data-tag-tip]");
    if (directTip) return { tipEl: directTip, hostEl: node };
    const tagName = node.tagName?.toLowerCase() || "";
    const isFocusableHost =
      tagName === "button" ||
      tagName === "a" ||
      Boolean(node.hasAttribute?.("tabindex")) ||
      node.getAttribute?.("role") === "button";
    if (isFocusableHost && typeof node.querySelector === "function") {
      const nestedTip = node.querySelector("[data-tag-tip]");
      if (nestedTip) return { tipEl: nestedTip, hostEl: node };
    }
    return null;
  }

  function hideTagHud() {
    if (tagHudTimer) {
      clearTimeout(tagHudTimer);
      tagHudTimer = null;
    }
    activeTagTipEl = null;
    clearHudAriaDescribedBy();
    if (elTagHud && !elTagHud.hidden) {
      elTagHud.hidden = true;
      elTagHud.setAttribute?.("aria-hidden", "true");
      elTagHud.innerHTML = "";
    }
  }

  function showTagHud(tipEl, hostEl = tipEl) {
    if (!elTagHud || !tipEl) return;
    const tone = tipEl.getAttribute("data-tag-tip") || "value";
    const title = tipEl.getAttribute("data-tag-tip-title") || "";
    const kind = tipEl.getAttribute("data-tag-tip-kind") || "客观核验依据";
    const reason = tipEl.getAttribute("data-tag-tip-reason") || "";
    const hint = tipEl.getAttribute("data-tag-tip-hint") || "";
    if (!title && !reason) return;

    elTagHud.innerHTML = `
      <div class="tag-hud-card is-tone-${escapeHtml(tone)}">
        <div class="tag-hud-head">
          <span class="tag-hud-badge is-${escapeHtml(tone)}">${renderTagSvg(tone)}<span>${escapeHtml(title)}</span></span>
          <span class="tag-hud-kind">${escapeHtml(kind)}</span>
        </div>
        ${reason ? `<div class="tag-hud-reason">${escapeHtml(reason)}</div>` : ""}
        ${hint ? `<div class="tag-hud-hint">${escapeHtml(hint)}</div>` : ""}
      </div>
    `;
    elTagHud.hidden = false;
    elTagHud.setAttribute?.("aria-hidden", "false");
    bindHudAriaDescribedBy(hostEl || tipEl);

    const rect =
      typeof tipEl.getBoundingClientRect === "function"
        ? tipEl.getBoundingClientRect()
        : { top: 120, bottom: 142, left: 120, width: 64, height: 22 };
    const hudRect = elTagHud.getBoundingClientRect?.() || { width: 280, height: 84 };
    const hudW = hudRect.width > 0 ? hudRect.width : 280;
    const hudH = hudRect.height > 0 ? hudRect.height : 84;
    const vw = globalThis.window?.innerWidth || 1440;
    const vh = globalThis.window?.innerHeight || 900;
    const placeBelow = rect.top < hudH + 18 && vh - rect.bottom > hudH + 12;
    const top = placeBelow ? rect.bottom + 8 : rect.top - hudH - 8;
    const rawLeft = rect.left + rect.width / 2 - hudW / 2;
    const left = Math.max(10, Math.min(vw - hudW - 10, rawLeft));
    const topPx = Math.round(Math.max(8, top));
    const leftPx = Math.round(left);
    if (elTagHud.style) {
      elTagHud.style.top = `${topPx}px`;
      elTagHud.style.left = `${leftPx}px`;
    } else {
      elTagHud.setAttribute?.("style", `top:${topPx}px;left:${leftPx}px`);
    }
  }

  function onTagPointerOver(event) {
    if (!elTagHud) return;
    const tipEl = event.target?.closest?.("[data-tag-tip]");
    if (!tipEl) {
      if (activeTagTipEl) hideTagHud();
      return;
    }
    if (tipEl === activeTagTipEl) return;
    if (tagHudTimer) clearTimeout(tagHudTimer);
    activeTagTipEl = tipEl;
    tagHudTimer = setTimeout(() => {
      tagHudTimer = null;
      if (!disposed && activeTagTipEl === tipEl) showTagHud(tipEl, tipEl);
    }, 75);
  }

  function onTagPointerOut(event) {
    if (!activeTagTipEl) return;
    const nextTip = event.relatedTarget?.closest?.("[data-tag-tip]");
    if (nextTip === activeTagTipEl) return;
    hideTagHud();
  }

  function onTagFocusIn(event) {
    if (!elTagHud) return;
    const match = resolveTagTipFromFocus(event.target);
    if (!match) {
      if (activeTagTipEl) hideTagHud();
      return;
    }
    if (tagHudTimer) {
      clearTimeout(tagHudTimer);
      tagHudTimer = null;
    }
    activeTagTipEl = match.tipEl;
    showTagHud(match.tipEl, match.hostEl);
  }

  function onTagFocusOut(event) {
    if (!activeTagTipEl) return;
    const nextMatch = resolveTagTipFromFocus(event.relatedTarget);
    if (nextMatch?.tipEl === activeTagTipEl) return;
    hideTagHud();
  }

  function onKeydown(event) {
    const key = event.key;
    const activeEl = document.activeElement;
    const tag = activeEl?.tagName?.toLowerCase() || "";
    const inEditable = tag === "input" || tag === "textarea" || tag === "select";

    if ((key === "Enter" || key === " ") && !inEditable && activeEl?.getAttribute?.("role") === "button" && activeEl?.hasAttribute?.("data-action")) {
      event.preventDefault?.();
      activeEl.click?.();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && key?.toLowerCase() === "k") {
      event.preventDefault?.();
      const open = !store.getState().paletteOpen;
      if (open) rememberFocus();
      store.setPaletteOpen(open, "");
      if (open) document.querySelector("[data-palette-input]")?.focus?.();
      return;
    }

    if (key === "/" && !inEditable && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault?.();
      rememberFocus();
      store.setPaletteOpen(true, "");
      document.querySelector("[data-palette-input]")?.focus?.();
      return;
    }

    if (key === "Enter" && store.getState().paletteOpen && document.activeElement?.hasAttribute?.("data-palette-input")) {
      const qVal = store.getState().paletteQuery.trim();
      if (qVal) {
        event.preventDefault?.();
        store.setPaletteOpen(false);
        store.setView("terminal");
        store.patchFilters({ q: qVal });
      }
      return;
    }

    if (key === "Escape") {
      if (elTagHud && !elTagHud.hidden) {
        hideTagHud();
        return;
      }
      const s = store.getState();
      if (s.paletteOpen) store.setPaletteOpen(false);
      else if (s.compareOpen) store.setCompareOpen(false);
      else if (s.inspectId) store.setInspectId(null);
      else if (s.savedDrawerOpen) store.setSavedDrawerOpen(false);
      else if (s.mobileRailOpen) store.setMobileRailOpen(false);
      else if (s.shopsExpanded && s.view === "terminal") {
        store.toggleShopsExpanded();
        doc.querySelector("[data-action='toggle-shops-expand']")?.focus?.();
      }
    }
  }

  function onVisibilityChange() {
    if (doc.visibilityState === "visible") {
      const s = store.getState();
      if (s.lastFetchAt && Date.now() - s.lastFetchAt >= REFRESH_INTERVAL_MS) {
        refresh(false);
      }
    }
  }

  // Cursor-tracking radial spotlight on interactive cards (browser-only, zero idle cost)
  let spotlightRaf = 0;
  let pendingPointerEvent = null;
  function onPointerMove(event) {
    const raf = globalThis.window?.requestAnimationFrame;
    if (typeof raf !== "function") return;
    pendingPointerEvent = event;
    if (spotlightRaf) return;
    spotlightRaf = raf(() => {
      spotlightRaf = 0;
      const ev = pendingPointerEvent;
      pendingPointerEvent = null;
      const card = ev?.target?.closest?.(".plan-card, .provider-card, .market-board-card, .kpi-tile, .guide-preset-card");
      if (!card || typeof card.getBoundingClientRect !== "function") return;
      const rect = card.getBoundingClientRect();
      card.style?.setProperty?.("--mx", `${Math.round(ev.clientX - rect.left)}px`);
      card.style?.setProperty?.("--my", `${Math.round(ev.clientY - rect.top)}px`);
    });
  }

  globalThis.window?.addEventListener?.("resize", onResize);
  globalThis.window?.addEventListener?.("scroll", hideTagHud, { passive: true, capture: true });
  doc.addEventListener("click", onClick);
  doc.addEventListener("change", onChange);
  doc.addEventListener("input", onInput);
  doc.addEventListener("keydown", onKeydown);
  doc.addEventListener("visibilitychange", onVisibilityChange);
  if (elTagHud) {
    doc.addEventListener("pointerover", onTagPointerOver, { passive: true });
    doc.addEventListener("pointerout", onTagPointerOut, { passive: true });
    doc.addEventListener("focusin", onTagFocusIn);
    doc.addEventListener("focusout", onTagFocusOut);
  }
  if (typeof globalThis.window?.requestAnimationFrame === "function") {
    doc.addEventListener("pointermove", onPointerMove, { passive: true });
  }

  const pollTimer = setInterval(() => {
    if (doc.visibilityState === "visible") {
      refresh(false);
      refreshVisitStats(false);
    }
  }, REFRESH_INTERVAL_MS);

  // Lightweight 1s live clock + sync progress bar + 15s freshness age + 3s live event capsule ticker
  let capsuleTick = 0;
  const liveTickerTimer = setInterval(() => {
    if (doc.visibilityState !== "visible") return;
    const nowMs = Date.now();
    const clockNode = doc.querySelector("[data-live-clock]");
    if (clockNode) clockNode.textContent = formatLiveClockText(new Date(nowMs));

    const curState = store.getState();
    const syncNode = doc.querySelector("[data-sync-progress]");
    if (syncNode && !curState.refreshing && curState.loadState === "ready") {
      const ratio = computeSyncProgressRatio(curState, REFRESH_INTERVAL_MS, nowMs).toFixed(3);
      syncNode.style?.setProperty?.("--sync-progress", ratio);
    }

    capsuleTick += 1;
    if (capsuleTick % 12 === 0) {
      refreshVisitStats(false);
    }
    if (capsuleTick % 15 === 0 && curState.loadState === "ready" && curState.payload?.generatedAt) {
      const teleNode = doc.querySelector("[data-telemetry-label]");
      if (teleNode) {
        const freshness = monitorFreshness(curState.payload.generatedAt, nowMs);
        teleNode.textContent = freshness.stale ? `快照偏旧 · ${freshness.label}` : `实时快照 · ${freshness.label}`;
      }
    }

    if (capsuleTick % 3 === 0) {
      const capsule = doc.querySelector("[data-live-capsule]");
      if (capsule && !capsule.matches?.(":hover")) {
        const count = Number(capsule.getAttribute("data-capsule-count") || 0);
        const track = capsule.querySelector("[data-capsule-track]");
        if (track && count > 1) {
          capsuleStep = (capsuleStep + 1) % count;
          track.style.transform = `translateY(-${capsuleStep * 24}px)`;
        }
      }
    }
  }, 1000);

  // Initial synchronous skeleton render + live snapshot fetch, then non-colliding visit hit
  render(store.getState());
  refresh(true).finally(() => {
    if (!disposed) scheduleVisitStatsAfterRefresh(true);
  });

  return {
    store,
    refresh,
    refreshVisitStats,
    dispose() {
      disposed = true;
      refreshController?.abort();
      if (statsTimer) clearTimeout(statsTimer);
      statsController?.abort();
      cancelVisitTween();
      cancelNumberTweens();
      if (spotlightRaf && typeof globalThis.window?.cancelAnimationFrame === "function") {
        globalThis.window.cancelAnimationFrame(spotlightRaf);
      }
      terminalList?.dispose();
      hideTagHud();
      if (resizeFrame) globalThis.window?.cancelAnimationFrame?.(resizeFrame);
      globalThis.window?.removeEventListener?.("resize", onResize);
      globalThis.window?.removeEventListener?.("scroll", hideTagHud, { capture: true });
      unsubscribe();
      clearInterval(pollTimer);
      clearInterval(liveTickerTimer);
      if (toastTimer) clearTimeout(toastTimer);
      doc.removeEventListener("click", onClick);
      doc.removeEventListener("change", onChange);
      doc.removeEventListener("input", onInput);
      doc.removeEventListener("keydown", onKeydown);
      doc.removeEventListener("visibilitychange", onVisibilityChange);
      if (elTagHud) {
        doc.removeEventListener("pointerover", onTagPointerOver);
        doc.removeEventListener("pointerout", onTagPointerOut);
        doc.removeEventListener("focusin", onTagFocusIn);
        doc.removeEventListener("focusout", onTagFocusOut);
      }
      if (typeof globalThis.window?.requestAnimationFrame === "function") {
        doc.removeEventListener("pointermove", onPointerMove);
      }
      doc.body?.classList?.remove("scroll-locked");
    }
  };
}
