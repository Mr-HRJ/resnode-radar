import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

// Only the project's loopback sidecar is supported; credentials stay outside Node/Git.
function proxyAddress(value) {
  let proxy;
  try { proxy = new URL(value); } catch { throw new Error("Invalid fallback proxy configuration"); }
  if (proxy.protocol !== "http:" || proxy.hostname !== "127.0.0.1" ||
      proxy.username || proxy.password || proxy.pathname !== "/" || proxy.search || proxy.hash) {
    throw new Error("Fallback proxy must be credential-free loopback HTTP");
  }
  return proxy;
}

export function openProxyTunnel(url, proxyUrl, { signal, alpn = "http/1.1" } = {}) {
  signal?.throwIfAborted();
  const proxy = proxyAddress(proxyUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Unsupported proxy destination");
  }
  return new Promise((resolve, reject) => {
    let socket, settled = false;
    const authority = `${url.hostname}:${url.port || (url.protocol === "https:" ? 443 : 80)}`;
    const req = httpRequest({ hostname: proxy.hostname, port: proxy.port || 80, method: "CONNECT",
      path: authority, headers: { host: authority }, agent: false, signal });
    const abort = () => fail(signal.reason ?? new DOMException("Aborted", "AbortError"));
    function fail(error) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      req.destroy();
      socket?.destroy();
      reject(error);
    }
    function ready() {
      if (settled) return;
      if (url.protocol === "https:" && alpn === "h2" && socket.alpnProtocol !== "h2") {
        return fail(new Error("Fallback destination did not negotiate HTTP/2"));
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolve(socket);
    }
    req.once("error", fail);
    req.once("connect", (response, tunnel, head) => {
      socket = tunnel;
      if (response.statusCode !== 200) return fail(new Error(`Fallback proxy CONNECT returned HTTP ${response.statusCode}`));
      if (head.length) tunnel.unshift(head);
      if (url.protocol === "https:") {
        // Authenticate the upstream certificate inside the tunnel; the proxy never decrypts it.
        socket = tlsConnect({ socket: tunnel, host: url.hostname,
          servername: isIP(url.hostname) ? undefined : url.hostname, ALPNProtocols: [alpn] });
        socket.once("error", fail);
        socket.once("secureConnect", ready);
      } else {
        socket.once("error", fail);
        ready();
      }
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) return abort();
    req.end();
  });
}

export function fetchProxy(input, { proxyUrl, headers = {}, signal, method = "GET", maxBytes = 8 * 1024 * 1024 } = {}) {
  const url = new URL(input);
  signal?.throwIfAborted();
  if (method !== "GET") throw new Error("Residential catalog fallback supports public GET requests only");
  return openProxyTunnel(url, proxyUrl, { signal }).then((socket) => new Promise((resolve, reject) => {
    let req, response, settled = false, size = 0;
    const chunks = [];
    const secure = url.protocol === "https:";
    const agent = secure ? new HttpsAgent() : new HttpAgent();
    agent.createConnection = () => socket;
    const abort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
    function finish(error, result) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      response?.destroy();
      req?.destroy();
      agent.destroy();
      socket.destroy();
      if (error) reject(error); else resolve(result);
    }
    try {
      signal?.throwIfAborted();
      req = (secure ? httpsRequest : httpRequest)(url, { method, agent, headers: { ...headers, "accept-encoding": "identity" } });
      req.on("error", (error) => finish(error));
      req.on("response", (incoming) => {
        response = incoming;
        incoming.on("error", (error) => finish(error));
        incoming.on("aborted", () => finish(new Error("Fallback response interrupted")));
        incoming.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) return finish(new Error("Fallback response exceeds size limit"));
          chunks.push(chunk);
        });
        incoming.on("end", () => {
          if (settled) return;
          try {
            let body = Buffer.concat(chunks);
            const encoding = incoming.headers["content-encoding"]?.toLowerCase();
            const decode = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync }[encoding];
            if (decode) body = decode(body, { maxOutputLength: maxBytes });
            else if (encoding && encoding !== "identity") throw new Error(`Unsupported fallback content encoding: ${encoding}`);
            const publicHeaders = Object.entries(incoming.headers).filter(([key]) => !["content-encoding", "content-length"].includes(key));
            const result = new Response([204, 205, 304].includes(incoming.statusCode) ? null : body,
              { status: incoming.statusCode, headers: publicHeaders });
            Object.defineProperty(result, "url", { value: url.href });
            finish(null, result);
          } catch (error) { finish(error); }
        });
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      req.end();
    } catch (error) { finish(error); }
  }));
}
