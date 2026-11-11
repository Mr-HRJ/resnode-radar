export const state = {
  payload: null,
  products: [],
  records: [],
  activeCategory: "all",
  activeSort: "recommend",
  savedOnly: false,
  saved: new Set(),
  filters: {
    search: "",
    region: "all",
    provider: "all",
    ipType: "all",
    status: "all",
    price: "all",
    currency: "all",
    route: "all",
    billing: "all"
  },
  selected: new Set(),
  expanded: new Set()
};
