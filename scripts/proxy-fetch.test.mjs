import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createH2Server } from "node:http2";
import { connect } from "node:net";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { fetchProxy } from "./proxy-fetch.mjs";
import { fetchHttp2 } from "./http2-fetch.mjs";

async function listen(t, server) {
  const sockets = new Set();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function proxyFor(t, destination, onConnect = () => {}) {
  const target = new URL(destination);
  const server = createServer();
  server.on("connect", (req, client, head) => {
    onConnect(req);
    assert.equal(req.url, target.host);
    const upstream = connect(Number(target.port), target.hostname);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
  });
  return listen(t, server);
}

test("CONNECT transport reads public GET responses and preserves redirects/refusals", async (t) => {
  let requests = 0, tunnels = 0;
  const url = await listen(t, createServer((req, res) => {
    requests++;
    assert.equal(req.method, "GET"); assert.equal(req.headers["user-agent"], "radar-test");
    if (req.url === "/redirect") res.writeHead(302, { location: "https://unapproved.example/" }).end();
    else res.writeHead(403, { "cf-mitigated": "challenge" }).end("验证页面");
  }));
  const proxyUrl = await proxyFor(t, url, () => tunnels++);
  const options = { proxyUrl, headers: { "user-agent": "radar-test" } };
  const response = await fetchProxy(url, options);
  assert.equal(response.status, 403); assert.equal(await response.text(), "验证页面");
  assert.equal(response.url, `${url}/`);
  assert.equal(response.headers.get("cf-mitigated"), "challenge");
  const redirect = await fetchProxy(`${url}/redirect`, options);
  assert.equal(redirect.status, 302); assert.equal(requests, 2); assert.equal(tunnels, 2);
});

test("CONNECT carries HTTP/2 independently from the native fetch transport", async (t) => {
  let tunnels = 0;
  const server = createH2Server();
  server.on("stream", (stream, headers) => {
    assert.equal(headers[":path"], "/catalog?pid=12");
    stream.respond({ ":status": 200 }); stream.end("套餐");
  });
  const url = await listen(t, server);
  const proxyUrl = await proxyFor(t, url, () => tunnels++);
  const response = await fetchHttp2(`${url}/catalog?pid=12`, { proxyUrl });
  assert.equal(await response.text(), "套餐"); assert.equal(tunnels, 1);
});

test("CONNECT response size limits cover compressed and uncompressed bodies", async (t) => {
  const url = await listen(t, createServer((req, res) => {
    const body = "公开套餐".repeat(100);
    if (req.url === "/gzip") res.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync(body));
    else res.end(body);
  }));
  const proxyUrl = await proxyFor(t, url);
  assert.equal((await (await fetchProxy(`${url}/gzip`, { proxyUrl })).text()).length, 400);
  for (const path of ["/gzip", "/plain"]) await assert.rejects(fetchProxy(`${url}${path}`, { proxyUrl, maxBytes: 128 }), /larger than|size|length/i);
});

test("CONNECT cancellation closes a stalled tunnel and an unfinished body", async (t) => {
  const controller = new AbortController();
  const stall = createServer();
  stall.on("connect", () => controller.abort(new Error("catalog timeout")));
  const proxyUrl = await listen(t, stall);
  await assert.rejects(fetchProxy("http://example.test/", { proxyUrl, signal: controller.signal }), /catalog timeout/);
  assert.throws(() => fetchProxy("http://example.test/", { proxyUrl, signal: controller.signal }), /catalog timeout/);
  const bodyController = new AbortController();
  const url = await listen(t, createServer((_req, res) => {
    res.write("partial"); bodyController.abort(new Error("body timeout"));
  }));
  const bodyProxy = await proxyFor(t, url);
  await assert.rejects(fetchProxy(url, { proxyUrl: bodyProxy, signal: bodyController.signal }), /body timeout/);
});

test("CONNECT rejects refused tunnels, non-loopback proxies, and non-GET methods", async (t) => {
  const server = createServer();
  server.on("connect", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  const proxyUrl = await listen(t, server);
  await assert.rejects(fetchProxy("http://example.test/", { proxyUrl }), /CONNECT returned HTTP 403/);
  for (const bad of ["https://127.0.0.1:8080", "http://example.com:8080", "http://secret:password@127.0.0.1:8080"]) {
    assert.throws(() => fetchProxy("https://example.test/", { proxyUrl: bad }), /credential-free loopback/);
  }
  assert.throws(() => fetchProxy("https://example.test/", { proxyUrl, method: "POST" }), /GET/);
});
