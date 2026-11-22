import { parse } from "node-html-parser";
import { catalogUrlAllowed, cleanPublicUrl } from "./catalog-pages.mjs";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const outOfStockRe = /\bOut of Stock\b|\bSold Out\b|已售罄|售罄|缺货|无库存|無庫存/i;
const inviteOnlyRe = /\binvit(?:e|ation)\s+code\b|邀请码|邀請碼/i;

export function parseWhmcsConfProduct(html, plan = {}) {
  const root = parse(String(html ?? ""));
  root.querySelectorAll("script, style, noscript, template").forEach((node) => node.remove());
  // Strip HTML comments before parsing visible product details so commented-out copy never leaks.
  const visibleHtml = root.toString().replace(/<!--[\s\S]*?-->/g, "");
  const cleanRoot = parse(visibleHtml);
  const text = clean(cleanRoot.structuredText);
  const lines = cleanRoot.structuredText.split(/\r?\n/).map(clean).filter(Boolean);

  const rawTitle = clean(
    cleanRoot.querySelector(".cartbox strong, .product-info strong, .orderrow strong, h2, h3")?.text
  ).replace(/^VPS\s*-\s*Self-managed\s*-\s*/i, "");
  const name = rawTitle && !/^Product\/Service$|^Shopping Cart$/i.test(rawTitle) ? rawTitle : clean(plan.name);

  const field = (prefix) => lines.find((line) => new RegExp(`^${prefix}\\s*:`, "i").test(line)) || null;
  const hardware = [field("CPU"), field("RAM"), field("SSD") || field("NVMe") || field("Disk")].filter(Boolean).join(" / ") || null;
  const bandwidth = [field("Link speed") || field("Bandwidth"), field("Transfer") || field("Traffic"), field("IPv4")].filter(Boolean).join(" / ") || null;
  const locLine = field("Location") || "";

  const priceMatches = [
    ...text.matchAll(/(?:US\$|CA\$|C\$|HK\$|A\$|[¥￥$€£])\s*([\d,]+(?:\.\d+)?)\s*(USD|CNY|EUR|GBP|CAD|AUD|HKD|JPY|TWD|SGD)?\s*(Monthly|Quarterly|Semi-Annually|Annually|Biennially|Triennially|月付|季付|半年付|年付)?/gi)
  ]
    .map((m) => {
      const amount = Number(m[1].replace(/,/g, ""));
      const currency = (m[2] || (m[0].includes("€") ? "EUR" : m[0].includes("£") ? "GBP" : /[¥￥]/.test(m[0]) ? "CNY" : "USD")).toUpperCase();
      const period = clean(m[3]);
      if (!Number.isFinite(amount) || amount <= 0 || !period) return null;
      return { amount, currency, period, label: `${currency} ${amount} ${period}` };
    })
    .filter(Boolean);

  const primaryPrice = priceMatches[0] || null;
  const blob = `${name} ${locLine} ${text}`;
  const region = plan.region || (
    /Amsterdam|Netherlands/i.test(blob) ? "荷兰"
      : /Hong Kong/i.test(blob) ? "香港"
        : /Singapore/i.test(blob) ? "新加坡"
          : /Tokyo|Osaka|Japan/i.test(blob) ? "日本"
            : /Sydney|Australia/i.test(blob) ? "澳大利亚"
              : /Los Angeles|Fremont|San Jose|New York|United States/i.test(blob) ? "美国" : null
  );
  const routes = [...new Set(blob.match(/CN2\s*GIA|CN2\s*GT|CN2|CMIN2|CMI|AS10099|9929|4837|HE\b/gi) || [])].join(" / ");
  const route = plan.route || routes || null;
  const inviteRequired = inviteOnlyRe.test(text);
  const soldOut = outOfStockRe.test(text);

  return {
    name,
    hardware,
    bandwidth,
    region,
    route,
    price: primaryPrice?.label || null,
    priceValue: primaryPrice?.amount ?? null,
    currency: primaryPrice?.currency || null,
    billingCycle: primaryPrice?.period || null,
    inviteRequired,
    soldOut,
    location: locLine || null
  };
}

function extractCookies(response) {
  const list = typeof response.headers?.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers?.get?.("set-cookie")].filter(Boolean);
  return list.map((entry) => String(entry).split(";")[0].trim()).filter(Boolean).join("; ");
}

