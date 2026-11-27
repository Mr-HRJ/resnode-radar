<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElConfigProvider, ElMessage } from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
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
const overlayStack = [];
let pendingFocusCandidate = null;
let lastHandledWorkspaceFocusSeq = props.store.state.workspaceFocusSeq || 0;
let spotlightRaf = 0;
let pendingPointerEvent = null;

function captureActiveElement() {
  const doc = globalThis.document;
  const active = doc?.activeElement;
  if (active && active !== doc.body && active !== doc.documentElement) {
    return active;
  }
  return null;
}

function rememberFocus() {
  const active = captureActiveElement();
  if (active) {
    pendingFocusCandidate = active;
  }
}

function resolveOverlayContainer(overlayId) {
  const doc = globalThis.document;
  if (!doc) return null;
  if (overlayId === "compare") return doc.querySelector("[data-compare-modal]");
  if (overlayId === "inspector") return doc.querySelector("[data-inspector-backdrop]");
  if (overlayId === "saved") return doc.querySelector("[data-saved-backdrop]");
  if (overlayId === "palette") return doc.querySelector("[data-palette-backdrop]");
  if (overlayId === "mobileRail") return doc.querySelector("[data-mobile-filter-sheet]");
  return null;
}

function resolveOverlayFallbackCandidates(overlayId) {
  const doc = globalThis.document;
  if (!doc) return [];
  const candidates = [];
  const pushUnique = (el) => {
    if (el && !candidates.includes(el)) candidates.push(el);
  };
  if (overlayId === "compare") {
    pushUnique(doc.querySelector("[data-compare-modal] [data-action='close-compare']"));
  } else if (overlayId === "inspector") {
    pushUnique(doc.querySelector("[data-inspector-backdrop] [data-action='close-inspector']"));
  } else if (overlayId === "saved") {
    pushUnique(doc.querySelector("[data-saved-backdrop] [data-action='close-saved']"));
  } else if (overlayId === "palette") {
    pushUnique(doc.querySelector("[data-palette-input]"));
  } else if (overlayId === "mobileRail") {
    pushUnique(doc.querySelector("[data-mobile-filter-sheet] [data-action='close-mobile-rail']"));
  }

  const container = resolveOverlayContainer(overlayId);
  if (container) {
    for (const el of container.querySelectorAll(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
    )) {
      if (!el.disabled && !el.hidden) {
        pushUnique(el);
      }
    }
    pushUnique(container.querySelector(".el-dialog, .el-drawer"));
  }
  return candidates;
}

function restoreFirstFocusableTarget(candidates) {
  for (const target of candidates) {
    if (restoreFocusTarget(target)) {
      return true;
    }
  }
  return false;
}

function restoreFocusTarget(target) {
  if (!target || target.isConnected === false) return false;
  try {
    target.focus?.();
    return globalThis.document?.activeElement === target;
  } catch {
    return false;
  }
}

const compareDeferred = ref(false);
const inspectorDeferred = ref(
  Boolean(
    props.store.state.inspectId &&
      props.store.state.compareOpen &&
      props.store.state.compareKeys.length > 0 &&
      props.store.comparedPlans.value.length === 0
  )
);
let inspectorDeferToken = 0;

const mobileRailActuallyVisible = computed(() =>
  Boolean(props.store.state.mobileRailOpen && props.store.state.view === "terminal")
);

function isUserBlockingOverlayOpen() {
  const s = props.store.state;
  return Boolean(s.paletteOpen || s.savedDrawerOpen || mobileRailActuallyVisible.value);
}

function scheduleInspectorReveal() {
  const token = ++inspectorDeferToken;
  void nextTick()
    .then(() => nextTick())
    .then(() => {
      if (token === inspectorDeferToken && !isUserBlockingOverlayOpen()) {
        inspectorDeferred.value = false;
      }
    });
}

