import assert from "node:assert/strict";
import { test } from "node:test";
import { productRegions, productSearchText } from "../src/domain/format.js";
import { DEFAULT_FILTERS, matchesFilters, normalizeProduct } from "../src/domain/catalog.js";

test("declared region membership supports macro-region, country filters and search without duplicating a grouped plan", () => {
  const raw = {
    id: "evoxt-1",
    sourceId: "evoxt",
    provider: "EVOXT",
    category: "vps",
    name: "VM-0.5 · Premium Network",
    region: "多地区（下单选择）",
    regions: ["香港", "日本"],
    status: "available",
    orderUrl: "https://evoxt.com"
  };
  const product = normalizeProduct(raw, 0, null, new Map());

  assert.equal(matchesFilters(product, { ...DEFAULT_FILTERS, region: "JP", q: "evoxt 日本" }, new Set()), true);
  assert.equal(matchesFilters(product, { ...DEFAULT_FILTERS, region: "日本", q: "evoxt 日本" }, new Set()), true);
  assert.equal(matchesFilters(product, { ...DEFAULT_FILTERS, region: "HK", q: "香港" }, new Set()), true);
  assert.equal(matchesFilters(product, { ...DEFAULT_FILTERS, region: "US" }, new Set()), false);
  assert.equal(matchesFilters(product, { ...DEFAULT_FILTERS, region: "MULTI" }, new Set()), true);
  assert.equal(matchesFilters(product, { ...DEFAULT_FILTERS, region: "多地区（下单选择）" }, new Set()), true);
  assert.deepEqual(productRegions(raw), ["多地区（下单选择）", "香港", "日本"]);
});

test("region options count each declared membership once and exclude unrelated evidence", () => {
  const product = { region: "日本", regions: [" 日本 ", "香港", null, {}, "", "香港"], raw: { response: "德国" }, note: "法国" };
  assert.deepEqual(productRegions(product), ["日本", "香港"]);
  assert.doesNotMatch(productSearchText(product), /德国|法国/);
  assert.deepEqual(productRegions({ region: "荷兰", regions: "日本" }), ["荷兰"]);
  assert.deepEqual(productRegions(null), []);
});
