export const state = {
  payload: null,
  products: [],
  records: [],
  activeCategory: "all",
  activeSort: "recommend",
  filters: {
    search: "",
    region: "all",
    provider: "all",
    ipType: "all",
    status: "all",
    price: "all",
    currency: "all"
  },
  selected: new Set(),
  expanded: new Set()
};
