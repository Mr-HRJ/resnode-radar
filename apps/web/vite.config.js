import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const webRoot = fileURLToPath(new URL("./", import.meta.url));
const repoRoot = resolve(webRoot, "../..");

function localDataMiddleware() {
  return {
    name: "resnode-radar-local-data",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const urlPath = (req.url || "").split("?")[0];
        if (!urlPath.startsWith("/data/")) return next();
        const rel = urlPath.replace(/^\/+/, "");
        if (rel.includes("..") || rel.endsWith(".sqlite") || rel.includes("/.")) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }
        const target = join(repoRoot, rel);
        if (!existsSync(target)) return next();
        res.setHeader(
          "Content-Type",
          extname(target) === ".json" ? "application/json; charset=utf-8" : "application/octet-stream"
        );
        res.setHeader("Cache-Control", "no-store");
        res.end(readFileSync(target));
      });
    }
  };
}

export default defineConfig({
  root: webRoot,
  base: "./",
  plugins: [vue(), localDataMiddleware()],
  resolve: {
    alias: {
      "@resnode-radar/contracts": resolve(repoRoot, "packages/contracts/src/index.js")
    }
  },
  build: {
    outDir: resolve(repoRoot, "dist"),
    emptyOutDir: true,
    assetsDir: "static",
    rollupOptions: {
      input: {
        main: resolve(webRoot, "index.html"),
        aaitr: resolve(webRoot, "reviews/aaitr.html"),
        lisahost: resolve(webRoot, "reviews/lisahost.html")
      }
    }
  },
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.{js,mjs}"]
  }
});
