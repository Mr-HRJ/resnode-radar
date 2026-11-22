import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publishSnapshot } from "./publish-snapshot.mjs";

test("optional publication writes only the data branch and preserves unrelated staged/unstaged work", async () => {
  const root = mkdtempSync(join(tmpdir(), "resnode-publish-test-"));
  const cwd = join(root, "work");
  const remote = join(root, "remote.git");
  mkdirSync(cwd);
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.test");
    git("init", "--bare", remote);
    git("remote", "add", "origin", remote);
    writeFileSync(join(cwd, "user.txt"), "original\n");
    git("add", "user.txt");
    git("commit", "-m", "Fixture baseline");
    const head = git("rev-parse", "HEAD");
    writeFileSync(join(cwd, "user.txt"), "staged change\n");
    git("add", "user.txt");
    writeFileSync(join(cwd, "user.txt"), "unstaged change\n");
    mkdirSync(join(cwd, "data"));
    // Real snapshots exceed execFile's default 1 MiB output buffer.
    writeFileSync(join(cwd, "data/products.json"), JSON.stringify({ generatedAt: "2026-11-22T00:00:00Z", padding: "x".repeat(1_100_000) }));
    const status = git("status", "--porcelain");
    const logger = { log() {} };
    assert.equal(await publishSnapshot(cwd, { logger }), true);
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.equal(git("status", "--porcelain"), status);
    assert.equal(git("show", ":user.txt"), "staged change");
    assert.equal(readFileSync(join(cwd, "user.txt"), "utf8"), "unstaged change\n");
    assert.equal(git("--git-dir", remote, "ls-tree", "-r", "--name-only", "data"), "data/products.json");
    assert.equal(await publishSnapshot(cwd, { logger }), false);
    writeFileSync(join(cwd, "data/products.json"), JSON.stringify({ generatedAt: "2026-11-22T01:00:00Z" }));
    assert.equal(await publishSnapshot(cwd, { logger }), true);
    writeFileSync(join(cwd, "data/products.json"), JSON.stringify({ generatedAt: "2026-11-21T00:00:00Z" }));
    await assert.rejects(publishSnapshot(cwd, { logger }), /newer/);
    assert.equal(git("rev-parse", "HEAD"), head);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
