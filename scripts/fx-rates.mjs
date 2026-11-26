import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { updateRates } from "../apps/collector/src/fx/fx-rates.js";

export * from "../apps/collector/src/fx/fx-rates.js";

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await updateRates();
}
