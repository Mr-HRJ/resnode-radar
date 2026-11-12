import assert from "node:assert/strict";
import { test } from "node:test";
import { productRegions, productSearchText } from "../discovery.js";
import { matchesFilters } from "../filter.js";
import { state } from "../state.js";

test("declared region membership supports country filters and search without duplicating a grouped plan", (t) => {
  const original = state.filters;
  t.after(() => { state.filters = original; });
  const product = { provider: "EVOXT", name: "VM-0.5 · Premium Network", region: "多地区（下单选择）", regions: ["香港", "日本"] };
  product._searchText = productSearchText(product);
  state.filters = { ...original, region: "日本", search: "evoxt 日本" };
  assert.equal(matchesFilters(product), true);
  state.filters = { ...original, region: "香港", search: "香港" };
  assert.equal(matchesFilters(product), true);
  state.filters = { ...original, region: "美国" };
  assert.equal(matchesFilters(product), false);
  state.filters = { ...original, region: "多地区（下单选择）" };
  assert.equal(matchesFilters(product), true);
  assert.deepEqual(productRegions(product), ["多地区（下单选择）", "香港", "日本"]);
});

test("region options count each declared membership once and exclude unrelated evidence", () => {
  const product = { region: "日本", regions: [" 日本 ", "香港", null, {}, "", "香港"], raw: { response: "德国" }, note: "法国" };
  assert.deepEqual(productRegions(product), ["日本", "香港"]);
  assert.doesNotMatch(productSearchText(product), /德国|法国/);
  assert.deepEqual(productRegions({ region: "荷兰", regions: "日本" }), ["荷兰"]);
  assert.deepEqual(productRegions(null), []);
});
