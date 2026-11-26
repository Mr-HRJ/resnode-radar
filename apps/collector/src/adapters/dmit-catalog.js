import { parse } from "node-html-parser";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const regions = { lax: "美国", hkg: "香港", tyo: "日本" };
const networks = { premium: "Premium", eyeball: "Eyeball", tier1: "Tier 1" };
const cycles = { monthly: "月", quarterly: "季", semiannually: "半年", annually: "年", biennially: "两年", triennially: "三年" };
const fail = (message) => new Error(`DMIT public catalog: ${message}`);

export function dmitUrl(value, base = "https://www.dmit.io/") {
  const url = new URL(value, base);
  if (url.protocol !== "https:" || !["www.dmit.io", "dmit.io"].includes(url.hostname) || url.port || url.username || url.password ||
      !["/pages/pricing", "/cart.php"].includes(url.pathname) || url.searchParams.get("a") === "checkout") throw fail("unsupported public URL");
  if ((url.pathname === "/pages/pricing" && url.search) || [...url.searchParams].some(([key, value]) =>
    key === "a" ? !["add", "confproduct"].includes(value) : !["pid", "i", "gid"].includes(key) || !/^\d+$/.test(value))) throw fail("unexpected storefront query");
  return url.href;
}

export function parseDmitPlans(source, result) {
  const root = parse(result.html);
  const plans = [], ids = new Set(), pids = new Set();
  for (const group of root.querySelectorAll(".plan-group")) {
    const location = group.getAttribute("data-loc"), family = group.getAttribute("data-hw"), network = group.getAttribute("data-net");
    if (!regions[location] || !/^(as3|an4|an5)$/.test(family ?? "") || !networks[network]) throw fail("unknown location, hardware or network group");
    for (const card of group.querySelectorAll(".plan-card")) {
      const name = clean(card.querySelector(".plan-card-name")?.text);
      const priceText = clean(card.querySelector(".plan-card-price")?.text);
      const price = priceText.match(/^\$\s*([\d,.]+)\s*\/\s*(Monthly|Annually)$/i);
      const button = card.querySelector(".plan-card-action button");
      const catalogSoldOut = button?.hasAttribute("disabled") && /out of stock/i.test(button.text);
      const assignment = button?.getAttribute("onclick")?.match(/window\.location\.href\s*=\s*(['"])([^'"]+)\1/);
      const orderUrl = assignment ? dmitUrl(assignment[2], result.finalUrl) : null;
      const order = orderUrl ? new URL(orderUrl) : null;
      const pid = order?.searchParams.get("pid") ?? null;
      if (!name || name.length > 80 || !price || (!pid && !catalogSoldOut) || (pid && (!/^[1-9]\d*$/.test(pid) || order.searchParams.get("a") !== "add" || order.pathname !== "/cart.php"))) throw fail("invalid plan, reference price or PID");
      const specs = {};
      for (const spec of card.querySelectorAll(".plan-spec")) {
        const icon = spec.querySelector("i")?.getAttribute("class") ?? "";
        for (const [key, marker] of [["cpu", "fa-microchip"], ["ram", "fa-memory"], ["disk", "fa-hdd"], ["traffic", "fa-exchange-alt"], ["port", "fa-bolt"]]) {
          if (icon.split(/\s+/).includes(marker)) specs[key] = clean(spec.text);
        }
      }
      if (![specs.cpu, specs.ram, specs.disk, specs.traffic].every(Boolean)) throw fail("plan specifications missing");
      const id = `${source.id}:plan:${location}:${family}:${network}:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      if (ids.has(id) || (pid && pids.has(pid))) throw fail("duplicate plan identity or PID");
      ids.add(id); if (pid) pids.add(pid);
      const amount = Number(price[1].replace(/,/g, ""));
      if (!Number.isFinite(amount) || amount <= 0) throw fail("invalid reference price");
      const cycle = price[2].toLowerCase();
      plans.push({
        id, name: `${location.toUpperCase()} ${family.toUpperCase()} ${networks[network]} ${name}`, category: "vps",
        region: regions[location], route: networks[network], hardware: `${specs.cpu} / ${specs.ram} RAM / ${specs.disk}`,
        bandwidth: [specs.port, specs.traffic].filter(Boolean).join(" / "), currency: "USD",
        price: `USD ${amount.toFixed(2)}/${cycles[cycle]}`, priceValue: amount,
        status: catalogSoldOut ? "unavailable" : "unknown", statusLabel: catalogSoldOut ? "目录标注缺货" : "SKU 库存待核验",
        stockCount: null, orderUrl,
        note: "官网定价页为参考报价，可能未及时更新；实际价格与库存以下单页为准。",
        evidence: catalogSoldOut ? "官方目录明确标注 Out of Stock；未公开精确库存数量。" : "已识别官方套餐及 PID，尚未核验 SKU 页面。",
        httpStatus: result.statusCode, finalUrl: result.finalUrl,
        raw: { pid, location, hardwareFamily: family, network, catalogPage: result.finalUrl, billingCycle: cycle, referencePrice: true, catalogSoldOut: Boolean(catalogSoldOut) }
      });
    }
  }
  if (!plans.length || plans.length > 200) throw fail("public plan cards missing or unexpectedly numerous");
  return plans;
}

function accessIssue(result) {
  const root = parse(result.html);
  const title = clean(root.querySelector("title")?.text).slice(0, 160);
  const reason = result.statusCode === 429 ? "rate-limited"
    : result.headers?.["cf-mitigated"] === "challenge" || /Just a moment|Attention Required.*Cloudflare|Security Check/i.test(title) ? "challenge"
    : [401, 403].includes(result.statusCode) ? `http-${result.statusCode}` : null;
  if (reason) {
    const retry = result.headers?.["retry-after"];
    const retryMs = /^\d+$/.test(retry ?? "") ? Date.now() + Number(retry) * 1000 : Date.parse(retry);
    return { status: "blocked", reason, httpStatus: result.statusCode, title,
      ...(Number.isFinite(retryMs) && Math.abs(retryMs) <= 8.64e15 ? { retryAfterAt: new Date(retryMs).toISOString() } : {}),
      message: `DMIT 公开入口受限（HTTP ${result.statusCode}，${title}），库存无法确认` };
  }
  if (!result.ok) return { status: "error", reason: "http-error", httpStatus: result.statusCode, message: `DMIT 公开页面返回 HTTP ${result.statusCode}` };
  return null;
}

export function applyDmitSku(plan, result) {
  const issue = accessIssue(result);
  if (issue) return { plan: { ...plan, status: "unknown", statusLabel: "SKU 核验受阻" }, issue };
  const root = parse(result.html);
  root.querySelectorAll("script,style,noscript,template").forEach((node) => node.remove());
  const text = clean(root.structuredText);
  const meta = { httpStatus: result.statusCode, finalUrl: result.finalUrl };
  if (/We are currently out of stock on this item/i.test(text)) return { plan: {
    ...plan, ...meta, status: "unavailable", statusLabel: "SKU 已售罄", stockCount: null,
    evidence: `官方 PID ${plan.raw.pid} 页面明确返回 Out of Stock。`, raw: { ...plan.raw, inventoryChecked: true }
  } };
  const form = root.querySelector("#frmConfigureProduct");
  const options = form?.querySelectorAll('select[name="billingcycle"] option') ?? [];
  const option = options.find((o) => o.getAttribute("value") === plan.raw.billingCycle) || options.find((o) => o.hasAttribute("selected")) || options[0];
  const cycle = option?.getAttribute("value");
  const price = clean(option?.text).match(/\$\s*([\d,.]+)\s+USD\b/i);
  const amount = price ? Number(price[1].replace(/,/g, "")) : NaN;
  const configurationUrl = new URL(result.finalUrl);
  const invitation = /\binvit(?:e|ation)\s+code\b|邀请码|邀請碼/i.test(text);
  if (form && configurationUrl.searchParams.get("a") === "confproduct" && cycles[cycle] && Number.isFinite(amount) && amount > 0 && !invitation) return { plan: {
    ...plan, ...meta, status: "available", statusLabel: "可订购配置页", price: `USD ${amount.toFixed(2)}/${cycles[cycle]}`, priceValue: amount,
    note: "价格来自官方 SKU 配置页，规格来自官方目录；未提交订单，库存数量未公开。",
    evidence: `官方 PID ${plan.raw.pid} 在独立匿名会话中进入配置页，公开 USD ${amount} ${cycle}。`,
    raw: { ...plan.raw, billingCycle: cycle, referencePrice: false, inventoryChecked: true }
  } };
  return { plan: { ...plan, ...meta, status: "unknown", statusLabel: invitation ? "需邀请码" : "SKU 库存未确认" }, issue: {
    status: "error", reason: "unrecognized-sku", httpStatus: result.statusCode, message: `DMIT PID ${plan.raw.pid} 未返回可确认的缺货页或公开配置报价`
  } };
}

export async function collectDmitPlans(source, fetchPage, { signal } = {}) {
  const attempts = [], plans = [];
  const result = { plans, attempts, pagesChecked: 0, skuChecked: 0, skuTotal: 0, failedPages: 0, pageLimitReached: false };
  const request = async (url, pid = null) => {
    signal?.throwIfAborted(); result.pagesChecked++;
    try {
      const response = await fetchPage(dmitUrl(url));
      const issue = accessIssue(response);
      attempts.push({ url, ...(pid ? { pid } : {}), finalUrl: response.finalUrl, httpStatus: response.statusCode, ...(issue || { status: "parsed" }) });
      if (issue) result.failedPages++;
      return { response, issue };
    } catch (error) {
      const issue = { status: "error", reason: "transport", message: error.message };
      attempts.push({ url, ...(pid ? { pid } : {}), ...issue }); result.failedPages++;
      return { issue };
    }
  };
  const catalog = await request(source.url);
  if (catalog.issue) return result;
  plans.push(...parseDmitPlans(source, catalog.response));
  result.skuTotal = plans.filter((p) => p.raw.pid).length;
  const priorities = new Map((source.skuPriority ?? []).map((pid, index) => [String(pid), index]));
  const indices = plans.map((_, index) => index).sort((a, b) => (priorities.get(plans[a].raw.pid) ?? -1) - (priorities.get(plans[b].raw.pid) ?? -1));
  for (const index of indices) {
    const plan = plans[index]; if (!plan.raw.pid) continue;
    if (signal?.aborted) { result.timeBudgetReached = true; break; }
    const sku = await request(plan.orderUrl, plan.raw.pid);
    plan.raw.inventoryAttemptedAt = new Date().toISOString();
    result.skuChecked++;
    if (sku.issue) {
      plans[index] = { ...plan, status: "unknown", statusLabel: "SKU 核验受阻" };
      if (sku.issue.status === "blocked" || signal?.aborted) break;
      continue;
    }
    const checked = applyDmitSku(plan, sku.response); plans[index] = checked.plan;
    if (checked.plan.raw.inventoryChecked) checked.plan.raw.inventoryCheckedAt = plan.raw.inventoryAttemptedAt;
    if (checked.issue) { Object.assign(attempts.at(-1), checked.issue); result.failedPages++; }
  }
  if (result.skuChecked < result.skuTotal && !result.failedPages) {
    result.failedPages++;
    attempts.push({ status: "error", reason: "incomplete", message: "DMIT SKU 采集未完成，未核验商品保留为未知库存" });
  }
  if (signal?.aborted) result.timeBudgetReached = true;
  return result;
}

export function runDmitWorker(source) {
  const timeoutMs = Math.max(1, Math.min(300000, (source.deadline ?? Date.now() + 300000) - Date.now()));
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [fileURLToPath(new URL("../transport/dmit-worker.js", import.meta.url))], {
      timeout: timeoutMs, signal: source.signal, maxBuffer: 4 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`DMIT worker failed (${error.code || error.signal || error.name})${stderr.trim() ? `: ${stderr.trim().slice(0, 350)}` : ""}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(fail("invalid worker response")); }
    });
    child.stdin.on("error", () => {}); // Process failure is reported by execFile's callback.
    child.stdin.end(JSON.stringify({ id: source.id, url: source.url, proxyUrl: source.proxyUrl || null, skuPriority: source.skuPriority ?? [], timeoutMs: Math.max(1, timeoutMs - 1500), requestIntervalMs: Math.max(8000, source.requestIntervalMs || 8000) }));
  });
}

