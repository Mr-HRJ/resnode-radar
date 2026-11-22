import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

// A separate index keeps the user's branch, staged changes and working tree intact.
// A normal push also refuses to overwrite a concurrent CI publication.
export async function publishSnapshot(cwd, { branch = "data", logger = console } = {}) {
  const git = async (args, env) => (await exec("git", args, { cwd, env, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
  await git(["check-ref-format", `refs/heads/${branch}`]);
  const ref = `refs/heads/${branch}`;
  const published = await git(["ls-remote", "--heads", "origin", ref]);
  const head = published.split(/\s/)[0];
  const snapshot = JSON.parse(readFileSync(join(cwd, "data/products.json"), "utf8"));
  if (!Number.isFinite(Date.parse(snapshot.generatedAt))) throw new Error("Snapshot has no valid collection time");
  if (head) {
    await git(["fetch", "--no-tags", "origin", head]);
    const previous = JSON.parse(await git(["show", `${head}:data/products.json`]));
    if (!Number.isFinite(Date.parse(previous.generatedAt)) || Date.parse(previous.generatedAt) > Date.parse(snapshot.generatedAt)) {
      throw new Error("Refusing to replace a newer or invalid published snapshot");
    }
  }

  const temp = mkdtempSync(join(tmpdir(), "resnode-publish-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(temp, "index") };
    await git(["read-tree", "--empty"], env);
    const files = ["data/products.json", ...(existsSync(join(cwd, "data/fx.json")) ? ["data/fx.json"] : [])];
    await git(["add", "-f", "--", ...files], env);
    const tree = await git(["write-tree"], env);
    if (head && tree === await git(["rev-parse", `${head}^{tree}`])) return false;
    const commit = await git(["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", `Publish monitored VPS data (${snapshot.generatedAt})`]);
    await git(["push", "origin", `${commit}:${ref}`]);
    logger.log(`[daemon] Published monitor snapshot to origin/${branch}`);
    return true;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
