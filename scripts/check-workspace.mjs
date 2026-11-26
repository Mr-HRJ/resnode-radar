import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const EXCLUDED_DIRS = new Set([
  ".git",
  ".agents",
  "node_modules",
  "dist",
  "logs",
  "data"
]);

const FORBIDDEN_TS_EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const JS_EXTS = new Set([".js", ".mjs"]);

const jsFiles = [];
const tsViolations = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(rootDir, full).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      if (rel === "deploy/vps/feeds") continue;
      walk(full);
      continue;
    }

    if (!entry.isFile()) continue;
    if (/^tsconfig(\..+)?\.json$/i.test(entry.name)) {
      tsViolations.push(rel);
      continue;
    }
    const ext = extname(entry.name).toLowerCase();
    if (FORBIDDEN_TS_EXTS.has(ext)) {
      tsViolations.push(rel);
    } else if (JS_EXTS.has(ext)) {
      jsFiles.push(full);
    }
  }
}

walk(rootDir);

if (tsViolations.length > 0) {
  console.error("Zero-TypeScript policy violated! Found TypeScript files:");
  for (const v of tsViolations) console.error(`  - ${v}`);
  process.exit(1);
}

for (const file of jsFiles.sort()) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

// Compile-check all Vue 3 SFCs via Vite build into a disposable temp folder
const tmpDist = mkdtempSync(join(tmpdir(), "resnode-vite-check-"));
try {
  const viteBin = join(rootDir, "node_modules/vite/bin/vite.js");
  execFileSync(
    process.execPath,
    [viteBin, "build", "--outDir", tmpDist, "--emptyOutDir"],
    {
      cwd: join(rootDir, "apps/web"),
      stdio: "pipe"
    }
  );
} finally {
  rmSync(tmpDist, { recursive: true, force: true });
}

// Verify root & scripts/* backward-compatible module shims resolve cleanly
const shimPaths = [
  "providers.js",
  "pricing.js",
  "saved.js",
  "scripts/monitor.mjs",
  "scripts/monitor-daemon.mjs",
  "scripts/visit-stats-server.mjs",
  "scripts/validate-monitor-data.mjs",
  "scripts/fx-rates.mjs"
];
for (const rel of shimPaths) {
  await import(pathToFileURL(resolve(rootDir, rel)).href);
}

console.log(
  `Checked ${jsFiles.length} JS/MJS files (0 TypeScript files), compiled Vue 3 SFC bundle, and verified ${shimPaths.length} compatibility shims.`
);
