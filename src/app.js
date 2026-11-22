import { DEFAULT_FILTERS } from "./domain/catalog.js";
import { escapeHtml } from "./domain/format.js";
import { REFRESH_INTERVAL_MS, fetchSnapshot } from "./services/snapshot.js";
import { applyTheme, createStore } from "./state/store.js";
import { renderCompareDock, renderCompareModal } from "./components/compare.js";
import { renderGuideView } from "./components/guide.js";
import { renderCommandPalette, renderHeader, renderStatusBanner } from "./components/header.js";
import { renderInspectorDrawer } from "./components/inspector.js";
import { renderProvidersView } from "./components/providers.js";
import { renderRadarView } from "./components/radar.js";
import { renderSavedDrawer } from "./components/saved-drawer.js";
import { renderTerminalView } from "./components/terminal.js";

const PRESETS = {
  "us-home-dedicated": { ...DEFAULT_FILTERS, track: "home", region: "US", noNat: true, status: "available" },
  "cn2-opt": { ...DEFAULT_FILTERS, route: "cn2", status: "available" },
  "budget-monthly": { ...DEFAULT_FILTERS, budget: "60", cycle: "monthly", fixedPriceOnly: true, status: "available" },
  "exact-stock": { ...DEFAULT_FILTERS, exactOnly: true, status: "available" }
};

