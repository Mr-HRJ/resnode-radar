<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import AppHeader from "./components/layout/AppHeader.vue";
import StatusBanner from "./components/layout/StatusBanner.vue";
import AppFooter from "./components/layout/AppFooter.vue";
import TerminalView from "./components/terminal/TerminalView.vue";
import RadarView from "./components/radar/RadarView.vue";
import ProvidersView from "./components/providers/ProvidersView.vue";
import GuideView from "./components/guide/GuideView.vue";
import InspectorDrawer from "./components/overlays/InspectorDrawer.vue";
import CompareDock from "./components/overlays/CompareDock.vue";
import CompareModal from "./components/overlays/CompareModal.vue";
import SavedDrawer from "./components/overlays/SavedDrawer.vue";
import CommandPalette from "./components/overlays/CommandPalette.vue";
import TagHudPopover from "./components/overlays/TagHudPopover.vue";

const props = defineProps({
  store: {
    type: Object,
    required: true
  }
});

const tagHudRef = ref(null);
const enteringView = ref(props.store.state.view);
let lastFocusBeforeOverlay = null;
let spotlightRaf = 0;
let pendingPointerEvent = null;

function rememberFocus() {
  const doc = globalThis.document;
  if (
    !lastFocusBeforeOverlay &&
    doc?.activeElement &&
    doc.activeElement !== doc.body
  ) {
    lastFocusBeforeOverlay = doc.activeElement;
  }
}

const anyOverlayOpen = computed(
  () =>
    props.store.state.paletteOpen ||
    (props.store.state.compareOpen && props.store.comparedPlans.value.length > 0) ||
    Boolean(props.store.state.inspectId) ||
    props.store.state.savedDrawerOpen ||
    props.store.state.mobileRailOpen
);

watch(
  anyOverlayOpen,
  (isOpen, wasOpen) => {
    if (isOpen) {
      enteringView.value = null;
    }
    if (isOpen && !wasOpen) {
      rememberFocus();
    }
    globalThis.document?.body?.classList?.toggle?.("scroll-locked", isOpen);
    if (!isOpen && wasOpen && lastFocusBeforeOverlay) {
      const target = lastFocusBeforeOverlay;
      lastFocusBeforeOverlay = null;
      try {
        target.focus?.();
      } catch {
        // ignore detached node focus errors
      }
    }
  },
  { immediate: true }
);

watch(
  () => props.store.state.view,
  (nextView) => {
    enteringView.value = nextView;
    tagHudRef.value?.hide?.();
  }
);

function handleOpenPalette() {
  rememberFocus();
  props.store.setPaletteOpen(true, "");
}

function handleOpenSaved() {
  rememberFocus();
  props.store.setSavedDrawerOpen(true);
}

function handleOpenCompare() {
  rememberFocus();
  props.store.setCompareOpen(true);
}

async function onKeydown(event) {
  const key = event.key;
  const doc = globalThis.document;
  const activeEl = doc?.activeElement;
  const tag = activeEl?.tagName?.toLowerCase() || "";
  const inEditable = tag === "input" || tag === "textarea" || tag === "select";

  if ((event.metaKey || event.ctrlKey) && key?.toLowerCase() === "k") {
    event.preventDefault?.();
    const open = !props.store.state.paletteOpen;
    if (open) rememberFocus();
    props.store.setPaletteOpen(open, "");
    return;
  }

  if (key === "/" && !inEditable && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault?.();
    rememberFocus();
    props.store.setPaletteOpen(true, "");
    return;
  }

  if (key === "Escape") {
    if (tagHudRef.value?.isOpen?.()) {
      tagHudRef.value.hide();
      return;
    }
    const s = props.store.state;
    if (s.paletteOpen) props.store.setPaletteOpen(false);
    else if (s.compareOpen) props.store.setCompareOpen(false);
    else if (s.inspectId) props.store.openInspector(null);
    else if (s.savedDrawerOpen) props.store.setSavedDrawerOpen(false);
    else if (s.mobileRailOpen) props.store.setMobileRailOpen(false);
    else if (s.shopsExpanded && s.view === "terminal") {
      props.store.toggleShopsExpanded();
      await nextTick();
      doc?.querySelector?.("[data-action='toggle-shops-expand']")?.focus?.();
    }
  }
}

