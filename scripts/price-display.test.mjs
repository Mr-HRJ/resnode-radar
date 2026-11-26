import assert from "node:assert/strict";
import { test } from "node:test";
import { describePricing, formatPriceLabel } from "@resnode-radar/contracts";

test("price labels standardize symbols and actual billing periods without changing amounts", () => {
  for (const [price, priceValue, expected] of [
    ["USD 39 Annually", 39, "$39/年"],
    ["USD 6/月", 6, "$6/月"],
    ["399.00元/每年", 399, "￥399/年"],
    ["$25.00 USD Annually", 25, "$25/年"],
    ["$36.00 Monthly", 36, "$36/月"],
    ["USD 72 / Annually", 72, "$72/年"],
    ["¥34.80 CNY/月缴", 34.8, "￥34.8/月"],
    ["￥198.00 / 年", 198, "￥198/年"],
    ["USD 29.9/月", 29.9, "$29.9/月"],
    ["$49.99 / Quarterly", 49.99, "$49.99/季度"],
    ["CNY 60 / 季付", 60, "￥60/季度"],
    ["$60 semi-annually", 60, "$60/半年"],
    ["$120 biennially", 120, "$120/两年"],
    ["$0 Monthly", 0, "$0/月"]
  ]) {
    const product = { price, priceValue };
    assert.equal(formatPriceLabel(product), expected, price);
    assert.deepEqual(product, { price, priceValue });
  }
});

test("other currencies and non-monthly terms remain distinct, including small hourly amounts", () => {
  for (const [price, priceValue, currency, expected] of [
    ["HKD $12/month", 12, "HKD", "HK$12/月"],
    ["JPY ¥800/月", 800, "JPY", "JP¥800/月"],
    ["CAD 9/month", 9, "CAD", "CA$9/月"],
    ["EUR 20.9 / 30 days (incl. VAT)", 20.9, "EUR", "€20.9/30天"],
    ["USD 0.000024 / hour", 0.000024, "USD", "$0.000024/小时"],
    ["USD 10 one-time", 10, "USD", "$10/一次性"],
    ["USD 9.99/月起", 9.99, "USD", "$9.99/月起"]
  ]) assert.equal(formatPriceLabel({ price, priceValue, currency }), expected);
});

test("uncertain amounts, currencies and periods keep the original quote", () => {
  for (const product of [
    { price: "$24", priceValue: 24 },
    { price: "$24/year", priceValue: null },
    { price: "€12/month", priceValue: 12, currency: "USD" },
    { price: "$12/month", priceValue: 12, raw: { billingCycle: "Annual" } },
    { price: "12 / month", priceValue: 12 },
    { price: "USD 12 / CNY 80 monthly", priceValue: 12 }
  ]) assert.equal(formatPriceLabel(product), product.price);
  assert.equal(formatPriceLabel(null), "未公开报价");
});

test("normalized bill and original evidence stay separate from monthly FX estimates", () => {
  const now = Date.parse("2026-11-22T06:00:00Z");
  const rates = { base: "CNY", date: "2026-11-20", rates: { CNY: 1, USD: 7 } };
  const product = { price: "USD 72 / Annually", priceValue: 72, currency: "USD" };
  const annual = describePricing(product, rates, now);
  assert.equal(annual.displayLabel, "$72/年");
  assert.equal(annual.originalLabel, product.price);
  assert.equal(annual.cnyMonthly, 42);
  assert.equal(annual.cnyLabel, "≈ ￥42.0/月");
  const stale = describePricing(product, { ...rates, date: "2026-01-01" }, now);
  assert.equal(stale.displayLabel, "$72/年");
  assert.equal(stale.cnyMonthly, null);
  const base = describePricing({ price: "$72/year起", priceValue: 72 }, rates, now);
  assert.equal(base.displayLabel, "$72/年起");
  assert.equal(base.cnyMonthly, null);
});