export async function monitorWhmcsPidWatch(source, helpers) {
  const { waitForRequestSlot, userAgent, isAntiBotResult, baseRecord, blockedRecord, errorRecord, fetchImpl = fetch } = helpers;
  const plans = Array.isArray(source.plans) ? source.plans : [];
  if (plans.length === 0) {
    return [errorRecord(source, new Error("whmcs_pid_watch source has no configured plans"))];
  }

  const baseCartUrl = cleanPublicUrl(source.url);
  if (!baseCartUrl) {
    return [errorRecord(source, new Error("whmcs_pid_watch source url is invalid"))];
  }

  const records = [];
  for (const plan of plans) {
    const pid = String(plan?.pid ?? "").trim();
    if (!pid) continue;
    const addUrlObj = new URL(baseCartUrl);
    addUrlObj.searchParams.set("a", "add");
    addUrlObj.searchParams.set("pid", pid);
    const addUrl = addUrlObj.href;

    try {
      await waitForRequestSlot(addUrl, source.requestIntervalMs ?? 2000, source.signal);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      let res;
      let html = "";
      try {
        res = await fetchImpl(addUrl, {
          headers: {
            "user-agent": userAgent,
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
          },
          redirect: "manual",
          signal: source.signal ? AbortSignal.any([controller.signal, source.signal]) : controller.signal
        });
        html = await res.text();
      } finally {
        clearTimeout(timeout);
      }

      const fetchMeta = {
        ok: res.ok,
        statusCode: res.status,
        finalUrl: addUrl,
        headers: Object.fromEntries(res.headers.entries()),
        html
      };

      const title = clean(parse(html).querySelector("title")?.text).slice(0, 140);
      if (
        res.status === 403 ||
        res.status === 429 ||
        fetchMeta.headers["cf-mitigated"] === "challenge" ||
        (!res.ok && isAntiBotResult?.(fetchMeta)) ||
        /Just a moment|Attention Required.*Cloudflare|Security Check|滑动验证/i.test(title)
      ) {
        records.push({
          ...blockedRecord(source, fetchMeta, `公开 pid 监控入口受限（HTTP ${res.status}${title ? `，${title}` : ""}），库存无法确认`),
          id: `${source.id}:diagnostic`,
          diagnostic: true
        });
        break;
      }

      const location = res.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(res.status) && location) {
        const nextUrl = cleanPublicUrl(location, addUrl);
        if (!nextUrl || !catalogUrlAllowed(nextUrl, source)) {
          throw new Error(`WHMCS pid=${pid} redirected outside configured official hosts`);
        }

        if (/confproduct/i.test(nextUrl)) {
          const cookieHeader = extractCookies(res);
          await waitForRequestSlot(nextUrl, source.requestIntervalMs ?? 2000, source.signal);
          const c2 = new AbortController();
          const t2 = setTimeout(() => c2.abort(), 20000);
          let confRes;
          let confHtml = "";
          try {
            confRes = await fetchImpl(nextUrl, {
              headers: {
                "user-agent": userAgent,
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                ...(cookieHeader ? { cookie: cookieHeader } : {})
              },
              redirect: "manual",
              signal: source.signal ? AbortSignal.any([c2.signal, source.signal]) : c2.signal
            });
            confHtml = await confRes.text();
          } finally {
            clearTimeout(t2);
          }

          const confMeta = {
            ok: confRes.ok,
            statusCode: confRes.status,
            finalUrl: nextUrl,
            headers: Object.fromEntries(confRes.headers.entries()),
            html: confHtml
          };
          if ([401, 403, 429].includes(confRes.status) || isAntiBotResult?.(confMeta)) {
            records.push({ ...blockedRecord(source, confMeta, `公开配置页访问受限（HTTP ${confRes.status}），库存无法确认`), id: `${source.id}:diagnostic`, diagnostic: true });
            break;
          }
          if (!confRes.ok) throw new Error(`WHMCS configuration page returned HTTP ${confRes.status}`);

          if (confRes.ok) {
            const parsed = parseWhmcsConfProduct(confHtml, plan);
            const hasPlan = parsed.priceValue !== null && Boolean(parsed.hardware);
            const status = parsed.soldOut ? "unavailable" : parsed.inviteRequired || !hasPlan ? "unknown" : "available";
            const statusLabel = status === "unavailable"
              ? "已售罄"
              : parsed.inviteRequired
                ? "需邀请码"
                : hasPlan ? "可订购入口" : "配置页未解析到套餐";
            records.push(baseRecord(source, confMeta, {
              id: `${source.id}:pid:${pid}`,
              sourceUrl: addUrl,
              finalUrl: nextUrl,
              name: parsed.name || plan.name,
              category: plan.category || source.category || "vps",
              region: parsed.region || plan.region || null,
              route: parsed.route || plan.route || null,
              hardware: parsed.hardware,
              bandwidth: parsed.bandwidth,
              price: parsed.price,
              priceValue: parsed.priceValue,
              currency: parsed.currency || source.currency || null,
              status,
              statusLabel,
              stockCount: status === "unavailable" ? 0 : null,
              orderUrl: addUrl,
              note: parsed.inviteRequired
                ? "限量款官方配置页要求输入邀请码（Invite Code）才可下单，非公开自由购买库存。"
                : "官方公开配置页监测；仅在解析到配置与价格时标记可订购入口，库存数量未公开。",
              evidence: `Official WHMCS pid=${pid} redirected to confproduct; inviteRequired=${parsed.inviteRequired}; soldOut=${parsed.soldOut}`,
              raw: {
                pid,
                catalogPage: addUrl,
                billingCycle: parsed.billingCycle,
                inviteRequired: parsed.inviteRequired,
                location: parsed.location
              }
            }));
            continue;
          }
        }

        // Redirected back to plain cart.php (or non-confproduct) -> retired / inactive pid
        records.push(baseRecord(source, fetchMeta, {
          id: `${source.id}:pid:${pid}`,
          sourceUrl: addUrl,
          finalUrl: nextUrl,
          name: clean(plan.name) || `${source.provider} PID ${pid}`,
          category: plan.category || source.category || "vps",
          region: plan.region || null,
          route: plan.route || null,
          hardware: null,
          bandwidth: null,
          price: null,
          priceValue: null,
          currency: source.currency || null,
          status: "unknown",
          statusLabel: "入口未开放",
          stockCount: null,
          orderUrl: addUrl,
          note: "该官方 pid 当前未进入配置页（已重定向回目录页），可能已下线或暂未开放。",
          evidence: `Official WHMCS pid=${pid} redirected to ${nextUrl} without confproduct`,
          raw: { pid, catalogPage: addUrl, redirectLocation: nextUrl }
        }));
        continue;
      }

      if (res.ok && parseWhmcsConfProduct(html).soldOut) {
        records.push(baseRecord(source, fetchMeta, {
          id: `${source.id}:pid:${pid}`,
          sourceUrl: addUrl,
          name: clean(plan.name) || `${source.provider} PID ${pid}`,
          category: plan.category || source.category || "vps",
          region: plan.region || null,
          route: plan.route || null,
          hardware: plan.hardware || null,
          bandwidth: plan.bandwidth || null,
          price: null,
          priceValue: null,
          currency: source.currency || null,
          status: "unavailable",
          statusLabel: "已售罄",
          stockCount: 0,
          orderUrl: addUrl,
          note: "限量款官方直链实时监测；官网当前显示 Out of Stock，补货时将在异动雷达触发提醒。",
          evidence: `Official WHMCS pid=${pid} returned Out of Stock`,
          raw: { pid, catalogPage: addUrl, outOfStock: true }
        }));
        continue;
      }

      records.push(baseRecord(source, fetchMeta, {
        id: `${source.id}:pid:${pid}`,
        sourceUrl: addUrl,
        name: clean(plan.name) || `${source.provider} PID ${pid}`,
        category: plan.category || source.category || "vps",
        region: plan.region || null,
        route: plan.route || null,
        hardware: null,
        bandwidth: null,
        price: null,
        priceValue: null,
        currency: source.currency || null,
        status: "unknown",
        statusLabel: "库存未确认",
        stockCount: null,
        orderUrl: addUrl,
        note: "官方直链返回 HTTP 200 但未包含明确的缺货或配置页信号。",
        evidence: `Official WHMCS pid=${pid} returned HTTP ${res.status} without confproduct or Out of Stock`,
        raw: { pid, catalogPage: addUrl }
      }));
    } catch (error) {
      records.push(errorRecord(source, error, {
        id: `${source.id}:pid:${pid}:error`,
        sourceUrl: addUrl,
        name: clean(plan.name) || `${source.provider} PID ${pid}`,
        diagnostic: true
      }));
      if (source.signal?.aborted) break;
    }
  }

  return records;
}
