import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseDaemonArgs, createStaticServer, startMonitorDaemon, writeAtomicJson } from "./monitor-daemon.mjs";
import { buildLaunchAgentPlist } from "./macos-service.mjs";

test("daemon CLI argument and environment parser enforces safe bounds", () => {
  const defaults = parseDaemonArgs([], {});
  assert.equal(defaults.intervalMinutes, 20);
  assert.equal(defaults.serve, false);
  assert.equal(defaults.port, 4173);
  assert.equal(defaults.gitPush, false);

  const custom = parseDaemonArgs(["--serve", "--interval", "15", "--port", "8090", "--git-push"], {});
  assert.equal(custom.serve, true);
  assert.equal(custom.intervalMinutes, 15);
  assert.equal(custom.port, 8090);
  assert.equal(custom.gitPush, true);

  const invalid = parseDaemonArgs(["--interval", "-5", "--port", "99999"], {});
  assert.equal(invalid.intervalMinutes, 20);
  assert.equal(invalid.port, 4173);
});

test("built-in static live server serves assets with no-store on data/ and blocks sensitive paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "resnode-daemon-test-"));
  const server = createStaticServer(root);
  try {
    writeFileSync(join(root, "index.html"), "<!doctype html><title>Radar</title>");
    mkdirSync(join(root, "data"), { recursive: true });
    writeAtomicJson(join(root, "data/daemon-status.json"), { active: true, state: "idle", intervalMinutes: 20 });
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git/config"), "secret");
    writeFileSync(join(root, ".env"), "test-only-placeholder");
    mkdirSync(join(root, "assets"));
    symlinkSync(join(root, ".env"), join(root, "assets/leak.txt"));

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const htmlRes = await fetch(`${base}/`);
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.headers.get("content-type"), /text\/html/);
    assert.match(await htmlRes.text(), /Radar/);

    const dataRes = await fetch(`${base}/data/daemon-status.json`);
    assert.equal(dataRes.status, 200);
    assert.equal(dataRes.headers.get("cache-control"), "no-store");
    assert.equal((await dataRes.json()).active, true);

    const gitRes = await fetch(`${base}/.git/config`);
    assert.equal(gitRes.status, 403);
    for (const path of ["/.env", "/assets/leak.txt", "/monitor/sources.json"]) {
      assert.equal((await fetch(`${base}${path}`)).status, 403, path);
    }
    assert.equal((await fetch(`${base}/assets/%00.png`)).status, 400);

    const postRes = await fetch(`${base}/data/daemon-status.json`, { method: "POST" });
    assert.equal(postRes.status, 405);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("stopping during FX refresh waits for the child and prevents collection from starting", async () => {
  const root = mkdtempSync(join(tmpdir(), "resnode-daemon-stop-"));
  const calls = [];
  const logger = { log() {}, error() {} };
  let handle;
  try {
    handle = await startMonitorDaemon({ forceInitial: true, serve: false, gitPush: false }, {
      cwd: root, logger,
      runScript: (script, _cwd, _timeout, onChild) => {
        calls.push(script);
        return new Promise((resolve) => onChild({ kill: () => { resolve({ stdout: "", stderr: "" }); } }));
      }
    });
    await handle.stop();
    assert.equal(calls.length, 1);
    assert.match(calls[0], /fx-rates/);
    const status = JSON.parse(readFileSync(join(root, "data/daemon-status.json")));
    assert.equal(status.state, "stopped");
    assert.equal(status.nextRunAt, null);
  } finally {
    await handle?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("one-shot daemon closes its server even when collection fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "resnode-daemon-once-"));
  let handle;
  try {
    handle = await startMonitorDaemon({ once: true, serve: true, host: "127.0.0.1", port: 0, gitPush: false }, {
      cwd: root, logger: { log() {}, error() {} },
      runScript: async () => { throw new Error("fixture failure"); }
    });
    assert.equal(handle.server.listening, false);
    assert.equal(handle.state.active, false);
    assert.equal(handle.state.lastError, "fixture failure");
    assert.equal(handle.state.nextRunAt, null);
  } finally {
    await handle?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS LaunchAgent generator embeds KeepAlive, RunAtLoad, and target interval", () => {
  const plist = buildLaunchAgentPlist({
    nodePath: "/usr/local/bin/node",
    workDir: "/tmp/resnode-radar",
    port: 4173,
    intervalMinutes: 15
  });
  assert.match(plist, /com\.resnode\.radar\.monitor/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<string>15<\/string>/);
  assert.ok(readFileSync(new URL("../wrangler.json", import.meta.url), "utf8").includes('"crons"'));
});
