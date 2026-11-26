import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStaticServer } from "../apps/collector/src/daemon.js";
import { buildCloudflare } from "./build-cloudflare.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export function parseStaticArgs(argv = process.argv.slice(2), env = process.env) {
  const args = {
    host: env.HOST || "127.0.0.1",
    port: Number(env.PORT ?? 4173),
    rootDir: env.STATIC_ROOT ? resolve(env.STATIC_ROOT) : projectRoot,
    rebuild: env.FORCE_BUILD === "1"
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--port" && argv[i + 1]) args.port = Number(argv[++i]);
    else if (token === "--host" && argv[i + 1]) args.host = argv[++i];
    else if (token === "--root" && argv[i + 1]) args.rootDir = resolve(argv[++i]);
    else if (token === "--rebuild") args.rebuild = true;
  }

  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65_535) {
    args.port = 4173;
  }
  return args;
}

export async function startStaticPreview(rawOptions = {}, { logger = console } = {}) {
  const options = { ...parseStaticArgs([]), ...rawOptions };
  const rootDir = resolve(options.rootDir || projectRoot);
  const distDir = join(rootDir, "dist");

  if (options.rebuild || !existsSync(join(distDir, "index.html"))) {
    buildCloudflare(distDir);
  }

  const server = createStaticServer(rootDir, {
    statsDbPath: options.statsDbPath
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port, options.host, resolveListen);
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : options.port;
  const url = `http://${options.host}:${port}/`;
  logger.log?.(`[serve:static] Static preview serving at ${url} (collector disabled)`);

  return {
    server,
    port,
    url,
    close() {
      return new Promise((resolveClose) => server.close(() => resolveClose()));
    }
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const opts = parseStaticArgs();
  const runtime = await startStaticPreview(opts);
  const shutdown = async () => {
    await runtime.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
