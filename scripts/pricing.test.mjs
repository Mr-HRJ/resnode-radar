import assert from "node:assert/strict";
import { test } from "node:test";
import { priceQuote, monthlyCny } from "../pricing.js";

const now = Date.parse("2026-11-11T12:00:00Z");
const rates = { base: "CNY", date: "2026-11-10", rates: { CNY: 1, USD: 6.7, EUR: 7.5, JPY: 0.04 } };

test("reference CNY monthly price respects annual payment and unknown/configurable quotes", () => {
  assert.equal(monthlyCny({ price: "$24/year", priceValue: 24 }, rates, now), 13.4);
  assert.equal(monthlyCny({ price: "60元/月", priceValue: 60 }, null, now), 60);
  assert.equal(monthlyCny({ price: "JPY 800/月", priceValue: 800 }, rates, now), 32);
  for (const product of [
    { price: "$24", priceValue: 24 }, { price: "$24/year起", priceValue: 24 },
    { price: "$24/year", priceValue: null }, { price: "$24/hour", priceValue: 24 },
    { price: "TWD 24/month", priceValue: 24 }, { price: "$24/month", priceValue: -24 }
  ]) assert.equal(monthlyCny(product, rates, now), null);
});

test("outdated, future, and invalid FX never produces a conversion", () => {
  const plan = { price: "$12/month", priceValue: 12 };
  for (const snapshot of [null, {}, { ...rates, date: "invalid" }, { ...rates, date: "2026-11-01" }, { ...rates, date: "2026-11-13" }, { ...rates, rates: { USD: 0 } }, { ...rates, rates: { USD: Infinity } }, { ...rates, base: "USD" }]) {
    assert.equal(monthlyCny(plan, snapshot, now), null);
  }
});

test("currency and billing conflicts stay uncertain instead of creating a false bargain", () => {
  for (const product of [
    { price: "€12/month", priceValue: 12, currency: "USD" },
    { price: "USD 12 / CNY 80 monthly", priceValue: 12 },
    { price: "HK$12/month", priceValue: 12, currency: "USD" }
  ]) { assert.equal(priceQuote(product).currency, null); assert.equal(monthlyCny(product, rates, now), null); }
  for (const product of [
    { price: "$12/month", priceValue: 12, raw: { billingCycle: "Annual" } },
    { price: "$12 monthly / annual", priceValue: 12 }
  ]) assert.equal(priceQuote(product).monthly, null);
  assert.equal(priceQuote({ price: "$60 semi-annually", priceValue: 60 }).months, 6);
  assert.equal(priceQuote({ price: "$12/month", priceValue: 12, name: "Annual saver" }).months, 1);
  assert.equal(priceQuote({ price: "JPY ¥800/月", priceValue: 800 }).currency, "JPY");
  assert.equal(priceQuote({ price: "HKD $12/month", priceValue: 12 }).currency, "HKD");
});
