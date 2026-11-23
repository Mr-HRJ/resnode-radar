import http from "node:http";
import { init, request } from "rsshub";

await init({ CACHE_TYPE: "memory", CACHE_EXPIRE: 300, ALLOW_ORIGIN: "http://127.0.0.1", LOGGER_LEVEL: "warn", NO_LOGFILES: true });
// Only explicitly configured public channels are exposed to the local collector.
const routes = new Set(["/telegram/channel/vmiss_com"]);
http.createServer(async (req, res) => {
  if (req.method !== "GET") { res.writeHead(405).end(); return; }
  if (req.url === "/healthz") { res.writeHead(200).end("ok"); return; }
  if (!routes.has(req.url)) { res.writeHead(404).end(); return; }
  try {
    const payload = await request(req.url);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(payload));
  } catch {
    res.writeHead(502, { "content-type": "application/json" }).end('{"error":"Public channel unavailable"}');
  }
}).listen(12180, "127.0.0.1");
