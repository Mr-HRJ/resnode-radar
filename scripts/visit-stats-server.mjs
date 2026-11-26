import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startVisitStatsServer } from "../apps/server/src/server.js";

export * from "../apps/server/src/server.js";

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const runtime = await startVisitStatsServer();
  console.log(`Visit stats service listening on 127.0.0.1:${runtime.port}`);
  const shutdown = async () => {
    await runtime.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
