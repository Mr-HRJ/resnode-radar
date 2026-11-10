import { state } from "./state.js";
import { text, normalizeSearch } from "./util.js";
import { productCategory, priceBandFor, orderabilityRank, stableCompare } from "./product.js";

export function filterBaseProducts() {
  return state.activeCategory === "all"
    ? state.products
    : state.products.filter((product) => productCategory(product) === state.activeCategory);
}

export function matchesFilters(product) {
  const query = normalizeSearch(state.filters.search).trim();
  if (query && !query.split(/\s+/).every((part) => product._searchText.includes(part))) return false;
  if (state.filters.region !== "all" && product.region !== state.filters.region) return false;
  if (state.filters.provider !== "all" && product.provider !== state.filters.provider) return false;
  if (state.filters.ipType !== "all" && product._ipType.value !== state.filters.ipType) return false;
  if (state.filters.status !== "all" && product.status !== state.filters.status) return false;
  if (state.filters.price !== "all" && priceBandFor(product) !== state.filters.price) return false;
  return true;
}

export function filteredProducts() {
  return filterBaseProducts().filter(matchesFilters);
}

export function visibleProducts() {
  const list = filteredProducts();
  return [...list].sort((a, b) => {
    if (state.activeSort === "region") {
      return text(a.region, "").localeCompare(text(b.region, ""), "zh-CN") || stableCompare(a, b);
    }
    if (state.activeSort === "price") {
      return (a.priceValue ?? 999999) - (b.priceValue ?? 999999) || orderabilityRank(a) - orderabilityRank(b) || stableCompare(a, b);
    }
    if (state.activeSort === "stock") {
      return orderabilityRank(a) - orderabilityRank(b) || (b.stockCount ?? -1) - (a.stockCount ?? -1) || stableCompare(a, b);
    }
    if (state.activeSort === "updated") {
      return text(b.fetchedAt, "").localeCompare(text(a.fetchedAt, "")) || stableCompare(a, b);
    }
    return (
      Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)) ||
      orderabilityRank(a) - orderabilityRank(b) ||
      (a.priceValue ?? 999999) - (b.priceValue ?? 999999) ||
      stableCompare(a, b)
    );
  });
}
