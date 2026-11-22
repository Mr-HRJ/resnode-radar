import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildCloudflare } from "./build-cloudflare.mjs";

export function buildVps(outputDirectory, siteUrl = "https://vps.bnoai.com/") {
  buildCloudflare(outputDirectory ?? fileURLToPath(new URL("../dist/", import.meta.url)), { siteUrl });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  buildVps(undefined, process.env.SITE_URL);
}
