import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { collectDmitPlans, dmitUrl } from "../adapters/dmit-catalog.js";

// A measured Chrome 150 macOS profile that was verified against the official
// storefront. Keep its UA, TLS extensions and HTTP/2 settings together.
export const dmitFingerprint = {
  impersonate: "chrome150",
  ja3: "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-5-10-11-13-16-18-23-27-35-43-45-51-17613-65037-65281,4588-29-23-24,0",
  akamai: "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
  headers: { "sec-ch-ua-platform": '"macOS"' }
};

async function main() {
  let input = "";
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 16384) throw new Error("DMIT worker input exceeds limit"); }
  const source = JSON.parse(input);
  dmitUrl(source.url);
  if (source.id !== "catalog-dmit" || !Number.isFinite(source.timeoutMs) || source.timeoutMs <= 0 || source.timeoutMs > 300000 ||
      !Array.isArray(source.skuPriority ?? []) || (source.skuPriority?.length ?? 0) > 200 || (source.skuPriority ?? []).some((pid) => !/^\d+$/.test(pid))) throw new Error("Invalid DMIT worker configuration");
  const signal = AbortSignal.timeout(Math.ceil(source.timeoutMs));
  let Session;
  if (source.proxyUrl) {
    const proxy = new URL(source.proxyUrl);
    if (proxy.protocol !== "http:" || proxy.hostname !== "127.0.0.1" || !proxy.port || proxy.username || proxy.password || proxy.pathname !== "/" || proxy.search || proxy.hash) throw new Error("DMIT requires its loopback HTTP proxy");
    const library = process.env.MONITOR_DMIT_CURL_LIB;
    if (!library || !(await stat(library)).isFile()) throw new Error("MONITOR_DMIT_CURL_LIB is not installed");
    // Explicitly select the deployment's pinned library; never auto-download at runtime.
    process.env.LIBCURL_PATH = library;
    ({ Session } = await import("impers"));
  }
  let nextSlot = 0;
  const fetchPage = async (initialUrl) => {
    const session = Session ? new Session({ ...dmitFingerprint, proxy: source.proxyUrl, allowRedirects: false, timeout: 15, verify: true }) : null;
    const cookies = new Map();
    let url = dmitUrl(initialUrl);
    try {
      for (let hop = 0; hop < 6; hop++) {
        signal.throwIfAborted();
        await delay(Math.max(0, nextSlot - Date.now()), undefined, { signal });
        nextSlot = Date.now() + Math.max(8000, source.requestIntervalMs || 8000);
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
        let statusCode, headers, html;
        if (session) {
          const chunks = []; let size = 0;
          const controller = new AbortController();
          const response = await session.get(url, { signal: AbortSignal.any([requestSignal, controller.signal]), contentCallback(chunk) {
            size += chunk.length;
            if (size > 8 * 1024 * 1024) controller.abort(new Error("DMIT response exceeds 8 MiB"));
            else chunks.push(chunk);
          } });
          try {
            if (size > 8 * 1024 * 1024) throw new Error("DMIT response exceeds 8 MiB");
            statusCode = response.status;
            headers = Object.fromEntries(["location", "cf-mitigated", "content-type", "retry-after"].map((name) => [name, response.headers.get(name)]));
            html = Buffer.concat(chunks).toString("utf8");
          } finally { await response.close(); }
        } else {
          const response = await fetch(url, { redirect: "manual", signal: requestSignal, headers: {
            "user-agent": "Mozilla/5.0 ResNodeRadar/0.2 (+https://github.com/Mr-HRJ/resnode-radar)", accept: "text/html,application/xhtml+xml,*/*;q=0.8",
            ...(cookies.size ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ") } : {})
          } });
          for (const entry of response.headers.getSetCookie()) {
            const cookie = entry.split(";", 1)[0], separator = cookie.indexOf("=");
            if (separator > 0) cookies.set(cookie.slice(0, separator), cookie.slice(separator + 1));
          }
          statusCode = response.status;
          headers = Object.fromEntries(["location", "cf-mitigated", "content-type", "retry-after"].map((name) => [name, response.headers.get(name)]));
          const chunks = []; let size = 0;
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > 8 * 1024 * 1024) throw new Error("DMIT response exceeds 8 MiB");
            chunks.push(chunk);
          }
          html = Buffer.concat(chunks).toString("utf8");
        }
        if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
          const next = dmitUrl(headers.location, url);
          if (new URL(next).origin !== new URL(url).origin) throw new Error("DMIT redirected outside its storefront origin");
          url = next; continue;
        }
        return { statusCode, ok: statusCode >= 200 && statusCode < 300, headers, finalUrl: url, html };
      }
      throw new Error("DMIT redirect limit exceeded");
    } finally { await session?.close(); }
  };
  const result = await collectDmitPlans(source, fetchPage, { signal });
  process.stdout.write(JSON.stringify(result));
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
