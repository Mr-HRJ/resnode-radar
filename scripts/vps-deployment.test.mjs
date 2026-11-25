import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildVps } from "./build-vps.mjs";

test("VPS assets use the production origin and leave collection data outside the public build", () => {
  const output = mkdtempSync(join(tmpdir(), "resnode-vps-test-"));
  try {
    const first = buildVps(output);
    assert.match(first.revision, /^[a-f0-9]{16}$/);
    for (const file of ["index.html", "reviews/aaitr.html", "reviews/lisahost.html", "sitemap.xml", "robots.txt"]) {
      const body = readFileSync(join(output, file), "utf8");
      assert.match(body, /https:\/\/vpsld\.com\//, file);
      assert.doesNotMatch(body, /majiayu000\.github\.io|haorenjie1997\.workers\.dev/, file);
    }
    for (const file of [".git", ".env", "data", "scripts", "monitor", "deploy", "node_modules"]) {
      assert.equal(existsSync(join(output, file)), false, file);
      assert.equal(existsSync(join(output, "static", first.revision, file)), false, file);
    }
    for (const page of ["index.html", "reviews/aaitr.html", "reviews/lisahost.html"]) {
      const html = readFileSync(join(output, page), "utf8");
      const references = [...html.matchAll(/(?:src|href)="(\/static\/[^"?#]+)"/g)].map(match => match[1]);
      assert.ok(references.length >= 5, page);
      for (const reference of references) assert.ok(existsSync(join(output, reference)), reference);
    }
    const moduleRoot = join(output, "static", first.revision);
    assert.equal(readFileSync(join(moduleRoot, "src/domain/catalog.js"), "utf8"), readFileSync(join(output, "src/domain/catalog.js"), "utf8"));
    assert.ok(existsSync(join(moduleRoot, "providers.js")), "relative module imports remain resolvable");
    const second = buildVps(output, "https://radar.example/");
    assert.equal(second.revision, first.revision, "origin changes do not invalidate unchanged assets");
    assert.match(readFileSync(join(output, "index.html"), "utf8"), /https:\/\/radar\.example\//);
    assert.throws(() => buildVps(output, "http://radar.example/"), /HTTPS origin/);

    const nginxHttps = readFileSync(new URL("../deploy/vps/nginx-https.conf", import.meta.url), "utf8");
    assert.match(nginxHttps, /location = \/api\/stats\b/);
    assert.match(nginxHttps, /proxy_pass http:\/\/127\.0\.0\.1:18920;/);
    const statsService = readFileSync(new URL("../deploy/vps/resnode-radar-stats.service", import.meta.url), "utf8");
    assert.match(statsService, /scripts\/visit-stats-server\.mjs/);
    assert.doesNotMatch(statsService, /STATS_BOOST/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
