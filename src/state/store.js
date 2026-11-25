import { loadSaved, saveSaved } from "../../saved.js";
import { DEFAULT_FILTERS, PLAN_TAG_ORDER, SHOP_TAG_ORDER } from "../domain/catalog.js";
import { isValidVisitStats, visitStatsDay } from "../services/visits.js";

export const VALID_VIEWS = ["terminal", "radar", "providers", "guide"];
export const MAX_COMPARE = 4;
export const PAGE_STEP = 60;
const THEME_KEY = "resnode-radar:theme:v4";
const VISIT_SESSION_KEY = "resnode-radar:visit-stats:v1";

function loadSessionVisitStats() {
  try {
    const raw = globalThis.sessionStorage?.getItem(VISIT_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (isValidVisitStats(parsed) && parsed.day === visitStatsDay()) {
      return parsed;
    }
  } catch {
    // ignore storage errors
  }
  return null;
}

function saveSessionVisitStats(stats) {
  try {
    globalThis.sessionStorage?.setItem(VISIT_SESSION_KEY, JSON.stringify(stats));
  } catch {
    // ignore storage errors
  }
}

export const DEFAULT_RADAR_FILTERS = Object.freeze({
  type: "all",
  window: "7d",
  region: "all",
  savedOnly: false,
  q: ""
});

export const DEFAULT_PROVIDER_FILTERS = Object.freeze({
  q: "",
  region: "all",
  feature: "all",
  tag: "all",
  health: "all"
});

export function parseUrlState(href = globalThis.window?.location?.href || "https://resnode-radar.local/") {
  const url = new URL(href, "https://resnode-radar.local/");
  const p = url.searchParams;

  const rawView = p.get("view") || "terminal";
  const view = VALID_VIEWS.includes(rawView) ? rawView : "terminal";

  const trackRaw = p.get("track") || p.get("cat") || "all";
  const track = ["all", "home", "cn-opt", "landing", "vps"].includes(trackRaw) ? trackRaw : "all";

  const statusRaw = p.get("status") || DEFAULT_FILTERS.status;
  const status = ["available", "all", "unavailable", "unknown"].includes(statusRaw) ? statusRaw : DEFAULT_FILTERS.status;

  const dealRaw = p.get("deal") || "all";
  const deal = dealRaw === "all" || dealRaw === "any" || PLAN_TAG_ORDER.includes(dealRaw) ? dealRaw : "all";

  const filters = {
    track,
    opt: p.get("opt") || "all",
    deal,
    status,
    exactOnly: p.get("exact") === "1",
    noNat: p.get("noNat") === "1",
    noSnapshot: p.get("noSnap") === "1",
    fixedPriceOnly: p.get("fixedPrice") === "1",
    savedOnly: p.get("saved") === "1",
    region: p.get("region") || "all",
    route: p.get("route") || "all",
    cpu: p.get("cpu") || "all",
    memory: p.get("mem") || "all",
    disk: p.get("disk") || "all",
    bandwidth: p.get("bw") || "all",
    traffic: p.get("traffic") || "all",
    budget: p.get("budget") || "all",
    minPrice: p.get("minP") || "",
    maxPrice: p.get("maxP") || "",
    cycle: p.get("cycle") || "all",
    provider: p.get("provider") || "all",
    q: p.get("q") || "",
    sort: p.get("sort") || DEFAULT_FILTERS.sort
  };

  const layout = p.get("layout") === "grid" ? "grid" : "table";

  const radar = {
    type: ["all", "restock", "soldout", "price"].includes(p.get("radarType")) ? p.get("radarType") : "all",
    window: ["24h", "72h", "7d"].includes(p.get("radarWin")) ? p.get("radarWin") : "7d",
    region: p.get("radarRegion") || "all",
    savedOnly: p.get("radarSaved") === "1",
    q: p.get("radarQ") || ""
  };

  const provTagRaw = p.get("provTag") || "all";
  const providersFilter = {
    q: p.get("provQ") || "",
    region: p.get("provRegion") || "all",
    feature: p.get("provFeature") || "all",
    tag: provTagRaw === "all" || SHOP_TAG_ORDER.includes(provTagRaw) ? provTagRaw : "all",
    health: p.get("provHealth") || "all"
  };

  const compareKeys = [...new Set(p.getAll("cmp").filter(Boolean))].slice(0, MAX_COMPARE);
  const compareOpen = p.get("compareOpen") === "1" && compareKeys.length > 0;
  const inspectId = p.get("inspect") || null;

  return {
    view,
    layout,
    filters,
    radar,
    providersFilter,
    compareKeys,
    compareOpen,
    inspectId
  };
}

export function serializeUrlState(state, baseHref = globalThis.window?.location?.href || "https://resnode-radar.local/") {
  const url = new URL(baseHref, "https://resnode-radar.local/");
  url.search = "";
  const p = url.searchParams;

  if (state.view && state.view !== "terminal") p.set("view", state.view);
  if (state.layout === "grid") p.set("layout", "grid");

  const f = state.filters || DEFAULT_FILTERS;
  if (f.track !== DEFAULT_FILTERS.track) p.set("track", f.track);
  if (f.opt && f.opt !== "all") p.set("opt", f.opt);
  if (f.deal && f.deal !== "all") p.set("deal", f.deal);
  if (f.status !== DEFAULT_FILTERS.status) p.set("status", f.status);
  if (f.exactOnly) p.set("exact", "1");
  if (f.noNat) p.set("noNat", "1");
  if (f.noSnapshot) p.set("noSnap", "1");
  if (f.fixedPriceOnly) p.set("fixedPrice", "1");
  if (f.savedOnly) p.set("saved", "1");
  if (f.region !== "all") p.set("region", f.region);
  if (f.route !== "all") p.set("route", f.route);
  if (f.cpu && f.cpu !== "all") p.set("cpu", f.cpu);
  if (f.memory && f.memory !== "all") p.set("mem", f.memory);
  if (f.disk && f.disk !== "all") p.set("disk", f.disk);
  if (f.bandwidth && f.bandwidth !== "all") p.set("bw", f.bandwidth);
  if (f.traffic && f.traffic !== "all") p.set("traffic", f.traffic);
  if (f.budget !== "all") p.set("budget", f.budget);
  if (f.minPrice && String(f.minPrice).trim()) p.set("minP", String(f.minPrice).trim());
  if (f.maxPrice && String(f.maxPrice).trim()) p.set("maxP", String(f.maxPrice).trim());
  if (f.cycle !== "all") p.set("cycle", f.cycle);
  if (f.provider !== "all") p.set("provider", f.provider);
  if (f.q && f.q.trim()) p.set("q", f.q.trim());
  if (f.sort && f.sort !== DEFAULT_FILTERS.sort) p.set("sort", f.sort);

  const r = state.radar || DEFAULT_RADAR_FILTERS;
  if (r.type !== "all") p.set("radarType", r.type);
  if (r.window !== "7d") p.set("radarWin", r.window);
  if (r.region !== "all") p.set("radarRegion", r.region);
  if (r.savedOnly) p.set("radarSaved", "1");
  if (r.q && r.q.trim()) p.set("radarQ", r.q.trim());

  const pv = state.providersFilter || DEFAULT_PROVIDER_FILTERS;
  if (pv.q && pv.q.trim()) p.set("provQ", pv.q.trim());
  if (pv.region !== "all") p.set("provRegion", pv.region);
  if (pv.feature !== "all") p.set("provFeature", pv.feature);
  if (pv.tag && pv.tag !== "all") p.set("provTag", pv.tag);
  if (pv.health !== "all") p.set("provHealth", pv.health);

  for (const key of (state.compareKeys || []).slice(0, MAX_COMPARE)) {
    p.append("cmp", key);
  }
  if (state.compareOpen && (state.compareKeys || []).length > 0) {
    p.set("compareOpen", "1");
  }
  if (state.inspectId) {
    p.set("inspect", state.inspectId);
  }

  return url.href;
}

export function loadTheme() {
  try {
    const saved = globalThis.localStorage?.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    // ignore storage errors
  }
  return "light";
}

export function applyTheme(theme) {
  const next = theme === "dark" ? "dark" : "light";
  try {
    globalThis.document?.documentElement?.setAttribute("data-theme", next);
    globalThis.localStorage?.setItem(THEME_KEY, next);
  } catch {
    // ignore
  }
  return next;
}

export function createStore(initialUrl) {
  const fromUrl = parseUrlState(initialUrl);
  const listeners = new Set();

  const state = {
    // Snapshot data lifecycle
    loadState: "loading", // "loading" | "ready" | "error"
    refreshing: false,
    errorDetail: null,
    payload: null,
    allRecords: [],
    plans: [],
    diagnostics: [],
    events: [],
    eventIndex: { byProduct: new Map(), byProvider: new Map() },
    lastFetchAt: null,
    visitStats: loadSessionVisitStats(),

    // View & filter state
    view: fromUrl.view,
    layout: fromUrl.layout,
    filters: { ...fromUrl.filters },
    radar: { ...fromUrl.radar },
    providersFilter: { ...fromUrl.providersFilter },
    pageLimit: PAGE_STEP,

    // Interactive overlays & tools
    savedKeys: loadSaved(),
    compareKeys: [...fromUrl.compareKeys],
    compareOpen: fromUrl.compareOpen,
    compareDiffOnly: false,
    inspectId: fromUrl.inspectId,
    savedDrawerOpen: false,
    mobileRailOpen: false,
    shopsExpanded: false,
    shopQuery: "",
    shopTab: "all",
    providersSort: "recommended",
    guideRouteTab: "all",
    guideChecked: new Set(),
    specsExpanded: true,
    paletteOpen: false,
    paletteQuery: "",
    theme: loadTheme()
  };

  function syncUrl() {
    try {
      const nextHref = serializeUrlState(state, globalThis.window?.location?.href);
      globalThis.window?.history?.replaceState?.(null, "", nextHref);
    } catch {
      // ignore history errors in restricted contexts
    }
  }

  function notify(options = { syncUrl: false }) {
    if (options.syncUrl) syncUrl();
    for (const fn of listeners) fn(state);
  }

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setSnapshotLoading(isInitial) {
      if (isInitial) {
        state.loadState = "loading";
        state.errorDetail = null;
      } else {
        state.refreshing = true;
      }
      notify();
    },
    setVisitStats(visitStats) {
      if (!visitStats) return;
      const prev = state.visitStats;
      if (
        prev &&
        prev.day === visitStats.day &&
        prev.todayPv === visitStats.todayPv &&
        prev.todayUv === visitStats.todayUv &&
        prev.totalPv === visitStats.totalPv &&
        prev.totalUv === visitStats.totalUv
      ) {
        return;
      }
      state.visitStats = visitStats;
      saveSessionVisitStats(visitStats);
      notify();
    },
    setSnapshotReady({ payload, allRecords, plans, diagnostics, events, eventIndex }) {
      state.loadState = "ready";
      state.refreshing = false;
      state.errorDetail = null;
      state.payload = payload;
      state.allRecords = allRecords;
      state.plans = plans;
      state.diagnostics = diagnostics;
      state.events = events;
      state.eventIndex = eventIndex;
      state.lastFetchAt = Date.now();
      const keys = new Set(plans.map((plan) => plan._key));
      const previousCount = state.compareKeys.length;
      state.compareKeys = state.compareKeys.filter((key) => keys.has(key));
      if (state.compareKeys.length === 0) state.compareOpen = false;
      notify({ syncUrl: state.compareKeys.length !== previousCount });
    },
    setSnapshotError(errorDetail) {
      state.refreshing = false;
      state.errorDetail = errorDetail;
      if (!state.payload) {
        state.loadState = "error";
      }
      notify();
    },
    setView(view) {
      if (!VALID_VIEWS.includes(view)) return;
      state.view = view;
      state.mobileRailOpen = false;
      notify({ syncUrl: true });
    },
    setLayout(layout) {
      state.layout = layout === "grid" ? "grid" : "table";
      notify({ syncUrl: true });
    },
    patchFilters(patch, { resetPage = true } = {}) {
      state.filters = { ...state.filters, ...patch };
      if (resetPage) state.pageLimit = PAGE_STEP;
      notify({ syncUrl: true });
    },
    resetFilters() {
      state.filters = { ...DEFAULT_FILTERS };
      state.pageLimit = PAGE_STEP;
      notify({ syncUrl: true });
    },
    loadMore(all = false) {
      state.pageLimit = all ? Math.max(state.plans.length, PAGE_STEP) : state.pageLimit + PAGE_STEP;
      notify();
    },
    patchRadar(patch) {
      state.radar = { ...state.radar, ...patch };
      notify({ syncUrl: true });
    },
    resetRadar() {
      state.radar = { ...DEFAULT_RADAR_FILTERS };
      notify({ syncUrl: true });
    },
    patchProviders(patch) {
      state.providersFilter = { ...state.providersFilter, ...patch };
      notify({ syncUrl: true });
    },
    resetProviders() {
      state.providersFilter = { ...DEFAULT_PROVIDER_FILTERS };
      state.providersSort = "recommended";
      notify({ syncUrl: true });
    },
    setProvidersSort(sort) {
      state.providersSort = sort || "recommended";
      notify();
    },
    toggleSaved(key) {
      if (!key) return false;
      const next = new Set(state.savedKeys);
      let added = false;
      if (next.has(key)) next.delete(key);
      else {
        next.add(key);
        added = true;
      }
      state.savedKeys = next;
      saveSaved(next);
      notify();
      return added;
    },
    clearSaved() {
      state.savedKeys = new Set();
      saveSaved(state.savedKeys);
      if (state.filters.savedOnly) {
        state.filters = { ...state.filters, savedOnly: false };
      }
      notify({ syncUrl: true });
    },
    toggleCompare(key) {
      if (!key) return { changed: false, reason: "invalid" };
      const idx = state.compareKeys.indexOf(key);
      if (idx >= 0) {
        state.compareKeys = state.compareKeys.filter((k) => k !== key);
        if (state.compareKeys.length === 0) state.compareOpen = false;
        notify({ syncUrl: true });
        return { changed: true, added: false };
      }
      if (state.compareKeys.length >= MAX_COMPARE) {
        return { changed: false, reason: "limit" };
      }
      state.compareKeys = [...state.compareKeys, key];
      notify({ syncUrl: true });
      return { changed: true, added: true };
    },
    clearCompare() {
      state.compareKeys = [];
      state.compareOpen = false;
      notify({ syncUrl: true });
    },
    setCompareOpen(open) {
      state.compareOpen = Boolean(open) && state.compareKeys.length > 0;
      notify({ syncUrl: true });
    },
    toggleCompareDiffOnly() {
      state.compareDiffOnly = !state.compareDiffOnly;
      notify();
    },
    setInspectId(id) {
      state.inspectId = id || null;
      notify({ syncUrl: true });
    },
    setSavedDrawerOpen(open) {
      state.savedDrawerOpen = Boolean(open);
      notify();
    },
    setMobileRailOpen(open) {
      state.mobileRailOpen = Boolean(open);
      notify();
    },
    toggleShopsExpanded() {
      state.shopsExpanded = !state.shopsExpanded;
      if (!state.shopsExpanded) {
        state.shopQuery = "";
        state.shopTab = "all";
      }
      notify();
    },
    setShopQuery(query) {
      state.shopQuery = query;
      notify();
    },
    setShopTab(tab) {
      state.shopTab = tab || "all";
      notify();
    },
    setGuideRouteTab(tab) {
      state.guideRouteTab = tab || "all";
      notify();
    },
    toggleGuideCheck(id) {
      if (!id) return;
      const next = new Set(state.guideChecked);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      state.guideChecked = next;
      notify();
    },
    toggleSpecsExpanded() {
      state.specsExpanded = !state.specsExpanded;
      notify();
    },
    setPaletteOpen(open, initialQuery) {
      state.paletteOpen = Boolean(open);
      if (initialQuery !== undefined) state.paletteQuery = initialQuery;
      notify();
    },
    setPaletteQuery(q) {
      state.paletteQuery = q;
      notify();
    },
    toggleTheme() {
      state.theme = applyTheme(state.theme === "dark" ? "light" : "dark");
      notify();
      return state.theme;
    },
    shareUrl() {
      return serializeUrlState(state, globalThis.window?.location?.href);
    }
  };
}
