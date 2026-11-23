import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildCloudflare } from "./build-cloudflare.mjs";

export function buildVps(outputDirectory, siteUrl = "https://vpsld.com/") {
  const output = outputDirectory ?? fileURLToPath(new URL("../dist/", import.meta.url));
  buildCloudflare(output, { siteUrl });
  const assets = ["styles", "src", "assets", "providers.js", "pricing.js", "saved.js", "favicon.svg"];
  const hash = createHash("sha256");
  function hashTree(path, relative) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) hashTree(join(path, entry.name), name);
      else hash.update(name).update("\0").update(readFileSync(join(path, entry.name))).update("\0");
    }
  }
  for (const asset of assets) {
    if (asset.includes(".")) hash.update(asset).update("\0").update(readFileSync(join(output, asset))).update("\0");
    else hashTree(join(output, asset), asset);
  }
  const revision = hash.digest("hex").slice(0, 16);
  const target = join(output, "static", revision);
  mkdirSync(target, { recursive: true });
  // Preserve relative module imports inside a content-addressed asset tree.
  for (const asset of assets) cpSync(join(output, asset), join(target, asset), { recursive: true });
  for (const page of ["index.html", ...readdirSync(join(output, "reviews")).filter(name => name.endsWith(".html")).map(name => `reviews/${name}`)]) {
    const path = join(output, page);
    writeFileSync(path, readFileSync(path, "utf8").replace(
      /\b(src|href)="(?:\.\.\/|\.\/)?((?:styles|src|assets)\/[^"?#]+|favicon\.svg)"/g,
      `$1="/static/${revision}/$2"`
    ));
  }
  return { revision };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  buildVps(undefined, process.env.SITE_URL);
}
