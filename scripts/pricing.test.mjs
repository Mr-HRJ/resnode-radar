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

test("BERO HOST keeps its VAT-inclusive 30-day quote without a monthly equivalent", () => {
  const product = { price: "EUR 20.9 / 30 days (incl. VAT)", priceValue: 20.9, currency: "EUR", raw: { billingCycle: "30 Tage", billingDays: 30 } };
  assert.deepEqual(priceQuote(product), { currency: "EUR", amount: 20.9, months: null, period: "30天", baseOnly: false, monthly: null });
  assert.equal(monthlyCny(product, rates, now), null);
  assert.equal(product.price, "EUR 20.9 / 30 days (incl. VAT)");
});

test("explicit day-count terms work in the quote and raw billing fields", () => {
  for (const fields of [
    { price: "EUR 20.9 / 30 days" }, { price: "EUR 20.9 /30天" },
    { raw: { billingCycle: "30 Tage" } }, { raw: { billingDays: 30 } },
    { raw: { billingCycle: "30 days", billingDays: 30 } }
  ]) {
    const product = { price: "EUR 20.9", priceValue: 20.9, ...fields };
    assert.equal(priceQuote(product).period, "30天");
    assert.equal(priceQuote(product).months, null);
    assert.equal(monthlyCny(product, rates, now), null);
  }
});

test("ordinary daily, hourly, and one-time quotes retain their periods", () => {
  for (const [label, period] of [["/day", "天"], ["daily", "天"], ["每天", "天"], ["/天", "天"], ["/hour", "小时"], ["/小时", "小时"], ["one-time", "一次性"]]) {
    const quote = priceQuote({ price: `$2 ${label}`, priceValue: 2 });
    assert.equal(quote.period, period);
    assert.equal(quote.months, null);
    assert.equal(quote.monthly, null);
  }
  assert.equal(priceQuote({ price: "$2/day", priceValue: 2, raw: { billingCycle: "1 day", billingDays: 1 } }).period, "天");
});

test("conflicting day counts and calendar terms remain uncertain", () => {
  for (const fields of [
    { price: "EUR 20.9 / 30 days", raw: { billingCycle: "Annual" } },
    { price: "EUR 20.9/year", raw: { billingCycle: "30 Tage", billingDays: 30 } },
    { price: "EUR 20.9/month", raw: { billingDays: 30 } },
    { price: "EUR 20.9/year", raw: { billingCycle: "Annual", billingDays: 30 } },
    { price: "EUR 20.9 / 30 days", raw: { billingDays: 31 } },
    { price: "EUR 20.9", raw: { billingCycle: "30 Tage", billingDays: 31 } },
    { price: "EUR 20.9 / 30 days / year" }
  ]) {
    const product = { priceValue: 20.9, ...fields };
    assert.equal(priceQuote(product).period, "周期待核对");
    assert.equal(priceQuote(product).months, null);
    assert.equal(monthlyCny(product, rates, now), null);
  }
});

test("malformed billingDays cannot replace a quoted monthly or annual term", () => {
  for (const billingDays of [undefined, null, 0, -30, 1.5, NaN, Infinity, 1000000, "30", "30 days", true, {}, []]) {
    for (const [term, months, period] of [["month", 1, "月"], ["year", 12, "年"]]) {
      const quote = priceQuote({ price: `$120/${term}`, priceValue: 120, raw: { billingDays } });
      assert.equal(quote.period, period);
      assert.equal(quote.months, months);
      assert.equal(quote.monthly, 120 / months);
    }
    assert.equal(priceQuote({ price: "$120", priceValue: 120, raw: { billingDays } }).period, "周期未注明");
  }
});

test("invalid quoted day counts do not become plausible durations", () => {
  for (const duration of ["0", "-30", "1.5", "1,030", "1e3", "Infinity", "1000000"]) {
    const quote = priceQuote({ price: `EUR 20.9 / ${duration} days`, priceValue: 20.9, raw: { billingCycle: `${duration} Tage` } });
    assert.equal(quote.period, "周期未注明");
    assert.equal(quote.monthly, null);
  }
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
