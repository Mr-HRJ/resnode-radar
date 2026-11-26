import "./styles/main.css";
import { createApp } from "vue";
import App from "./App.vue";
import { createRadarStore } from "./stores/radar-store.js";

export function mountApp(options = {}) {
  const doc = options.document ?? globalThis.document;
  const container =
    options.container ??
    doc?.querySelector?.("[data-app-root]") ??
    doc?.querySelector?.("#app");

  if (!container) {
    throw new Error("Cannot mount VPS雷达 app: missing [data-app-root] or #app container");
  }

  const store = createRadarStore(options);
  const app = createApp(App, { store });
  app.mount(container);

  if (options.autoStart !== false) {
    store.startLifecycle();
  }

  return {
    app,
    store,
    refresh: (force = false) => store.refreshSnapshot({ force }),
    refreshVisitStats: (record = false) => store.refreshVisitStats(record),
    dispose() {
      store.dispose();
      app.unmount();
    }
  };
}

if (
  typeof window !== "undefined" &&
  !globalThis.__RADAR_DISABLE_AUTO_MOUNT__ &&
  globalThis.document?.querySelector?.("[data-app-root]")
) {
  mountApp();
}
