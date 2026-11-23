import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "node-html-parser";
import { normalizeOrder } from "./collection-state.mjs";

const hash = (s) => createHash("sha256").update(s).digest("hex");
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
export function safeAnnouncementUrl(value, base, allowedHosts) {
  try {
    const u = new URL(value, base);
    if (u.protocol !== "https:" || u.username || u.password || u.port || !allowedHosts.includes(u.hostname)) return null;
    u.hash = ""; return u.href;
  } catch { return null; }
}
export function candidatesFromLinks(links, sources) {
  const matches = new Map();
  for (const link of links) {
    for (const source of sources) {
      const hosts = [...new Set([source.url, source.website, ...(source.catalogUrls ?? [])].filter(Boolean).map((url) => { try { return new URL(url).hostname; } catch { return ""; } }))];
      const safe = safeAnnouncementUrl(link, undefined, hosts); if (!safe) continue;
      const u = new URL(safe);
      const allowedQuery = [...u.searchParams.keys()].every((key) => /^(pid|gid|a|id|product_id|plan_id|currency|language|billingcycle|rp|locale|utm_\w+|aff|ref)$/.test(key));
      if (!allowedQuery || /login|logout|checkout|clientarea|unsubscribe|restock_notifier/i.test(u.pathname + u.search)) continue;
      if (u.searchParams.has("a") && u.searchParams.get("a") !== "add") continue;
      if (!((u.pathname.endsWith("/cart.php") && /^\d+$/.test(u.searchParams.get("pid") ?? "")) || /\/(?:store|products?|plans?|order|shop)\/[^/]+/i.test(u.pathname))) continue;
      const url = normalizeOrder(safe); matches.set(url, { url, sourceId: source.id, provider: source.provider }); break;
    }
  }
  return [...matches.values()].slice(0, 12);
}
export function normalizeAnnouncement(row, source, sources, at) {
  const root = parse(String(row.html ?? "").slice(0, 500_000));
  root.querySelectorAll("script,style,iframe,form,template").forEach((el) => el.remove());
  const plain = clean(root.structuredText).slice(0, 1500);
  const links = root.querySelectorAll("a[href]").map((a) => { try { return new URL(a.getAttribute("href"), row.link || source.url).href; } catch { return ""; } });
  links.push(...plain.match(/https:\/\/[^\s<>"'\])]+/g) ?? []);
  const title = clean(parse(String(row.title ?? "")).text).slice(0, 200);
  const url = safeAnnouncementUrl(row.link, source.url, source.linkHosts);
  if (!title || !url) return null;
  const date = Date.parse(row.published), now = Date.parse(at);
  const publishedAt = Number.isFinite(date) && date <= now + 300000 ? new Date(date).toISOString() : null;
  const candidates = candidatesFromLinks([url, ...links], sources);
  const key = hash(String(row.guid || url));
  return { key, hash: hash(JSON.stringify({ title, url, plain, publishedAt, candidates })), title, url, summary: plain,
    publishedAt, observedAt: at, candidates };
}
export async function parseFeedXml(xml) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.env.MONITOR_PYTHON || "python3", [fileURLToPath(new URL("./parse-feed.py", import.meta.url))],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(new Error("订阅 XML 无法解析"));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error("订阅解析结果无效")); }
      });
    child.stdin.on("error", () => {}); child.stdin.end(xml);
  });
}
async function get(url, { headers = {}, local = false } = {}) {
  const initial = new URL(url);
  if (local && (initial.protocol !== "http:" || initial.hostname !== "127.0.0.1" || initial.username || initial.password)) throw new Error("Sidecar must use a loopback HTTP address");
  let current = initial;
  const signal = AbortSignal.timeout(20000);
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetch(current, { headers: { "user-agent": "ResNodeRadar/0.2 (+https://vps.bnoai.com)", ...headers }, redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get("location")) {
      await response.body?.cancel(); const next = new URL(response.headers.get("location"), current);
      if (next.origin !== initial.origin) throw new Error("订阅跳转超出已确认来源"); current = next; continue;
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error("订阅响应超过大小限制"); chunks.push(chunk);
    }
    return { status: response.status, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") };
  }
  throw new Error("订阅跳转次数超限");
}
async function changedetectionRows(source) {
  const base = process.env.MONITOR_CHANGEDETECTION_URL || "http://127.0.0.1:12500";
  let key;
  try { key = readFileSync(join(process.env.CREDENTIALS_DIRECTORY || "/etc/resnode-radar-feeds", "changes-api-key"), "utf8").trim(); }
  catch { throw new Error("页面变化服务尚未配置凭据"); }
  const headers = { "x-api-key": key };
  const list = await get(`${base}/api/v1/watch`, { headers, local: true });
  if (list.status !== 200) throw new Error(`页面变化服务返回 HTTP ${list.status}`);
  const [id, watch] = Object.entries(JSON.parse(list.body)).find(([, w]) => w.url === source.url) ?? [];
  if (!id || watch.last_error || !watch.last_checked) throw new Error(watch?.last_error ? "页面变化服务读取上游失败" : "页面变化服务尚未完成首次检查");
  if (Date.now() - Number(watch.last_checked) * 1000 > 45 * 60000) throw new Error("页面变化服务的上游检查已过期");
  const history = await get(`${base}/api/v1/watch/${encodeURIComponent(id)}/history`, { headers, local: true });
  if (history.status !== 200) throw new Error("无法读取页面变化历史");
  const timestamps = Object.keys(JSON.parse(history.body)).filter((t) => /^\d+(?:\.\d+)?$/.test(t)).sort((a, b) => Number(b) - Number(a));
  if (!timestamps.length) throw new Error("页面变化服务没有有效快照");
  const timestamp = timestamps[0];
  const snapshot = await get(`${base}/api/v1/watch/${encodeURIComponent(id)}/history/${timestamp}`, { headers, local: true });
  if (snapshot.status !== 200) throw new Error("无法读取页面变化内容");
  return [{ guid: `${source.id}:${timestamp}`, title: `${source.name}页面更新`, link: source.url,
    published: null, html: snapshot.body.replaceAll("<", "&lt;").replaceAll(">", "&gt;") }];
}
export async function refreshAnnouncements(store, config, sources, at = new Date().toISOString()) {
  for (const source of config) {
    const previous = store.feedState(source.id) || {};
    try {
      let rows, response;
      if (source.kind === "changedetection") rows = await changedetectionRows(source);
      else if (source.kind === "rsshub") {
        response = await get(`${process.env.MONITOR_RSSHUB_URL || "http://127.0.0.1:12180"}/telegram/channel/${encodeURIComponent(source.channel)}`, { local: true });
        if (response.status !== 200) throw new Error(`RSSHub 返回 HTTP ${response.status}`);
        const feed = JSON.parse(response.body); const items = feed.item || feed.items;
        if (!Array.isArray(items)) throw new Error("RSSHub 订阅格式无效");
        rows = items.slice(0, 60).map((item) => ({ guid: item.guid || item.id || item.link, title: item.title,
          link: item.link || item.url, published: item.pubDate || item.published || item.date_published, html: item.description || item.content_html || item.content }));
      } else {
        response = await get(source.url, { headers: { ...(previous.etag ? { "if-none-match": previous.etag } : {}), ...(previous.lastModified ? { "if-modified-since": previous.lastModified } : {}) } });
        if (response.status === 304) {
          if (!previous.initialized) throw new Error("首次订阅未取得内容");
          store.saveFeed(source.id, { ...previous, status: "ok", checkedAt: at, lastSuccessAt: at, error: null }); continue;
        }
        if (response.status !== 200) throw new Error(`订阅源返回 HTTP ${response.status}`);
        rows = await parseFeedXml(response.body);
      }
      let accepted = 0;
      store.transaction(() => {
        for (const row of rows) {
          const item = normalizeAnnouncement(row, source, sources, at); if (!item) continue;
          const ingested = store.ingestAnnouncement(source, item, at); accepted++;
          // Historical imports establish a baseline; only recent offers deserve immediate verification.
          if (ingested.changed && (!ingested.created || !ingested.record.baseline || Date.parse(item.publishedAt) >= Date.parse(at) - 7 * 86400000)) {
            for (const candidate of item.candidates) store.enqueue(candidate.url, candidate.sourceId, at);
          }
        }
        if (rows.length && !accepted) throw new Error("订阅条目未通过来源校验");
        store.saveFeed(source.id, { initialized: true, name: source.name, url: source.url, kind: source.kind, trust: source.trust,
          status: "ok", checkedAt: at, lastSuccessAt: at, error: null, items: accepted,
          etag: response?.headers.get("etag") || null, lastModified: response?.headers.get("last-modified") || null });
      });
    } catch (error) {
      store.saveFeed(source.id, { ...previous, name: source.name, url: source.url, kind: source.kind, trust: source.trust,
        status: "error", checkedAt: at, error: String(error.message).slice(0, 180) });
    }
  }
  return store.announcementPayload(at);
}
