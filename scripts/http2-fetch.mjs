import { connect } from "node:http2";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { openProxyTunnel } from "./proxy-fetch.mjs";

// Some public storefronts accept HTTP/2 but reject HTTP/1.1. Keep redirects in
// the collector so every hop still passes its official-host check and pacer.
export function fetchHttp2(input, { headers = {}, signal, maxBytes = 8 * 1024 * 1024, proxyUrl } = {}) {
  const url = new URL(input);
  signal?.throwIfAborted();
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Unsupported HTTP/2 URL");
  }
  if (proxyUrl) return openProxyTunnel(url, proxyUrl, { signal, alpn: "h2" })
    .then((socket) => readHttp2(url, { headers, signal, maxBytes }, socket));
  return readHttp2(url, { headers, signal, maxBytes });
}

function readHttp2(url, { headers, signal, maxBytes }, proxySocket) {
  return new Promise((resolve, reject) => {
    let session, stream, settled = false, responseHeaders, size = 0;
    const chunks = [];
    function finish(error, response) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      session?.destroy();
      proxySocket?.destroy();
      if (error) reject(error); else resolve(response);
    }
    const abort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
    try {
      // TLS certificate and hostname verification use Node's secure defaults.
      session = connect(url.origin, { ...(proxySocket ? { createConnection: () => proxySocket } : {}), settings: { enablePush: false } });
      session.on("error", (error) => finish(error));
      session.on("close", () => {
        if (!settled) finish(new Error("HTTP/2 connection closed before response completed"));
      });
      stream = session.request({ ...headers, "accept-encoding": "identity", ":method": "GET", ":path": `${url.pathname}${url.search}` });
      stream.on("error", (error) => finish(error));
      stream.on("aborted", () => finish(new Error("HTTP/2 response was interrupted")));
      stream.on("close", () => {
        if (!settled) finish(new Error("HTTP/2 stream closed before response completed"));
      });
      stream.on("response", (received) => { responseHeaders = received; });
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) return finish(new Error("HTTP/2 response exceeds size limit"));
        chunks.push(chunk);
      });
      stream.on("end", () => {
        if (settled) return;
        try {
          if (!responseHeaders) throw new Error("HTTP/2 response headers missing");
          let body = Buffer.concat(chunks);
          const encoding = responseHeaders["content-encoding"]?.toLowerCase();
          const decode = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync }[encoding];
          if (decode) body = decode(body, { maxOutputLength: maxBytes });
          else if (encoding && encoding !== "identity") throw new Error(`Unsupported HTTP/2 content encoding: ${encoding}`);
          const status = Number(responseHeaders[":status"]);
          const publicHeaders = Object.entries(responseHeaders).filter(([key]) => !key.startsWith(":") && !["content-encoding", "content-length"].includes(key));
          const response = new Response([204, 205, 304].includes(status) ? null : body, { status, headers: publicHeaders });
          Object.defineProperty(response, "url", { value: url.href });
          finish(null, response);
        } catch (error) { finish(error); }
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      stream.end();
    } catch (error) { finish(error); }
  });
}