export function mountApp(options = {}) {
  const doc = globalThis.document;
  const endpoint = options.endpoint || "data/products.json";
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
  const elToast = doc.querySelector("[data-toast-region]");

  let lastFocusBeforeOverlay = null;
  let toastTimer = null;
  let pendingRefresh = null;
  let refreshController = null;
  let disposed = false;

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
    if (active.hasAttribute?.("data-terminal-search")) {
      const scope = active.closest?.("[data-filter-dock]") ? "[data-filter-dock] " : ".mobile-quick-bar ";
      return {
        selector: `${scope}[data-terminal-search]`,
        start: active.selectionStart ?? active.value?.length ?? 0,
        end: active.selectionEnd ?? active.value?.length ?? 0
      };
    }
    for (const attr of ["data-radar-search", "data-provider-search", "data-palette-input"]) {
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
      try {
        node.setSelectionRange?.(snapshot.start, snapshot.end);
      } catch {
        // ignore non-selectable inputs
      }
    }
  }

  function render(state) {
    const inputSnap = captureActiveInput();
    const now = Date.now();

    if (elHeader) elHeader.innerHTML = renderHeader(state, now);

    if (elBanner) {
      const bannerHtml = renderStatusBanner(state, now);
      elBanner.innerHTML = bannerHtml;
      elBanner.hidden = !bannerHtml;
    }

    if (elTerminal) {
      elTerminal.hidden = state.view !== "terminal";
      if (state.view === "terminal") elTerminal.innerHTML = renderTerminalView(state, now);
    }
    if (elRadar) {
      elRadar.hidden = state.view !== "radar";
      if (state.view === "radar") elRadar.innerHTML = renderRadarView(state, now);
    }
    if (elProviders) {
      elProviders.hidden = state.view !== "providers";
      if (state.view === "providers") elProviders.innerHTML = renderProvidersView(state);
    }
    if (elGuide) {
      elGuide.hidden = state.view !== "guide";
      if (state.view === "guide") elGuide.innerHTML = renderGuideView();
    }

    if (elDock) {
      const dockHtml = renderCompareDock(state);
      elDock.innerHTML = dockHtml;
      elDock.hidden = !dockHtml || state.compareOpen;
    }

    if (elCompareModal) {
      const modalHtml = renderCompareModal(state);
      elCompareModal.innerHTML = modalHtml;
      elCompareModal.hidden = !modalHtml;
    }

    if (elInspector) {
      const inspHtml = renderInspectorDrawer(state, now);
      elInspector.innerHTML = inspHtml;
      elInspector.hidden = !inspHtml;
    }

    if (elSaved) {
      const savedHtml = renderSavedDrawer(state);
      elSaved.innerHTML = savedHtml;
      elSaved.hidden = !savedHtml;
    }

    if (elPalette) {
      const palHtml = renderCommandPalette(state);
      elPalette.innerHTML = palHtml;
      elPalette.hidden = !palHtml;
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

    restoreActiveInput(inputSnap);
    restoreFocusIfClear(state);
  }

  const unsubscribe = store.subscribe(render);

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
    store.setAdvancedOpen(false);
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

    // Close advanced filter popover when clicking outside
    if (store.getState().advancedOpen && !target.closest(".adv-wrap")) {
      store.setAdvancedOpen(false);
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
        refresh(store.getState().loadState !== "ready");
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
      case "set-region": {
        const reg = actNode.getAttribute("data-region");
        const cur = store.getState().filters.region;
        store.patchFilters({ region: cur === reg ? "all" : reg });
        break;
      }
      case "set-route": {
        const rt = actNode.getAttribute("data-route");
        const cur = store.getState().filters.route;
        store.patchFilters({ route: cur === rt ? "all" : rt });
        break;
      }
      case "set-budget":
        store.patchFilters({ budget: actNode.getAttribute("data-budget") || "all" });
        break;
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
      case "toggle-advanced":
        store.toggleAdvancedOpen();
        break;
      case "close-advanced":
        store.setAdvancedOpen(false);
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
        if (key && Object.hasOwn(DEFAULT_FILTERS, key)) {
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
      case "load-more":
        store.loadMore(false);
        break;
      case "load-all":
        store.loadMore(true);
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
      case "reset-providers":
        store.resetProviders();
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
      store.patchFilters({ [selectKey]: target.value });
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
    }
  }

  function onInput(event) {
    const target = event.target;
    if (!target || typeof target.hasAttribute !== "function") return;

    if (target.hasAttribute("data-terminal-search")) {
      store.patchFilters({ q: target.value });
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
    if (target.hasAttribute("data-palette-input")) {
      store.setPaletteQuery(target.value);
    }
  }

  function onKeydown(event) {
    const key = event.key;
    const tag = document.activeElement?.tagName?.toLowerCase() || "";
    const inEditable = tag === "input" || tag === "textarea" || tag === "select";

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

    if (key === "Escape") {
      const s = store.getState();
      if (s.paletteOpen) store.setPaletteOpen(false);
      else if (s.advancedOpen) store.setAdvancedOpen(false);
      else if (s.compareOpen) store.setCompareOpen(false);
      else if (s.inspectId) store.setInspectId(null);
      else if (s.savedDrawerOpen) store.setSavedDrawerOpen(false);
      else if (s.mobileRailOpen) store.setMobileRailOpen(false);
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState === "visible") {
      const s = store.getState();
      if (s.lastFetchAt && Date.now() - s.lastFetchAt >= REFRESH_INTERVAL_MS) {
        refresh(false);
      }
    }
  }

  doc.addEventListener("click", onClick);
  doc.addEventListener("change", onChange);
  doc.addEventListener("input", onInput);
  doc.addEventListener("keydown", onKeydown);
  doc.addEventListener("visibilitychange", onVisibilityChange);

  const pollTimer = setInterval(() => {
    if (doc.visibilityState === "visible") {
      refresh(false);
    }
  }, REFRESH_INTERVAL_MS);

  // Initial synchronous skeleton render + live snapshot fetch
  render(store.getState());
  refresh(true);

  return {
    store,
    refresh,
    dispose() {
      disposed = true;
      refreshController?.abort();
      unsubscribe();
      clearInterval(pollTimer);
      if (toastTimer) clearTimeout(toastTimer);
      doc.removeEventListener("click", onClick);
      doc.removeEventListener("change", onChange);
      doc.removeEventListener("input", onInput);
      doc.removeEventListener("keydown", onKeydown);
      doc.removeEventListener("visibilitychange", onVisibilityChange);
      doc.body?.classList?.remove("scroll-locked");
    }
  };
}
