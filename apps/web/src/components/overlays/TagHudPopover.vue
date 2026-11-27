<script setup>
import { nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useZIndex } from "element-plus";
import TagSvgIcon from "../icons/TagSvgIcon.vue";

const { nextZIndex } = useZIndex();
const hudRef = ref(null);
const hud = reactive({
  open: false,
  tone: "value",
  title: "",
  kind: "客观核验依据",
  reason: "",
  hint: "",
  top: 0,
  left: 0,
  zIndex: 3000
});

let hoverTimer = null;
let activeTipEl = null;
let activeDescribedEl = null;
let disposed = false;

const HUD_ID = "radar-tag-hud";

function clearAriaDescribedBy() {
  if (!activeDescribedEl) return;
  const cur = activeDescribedEl.getAttribute?.("aria-describedby") || "";
  const next = cur
    .split(/\s+/)
    .filter((t) => t && t !== HUD_ID)
    .join(" ");
  if (next) activeDescribedEl.setAttribute?.("aria-describedby", next);
  else activeDescribedEl.removeAttribute?.("aria-describedby");
  activeDescribedEl = null;
}

function bindAriaDescribedBy(hostEl) {
  if (!hostEl) return;
  if (activeDescribedEl && activeDescribedEl !== hostEl) {
    clearAriaDescribedBy();
  }
  const cur = hostEl.getAttribute?.("aria-describedby") || "";
  const tokens = cur.split(/\s+/).filter(Boolean);
  if (!tokens.includes(HUD_ID)) tokens.push(HUD_ID);
  hostEl.setAttribute?.("aria-describedby", tokens.join(" "));
  activeDescribedEl = hostEl;
}

function resolveTagTipFromFocus(node) {
  if (!node || typeof node.closest !== "function") return null;
  const directTip = node.closest("[data-tag-tip]");
  if (directTip) return { tipEl: directTip, hostEl: node };
  const tagName = node.tagName?.toLowerCase() || "";
  const isFocusableHost =
    tagName === "button" ||
    tagName === "a" ||
    node.getAttribute?.("role") === "button";
  if (isFocusableHost && typeof node.querySelector === "function") {
    const nestedTip = node.querySelector("[data-tag-tip]");
    if (nestedTip) return { tipEl: nestedTip, hostEl: node };
  }
  return null;
}

function hide() {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  activeTipEl = null;
  clearAriaDescribedBy();
  if (hud.open) {
    hud.open = false;
    hud.title = "";
    hud.reason = "";
    hud.hint = "";
  }
}

function computeClampedPosition(tipEl) {
  const rect =
    typeof tipEl?.getBoundingClientRect === "function"
      ? tipEl.getBoundingClientRect()
      : { top: 120, bottom: 142, left: 120, width: 64, height: 22 };
  const hudRect = hudRef.value?.getBoundingClientRect?.() || { width: 280, height: 84 };
  const hudW = hudRect.width > 0 ? hudRect.width : 280;
  const hudH = hudRect.height > 0 ? hudRect.height : 84;
  const vw = globalThis.visualViewport?.width || globalThis.window?.innerWidth || 1440;
  const vh = globalThis.visualViewport?.height || globalThis.window?.innerHeight || 900;

  const placeBelow = rect.top < hudH + 18 && vh - rect.bottom > hudH + 12;
  const rawTop = placeBelow ? rect.bottom + 8 : rect.top - hudH - 8;
  const rawLeft = rect.left + rect.width / 2 - hudW / 2;

  const maxTop = Math.max(8, vh - hudH - 8);
  const maxLeft = Math.max(10, vw - hudW - 10);
  hud.top = Math.round(Math.max(8, Math.min(maxTop, rawTop)));
  hud.left = Math.round(Math.max(10, Math.min(maxLeft, rawLeft)));
}

function onViewportResize() {
  if (disposed || !hud.open || !activeTipEl) return;
  if (activeTipEl.isConnected === false) {
    hide();
    return;
  }
  const style = globalThis.getComputedStyle?.(activeTipEl);
  if (style && (style.display === "none" || style.visibility === "hidden")) {
    hide();
    return;
  }
  computeClampedPosition(activeTipEl);
}

