// No exchange-rate assumptions: prices are compared within their original currency.
export function priceQuote(product) {
  const label = String(product.price ?? "");
  const explicit = label.match(/\b(USD|CNY|EUR|GBP|CAD|AUD|HKD|JPY|TWD)\b/i)?.[1]?.toUpperCase();
  const currency = product.currency || explicit || (/HK\$/.test(label) ? "HKD" : /(?:CA|C)\$/.test(label) ? "CAD" : /A\$/.test(label) ? "AUD" : /€/.test(label) ? "EUR" : /£/.test(label) ? "GBP" : /[¥￥]/.test(label) ? "CNY" : /\$/.test(label) ? "USD" : null);
  const amount = Number.isFinite(product.priceValue) ? product.priceValue : null;
  const cycle = `${label} ${product.raw?.billingCycle ?? ""} ${product.name ?? ""}`;
  let months = null;
  let period = "周期未注明";
  for (const [pattern, length, title] of [
    [/三年|triennial/i, 36, "三年"], [/两年|兩年|biennial/i, 24, "两年"], [/半年|semi[-_ ]?annual/i, 6, "半年"],
    [/季度|季付|季缴|季繳|quarterly|\/\s*季/i, 3, "季"], [/annual|year|\/\s*yr\b|\/\s*年|年付|年缴|年繳|每年/i, 12, "年"],
    [/month|\/\s*mo\b|\/\s*月|月付|月缴|月繳|每月|月額/i, 1, "月"]
  ]) { if (pattern.test(cycle)) { months = length; period = title; break; } }
  if (/小时|hour/i.test(label)) { months = null; period = "小时"; }
  if (/一次性|onetime|one[- ]time/i.test(label)) { months = null; period = "一次性"; }
  const baseOnly = /起|from|starting|基础价/i.test(label) || Boolean(product.raw?.configurable);
  return { currency, amount, months, period, baseOnly, monthly: amount !== null && months && !baseOnly ? amount / months : null };
}

export function comparePrices(a, b) {
  const x = priceQuote(a), y = priceQuote(b);
  const rank = (q) => q.currency ? ["USD", "CNY", "EUR", "GBP", "JPY", "HKD", "CAD", "AUD", "TWD"].indexOf(q.currency) + 1 : 99;
  return rank(x) - rank(y) || (x.monthly ?? Infinity) - (y.monthly ?? Infinity) || (x.amount ?? Infinity) - (y.amount ?? Infinity);
}
