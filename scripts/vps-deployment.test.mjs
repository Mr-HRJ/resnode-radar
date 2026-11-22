import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildVps } from "./build-vps.mjs";

test("VPS assets use the production origin and leave collection data outside the public build", () => {
  const output = mkdtempSync(join(tmpdir(), "resnode-vps-test-"));
  try {
    buildVps(output);
    for (const file of ["index.html", "reviews/aaitr.html", "reviews/lisahost.html", "sitemap.xml", "robots.txt"]) {
      const body = readFileSync(join(output, file), "utf8");
      assert.match(body, /https:\/\/vps\.bnoai\.com\//, file);
      assert.doesNotMatch(body, /majiayu000\.github\.io|haorenjie1997\.workers\.dev/, file);
    }
    for (const file of [".git", ".env", "data", "scripts", "monitor", "deploy", "node_modules"]) {
      assert.equal(existsSync(join(output, file)), false, file);
    }
    buildVps(output, "https://radar.example/");
    assert.match(readFileSync(join(output, "index.html"), "utf8"), /https:\/\/radar\.example\//);
    assert.throws(() => buildVps(output, "http://radar.example/"), /HTTPS origin/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