// Unified stacking invariant across initial URL load, slow snapshot hydration, 503 retry recovery, and popstate:
// 1. If the user actively opens CommandPalette, SavedDrawer, or MobileFilterSheet before delayed CompareModal /
//    InspectorDrawer mount, keep those pending overlays deferred until the foreground overlay closes so they never
//    jump above or steal focus.
// 2. Whenever CompareModal and InspectorDrawer are both active from URL/snapshot state, CompareModal always
//    mounts underneath first and InspectorDrawer reveals on top with higher z-index, focus, and Escape priority.
watch(
  () => [
    props.store.state.loadState,
    props.store.comparedPlans.value.length,
    props.store.state.compareOpen,
    props.store.state.inspectId,
    isUserBlockingOverlayOpen(),
    props.store.state.inspectActionSeq,
    props.store.state.inspectSource
  ],
  (
    [
      loadState,
      comparedLen,
      compareOpen,
      inspectId,
      blockingOverlayOpen,
      inspectActionSeq,
      inspectSource
    ],
    prev = []
  ) => {
    const compareEligible = Boolean(compareOpen && comparedLen > 0);
    const compareWasEligible = Boolean(prev[2] && prev[1] > 0);
    const compareCurrentlyShown = Boolean(compareWasEligible && !compareDeferred.value);
    const inspectorCurrentlyShown = Boolean(prev[3] && !inspectorDeferred.value);
    const explicitUserInspect = Boolean(
      inspectId && inspectSource === "user" && inspectActionSeq !== (prev[5] ?? 0)
    );

    if (blockingOverlayOpen) {
      if (!compareEligible) {
        compareDeferred.value = false;
      } else if (!compareCurrentlyShown) {
        compareDeferred.value = true;
      }

      if (!inspectId) {
        inspectorDeferToken += 1;
        inspectorDeferred.value = false;
      } else if (explicitUserInspect) {
        // Explicit user openInspector() (e.g. picking a plan in CommandPalette, even when its ID matches
        // a previously deferred URL inspectId) immediately reveals InspectorDrawer on top with focus.
        inspectorDeferToken += 1;
        inspectorDeferred.value = false;
      } else if (!inspectorCurrentlyShown) {
        // Background restoration (initial slow URL load or popstate history navigation) never preempts
        // an active foreground overlay (CommandPalette / SavedDrawer / MobileFilterSheet).
        inspectorDeferToken += 1;
        inspectorDeferred.value = true;
      }
      return;
    }

    const wasCompareDeferred = compareDeferred.value;
    compareDeferred.value = false;

    if (!inspectId) {
      inspectorDeferToken += 1;
      inspectorDeferred.value = false;
      return;
    }

    // CompareModal just opened (or un-deferred after foreground overlay closed / retry / popstate) while InspectorDrawer
    // is also active: keep/cycle InspectorDrawer behind CompareModal for 2 ticks so CompareModal settles underneath first.
    if (compareEligible && (!compareWasEligible || wasCompareDeferred)) {
      inspectorDeferred.value = true;
      scheduleInspectorReveal();
      return;
    }

    // If popstate arrived before the first snapshot finished loading with both compareOpen and inspectId,
    // keep InspectorDrawer deferred until the snapshot resolves CompareModal first.
    if (
      loadState !== "ready" &&
      compareOpen &&
      props.store.state.compareKeys.length > 0 &&
      comparedLen === 0
    ) {
      inspectorDeferred.value = true;
      return;
    }

    if (inspectorDeferred.value) {
      if (!compareOpen) {
        inspectorDeferToken += 1;
        inspectorDeferred.value = false;
      } else if (compareEligible) {
        scheduleInspectorReveal();
      } else if (loadState === "ready") {
        // Snapshot loaded successfully, yet no compared plans resolved; reveal InspectorDrawer immediately.
        inspectorDeferToken += 1;
        inspectorDeferred.value = false;
      }
    }
  },
  { immediate: true }
);

const overlayStates = computed(() => ({
  palette: Boolean(props.store.state.paletteOpen),
  compare: Boolean(
    props.store.state.compareOpen && props.store.comparedPlans.value.length > 0 && !compareDeferred.value
  ),
  inspector: Boolean(props.store.state.inspectId && !inspectorDeferred.value),
  saved: Boolean(props.store.state.savedDrawerOpen),
  mobileRail: mobileRailActuallyVisible.value
}));

