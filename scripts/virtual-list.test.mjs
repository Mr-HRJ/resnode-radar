import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "node-html-parser";
import { mountVirtualList, renderVirtualBlocks } from "../src/components/virtual-list.js";

test("3880 records recycle in both directions, retain measured heights and release observers", (t) => {
  const items = Array.from({ length: 3880 }, (_, id) => ({ id }));
  const options = { items, table: true, size: 24, renderItem: (item, index) => `<tr data-id="${item.id}" aria-rowindex="${index + 2}"><td>Plan ${item.id}</td></tr>` };
  const root = parse(`<table>${renderVirtualBlocks(items, options)}</table>`);
  const blocks = root.querySelectorAll("[data-virtual-block]");
  assert.equal(root.querySelectorAll("[data-id]").length, 24);
  const handlers = new Map();
  const frames = new Map();
  let observer;
  let scrollY = 0;
  let frameId = 0;
  for (const [index, block] of blocks.entries()) {
    block.getBoundingClientRect = () => ({ top: index * 1536 - scrollY, bottom: (index + 1) * 1536 - scrollY, height: 1548 });
  }
  const win = {
    innerHeight: 800,
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; this.observed = []; observer = this; }
      observe(block) { this.observed.push(block); }
      disconnect() { this.observed = []; }
    },
    addEventListener(type, fn) { handlers.set(type, fn); },
    removeEventListener(type, fn) { if (handlers.get(type) === fn) handlers.delete(type); },
    requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); }
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: win, configurable: true });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : delete globalThis.window);
  const list = mountVirtualList(root, options);
  assert.equal(observer.observed.length, Math.ceil(3880 / 24));
  const scroll = (top) => {
    scrollY = top;
    handlers.get("scroll")();
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(fn => fn());
  };
  scroll(161 * 1536);
  assert.ok(root.querySelector('[data-id="3879"]'), "the last record is reachable without a load button");
  assert.equal(root.querySelector('[data-id="0"]'), null);
  assert.equal(blocks[0].querySelector("td").getAttribute("style"), "height:1548px");
  assert.ok(root.querySelectorAll("[data-id]").length <= 72);
  scroll(0);
  assert.ok(root.querySelector('[data-id="0"]'));
  assert.equal(root.querySelector('[data-id="3879"]'), null);
  list.reveal(3879);
  assert.equal(root.querySelector('[data-id="3879"]').getAttribute("aria-rowindex"), "3881");
  handlers.get("scroll")();
  list.dispose();
  assert.equal(frames.size, 0);
  assert.equal(handlers.size, 0);
  assert.equal(observer.observed.length, 0);
  const html = root.innerHTML;
  observer.callback([{ target: blocks[0], isIntersecting: false, boundingClientRect: { height: 1548 } }]);
  assert.equal(root.innerHTML, html, "late observer deliveries cannot mutate a disposed list");
});

test("card blocks align complete grid rows and do not pre-render the offscreen catalog", () => {
  const items = Array.from({ length: 3880 }, (_, id) => ({ id }));
  for (const columns of [1, 3, 5]) {
    const html = renderVirtualBlocks(items, { table: false, columns, size: columns * 6, renderItem: item => `<article data-id="${item.id}"></article>` });
    const root = parse(html);
    assert.equal(root.querySelectorAll("article").length, columns * 6);
    assert.equal(root.querySelectorAll("tbody").length, 0);
    assert.ok(root.querySelector('[data-virtual-block] .virtual-spacer'));
    assert.ok(root.querySelectorAll("*").length < 1500);
  }
});
