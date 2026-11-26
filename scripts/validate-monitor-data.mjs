import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  validateMonitorPayload,
  validateV2PublishedData
} from "../apps/collector/src/validate.js";

export { validateMonitorPayload, validateV2PublishedData };

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const outPath = process.env.MONITOR_OUTPUT || "data/products.json";
    const v1Bytes = readFileSync(outPath);
    const payload = JSON.parse(v1Bytes.toString("utf8"));
    const sourcesPath = existsSync("monitor/sources.json")
      ? "monitor/sources.json"
      : new URL("../apps/collector/config/sources.json", import.meta.url);
    const sources = JSON.parse(readFileSync(sourcesPath, "utf8"));
    const only = new Set((process.env.MONITOR_ONLY || "").split(",").filter(Boolean));
    const errors = [
      ...validateMonitorPayload(payload, {
        expectedSourceIds: sources
          .filter((s) => !only.size || only.has(s.id))
          .map((s) => s.id)
      }),
      ...(!only.size ? validateV2PublishedData({ dataDir: dirname(resolve(outPath)), fullPayload: payload, v1Bytes }) : [])
    ];
    for (const error of errors) console.error(error);
    if (errors.length) process.exitCode = 1;
    else {
      console.log(
        `Validated ${payload.products.length} monitor records and ${payload.events.length} events`
      );
    }
  } catch (error) {
    console.error(`Monitor data validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
