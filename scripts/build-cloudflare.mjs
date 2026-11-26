import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const webRoot = join(projectRoot, "apps/web");
const viteBin = join(projectRoot, "node_modules/vite/bin/vite.js");

const CANONICAL_ORIGINS = [
  "https://vpsld.com/",
  "https://majiayu000.github.io/resnode-radar/"
];
const REPO_URLS = [
  "https://github.com/Mr-HRJ/resnode-radar",
  "https://github.com/majiayu000/resnode-radar"
];

export function buildCloudflare(outputDirectory = join(projectRoot, "dist"), { siteUrl } = {}) {
  const outDir = resolve(outputDirectory);
  const config = JSON.parse(readFileSync(join(projectRoot, "wrangler.json"), "utf8"));
  const site = new URL(siteUrl ?? config.vars.SITE_URL);
  if (site.protocol !== "https:" || site.pathname !== "/" || site.search || site.hash) {
    throw new Error("SITE_URL must be an HTTPS origin with a trailing slash");
  }
  const repository = `https://github.com/${config.vars.DATA_REPOSITORY}`;

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  execFileSync(
    process.execPath,
    [viteBin, "build", "--outDir", outDir, "--emptyOutDir"],
    {
      cwd: webRoot,
      stdio: "pipe"
    }
  );

  cpSync(join(projectRoot, "LICENSE"), join(outDir, "LICENSE"));

  const htmlPages = [
    "index.html",
    ...readdirSync(join(outDir, "reviews"))
      .filter((name) => name.endsWith(".html"))
      .map((name) => `reviews/${name}`)
  ];

  for (const file of htmlPages) {
    const htmlPath = join(outDir, file);
    let html = readFileSync(htmlPath, "utf8");
    for (const orig of CANONICAL_ORIGINS) {
      html = html.replaceAll(orig, site.href);
    }
    for (const repo of REPO_URLS) {
      html = html.replaceAll(repo, repository);
    }
    writeFileSync(htmlPath, html);
  }

  // Only include indexable canonical URLs in sitemap.xml (draft review pages carry noindex)
  writeFileSync(
    join(outDir, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${site.href}</loc></url></urlset>\n`
  );
  writeFileSync(
    join(outDir, "robots.txt"),
    `User-agent: *\nAllow: /\nSitemap: ${site.href}sitemap.xml\n`
  );
  console.log(`Browser assets ready: ${outDir}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  buildCloudflare();
}
