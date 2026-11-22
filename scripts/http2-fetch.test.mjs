import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http2";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { fetchHttp2 } from "./http2-fetch.mjs";

async function serverFor(t, handler) {
  const server = createServer();
  server.on("stream", handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("HTTP/2 reads UTF-8 catalog content and preserves refusal responses", async (t) => {
  const url = await serverFor(t, (stream, headers) => {
    assert.equal(headers["user-agent"], "ResNodeRadar test");
    assert.equal(headers[":method"], "GET");
    assert.equal(headers[":path"], "/catalog?region=vn");
    stream.respond({ ":status": 403, "cf-mitigated": "challenge", "content-type": "text/html" });
    stream.end("<title>验证</title>");
  });
  const response = await fetchHttp2(`${url}/catalog?region=vn`, { headers: { "user-agent": "ResNodeRadar test" } });
  assert.equal(response.status, 403);
  assert.equal(response.ok, false);
  assert.equal(response.url, `${url}/catalog?region=vn`);
  assert.equal(response.headers.get("cf-mitigated"), "challenge");
  assert.equal(await response.text(), "<title>验证</title>");
});

test("HTTP/2 returns redirects without requesting their destination", async (t) => {
  let calls = 0;
  const url = await serverFor(t, (stream) => {
    calls++;
    stream.respond({ ":status": 302, location: "https://unapproved.example/catalog" });
    stream.end();
  });
  const response = await fetchHttp2(url);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://unapproved.example/catalog");
  assert.equal(calls, 1);
});

test("HTTP/2 decompresses public pages and limits decompressed size", async (t) => {
  const body = "公开套餐".repeat(100);
  const url = await serverFor(t, (stream) => {
    stream.respond({ ":status": 200, "content-encoding": "gzip" });
    stream.end(gzipSync(body));
  });
  assert.equal(await (await fetchHttp2(url)).text(), body);
  await assert.rejects(fetchHttp2(url, { maxBytes: 128 }), /larger than|size|length/i);
});

test("HTTP/2 rejects oversized responses before accepting partial catalog data", async (t) => {
  const url = await serverFor(t, (stream) => {
    stream.respond({ ":status": 200 });
    stream.end("x".repeat(1024));
  });
  await assert.rejects(fetchHttp2(url, { maxBytes: 100 }), /size limit/);
});

test("HTTP/2 source cancellation closes an unfinished request", async (t) => {
  const controller = new AbortController();
  const url = await serverFor(t, (stream) => {
    stream.respond({ ":status": 200 });
    stream.write("partial");
    controller.abort(new Error("Source time budget exceeded"));
  });
  await assert.rejects(fetchHttp2(url, { signal: controller.signal }), /Source time budget exceeded/);
  assert.throws(() => fetchHttp2(url, { signal: controller.signal }), /Source time budget exceeded/);
});
