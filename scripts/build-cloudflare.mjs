import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const originalSite = "https://majiayu000.github.io/resnode-radar/";
const originalRepository = "https://github.com/majiayu000/resnode-radar";

export function buildCloudflare(outputDirectory = join(projectRoot, "dist")) {
  const config = JSON.parse(readFileSync(join(projectRoot, "wrangler.json"), "utf8"));
  const site = new URL(config.vars.SITE_URL);
  if (site.protocol !== "https:" || site.pathname !== "/" || site.search || site.hash) {
    throw new Error("SITE_URL must be an HTTPS origin with a trailing slash");
  }
  const repository = `https://github.com/${config.vars.DATA_REPOSITORY}`;
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });

  // Publish only browser assets. Collector code, Git metadata, dependencies and
  // the old bundled inventory snapshot are deliberately outside the upload.
  for (const file of ["index.html", "styles.css", "radar.css", "providers.js", "directory.js", "pricing.js", "app.js", "filter.js", "product.js", "product-view.js", "discovery.js", "saved.js", "icons.js", "state.js", "util.js", "favicon.svg", "assets", "reviews", "LICENSE"]) {
    cpSync(join(projectRoot, file), join(outputDirectory, file), { recursive: true });
  }
  for (const file of ["index.html", ...readdirSync(join(outputDirectory, "reviews")).filter((name) => name.endsWith(".html")).map((name) => `reviews/${name}`)]) {
    const path = join(outputDirectory, file);
    const html = readFileSync(path, "utf8")
      .replaceAll(originalSite, site.href)
      .replaceAll(originalRepository, repository);
    writeFileSync(path, html);
  }
  writeFileSync(join(outputDirectory, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${site.href}</loc></url></urlset>\n`);
  writeFileSync(join(outputDirectory, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${site.href}sitemap.xml\n`);
  console.log(`Cloudflare assets ready: ${outputDirectory}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  buildCloudflare();
}
