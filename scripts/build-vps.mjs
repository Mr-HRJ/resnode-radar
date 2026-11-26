import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildCloudflare } from "./build-cloudflare.mjs";

export function buildVps(outputDirectory, siteUrl = "https://vpsld.com/") {
  const output = resolve(outputDirectory ?? fileURLToPath(new URL("../dist/", import.meta.url)));
  buildCloudflare(output, { siteUrl });

  const assets = ["static", "assets", "favicon.svg"].filter((item) =>
    existsSync(join(output, item))
  );
  const hash = createHash("sha256");

  function hashTree(dirPath, relative) {
    for (const entry of readdirSync(dirPath, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        hashTree(join(dirPath, entry.name), name);
      } else {
        hash.update(name).update("\0").update(readFileSync(join(dirPath, entry.name))).update("\0");
      }
    }
  }

  for (const asset of assets) {
    if (asset.includes(".")) {
      hash.update(asset).update("\0").update(readFileSync(join(output, asset))).update("\0");
    } else {
      hashTree(join(output, asset), asset);
    }
  }

  const revision = hash.digest("hex").slice(0, 16);
  const target = join(output, "static", revision);
  mkdirSync(target, { recursive: true });

  // Copy compiled Vite chunks + public assets into content-addressed `/static/<revision>/...`
  for (const asset of assets) {
    if (asset === "static") {
      const innerStatic = join(target, "static");
      mkdirSync(innerStatic, { recursive: true });
      for (const entry of readdirSync(join(output, "static"), { withFileTypes: true })) {
        if (entry.name === revision) continue;
        cpSync(join(output, "static", entry.name), join(innerStatic, entry.name), {
          recursive: true
        });
      }
    } else {
      cpSync(join(output, asset), join(target, asset), { recursive: true });
    }
  }

  const pages = [
    "index.html",
    ...readdirSync(join(output, "reviews"))
      .filter((name) => name.endsWith(".html"))
      .map((name) => `reviews/${name}`)
  ];

  for (const page of pages) {
    const htmlPath = join(output, page);
    writeFileSync(
      htmlPath,
      readFileSync(htmlPath, "utf8").replace(
        /\b(src|href)="(?:\.\.\/|\.\/)?((?:static|assets)\/[^"?#]+|favicon\.svg)"/g,
        `$1="/static/${revision}/$2"`
      )
    );
  }

  return { revision };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  buildVps(undefined, process.env.SITE_URL);
}
