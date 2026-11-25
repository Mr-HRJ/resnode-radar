// Keep natural row/card heights while recycling offscreen blocks. Placeholders
// preserve the document scrollbar; filtering and sorting still use every item.
export function renderVirtualSpacer(height, table) {
  return table
    ? `<tr class="virtual-spacer" aria-hidden="true"><td colspan="8" style="height:${height}px"></td></tr>`
    : `<div class="virtual-spacer" aria-hidden="true" style="height:${height}px"></div>`;
}

export function renderVirtualBlocks(items, { table, size, columns = 1, renderItem }) {
  const blocks = [];
  for (let start = 0; start < items.length; start += size) {
    const count = Math.min(size, items.length - start);
    const height = table ? count * 64 : Math.ceil(count / columns) * 250;
    const content = start === 0
      ? items.slice(start, start + size).map((item, index) => renderItem(item, start + index)).join("")
      : renderVirtualSpacer(height, table);
    const attrs = `data-virtual-block="${start}" data-virtual-height="${height}"${start === 0 ? ' data-mounted="true"' : ""}`;
    blocks.push(table
      ? `<tbody ${attrs}>${content}</tbody>`
      : `<div ${attrs} class="plan-grid virtual-card-block" style="--virtual-columns:${columns}">${content}</div>`);
  }
  return blocks.join("");
}

export function mountVirtualList(root, { items, table, size, renderItem }) {
  const win = globalThis.window;
  const blocks = Array.from(root.querySelectorAll("[data-virtual-block]"));
  let disposed = false;
  let frame = 0;
  const observer = typeof win?.IntersectionObserver === "function"
    ? new win.IntersectionObserver(update, { rootMargin: "700px 0px" })
    : null;

  function mount(block) {
    if (block.hasAttribute("data-mounted")) return;
    const start = Number(block.getAttribute("data-virtual-block"));
    block.innerHTML = items.slice(start, start + size).map((item, index) => renderItem(item, start + index)).join("");
    block.setAttribute("data-mounted", "true");
  }

  function update(entries) {
    if (disposed) return;
    // Read all heights before DOM writes to avoid repeated synchronous layouts.
    const changes = entries.map(entry => ({
      block: entry.target,
      visible: entry.isIntersecting,
      height: entry.boundingClientRect.height
    }));
    for (const { block, visible, height } of changes) {
      if (visible) {
        mount(block);
      } else if (block.hasAttribute("data-mounted") && !block.contains?.(root.ownerDocument?.activeElement)) {
        if (height > 0) block.setAttribute("data-virtual-height", String(height));
        block.innerHTML = renderVirtualSpacer(Number(block.getAttribute("data-virtual-height")), table);
        block.removeAttribute("data-mounted");
      }
    }
  }

  function syncViewport() {
    frame = 0;
    if (disposed || !blocks[0]?.getBoundingClientRect) return;
    update(blocks.map(block => {
      const rect = block.getBoundingClientRect();
      return { target: block, boundingClientRect: rect, isIntersecting: rect.bottom >= -700 && rect.top <= win.innerHeight + 700 };
    }));
  }

  function scheduleSync() {
    if (!frame && !disposed) frame = win.requestAnimationFrame(syncViewport);
  }

  syncViewport();
  for (const block of blocks) observer?.observe(block);
  // Also covers browsers without IntersectionObserver and evicts blocks whose
  // focused button kept them alive when they first left the viewport.
  win?.addEventListener?.("scroll", scheduleSync, { passive: true });
  root.addEventListener?.("focusout", scheduleSync);

  return {
    reveal(index) {
      const block = blocks[Math.floor(index / size)];
      if (block) mount(block);
    },
    dispose() {
      disposed = true;
      observer?.disconnect();
      if (frame) win.cancelAnimationFrame(frame);
      win?.removeEventListener?.("scroll", scheduleSync);
      root.removeEventListener?.("focusout", scheduleSync);
    }
  };
}
