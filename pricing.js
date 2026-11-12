// Preserve the original quote. Exchange-rate estimates never replace the bill.
const currencies = ["USD", "CNY", "EUR", "GBP", "JPY", "HKD", "CAD", "AUD", "TWD", "SGD", "KRW"];
const periods = [
  [/小时|hour/i, null, "小时"], [/一次性|onetime|one[- ]time/i, null, "一次性"],
  [/每日|每天|\/\s*天|\/\s*day|daily/i, null, "天"],
  [/三年|triennial/i, 36, "三年"], [/两年|兩年|二年|biennial/i, 24, "两年"],
  [/半年|semi[-_ ]?annual/i, 6, "半年"], [/季度|季付|季缴|季繳|quarterly|每季|\/\s*季/i, 3, "季"],
  [/annual|year|\/\s*yr\b|\/\s*年|年付|年缴|年繳|每年/i, 12, "年"],
  [/month|\/\s*mo\b|\/\s*月|月付|月缴|月繳|每月|月額/i, 1, "月"]
];
function dayBillingPeriod(days) {
  // Bound day counts to roughly ten years; they never imply calendar months.
  return Number.isInteger(days) && days > 0 && days <= 3660 ? [null, days === 1 ? "天" : `${days}天`] : null;
}
function billingPeriod(value, billingDays) {
  const rawDays = dayBillingPeriod(billingDays);
  const found = rawDays ? [rawDays] : [];
  let remaining = value.replace(/(?:^|[^\w.,+−-])(\d+)\s*(?:days?\b|Tage?\b|天)/gi, (match, days) => {
    const period = dayBillingPeriod(Number(days));
    if (period) found.push(period);
    return "";
  });
  for (const [pattern, months, period] of periods) {
    if (pattern.test(remaining)) { found.push([months, period]); remaining = remaining.replace(new RegExp(pattern.source, "gi"), ""); }
  }
  if (new Set(found.map(([, period]) => period)).size > 1) return [null, "周期待核对"];
  return found[0] || [null, "周期未注明"];
}
export function priceQuote(product) {
  const label = String(product.price ?? "");
  const codes = [...label.matchAll(/\b(USD|CNY|EUR|GBP|CAD|AUD|HKD|JPY|TWD|SGD|KRW)\b/gi)].map((match) => match[1].toUpperCase());
  const field = typeof product.currency === "string" ? product.currency.toUpperCase() : null;
  let currency = field || codes[0] || (/NT\$/.test(label) ? "TWD" : /HK\$/.test(label) ? "HKD" : /(?:CA|C)\$/.test(label) ? "CAD" : /A\$/.test(label) ? "AUD" : /€/.test(label) ? "EUR" : /£/.test(label) ? "GBP" : /[¥￥]|元|RMB/.test(label) ? "CNY" : /\$/.test(label) ? "USD" : null);
  const symbolCurrency = /NT\$/.test(label) ? "TWD" : /HK\$/.test(label) ? "HKD" : /(?:CA|C)\$/.test(label) ? "CAD" : /A\$/.test(label) ? "AUD" : /US\$/.test(label) ? "USD" : /€/.test(label) ? "EUR" : /£/.test(label) ? "GBP" : null;
  if (codes.some((code) => code !== currency) || (symbolCurrency && symbolCurrency !== currency)) currency = null;
  const amount = Number.isFinite(product.priceValue) && product.priceValue >= 0 ? product.priceValue : null;
  const labelPeriod = billingPeriod(label), rawPeriod = billingPeriod(String(product.raw?.billingCycle ?? ""), product.raw?.billingDays);
  let [months, period] = labelPeriod[1] === "周期未注明" ? rawPeriod : labelPeriod;
  if (labelPeriod[1] !== "周期未注明" && rawPeriod[1] !== "周期未注明" && labelPeriod[1] !== rawPeriod[1]) [months, period] = [null, "周期待核对"];
  if (period === "周期未注明") [months, period] = billingPeriod(String(product.name ?? ""));
  const baseOnly = /起|\bfrom\b|starting|基础价/i.test(label) || Boolean(product.raw?.configurable);
  return { currency, amount, months, period, baseOnly, monthly: amount !== null && months && !baseOnly ? amount / months : null };
}
export function comparePrices(a, b) {
  const x = priceQuote(a), y = priceQuote(b);
  const rank = (q) => currencies.includes(q.currency) ? currencies.indexOf(q.currency) : 99;
  return rank(x) - rank(y) || (x.monthly ?? Infinity) - (y.monthly ?? Infinity) || (x.amount ?? Infinity) - (y.amount ?? Infinity);
}
export function monthlyCny(product, snapshot, now = Date.now()) {
  const quote = priceQuote(product);
  if (quote.monthly === null || !quote.currency) return null;
  if (quote.currency === "CNY") return quote.monthly;
  const date = Date.parse(`${snapshot?.date}T00:00:00Z`);
  const age = now - date;
  const rate = snapshot?.rates?.[quote.currency];
  if (snapshot?.base !== "CNY" || !Number.isFinite(age) || age < -86400000 || age > 7 * 86400000 || !Number.isFinite(rate) || rate <= 0) return null;
  return quote.monthly * rate;
}
