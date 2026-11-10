import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sourceUrl = "https://www.racknerd.com/kvm-vps";
const monitorPath = fileURLToPath(new URL("./monitor.mjs", import.meta.url));
const validatorPath = fileURLToPath(new URL("./validate-monitor-data.mjs", import.meta.url));
const row = ({ memory = "512 MB RAM", price = "$26.99 /year", order = '<a href="https://my.racknerd.com/cart.php?a=add&amp;pid=1">ORDER NOW</a>' } = {}) =>
  `<tr><td>${memory}</td><td>1 vCore</td><td>30 GB RAID-10 SSD</td><td>500 GB @ 1Gbps</td><td>1 Free IP</td><td>${price}</td><td>${order}</td></tr>`;
const table = (rows) => `<table class="plan-list"><tr>${["Plan", "CPU", "SSD Storage", "Bandwidth", "IPv4", "Pricing", "Order"].map((x) => `<th>${x}</th>`).join("")}</tr>${rows}<tr><td colspan="7"></td></tr></table>`;

function runMonitor(html) {
  const dir = mkdtempSync(join(tmpdir(), "resnode-racknerd-test-"));
  try {
    mkdirSync(join(dir, "monitor"));
    writeFileSync(join(dir, "monitor/sources.json"), JSON.stringify([{
      id: "racknerd-kvm", provider: "RackNerd", category: "vps", adapter: "racknerd_kvm", url: sourceUrl
    }]));
    writeFileSync(join(dir, "page.html"), html);
    writeFileSync(join(dir, "mock-fetch.mjs"), `
      import { readFileSync } from "node:fs";
      globalThis.fetch = async (url) => {
        if (String(url) !== ${JSON.stringify(sourceUrl)}) throw new Error("Unexpected offline request");
        const response = new Response(readFileSync("page.html", "utf8"));
        Object.defineProperty(response, "url", { value: ${JSON.stringify(sourceUrl)} });
        return response;
      };
    `);
    execFileSync(process.execPath, ["--import", join(dir, "mock-fetch.mjs"), monitorPath], {
      cwd: dir, env: { ...process.env, MONITOR_FETCH_RETRIES: "0", MONITOR_CONCURRENCY: "1" }, stdio: "pipe"
    });
    execFileSync(process.execPath, [validatorPath], { cwd: dir, stdio: "pipe" });
    return JSON.parse(readFileSync(join(dir, "data/products.json"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("RackNerd official table preserves billing periods, VPS category, SKU and order-entry evidence", () => {
  const { products, summary } = runMonitor(table(row() + row({ memory: "1 GB RAM", price: "$17.99 /month", order: '<a href="https://my.racknerd.com/cart.php?a=add&amp;pid=20">ORDER NOW</a>' })));
  assert.equal(summary.total, 2);
  const byId = new Map(products.map((p) => [p.id, p]));
  const annual = byId.get("racknerd-kvm:pid:1");
  assert.equal(annual.category, "vps");
  assert.equal(annual.price, "$26.99 /year");
  assert.equal(annual.priceValue, 26.99);
  assert.equal(annual.hardware, "1 vCore / 512 MB RAM / 30 GB RAID-10 SSD");
  assert.equal(annual.stockCount, null);
  assert.equal(annual.statusLabel, "可订购入口");
  assert.equal(annual.evidenceLevel.value, "official-order");
  assert.equal(annual.orderUrl, "https://my.racknerd.com/cart.php?a=add&pid=1");
  assert.equal(byId.get("racknerd-kvm:pid:20").price, "$17.99 /month");
});

test("RackNerd sold-out, absent and disabled purchase links do not create available stock", () => {
  const { products } = runMonitor(table(
    row({ memory: "1 GB RAM", order: "Sold Out" }) +
    row({ memory: "2 GB RAM", order: "Contact us" }) +
    row({ memory: "4 GB RAM", order: '<a class="disabled" href="https://my.racknerd.com/cart.php?a=add&amp;pid=22">ORDER NOW</a>' })
  ));
  const soldOut = products.find((p) => p.name.includes("1 GB"));
  assert.equal(soldOut.status, "unavailable");
  assert.equal(soldOut.stockCount, 0);
  assert.ok(products.every((p) => p.status !== "available" && p.orderUrl === null));
  assert.equal(products.filter((p) => p.status === "unknown").length, 2);
});

test("RackNerd layout drift and foreign order URLs produce explicit errors", () => {
  for (const html of [table(row()).replace("<th>Pricing</th>", "<th>Changed</th>"), table(row({ order: '<a href="https://example.invalid/cart.php?a=add&amp;pid=1">ORDER NOW</a>' }))]) {
    const { products, summary } = runMonitor(html);
    assert.equal(summary.error, 1);
    assert.equal(summary.available, 0);
    assert.equal(products[0].category, "vps");
  }
});