export async function monitorDmitCatalog(source, helpers) {
  const { baseRecord, blockedRecord, errorRecord, runWorker = runDmitWorker } = helpers;
  try {
    const collected = await runWorker(source);
    if (!Array.isArray(collected.plans) || !Array.isArray(collected.attempts)) throw fail("invalid worker result");
    const records = collected.plans.map((plan) => baseRecord(source, { statusCode: plan.httpStatus, finalUrl: plan.finalUrl }, plan));
    const failure = collected.attempts.find((a) => ["blocked", "error"].includes(a.status));
    if (failure) {
      const meta = { statusCode: failure.httpStatus, finalUrl: failure.finalUrl || failure.url || source.url };
      const diagnostic = failure.status === "blocked" ? blockedRecord(source, meta, failure.message) : errorRecord(source, new Error(failure.message), { httpStatus: failure.httpStatus, finalUrl: meta.finalUrl });
      records.push({ ...diagnostic, id: `${source.id}:diagnostic`, diagnostic: true, raw: { attempts: collected.attempts } });
    }
    if (!records.length) throw fail("worker returned no catalog or diagnosis");
    const collection = Object.fromEntries(["pagesChecked", "failedPages", "skuChecked", "skuTotal", "pageLimitReached", "timeBudgetReached"].filter((key) => collected[key] !== undefined).map((key) => [key, collected[key]]));
    return records.map((record) => ({ ...record, collection }));
  } catch (error) {
    return [{ ...errorRecord(source, error), id: `${source.id}:diagnostic`, diagnostic: true, raw: { attempts: [{ status: "error", reason: "transport", message: error.message }] } }];
  }
}
