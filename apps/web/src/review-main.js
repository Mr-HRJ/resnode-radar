import "./styles/main.css";
import { createApp, h, reactive } from "vue";
import { ElConfigProvider } from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import { applyTheme, fxExpiresAtMs, loadTheme } from "@resnode-radar/contracts";
import ReviewLiveBox from "./components/reviews/ReviewLiveBox.vue";
import { REFRESH_INTERVAL_MS, loadRadarSnapshot } from "./services/snapshot-client.js";

export async function mountReviewDossier(endpointOrOptions = null) {
  const options =
    typeof endpointOrOptions === "string"
      ? { endpoint: endpointOrOptions }
      : endpointOrOptions || {};
  const doc = options.document ?? globalThis.document;
  const win = options.window ?? globalThis.window;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const nowFn = typeof options.now === "function" ? options.now : () => Date.now();

  let theme = applyTheme(loadTheme(win?.localStorage), win?.localStorage, doc);
  const themeBtn = doc?.querySelector?.("[data-action='toggle-theme']");
  const updateThemeBtn = () => {
    if (themeBtn) themeBtn.textContent = theme === "dark" ? "☀ 亮色" : "☾ 暗色";
  };
  updateThemeBtn();

  const onClick = (event) => {
    const btn = event.target?.closest?.("[data-action='toggle-theme']");
    if (!btn) return;
    theme = applyTheme(theme === "dark" ? "light" : "dark", win?.localStorage, doc);
    updateThemeBtn();
  };
  doc?.addEventListener?.("click", onClick);

  const box = doc?.querySelector?.("[data-review-live-box]");
  if (!box) {
    return { dispose: () => doc?.removeEventListener?.("click", onClick) };
  }

  const providerId = box.getAttribute("data-provider-id") || "";
  const propsState = reactive({
    providerId,
    status: "loading",
    payload: null,
    errorMessage: "",
    nowMs: options.initialNowMs ?? nowFn()
  });

  const app = createApp({
    render: () =>
      h(
        ElConfigProvider,
        { locale: zhCn },
        { default: () => h(ReviewLiveBox, { ...propsState }) }
      )
  });
  app.mount(box);

  let disposed = false;
  let activeCtrl = null;
  let currentSnapshotId = null;
  let lastFetchAt = 0;
  let clockTimer = null;
  let pollTimer = null;
  let fxBoundaryTimer = null;

  function clearFxBoundaryTimer() {
    if (fxBoundaryTimer) {
      clearTimeout(fxBoundaryTimer);
      fxBoundaryTimer = null;
    }
  }

  function scheduleFxBoundaryTimer() {
    clearFxBoundaryTimer();
    if (disposed || !propsState.payload?.exchangeRates) return;
    const expiresAt = fxExpiresAtMs(propsState.payload.exchangeRates);
    if (!Number.isFinite(expiresAt)) return;
    const remaining = expiresAt - propsState.nowMs + 50;
    if (remaining > 0 && remaining < 8 * 86_400_000) {
      fxBoundaryTimer = setTimeout(() => {
        if (!disposed) {
          tickClock(nowFn());
        }
      }, remaining);
    }
  }

  function tickClock(nextNow = nowFn()) {
    if (disposed) return;
    propsState.nowMs = nextNow;
    scheduleFxBoundaryTimer();
  }

  async function refresh({ force = false } = {}) {
    if (disposed) return;
    activeCtrl?.abort();
    const ctrl = new AbortController();
    activeCtrl = ctrl;

    try {
      const res = await loadRadarSnapshot({
        endpoint: options.endpoint ?? null,
        currentSnapshotId: force ? null : currentSnapshotId,
        signal: ctrl.signal,
        nowMs: nowFn(),
        doc,
        locationHref: win?.location?.href || "https://vpsld.com/reviews/",
        fetchImpl
      });
      if (disposed || ctrl.signal.aborted) return;
      lastFetchAt = nowFn();
      propsState.nowMs = lastFetchAt;
      if (!res.unchanged) {
        currentSnapshotId = res.snapshotId;
        propsState.payload = res.payload;
      }
      propsState.errorMessage = "";
      propsState.status = "ready";
      scheduleFxBoundaryTimer();
    } catch (err) {
      if (disposed || ctrl.signal.aborted || err?.code === "ABORTED") return;
      if (!propsState.payload) {
        propsState.errorMessage =
          err?.detail || (err instanceof Error ? err.message : "Fetch error");
        propsState.status = "error";
      }
    } finally {
      if (activeCtrl === ctrl) {
        activeCtrl = null;
      }
    }
  }

  const onVisibilityChange = () => {
    if (disposed) return;
    if (!doc?.visibilityState || doc.visibilityState === "visible") {
      const cur = nowFn();
      tickClock(cur);
      if (lastFetchAt && cur - lastFetchAt >= REFRESH_INTERVAL_MS) {
        void refresh();
      }
    }
  };

  doc?.addEventListener?.("visibilitychange", onVisibilityChange);
  clockTimer = setInterval(() => {
    tickClock(nowFn());
  }, 30_000);
  pollTimer = setInterval(() => {
    if (!doc || doc.visibilityState !== "hidden") {
      void refresh();
    }
  }, REFRESH_INTERVAL_MS);

  await refresh({ force: true });

  return {
    tickClock,
    refresh,
    dispose() {
      disposed = true;
      activeCtrl?.abort();
      if (clockTimer) clearInterval(clockTimer);
      if (pollTimer) clearInterval(pollTimer);
      clearFxBoundaryTimer();
      doc?.removeEventListener?.("click", onClick);
      doc?.removeEventListener?.("visibilitychange", onVisibilityChange);
      app.unmount();
    }
  };
}

if (
  typeof window !== "undefined" &&
  !globalThis.__RADAR_DISABLE_AUTO_MOUNT__ &&
  globalThis.document?.querySelector?.("[data-review-live-box]")
) {
  void mountReviewDossier();
}
