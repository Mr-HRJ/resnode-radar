import assert from "node:assert/strict";
import { test } from "node:test";
import { transportErrorDetails } from "./transport-errors.mjs";

test("DNS diagnostics retain the hostname and distinguish permanent lookup failures from transient ones", () => {
  for (const code of ["ENOTFOUND", "EAI_AGAIN"]) {
    const error = new TypeError("fetch failed", { cause: { code, hostname: "www.vmvm.io" } });
    const details = transportErrorDetails(error, "https://example.com");
    assert.equal(details.code, code);
    assert.equal(details.hostname, "www.vmvm.io");
    assert.match(details.message, new RegExp(code));
    assert.match(details.message, /www\.vmvm\.io/);
    assert.match(details.message, code === "ENOTFOUND" ? /无法解析/ : /临时/);
  }
});

test("direct HTTP/2 errors and non-transport parser errors keep their cause", () => {
  assert.equal(transportErrorDetails(Object.assign(new Error("reset"), { code: "ECONNRESET" })).message, "reset [ECONNRESET]");
  assert.deepEqual(transportErrorDetails(new Error("Plan schema changed")), { message: "Plan schema changed", code: null, hostname: null });
  assert.equal(transportErrorDetails(new Error("Invalid source URL"), "not a URL").message, "Invalid source URL");
});
