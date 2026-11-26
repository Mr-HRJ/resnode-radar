import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCollection } from "../apps/collector/src/runner.js";

export * from "../apps/collector/src/runner.js";

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCollection({
    cwd: process.cwd(),
    env: process.env,
    argv: process.argv.slice(2),
    logger: console
  });
}
