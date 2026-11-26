import assert from "node:assert/strict";
import { test } from "node:test";
import { createOriginPacer } from "./request-pacing.mjs";

test("concurrent sources on one origin are spaced while other merchants can proceed", async () => {
  let time = 0;
  const pending = [];
  const starts = [];
  const pace = createOriginPacer({
    now: () => time,
    sleep: (delay) => new Promise((resolve) => pending.push({ at: time + delay, resolve }))
  });
  const start = async (url) => { await pace(url, 10000); starts.push([url, time]); };
  const jobs = [start("https://merchant.example/a"), start("https://merchant.example/b"), start("https://merchant.example/c"), start("https://other.example/a")];
  await new Promise(setImmediate);
  assert.deepEqual(starts, [["https://merchant.example/a", 0], ["https://other.example/a", 0]]);
  // Serialized FIFO pacing schedules the next origin sleep after the active waiter releases,
  // preventing 0ms back-to-back launches if an earlier sleep wakes late.
  assert.deepEqual(pending.map((timer) => timer.at), [10000]);
  for (const timer of pending) {
    time = timer.at;
    timer.resolve();
    await new Promise(setImmediate);
  }
  await Promise.all(jobs);
  assert.deepEqual(pending.map((timer) => timer.at), [10000, 20000]);
  assert.deepEqual(starts.slice(2), [["https://merchant.example/b", 10000], ["https://merchant.example/c", 20000]]);
});

test("sources without pacing remain immediate and expired reservations do not add delays", async () => {
  let time = 0;
  const pace = createOriginPacer({ now: () => time, sleep: () => assert.fail("Unexpected delay") });
  await pace("https://merchant.example/a");
  await pace("https://merchant.example/a", 10000);
  time = 20000;
  await pace("https://merchant.example/b", 10000);
});

test("a source deadline cancels an origin pacing wait before another HTTP request starts", async () => {
  const pace = createOriginPacer();
  await pace("https://merchant.example/a", 60_000);
  const controller = new AbortController();
  const pending = pace("https://merchant.example/b", 60_000, controller.signal);
  controller.abort(new Error("source deadline"));
  await assert.rejects(pending, /aborted|source deadline/i);
  await assert.rejects(pace("https://other.example/a", 0, controller.signal), /source deadline/);
});