const anyOverlayOpen = computed(() => Object.values(overlayStates.value).some(Boolean));

watch(
  overlayStates,
  (next, prev = {}) => {
    const keys = ["palette", "compare", "inspector", "saved", "mobileRail"];
    const closedIds = new Set();
    const openedKeys = [];

    for (const key of keys) {
      const wasOpen = Boolean(prev?.[key]);
      const isOpen = Boolean(next[key]);
      if (wasOpen && !isOpen) {
        closedIds.add(key);
      } else if (!wasOpen && isOpen) {
        openedKeys.push(key);
      }
    }

    // Extract closed entries in actual overlayStack order (bottom -> top) before mutating overlayStack
    const closedEntries = [];
    for (let i = 0; i < overlayStack.length; ) {
      if (closedIds.has(overlayStack[i].id)) {
        closedEntries.push(overlayStack.splice(i, 1)[0]);
      } else {
        i += 1;
      }
    }

    const closedContainers = closedEntries
      .map((entry) => resolveOverlayContainer(entry.id))
      .filter(Boolean);
    const isSafeOutsideClosed = (el) =>
      Boolean(el && el.isConnected && !closedContainers.some((container) => container.contains(el)));

    const pickSafeClosedReturn = () => {
      for (let i = closedEntries.length - 1; i >= 0; i -= 1) {
        const entry = closedEntries[i];
        if (isSafeOutsideClosed(entry.returnFocus)) {
          return { returnFocus: entry.returnFocus, returnSelector: entry.returnSelector || null };
        }
      }
      for (let i = closedEntries.length - 1; i >= 0; i -= 1) {
        if (closedEntries[i].returnSelector) {
          return { returnFocus: null, returnSelector: closedEntries[i].returnSelector };
        }
      }
      return { returnFocus: null, returnSelector: null };
    };

    if (openedKeys.length > 0) {
      enteringView.value = null;
      // Never let a stale workspace-navigation focus sequence bleed into a newly opened overlay's Escape/close return.
      lastHandledWorkspaceFocusSeq = props.store.state.workspaceFocusSeq || 0;
      const inherited = pickSafeClosedReturn();
      const rawCandidate = isSafeOutsideClosed(pendingFocusCandidate)
        ? pendingFocusCandidate
        : (isSafeOutsideClosed(captureActiveElement()) ? captureActiveElement() : null) ||
          inherited.returnFocus ||
          null;
      pendingFocusCandidate = null;

      for (const key of openedKeys) {
        const existingIdx = overlayStack.findIndex((entry) => entry.id === key);
        if (existingIdx >= 0) overlayStack.splice(existingIdx, 1);
        const returnSelector =
          key === "compare" &&
          rawCandidate?.closest?.("[data-compare-dock]") &&
          rawCandidate?.getAttribute?.("data-action") === "open-compare"
            ? "[data-compare-dock] [data-action='open-compare']"
            : key === "mobileRail"
              ? "[data-action='open-mobile-rail']"
              : inherited.returnSelector;
        overlayStack.push({ id: key, returnFocus: rawCandidate, returnSelector });
      }
      if (openedKeys.includes("mobileRail") && overlayStack.at(-1)?.id === "mobileRail") {
        const focusMobileSheet = () => {
          if (overlayStack.at(-1)?.id !== "mobileRail" || !overlayStates.value.mobileRail) return;
          const sheet = resolveOverlayContainer("mobileRail");
          if (sheet) void sheet.offsetHeight;
          const active = globalThis.document?.activeElement;
          if (sheet && active && sheet.contains(active)) return;
          restoreFirstFocusableTarget(resolveOverlayFallbackCandidates("mobileRail"));
        };
        void nextTick().then(() => {
          focusMobileSheet();
          if (typeof globalThis.window?.requestAnimationFrame === "function") {
            globalThis.window.requestAnimationFrame(() => {
              focusMobileSheet();
              globalThis.window.requestAnimationFrame(focusMobileSheet);
            });
          }
        });
      }
    } else if (closedEntries.length > 0) {
      pendingFocusCandidate = null;
      const topRemaining = overlayStack.at(-1) || null;
      const closedTop = closedEntries.at(-1) || null;
      const safeClosedReturn = pickSafeClosedReturn();

      // If one or more underlying overlays closed while another overlay remains on top (e.g. popstate closes
      // CompareModal + InspectorDrawer beneath CommandPalette), preserve focus inside the topmost overlay and
      // transfer the topmost surviving outside-closed page trigger onto any remaining entry whose returnFocus
      // belonged to a closing overlay.
      if (topRemaining) {
        for (const remaining of overlayStack) {
          if (!isSafeOutsideClosed(remaining.returnFocus)) {
            if (safeClosedReturn.returnFocus) {
              remaining.returnFocus = safeClosedReturn.returnFocus;
            }
            if (!remaining.returnSelector && safeClosedReturn.returnSelector) {
              remaining.returnSelector = safeClosedReturn.returnSelector;
            }
          }
        }
        const ensureTopOverlayFocus = () => {
          const topContainer = resolveOverlayContainer(topRemaining.id);
          const active = globalThis.document?.activeElement;
          if (topContainer && active && topContainer.contains(active)) {
            return;
          }
          const inTopCandidate =
            closedTop?.returnFocus?.isConnected && topContainer?.contains(closedTop.returnFocus)
              ? closedTop.returnFocus
              : null;
          if (inTopCandidate && restoreFocusTarget(inTopCandidate)) {
            return;
          }
          restoreFirstFocusableTarget(resolveOverlayFallbackCandidates(topRemaining.id));
        };
        ensureTopOverlayFocus();
        void nextTick().then(ensureTopOverlayFocus);
      } else {
        const currentWorkspaceFocusSeq = props.store.state.workspaceFocusSeq || 0;
        const focusMainWorkspaceForNav =
          currentWorkspaceFocusSeq !== lastHandledWorkspaceFocusSeq;
        if (focusMainWorkspaceForNav) {
          lastHandledWorkspaceFocusSeq = currentWorkspaceFocusSeq;
        }
        const resolveClosedReturnTarget = () =>
          focusMainWorkspaceForNav
            ? globalThis.document?.getElementById?.("main-workspace") || null
            : (safeClosedReturn.returnFocus?.isConnected ? safeClosedReturn.returnFocus : null) ||
              (safeClosedReturn.returnSelector
                ? globalThis.document?.querySelector?.(safeClosedReturn.returnSelector)
                : null);
        const resolveWorkspaceFallbackTarget = () =>
          globalThis.document?.getElementById?.("main-workspace") || null;

        const applyClosedFocusRestore = () => {
          const target = resolveClosedReturnTarget();
          if (target && restoreFocusTarget(target)) {
            return;
          }
          const active = globalThis.document?.activeElement;
          const needsFallback =
            !active ||
            active === globalThis.document?.body ||
            active === globalThis.document?.documentElement ||
            closedContainers.some((container) => container.contains(active));
          if (needsFallback) {
            restoreFocusTarget(resolveWorkspaceFallbackTarget());
          }
        };

        const immediateTarget = resolveClosedReturnTarget();
        if (immediateTarget) {
          restoreFocusTarget(immediateTarget);
        }
        // Re-apply after ElDialog/ElDrawer unmount focus-trap teardown & hidden-host re-show (e.g. CompareDock),
        // or fall back to #main-workspace when the original trigger unmounted (e.g. removing the last compared item).
        void nextTick().then(() => {
          if (anyOverlayOpen.value) return;
          if (focusMainWorkspaceForNav) {
            restoreFocusTarget(resolveWorkspaceFallbackTarget());
            void nextTick().then(() => {
              if (!anyOverlayOpen.value) {
                restoreFocusTarget(resolveWorkspaceFallbackTarget());
              }
            });
            return;
          }
          const active = globalThis.document?.activeElement;
          const stillNeedsRestore =
            !active ||
            active === globalThis.document?.body ||
            active === globalThis.document?.documentElement ||
            closedContainers.some((container) => container.contains(active));
          if (stillNeedsRestore) {
            applyClosedFocusRestore();
          }
        });
      }
    }

    globalThis.document?.body?.classList?.toggle?.("scroll-locked", anyOverlayOpen.value);
  },
  { immediate: true }
);