function onPointerMove(event) {
  const raf = globalThis.window?.requestAnimationFrame;
  if (typeof raf !== "function") return;
  pendingPointerEvent = event;
  if (spotlightRaf) return;
  spotlightRaf = raf(() => {
    spotlightRaf = 0;
    const ev = pendingPointerEvent;
    pendingPointerEvent = null;
    const card = ev?.target?.closest?.(
      ".plan-card, .provider-card, .market-board-card, .kpi-tile, .guide-preset-card"
    );
    if (!card || typeof card.getBoundingClientRect !== "function") return;
    const rect = card.getBoundingClientRect();
    card.style?.setProperty?.("--mx", `${Math.round(ev.clientX - rect.left)}px`);
    card.style?.setProperty?.("--my", `${Math.round(ev.clientY - rect.top)}px`);
  });
}

onMounted(() => {
  const doc = globalThis.document;
  doc?.addEventListener?.("keydown", onKeydown);
  if (typeof globalThis.window?.requestAnimationFrame === "function") {
    doc?.addEventListener?.("pointermove", onPointerMove, { passive: true });
  }
});

onBeforeUnmount(() => {
  const doc = globalThis.document;
  doc?.removeEventListener?.("keydown", onKeydown);
  doc?.removeEventListener?.("pointermove", onPointerMove);
  if (spotlightRaf && typeof globalThis.window?.cancelAnimationFrame === "function") {
    globalThis.window.cancelAnimationFrame(spotlightRaf);
  }
  doc?.body?.classList?.remove?.("scroll-locked");
});
</script>

<template>
  <div class="app-shell">
    <AppHeader
      :store="store"
      @open-palette="handleOpenPalette"
      @open-saved="handleOpenSaved"
      @open-compare="handleOpenCompare"
    />

    <StatusBanner :store="store" />

    <main id="main-workspace" class="app-main" tabindex="-1">
      <section
        data-view-panel="terminal"
        :class="{ 'is-view-entering': enteringView === 'terminal' }"
        :hidden="store.state.view !== 'terminal'"
        @animationend.self="enteringView = null"
      >
        <TerminalView v-if="store.state.view === 'terminal'" :store="store" />
      </section>

      <section
        data-view-panel="radar"
        :class="{ 'is-view-entering': enteringView === 'radar' }"
        :hidden="store.state.view !== 'radar'"
        @animationend.self="enteringView = null"
      >
        <RadarView v-if="store.state.view === 'radar'" :store="store" />
      </section>

      <section
        data-view-panel="providers"
        :class="{ 'is-view-entering': enteringView === 'providers' }"
        :hidden="store.state.view !== 'providers'"
        @animationend.self="enteringView = null"
      >
        <ProvidersView v-if="store.state.view === 'providers'" :store="store" />
      </section>

      <section
        data-view-panel="guide"
        :class="{ 'is-view-entering': enteringView === 'guide' }"
        :hidden="store.state.view !== 'guide'"
        @animationend.self="enteringView = null"
      >
        <GuideView v-if="store.state.view === 'guide'" :store="store" />
      </section>
    </main>

    <AppFooter />

    <CompareDock :store="store" @open-compare="handleOpenCompare" />
    <CompareModal :store="store" />
    <InspectorDrawer :store="store" />
    <SavedDrawer :store="store" />
    <CommandPalette :store="store" />

    <div
      class="sheet-backdrop"
      data-sheet-backdrop
      :hidden="!store.state.mobileRailOpen"
      @click="store.setMobileRailOpen(false)"
    ></div>

    <TagHudPopover ref="tagHudRef" />

    <div class="toast-region" data-toast-region aria-live="polite" aria-atomic="true">
      <div v-if="store.state.toastMessage" class="toast-item" role="status">
        {{ store.state.toastMessage }}
      </div>
    </div>
  </div>
</template>
