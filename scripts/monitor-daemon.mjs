import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDaemonArgs, startMonitorDaemon } from "../apps/collector/src/daemon.js";

export * from "../apps/collector/src/daemon.js";

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const opts = parseDaemonArgs();
  const handle = await startMonitorDaemon(opts);
  if (opts.once && handle.state.lastError) process.exitCode = 1;
  const shutdown = async () => {
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