watch(
  () => props.store.state.view,
  (nextView) => {
    enteringView.value = nextView;
    composingTarget = null;
    tagHudRef.value?.hide?.();
    if (nextView !== "terminal" && props.store.state.mobileRailOpen) {
      props.store.setMobileRailOpen(false);
    }
  }
);

// Preserve keyboard focus inside the topmost open drawer/dialog when snapshot hydration or history navigation
// replaces a focused button (e.g. InspectorDrawer "返回列表", SavedDrawer "移除", or CompareModal "移出对比").
watch(
  () => [
    props.store.state.loadState,
    props.store.state.snapshotId,
    props.store.plans.value,
    props.store.allRecords.value,
    props.store.state.inspectId,
    props.store.state.compareKeys.join(","),
    props.store.state.savedKeys.size
  ],
  () => {
    const topOverlayId = overlayStack.at(-1)?.id || null;
    if (!topOverlayId) return;
    const topContainer = resolveOverlayContainer(topOverlayId);
    const activeBefore = globalThis.document?.activeElement || null;
    if (!topContainer || !activeBefore || !topContainer.contains(activeBefore)) return;

    const focusedAction = activeBefore.getAttribute?.("data-action") || null;
    const focusedKey = activeBefore.getAttribute?.("data-key") || null;
    const focusedProductId = activeBefore.getAttribute?.("data-product-id") || null;

    void nextTick().then(() => {
      if (overlayStack.at(-1)?.id !== topOverlayId) return;
      const currentContainer = resolveOverlayContainer(topOverlayId);
      if (!currentContainer) return;
      const activeAfter = globalThis.document?.activeElement;
      if (activeAfter && currentContainer.contains(activeAfter)) return;

      const matchCandidates = [];
      if (focusedAction) {
        const actionControls = [...currentContainer.querySelectorAll("[data-action]")].filter(
          (el) => !el.disabled && !el.hidden && el.getAttribute("data-action") === focusedAction
        );
        if (focusedKey) {
          for (const el of actionControls) {
            if (el.getAttribute("data-key") === focusedKey) matchCandidates.push(el);
          }
        }
        if (focusedProductId) {
          for (const el of actionControls) {
            if (el.getAttribute("data-product-id") === focusedProductId) matchCandidates.push(el);
          }
        }
        for (const el of actionControls) {
          if (!matchCandidates.includes(el)) matchCandidates.push(el);
        }
      }
      if (!restoreFirstFocusableTarget(matchCandidates)) {
        restoreFirstFocusableTarget(resolveOverlayFallbackCandidates(topOverlayId));
      }
    });
  }
);