async function show(tipEl, hostEl = tipEl) {
  if (!tipEl || disposed) return;
  const tone = tipEl.getAttribute("data-tag-tip") || "value";
  const title = tipEl.getAttribute("data-tag-tip-title") || "";
  const kind = tipEl.getAttribute("data-tag-tip-kind") || "客观核验依据";
  const reason = tipEl.getAttribute("data-tag-tip-reason") || "";
  const hint = tipEl.getAttribute("data-tag-tip-hint") || "";
  if (!title && !reason) return;

  hud.tone = tone;
  hud.title = title;
  hud.kind = kind;
  hud.reason = reason;
  hud.hint = hint;
  hud.zIndex = Math.max(3000, nextZIndex());
  hud.open = true;
  bindAriaDescribedBy(hostEl || tipEl);

  await nextTick();
  if (disposed || !hud.open || activeTipEl !== tipEl) return;
  computeClampedPosition(tipEl);
}

function onPointerOver(event) {
  const tipEl = event.target?.closest?.("[data-tag-tip]");
  if (!tipEl) {
    if (activeTipEl) hide();
    return;
  }
  if (tipEl === activeTipEl) return;
  if (hoverTimer) clearTimeout(hoverTimer);
  activeTipEl = tipEl;
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    if (!disposed && activeTipEl === tipEl) void show(tipEl, tipEl);
  }, 75);
}

function onPointerOut(event) {
  if (!activeTipEl) return;
  const nextTip = event.relatedTarget?.closest?.("[data-tag-tip]");
  if (nextTip === activeTipEl) return;
  hide();
}

function onFocusIn(event) {
  const match = resolveTagTipFromFocus(event.target);
  if (!match) {
    if (activeTipEl) hide();
    return;
  }
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  activeTipEl = match.tipEl;
  void show(match.tipEl, match.hostEl);
}

function onFocusOut(event) {
  if (!activeTipEl) return;
  const nextMatch = resolveTagTipFromFocus(event.relatedTarget);
  if (nextMatch?.tipEl === activeTipEl) return;
  hide();
}

onMounted(() => {
  const doc = globalThis.document;
  const win = globalThis.window;
  doc?.addEventListener?.("pointerover", onPointerOver, { passive: true });
  doc?.addEventListener?.("pointerout", onPointerOut, { passive: true });
  doc?.addEventListener?.("focusin", onFocusIn);
  doc?.addEventListener?.("focusout", onFocusOut);
  win?.addEventListener?.("scroll", hide, { passive: true, capture: true });
  win?.addEventListener?.("resize", onViewportResize, { passive: true });
  win?.visualViewport?.addEventListener?.("resize", onViewportResize, { passive: true });
});

onBeforeUnmount(() => {
  disposed = true;
  hide();
  const doc = globalThis.document;
  const win = globalThis.window;
  doc?.removeEventListener?.("pointerover", onPointerOver);
  doc?.removeEventListener?.("pointerout", onPointerOut);
  doc?.removeEventListener?.("focusin", onFocusIn);
  doc?.removeEventListener?.("focusout", onFocusOut);
  win?.removeEventListener?.("scroll", hide, { capture: true });
  win?.removeEventListener?.("resize", onViewportResize);
  win?.visualViewport?.removeEventListener?.("resize", onViewportResize);
});

defineExpose({
  hide,
  isOpen: () => hud.open
});
</script>

<template>
  <div
    :id="HUD_ID"
    ref="hudRef"
    class="tag-hud tag-hud-popover"
    data-tag-hud
    role="tooltip"
    :hidden="!hud.open"
    :aria-hidden="String(!hud.open)"
    :style="{ top: `${hud.top}px`, left: `${hud.left}px`, zIndex: String(hud.zIndex) }"
  >
    <div v-if="hud.open" class="tag-hud-card" :class="`is-tone-${hud.tone}`">
      <div class="tag-hud-head">
        <span class="tag-hud-badge" :class="`is-${hud.tone}`">
          <TagSvgIcon :tone="hud.tone" />
          <span>{{ hud.title }}</span>
        </span>
        <span class="tag-hud-kind">{{ hud.kind }}</span>
      </div>
      <div v-if="hud.reason" class="tag-hud-reason">{{ hud.reason }}</div>
      <div v-if="hud.hint" class="tag-hud-hint">{{ hud.hint }}</div>
    </div>
  </div>
</template>
