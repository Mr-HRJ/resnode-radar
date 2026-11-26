import {
  DEFAULT_FILTERS,
  PLAN_TAG_ORDER,
  SHOP_TAG_ORDER
} from "./catalog.js";

export const VALID_VIEWS = ["terminal", "radar", "providers", "guide"];
export const MAX_COMPARE = 4;
export const PAGE_STEP = 60;
export const THEME_KEY = "resnode-radar:theme:v4";
export const VISIT_SESSION_KEY = "resnode-radar:visit-stats:v1";
export const VISIT_RECORDED_SESSION_KEY = "resnode-radar:visit-recorded:v1";

export const PRESETS = Object.freeze({
  "us-home-dedicated": Object.freeze({
    ...DEFAULT_FILTERS,
    track: "home",
    region: "US",
    noNat: true,
    status: "available"
  }),
  "cn2-opt": Object.freeze({
    ...DEFAULT_FILTERS,
    route: "cn2",
    status: "available"
  }),
  "budget-monthly": Object.freeze({
    ...DEFAULT_FILTERS,
    budget: "0-50",
    maxPrice: "60",
    cycle: "monthly",
    fixedPriceOnly: true,
    status: "available"
  }),
  "exact-stock": Object.freeze({
    ...DEFAULT_FILTERS,
    exactOnly: true,
    status: "available"
  }),
  "deal-blockbuster": Object.freeze({
    ...DEFAULT_FILTERS,
    deal: "blockbuster",
    status: "available"
  }),
  "deal-generous": Object.freeze({
    ...DEFAULT_FILTERS,
    deal: "generous",
    status: "available"
  }),
  "deal-annual": Object.freeze({
    ...DEFAULT_FILTERS,
    deal: "annual",
    status: "available"
  }),
  "deal-home-opt": Object.freeze({
    ...DEFAULT_FILTERS,
    deal: "home-opt",
    status: "available"
  }),
  "deal-scarce": Object.freeze({
    ...DEFAULT_FILTERS,
    deal: "scarce",
    status: "available"
  })
});

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

export function parseUrlState(
  href = globalThis.window?.location?.href || "https://resnode-radar.local/"
) {
  const url = new URL(href, "https://resnode-radar.local/");
  const p = url.searchParams;

  const rawView = p.get("view") || "terminal";
  const view = VALID_VIEWS.includes(rawView) ? rawView : "terminal";

  const trackRaw = p.get("track") || p.get("cat") || "all";
  const track = ["all", "home", "cn-opt", "landing", "vps"].includes(trackRaw) ? trackRaw : "all";

  const statusRaw = p.get("status") || DEFAULT_FILTERS.status;
  const status = ["available", "all", "unavailable", "unknown"].includes(statusRaw)
    ? statusRaw
    : DEFAULT_FILTERS.status;

  const dealRaw = p.get("deal") || "all";
  const deal =
    dealRaw === "all" || dealRaw === "any" || PLAN_TAG_ORDER.includes(dealRaw) ? dealRaw : "all";

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
    type: ["all", "restock", "soldout", "price"].includes(p.get("radarType"))
      ? p.get("radarType")
      : "all",
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

  // NOTE: ?cmp= stores savedKey (_key), whereas ?inspect= stores product.id
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

export function serializeUrlState(
  state,
  baseHref = globalThis.window?.location?.href || "https://resnode-radar.local/"
) {
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

export function loadTheme(storage = globalThis.localStorage) {
  try {
    const saved = storage?.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    // ignore storage errors
  }
  return "light";
}

export function applyTheme(
  theme,
  storage = globalThis.localStorage,
  doc = globalThis.document
) {
  const next = theme === "dark" ? "dark" : "light";
  try {
    doc?.documentElement?.setAttribute("data-theme", next);
    storage?.setItem(THEME_KEY, next);
  } catch {
    // ignore storage errors
  }
  return next;
}

const ALLOWED_ASSET_PREFIXES = ["data/v2/", "data/snapshots/", "data/products.json", "api/"];

/**
 * Resolves a data or API relative path safely against the declared site base
 * (`<meta name="radar-base" content="./">` on root, `"../"` on `/reviews/*.html`),
 * preserving subpath static hosting compatibility while blocking cross-origin or traversal paths.
 */
export function resolveSiteAssetUrl(
  relPath,
  {
    doc = globalThis.document,
    locationHref = globalThis.window?.location?.href || "https://resnode-radar.local/"
  } = {}
) {
  const cleanRel = String(relPath ?? "").replace(/^\/+/, "").trim();
  if (
    !cleanRel ||
    cleanRel.includes("..") ||
    cleanRel.includes("\\") ||
    !ALLOWED_ASSET_PREFIXES.some(
      (prefix) => cleanRel === prefix || cleanRel.startsWith(prefix)
    )
  ) {
    throw new Error(`Disallowed site asset path: ${String(relPath)}`);
  }

  const pageUrl = new URL(locationHref, "https://resnode-radar.local/");
  const metaBase = doc?.querySelector?.('meta[name="radar-base"]')?.getAttribute?.("content") || "./";
  const siteRoot = new URL(metaBase, pageUrl);
  const resolved = new URL(cleanRel, siteRoot);

  if (resolved.origin !== pageUrl.origin || resolved.username || resolved.password) {
    throw new Error("Site asset resolution must remain same-origin");
  }
  return resolved.href;
}