let activeToastHandle = null;
let activeToastText = "";
let activeToastType = "success";

function closeActiveToast() {
  if (activeToastHandle) {
    try {
      activeToastHandle.close();
    } catch {
      // ignore close errors on unmount
    }
    activeToastHandle = null;
  }
  activeToastText = "";
  activeToastType = "success";
  ElMessage.closeAll();
}

watch(
  () => [props.store.state.toastSeq, props.store.state.toastMessage, props.store.state.toastType],
  ([, msg, rawType]) => {
    if (!msg) {
      closeActiveToast();
      return;
    }
    const type = rawType || "success";
    // Single store timer owns lifetime (duration: 0), so identical consecutive messages renew cleanly without flickering or duplicating alert nodes.
    if (activeToastHandle && activeToastText === msg && activeToastType === type) {
      return;
    }
    closeActiveToast();
    activeToastText = msg;
    activeToastType = type;
    let handle = null;
    handle = ElMessage({
      message: msg,
      type,
      plain: true,
      duration: 0,
      customClass: "radar-el-message",
      onClose: () => {
        if (activeToastHandle === handle) {
          activeToastHandle = null;
          activeToastText = "";
          activeToastType = "success";
        }
      }
    });
    activeToastHandle = handle;
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

const NON_TEXT_INPUT_TYPES = new Set([
  "radio",
  "checkbox",
  "button",
  "submit",
  "reset",
  "range",
  "color",
  "file",
  "image"
]);

let composingTarget = null;

function onDocCompositionStart(event) {
  composingTarget = event?.target || null;
}

function onDocCompositionEnd(event) {
  if (!composingTarget || !event?.target || event.target === composingTarget) {
    composingTarget = null;
  }
}

function onDocFocusIn() {
  if (
    composingTarget &&
    (!composingTarget.isConnected || globalThis.document?.activeElement !== composingTarget)
  ) {
    composingTarget = null;
  }
}

function isActiveDocComposition(event) {
  if (event?.isComposing || event?.key === "Process" || event?.keyCode === 229) {
    return true;
  }
  if (!composingTarget) return false;
  const target = event?.target || globalThis.document?.activeElement || null;
  if (!composingTarget.isConnected || (target && target !== composingTarget)) {
    composingTarget = null;
    return false;
  }
  return target === composingTarget;
}

function getFocusableSheetControls(sheet) {
  if (!sheet) return [];
  const win = globalThis.window;
  const hasLayout = typeof sheet.getClientRects === "function" && sheet.getClientRects().length > 0;
  return [
    ...sheet.querySelectorAll(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
    )
  ].filter((el) => {
    if (el.disabled || el.hidden || el.getAttribute?.("aria-hidden") === "true") return false;
    if (el.closest?.("[hidden]")) return false;
    if (typeof win?.getComputedStyle === "function") {
      const style = win.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    if (hasLayout && typeof el.getClientRects === "function" && el.getClientRects().length === 0) {
      return false;
    }
    return true;
  });
}

async function handleEscapeKey() {
  const doc = globalThis.document;
  if (tagHudRef.value?.isOpen?.()) {
    tagHudRef.value.hide();
    return;
  }
  const topOverlay = overlayStack.at(-1)?.id || null;
  const visibleOverlays = overlayStates.value;
  const s = props.store.state;
  if (topOverlay === "palette" && visibleOverlays.palette) {
    props.store.setPaletteOpen(false);
  } else if (topOverlay === "inspector" && visibleOverlays.inspector) {
    props.store.openInspector(null);
  } else if (topOverlay === "compare" && visibleOverlays.compare) {
    props.store.setCompareOpen(false);
  } else if (topOverlay === "saved" && visibleOverlays.saved) {
    props.store.setSavedDrawerOpen(false);
  } else if (topOverlay === "mobileRail" && visibleOverlays.mobileRail) {
    props.store.setMobileRailOpen(false);
  } else if (visibleOverlays.palette) {
    props.store.setPaletteOpen(false);
  } else if (visibleOverlays.inspector) {
    props.store.openInspector(null);
  } else if (visibleOverlays.compare) {
    props.store.setCompareOpen(false);
  } else if (visibleOverlays.saved) {
    props.store.setSavedDrawerOpen(false);
  } else if (visibleOverlays.mobileRail) {
    props.store.setMobileRailOpen(false);
  } else if (s.shopsExpanded && s.view === "terminal") {
    props.store.toggleShopsExpanded();
    await nextTick();
    doc?.querySelector?.("[data-action='toggle-shops-expand']")?.focus?.();
  }
}

function onEscapePassthrough() {
  void handleEscapeKey();
}

async function onKeydown(event) {
  if (isActiveDocComposition(event)) {
    return;
  }
  const key = event.key;
  const doc = globalThis.document;

  if (
    key === "Tab" &&
    overlayStack.at(-1)?.id === "mobileRail" &&
    overlayStates.value.mobileRail
  ) {
    const sheet = resolveOverlayContainer("mobileRail");
    if (sheet) {
      const focusables = getFocusableSheetControls(sheet);
      if (focusables.length === 0) {
        event.preventDefault?.();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = doc?.activeElement;
      if (!event.shiftKey && (active === last || !sheet.contains(active))) {
        event.preventDefault?.();
        first.focus?.();
        return;
      }
      if (event.shiftKey && (active === first || active === sheet || !sheet.contains(active))) {
        event.preventDefault?.();
        last.focus?.();
        return;
      }
    }
  }

  const activeEl = doc?.activeElement;
  const tag = activeEl?.tagName?.toLowerCase() || "";
  const inputType = tag === "input" ? (activeEl?.type || "text").toLowerCase() : "";
  const inEditable =
    (tag === "input" && !NON_TEXT_INPUT_TYPES.has(inputType)) ||
    tag === "textarea" ||
    tag === "select" ||
    Boolean(activeEl?.isContentEditable) ||
    activeEl?.getAttribute?.("role") === "combobox";

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
    await handleEscapeKey();
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

let mobileMediaQuery = null;

function isDesktopViewportWidth() {
  const win = globalThis.window;
  if (!win) return false;
  if (typeof win.matchMedia === "function") {
    return !win.matchMedia("(max-width: 860px)").matches;
  }
  return Number.isFinite(win.innerWidth) && win.innerWidth > 860;
}

function onViewportChange() {
  if (props.store.state.mobileRailOpen && isDesktopViewportWidth()) {
    props.store.setMobileRailOpen(false);
  }
}

onMounted(() => {
  const doc = globalThis.document;
  const win = globalThis.window;
  doc?.addEventListener?.("compositionstart", onDocCompositionStart, true);
  doc?.addEventListener?.("compositionend", onDocCompositionEnd, true);
  doc?.addEventListener?.("focusin", onDocFocusIn, true);
  doc?.addEventListener?.("keydown", onKeydown);
  doc?.addEventListener?.("resnode:escape-passthrough", onEscapePassthrough);
  if (typeof win?.requestAnimationFrame === "function") {
    doc?.addEventListener?.("pointermove", onPointerMove, { passive: true });
  }
  win?.addEventListener?.("resize", onViewportChange, { passive: true });
  if (typeof win?.matchMedia === "function") {
    mobileMediaQuery = win.matchMedia("(max-width: 860px)");
    mobileMediaQuery?.addEventListener?.("change", onViewportChange);
  }
});

onBeforeUnmount(() => {
  const doc = globalThis.document;
  const win = globalThis.window;
  composingTarget = null;
  doc?.removeEventListener?.("compositionstart", onDocCompositionStart, true);
  doc?.removeEventListener?.("compositionend", onDocCompositionEnd, true);
  doc?.removeEventListener?.("focusin", onDocFocusIn, true);
  doc?.removeEventListener?.("keydown", onKeydown);
  doc?.removeEventListener?.("resnode:escape-passthrough", onEscapePassthrough);
  doc?.removeEventListener?.("pointermove", onPointerMove);
  win?.removeEventListener?.("resize", onViewportChange);
  mobileMediaQuery?.removeEventListener?.("change", onViewportChange);
  mobileMediaQuery = null;
  if (spotlightRaf && typeof win?.cancelAnimationFrame === "function") {
    win.cancelAnimationFrame(spotlightRaf);
  }
  doc?.body?.classList?.remove?.("scroll-locked");
  closeActiveToast();
});
</script>

<template>
  <ElConfigProvider :locale="zhCn" :z-index="2000">
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
    <CompareModal :store="store" :deferred="compareDeferred" />
    <InspectorDrawer :store="store" :deferred="inspectorDeferred" />
    <SavedDrawer :store="store" />
    <CommandPalette :store="store" />

    <div
      class="sheet-backdrop"
      data-sheet-backdrop
      :hidden="!mobileRailActuallyVisible"
      @click="store.setMobileRailOpen(false)"
    ></div>

    <TagHudPopover ref="tagHudRef" />
  </div>
  </ElConfigProvider>
</template>
