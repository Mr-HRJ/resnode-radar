import { computed, reactive, ref, shallowRef } from "vue";
import {
  DEFAULT_FILTERS,
  DEFAULT_PROVIDER_FILTERS,
  DEFAULT_RADAR_FILTERS,
  MAX_COMPARE,
  PAGE_STEP,
  PRESETS,
  VALID_VIEWS,
  applyTheme,
  fxExpiresAtMs,
  fxFreshness,
  loadSaved,
  loadTheme,
  matchesFilters,
  parseUrlState,
  saveSaved,
  serializeUrlState,
  sortProducts
} from "@resnode-radar/contracts";
import {
  REFRESH_INTERVAL_MS,
  fetchSourceAudit,
  loadRadarSnapshot,
  normalizeSnapshotPayloadSync
} from "../services/snapshot-client.js";
import {
  fetchVisitStats,
  hasRecordedSessionVisit,
  loadSessionVisitStats,
  markSessionVisitRecorded,
  saveSessionVisitStats
} from "../services/visits-client.js";

export function createRadarStore(options = {}) {
  const win = options.window ?? globalThis.window;
  const doc = options.document ?? globalThis.document;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const endpoint = options.endpoint ?? null;
  const statsEndpoint = options.statsEndpoint === undefined ? null : options.statsEndpoint;
  const statsEnabled = options.enableVisitStats !== false && statsEndpoint !== "";
  const initialHref = options.initialUrl ?? win?.location?.href ?? "https://vpsld.com/";

  const fromUrl = parseUrlState(initialHref);
  const nowMs = ref(options.initialNowMs ?? Date.now());

  const state = reactive({
    loadState: "loading", // "loading" | "ready" | "error"
    refreshing: false,
    errorDetail: null,
    auditNotice: null,
    protocolMode: "v2", // "v2" | "v1"
    snapshotId: null,
    lastFetchAt: null,
    visitStats: loadSessionVisitStats(win?.sessionStorage, nowMs.value),

    view: fromUrl.view,
    layout: fromUrl.layout,
    filters: { ...fromUrl.filters },
    radar: { ...fromUrl.radar },
    providersFilter: { ...fromUrl.providersFilter },
    pageLimit: PAGE_STEP,

    savedKeys: loadSaved(win?.localStorage),
    compareKeys: [...fromUrl.compareKeys],
    compareOpen: fromUrl.compareOpen,
    compareDiffOnly: false,
    inspectId: fromUrl.inspectId,
    inspectSource: fromUrl.inspectId ? "url" : "user",
    inspectActionSeq: 0,
    workspaceFocusSeq: 0,
    savedDrawerOpen: false,
    mobileRailOpen: false,
    shopsExpanded: false,
    shopQuery: "",
    shopTab: "all",
    providersSort: "recommended",
    guideRouteTab: "all",
    guideChecked: new Set(),
    specsExpanded: false,
    paletteOpen: false,
    paletteQuery: "",
    theme: applyTheme(loadTheme(win?.localStorage)),
    toastMessage: "",
    toastType: "success",
    toastSeq: 0
  });

  // Keep large arrays in shallowRef so Vue never deep-proxies 3,700+ records unnecessarily!
  const rawPayload = shallowRef(null);
  const allRecords = shallowRef([]);
  const plans = shallowRef([]);
  const diagnostics = shallowRef([]);
  const events = shallowRef([]);
  const eventIndex = shallowRef({ byProduct: new Map(), byProvider: new Map() });

  // Per-source lazy-loaded audit cache (`${snapshotId}:${sourceId}` -> SourceAudit)
  const auditCache = new Map();
  const activeAudit = shallowRef(null);
  const auditLoading = ref(false);

  let disposed = false;
  let refreshAbort = null;
  let pendingRefreshPromise = null;
  let auditAbort = null;
  let statsAbort = null;
  let pendingStatsPromise = null;
  let pendingStatsRecord = false;
  let pollTimer = null;
  let clockTimer = null;
  let fxBoundaryTimer = null;
  let toastTimer = null;
  let lastFxExpiredState = null;
  let lastAuditExpiredSnapId = null;

  function syncUrl(replace = true) {
    if (!win?.history) return;
    try {
      const nextHref = serializeUrlState(state, win.location?.href || initialHref);
      if (replace) win.history.replaceState?.(null, "", nextHref);
      else if (typeof win.history.pushState === "function") win.history.pushState(null, "", nextHref);
      else win.history.replaceState?.(null, "", nextHref);
    } catch {
      // ignore history errors in sandboxed/test envs
    }
  }

  function showToast(msg, durationMs = 2400, type = "success") {
    if (disposed) return;
    state.toastMessage = msg;
    state.toastType = type;
    state.toastSeq += 1;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (!disposed) {
        state.toastMessage = "";
        state.toastType = "success";
      }
    }, durationMs);
  }

  function reconcileCompareOpen(planList = plans.value, { sync = true } = {}) {
    if (!state.compareOpen) return;
    const validKeySet = new Set(planList.map((p) => p._key));
    const matchedCount = state.compareKeys.filter((k) => validKeySet.has(k)).length;
    if (matchedCount > 0) return;
    state.compareOpen = false;
    if (sync) syncUrl(true);
  }

  function scheduleFxBoundaryTimer() {
    if (fxBoundaryTimer) {
      clearTimeout(fxBoundaryTimer);
      fxBoundaryTimer = null;
    }
    const payload = rawPayload.value;
    if (!payload?.exchangeRates) return;
    const expiresAt = fxExpiresAtMs(payload.exchangeRates);
    if (!Number.isFinite(expiresAt)) return;
    const remaining = expiresAt - nowMs.value + 50;
    if (remaining > 0 && remaining < 8 * 86_400_000) {
      fxBoundaryTimer = setTimeout(() => {
        if (!disposed) tickClock(Date.now());
      }, remaining);
    }
  }

  function tickClock(nextNow = Date.now()) {
    if (disposed) return;
    nowMs.value = nextNow;
    const payload = rawPayload.value;
    if (!payload) return;
    const fx = fxFreshness(payload.exchangeRates, nextNow);
    // If FX crossed the 7-day boundary while snapshotId stayed unchanged, re-normalize immediately!
    if (lastFxExpiredState !== null && fx.expired !== lastFxExpiredState) {
      lastFxExpiredState = fx.expired;
      const renorm = normalizeSnapshotPayloadSync(payload, nextNow);
      allRecords.value = renorm.allRecords;
      plans.value = renorm.plans;
      diagnostics.value = renorm.diagnostics;
      events.value = renorm.events;
      eventIndex.value = renorm.eventIndex;
    }
  }

  function refreshSnapshot({ force = false } = {}) {
    if (disposed) return Promise.resolve();
    if (!force && pendingRefreshPromise) return pendingRefreshPromise;

    refreshAbort?.abort();
    const ctrl = new AbortController();
    refreshAbort = ctrl;

    const hadSnapshot = state.loadState === "ready" && Boolean(rawPayload.value);
    if (hadSnapshot) state.refreshing = true;
    else state.loadState = "loading";

    const run = (async () => {
      try {
        const requestNowMs = nowMs.value;
        const result = await loadRadarSnapshot({
          endpoint,
          currentSnapshotId: force ? null : state.snapshotId,
          signal: ctrl.signal,
          nowMs: requestNowMs,
          doc,
          locationHref: win?.location?.href || initialHref,
          fetchImpl
        });
        if (disposed || ctrl.signal.aborted) return;

        state.lastFetchAt = Date.now();
        state.errorDetail = null;
        state.protocolMode = result.mode;

        if (result.stats) {
          state.visitStats = result.stats;
          saveSessionVisitStats(result.stats, win?.sessionStorage);
        }

        if (!result.unchanged) {
          const commitNowMs = nowMs.value;
          const fxAtRequest = fxFreshness(result.payload.exchangeRates, requestNowMs);
          const fxAtCommit = fxFreshness(result.payload.exchangeRates, commitNowMs);
          const crossedFxBoundary =
            commitNowMs !== requestNowMs &&
            (fxAtCommit.expired !== fxAtRequest.expired || fxAtCommit.valid !== fxAtRequest.valid);
          const committed = crossedFxBoundary
            ? normalizeSnapshotPayloadSync(result.payload, commitNowMs)
            : result;

          state.snapshotId = result.snapshotId;
          rawPayload.value = result.payload;
          allRecords.value = committed.allRecords;
          plans.value = committed.plans;
          diagnostics.value = committed.diagnostics;
          events.value = committed.events;
          eventIndex.value = committed.eventIndex;
          lastFxExpiredState = fxAtCommit.expired;
          scheduleFxBoundaryTimer();

          // Close CompareModal & sync URL if 0 selected compareKeys match the loaded snapshot, while keeping keys for dock/recovery
          reconcileCompareOpen(committed.plans, { sync: true });
        } else {
          tickClock(nowMs.value);
        }
        state.loadState = "ready";
        state.refreshing = false;

        if (state.inspectId) {
          void loadInspectorAuditForCurrentPlan();
        }
      } catch (err) {
        if (disposed || ctrl.signal.aborted || err?.code === "ABORTED") return;
        state.refreshing = false;
        state.errorDetail = err;
        // Retain last valid snapshot on background refresh failure; only enter error empty-state on initial load failure!
        if (!hadSnapshot) {
          state.loadState = "error";
        }
      } finally {
        if (pendingRefreshPromise === run) {
          pendingRefreshPromise = null;
        }
        if (refreshAbort === ctrl) {
          refreshAbort = null;
        }
      }
    })();

    pendingRefreshPromise = run;
    return run;
  }

  async function loadInspectorAuditForCurrentPlan() {
    auditAbort?.abort();
    activeAudit.value = null;
    state.auditNotice = null;

    if (!state.inspectId || state.loadState !== "ready") return;
    const plan = allRecords.value.find((r) => r.id === state.inspectId);
    if (!plan) return;

    // If v1 payload already embeds full raw.attempts, no shard fetch needed
    if (state.protocolMode === "v1" || !state.snapshotId || state.snapshotId.startsWith("v1_")) {
      activeAudit.value = {
        raw: plan.raw ?? null,
        observations: []
      };
      return;
    }

    const targetSnapId = state.snapshotId;
    const ctrl = new AbortController();
    auditAbort = ctrl;
    auditLoading.value = true;
    try {
      const shard = await fetchSourceAudit({
        snapshotId: targetSnapId,
        sourceId: plan.sourceId,
        signal: ctrl.signal,
        cache: auditCache,
        doc,
        locationHref: win?.location?.href || initialHref,
        fetchImpl
      });
      if (disposed || ctrl.signal.aborted) return;
      const entry =
        shard?.records && Object.hasOwn(shard.records, plan.id)
          ? shard.records[plan.id]
          : null;
      activeAudit.value = entry
        ? { raw: entry.raw ?? plan.raw ?? null, observations: entry.observations ?? [] }
        : { raw: plan.raw ?? null, observations: [] };
    } catch (err) {
      if (disposed || ctrl.signal.aborted || err?.code === "ABORTED") return;
      if (err?.code === "AUDIT_EXPIRED" && lastAuditExpiredSnapId !== targetSnapId) {
        // Coordinated full refresh (at most once per snapshotId): never graft new audit onto old row or loop infinitely!
        lastAuditExpiredSnapId = targetSnapId;
        state.auditNotice = err.message;
        await refreshSnapshot({ force: true });
        return;
      }
      state.auditNotice = err?.message || "审计报文加载失败，当前展示主快照摘要";
    } finally {
      if (auditAbort === ctrl) auditLoading.value = false;
    }
  }

  function refreshVisitStats(record = false) {
    if (disposed || !statsEnabled) return Promise.resolve(null);
    if (pendingStatsPromise && (!record || pendingStatsRecord)) {
      return pendingStatsPromise;
    }
    statsAbort?.abort();
    const ctrl = new AbortController();
    statsAbort = ctrl;
    pendingStatsRecord = Boolean(record);
    const run = fetchVisitStats(statsEndpoint, {
      record,
      signal: ctrl.signal,
      doc,
      locationHref: win?.location?.href || initialHref,
      fetchImpl
    })
      .then((stats) => {
        if (!disposed && !ctrl.signal.aborted && stats) {
          state.visitStats = stats;
          saveSessionVisitStats(stats, win?.sessionStorage);
          if (record) {
            markSessionVisitRecorded(win?.sessionStorage, stats.day);
          }
        }
        return stats;
      })
      .finally(() => {
        if (statsAbort === ctrl) {
          statsAbort = null;
          pendingStatsPromise = null;
          pendingStatsRecord = false;
        }
      });
    pendingStatsPromise = run;
    return run;
  }

  async function syncVisitCounterOnce() {
    if (!statsEnabled) return null;
    const shouldRecordHit = !hasRecordedSessionVisit(win?.sessionStorage, nowMs.value);
    if (!shouldRecordHit && state.visitStats) {
      return refreshVisitStats(false);
    }
    return refreshVisitStats(shouldRecordHit);
  }

  // Computed terminal filtered & sorted plans
  const filteredTerminalPlans = computed(() => {
    const list = plans.value.filter((p) => matchesFilters(p, state.filters, state.savedKeys));
    return sortProducts(list, state.filters.sort);
  });

  const comparedPlans = computed(() => {
    const byKey = new Map(plans.value.map((p) => [p._key, p]));
    return state.compareKeys.map((k) => byKey.get(k)).filter(Boolean);
  });

  // Action mutations
  function setView(view) {
    if (!VALID_VIEWS.includes(view)) return;
    state.view = view;
    if (view !== "terminal") {
      state.mobileRailOpen = false;
    }
    syncUrl(false);
  }

  function setLayout(layout) {
    if (layout !== "table" && layout !== "grid") return;
    state.layout = layout;
    syncUrl(true);
  }

  function updateFilters(patch, { resetPage = true } = {}) {
    Object.assign(state.filters, patch);
    if (resetPage) state.pageLimit = PAGE_STEP;
    syncUrl(true);
  }

  function resetFilters() {
    Object.assign(state.filters, { ...DEFAULT_FILTERS });
    state.pageLimit = PAGE_STEP;
    syncUrl(true);
  }

  function patchRadar(patch) {
    Object.assign(state.radar, patch);
    syncUrl(true);
  }

  function resetRadar() {
    Object.assign(state.radar, { ...DEFAULT_RADAR_FILTERS });
    syncUrl(true);
  }

  function patchProviders(patch) {
    Object.assign(state.providersFilter, patch);
    syncUrl(true);
  }

  function resetProviders() {
    Object.assign(state.providersFilter, { ...DEFAULT_PROVIDER_FILTERS });
    state.providersSort = "recommended";
    syncUrl(true);
  }

  function applyPreset(presetKey) {
    const preset = PRESETS[presetKey];
    if (!preset) return;
    state.view = "terminal";
    Object.assign(state.filters, { ...preset });
    state.pageLimit = PAGE_STEP;
    state.mobileRailOpen = false;
    state.paletteOpen = false;
    syncUrl(false);
  }

  function toggleDealFilter(dealKey) {
    const next = !dealKey || dealKey === "all" || state.filters.deal === dealKey ? "all" : dealKey;
    state.view = "terminal";
    updateFilters({ deal: next });
  }

  function filterByProviderTag(tagKey) {
    state.view = "providers";
    state.mobileRailOpen = false;
    state.providersFilter.tag = state.providersFilter.tag === tagKey ? "all" : tagKey;
    syncUrl(false);
  }

  function closeOverlaysForNavigation() {
    const hadOpenOverlay = Boolean(
      (state.compareOpen && comparedPlans.value.length > 0) ||
        state.inspectId ||
        state.savedDrawerOpen ||
        state.paletteOpen ||
        (state.mobileRailOpen && state.view === "terminal")
    );
    state.compareOpen = false;
    state.inspectId = null;
    state.savedDrawerOpen = false;
    state.paletteOpen = false;
    state.mobileRailOpen = false;
    if (hadOpenOverlay) {
      state.workspaceFocusSeq += 1;
    }
  }

  function drillProvider(providerId, status = "all") {
    state.view = "terminal";
    closeOverlaysForNavigation();
    Object.assign(state.filters, {
      ...DEFAULT_FILTERS,
      provider: providerId,
      status
    });
    state.pageLimit = PAGE_STEP;
    syncUrl(false);
  }

  function toggleSave(key) {
    if (!key) return false;
    const next = new Set(state.savedKeys);
    const added = !next.has(key);
    if (added) next.add(key);
    else next.delete(key);
    state.savedKeys = next;
    saveSaved(next, win?.localStorage);
    showToast(added ? "已加入本地收藏夹" : "已从本地收藏夹移除");
    return added;
  }

  function clearSaved() {
    state.savedKeys = new Set();
    saveSaved(state.savedKeys, win?.localStorage);
    if (state.filters.savedOnly) state.filters.savedOnly = false;
    showToast("已清空本地收藏夹");
    syncUrl(true);
  }

  function toggleCompare(key) {
    if (!key) return { changed: false, reason: "empty" };
    const idx = state.compareKeys.indexOf(key);
    if (idx >= 0) {
      state.compareKeys.splice(idx, 1);
      if (
        state.compareOpen &&
        (state.compareKeys.length === 0 ||
          (state.loadState === "ready" && comparedPlans.value.length === 0))
      ) {
        state.compareOpen = false;
      }
      syncUrl(true);
      return { changed: true, added: false };
    }
    if (state.compareKeys.length >= MAX_COMPARE) {
      showToast(`横向对比最多同时选择 ${MAX_COMPARE} 款套餐`, 2400, "warning");
      return { changed: false, reason: "limit" };
    }
    state.compareKeys.push(key);
    syncUrl(true);
    return { changed: true, added: true };
  }

  function clearCompare() {
    state.compareKeys = [];
    state.compareOpen = false;
    syncUrl(true);
  }

  function setCompareOpen(open) {
    if (!open) {
      state.compareOpen = false;
    } else if (!rawPayload.value && state.loadState !== "ready") {
      state.compareOpen = state.compareKeys.length > 0;
    } else {
      state.compareOpen = comparedPlans.value.length > 0;
    }
    syncUrl(true);
  }

  function toggleCompareDiffOnly() {
    state.compareDiffOnly = !state.compareDiffOnly;
  }

  function openInspector(productId) {
    state.inspectId = productId || null;
    state.inspectSource = "user";
    if (productId) {
      state.inspectActionSeq += 1;
    }
    syncUrl(true);
    if (productId) {
      void loadInspectorAuditForCurrentPlan();
    } else {
      activeAudit.value = null;
      state.auditNotice = null;
    }
  }

  function setSavedDrawerOpen(open) {
    state.savedDrawerOpen = Boolean(open);
  }

  function setMobileRailOpen(open) {
    state.mobileRailOpen = Boolean(open) && state.view === "terminal";
  }

  function setPaletteOpen(open, query = null) {
    state.paletteOpen = Boolean(open);
    if (query !== null) state.paletteQuery = query;
  }

  function setPaletteQuery(query) {
    state.paletteQuery = String(query ?? "");
  }

  function toggleShopsExpanded() {
    state.shopsExpanded = !state.shopsExpanded;
  }

  function setShopQuery(query) {
    state.shopQuery = String(query ?? "");
  }

  function setShopTab(tab) {
    state.shopTab = tab || "all";
  }

  function toggleSpecsExpanded() {
    state.specsExpanded = !state.specsExpanded;
  }

  function setProvidersSort(sort) {
    state.providersSort = sort || "recommended";
  }

  function setGuideRouteTab(tab) {
    state.guideRouteTab = tab || "all";
  }

  function toggleGuideCheck(checkId) {
    if (!checkId) return;
    const next = new Set(state.guideChecked);
    if (next.has(checkId)) next.delete(checkId);
    else next.add(checkId);
    state.guideChecked = next;
  }

  function setVisitStats(stats) {
    if (stats) {
      state.visitStats = stats;
      saveSessionVisitStats(stats, win?.sessionStorage);
    }
  }

  function toggleTheme() {
    state.theme = applyTheme(state.theme === "dark" ? "light" : "dark", win?.localStorage, doc);
  }

  function shareUrl() {
    const href = serializeUrlState(state, win?.location?.href || initialHref);
    syncUrl(true);
    return href;
  }

  async function copyShareUrl() {
    const href = shareUrl();
    try {
      if (win?.navigator?.clipboard?.writeText) {
        await win.navigator.clipboard.writeText(href);
        showToast("已复制带完整状态的分享链接");
      } else if (globalThis.navigator?.clipboard?.writeText) {
        await globalThis.navigator.clipboard.writeText(href);
        showToast("已复制带完整状态的分享链接");
      } else {
        showToast("链接已同步到浏览器地址栏");
      }
    } catch {
      showToast("链接已同步到浏览器地址栏");
    }
    return href;
  }

  // Browser lifecycle listeners
  const onPopState = () => {
    const parsed = parseUrlState(win?.location?.href || initialHref);
    state.view = parsed.view;
    if (parsed.view !== "terminal") {
      state.mobileRailOpen = false;
    }
    state.layout = parsed.layout;
    Object.assign(state.filters, parsed.filters);
    Object.assign(state.radar, parsed.radar);
    Object.assign(state.providersFilter, parsed.providersFilter);
    state.compareKeys = [...parsed.compareKeys];
    state.compareOpen = parsed.compareOpen;
    state.inspectId = parsed.inspectId;
    state.inspectSource = "url";
    if (rawPayload.value && state.loadState === "ready") {
      reconcileCompareOpen(plans.value, { sync: true });
    }
    if (state.inspectId) void loadInspectorAuditForCurrentPlan();
  };

  const onVisibilityChange = () => {
    if (doc?.visibilityState === "visible") {
      tickClock(Date.now());
      if (
        state.lastFetchAt &&
        Date.now() - state.lastFetchAt >= REFRESH_INTERVAL_MS
      ) {
        void refreshSnapshot();
      }
    }
  };

  function startLifecycle() {
    win?.addEventListener?.("popstate", onPopState);
    doc?.addEventListener?.("visibilitychange", onVisibilityChange);

    clockTimer = setInterval(() => {
      tickClock(Date.now());
    }, 30_000);

    pollTimer = setInterval(() => {
      if (!doc || doc.visibilityState !== "hidden") {
        void refreshSnapshot();
        if (statsEnabled) void refreshVisitStats(false);
      }
    }, REFRESH_INTERVAL_MS);

    void refreshSnapshot().finally(() => {
      if (!disposed && statsEnabled) {
        void syncVisitCounterOnce();
      }
    });
  }

  function dispose() {
    disposed = true;
    refreshAbort?.abort();
    auditAbort?.abort();
    statsAbort?.abort();
    if (pollTimer) clearInterval(pollTimer);
    if (clockTimer) clearInterval(clockTimer);
    if (fxBoundaryTimer) clearTimeout(fxBoundaryTimer);
    if (toastTimer) clearTimeout(toastTimer);
    win?.removeEventListener?.("popstate", onPopState);
    doc?.removeEventListener?.("visibilitychange", onVisibilityChange);
  }

  // Provide backward-compatible helper view for programmatic callers/tests
  function getState() {
    return {
      ...state,
      payload: rawPayload.value,
      allRecords: allRecords.value,
      plans: plans.value,
      diagnostics: diagnostics.value,
      events: events.value,
      eventIndex: eventIndex.value
    };
  }

  return {
    state,
    nowMs,
    rawPayload,
    allRecords,
    plans,
    diagnostics,
    events,
    eventIndex,
    activeAudit,
    auditLoading,
    filteredTerminalPlans,
    comparedPlans,
    tickClock,
    refreshSnapshot,
    refreshVisitStats,
    loadInspectorAuditForCurrentPlan,
    setView,
    setLayout,
    updateFilters,
    patchFilters: updateFilters,
    resetFilters,
    patchRadar,
    resetRadar,
    patchProviders,
    resetProviders,
    applyPreset,
    closeOverlaysForNavigation,
    toggleDealFilter,
    filterByProviderTag,
    drillProvider,
    toggleSave,
    toggleSaved: toggleSave,
    clearSaved,
    toggleCompare,
    clearCompare,
    setCompareOpen,
    toggleCompareDiffOnly,
    openInspector,
    setInspectId: openInspector,
    setSavedDrawerOpen,
    setMobileRailOpen,
    setPaletteOpen,
    setPaletteQuery,
    toggleShopsExpanded,
    setShopQuery,
    setShopTab,
    toggleSpecsExpanded,
    setProvidersSort,
    setGuideRouteTab,
    toggleGuideCheck,
    setVisitStats,
    toggleTheme,
    shareUrl,
    copyShareUrl,
    showToast,
    syncUrl,
    startLifecycle,
    dispose,
    getState,
    DEFAULT_RADAR_FILTERS,
    DEFAULT_PROVIDER_FILTERS
  };
}
