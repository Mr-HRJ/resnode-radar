---
name: verify
description: Run VPS Radar in a real browser, capture its public UI and data behavior, and verify the deployed Cloudflare site.
---

# Runtime verification

This is a static ES-module website. The UI reads `data/products.json`; production serves that path through `cloudflare/worker.mjs`. Source files are allowlisted into `dist/` by `npm run build:cloudflare`.

## Launch

- Normal local preview: `npm run serve`, then open `http://127.0.0.1:4173/` in Chromium.
- Production URL: read `wrangler.json` → `vars.SITE_URL`. Visit that actual origin after deploying. Do not intercept production requests when claiming online verification.
- Use an installed Playwright package, locating it with `rg --files --hidden --no-ignore ~/.npm/_npx -g package.json | rg '/playwright/package.json$'` if it is not a project dependency. Import the adjacent `index.mjs` from a temporary script. Keep scripts and captures under `$CLAUDE_JOB_DIR/tmp` when that variable is present.
- On this macOS environment, cached `chromium_headless_shell-*` binaries under `~/Library/Caches/ms-playwright/` work with `chromium.launch({executablePath, args:['--no-sandbox','--disable-gpu','--in-process-gpu']})`. This avoids Chrome profile singleton failures. Use the actual installed path, not a hardcoded browser revision.
- If local socket binding is prohibited, launch Chromium over its pipe and use Playwright `context.route()` to serve the actual workspace files at `http://radar.local/`. Return the correct HTML/JS/CSS/JSON/SVG content types; strip query strings, constrain resolved paths to the project, and abort requests to other origins. This verifies the real static app but does **not** verify a listening HTTP server or the production Worker. Say which surface was used.
- For production, pass a proxy to Chromium if required by the environment. Never print credentials or a proxy URL containing credentials.

## Drive the UI

Wait for `[data-products] tr[data-key]` with `state:'attached'`: the table remains in the DOM but is hidden at mobile widths. Wait for actual visible cards separately.

1. Confirm the plan count, collection timestamp, freshness notice, and real first-page results. Source diagnostics must stay in the provider directory.
2. Combine region/route/currency/billing filters; search a provider alias. Reload the query URL and check that controls/results restore. Clear an empty result through its recovery button.
3. Bookmark a plan and reload. Enter saved plans, then use browser Back to restore the previous filters. On desktop cards and mobile, toggle a bookmark with Space and confirm keyboard focus remains on the visible bookmark.
4. Select four plans and attempt a fifth; comparison must cap at four. Open the comparison dialog and close it with Escape. Verify card/table layout switching and pagination.
5. Open a provider's collection details, then refresh inventory. The open dialog must update rather than retaining old availability. Trigger a 503 at the browser request boundary and check that counts become unknown, shared filters survive, and retry recovers.
6. Visit activity and guide views. A baseline with no events must explain that history is being established, not invent a restock. Expand FAQs.
7. Toggle theme and reload. Check at least 390, 768, and 1440px. Inspect `document.documentElement.scrollWidth <= innerWidth` and look at the screenshots. Use `animations:'disabled'` or reduced motion for settled captures.
8. For automatic refreshing, Playwright's browser clock can advance five minutes while visible. Check that the published JSON is reread and selections remain attached to the same products. No direct provider crawl should occur in the browser.

Record `pageerror` events, response status, and screenshots. Tests and syntax checks are CI evidence, not a substitute for these interactions.

## Production and scheduled collection

Publishing is an external write; only do it when authorized in the session.

- Build and deploy using the pinned commands in `package.json`; capture the Worker version ID and URL from Wrangler.
- Check the live homepage, module URLs, and `/data/products.json` over HTTPS. Confirm the canonical URL uses this deployment's origin.
- After publishing collector changes to `main`, dispatch `Monitor VPS Sources` through `gh workflow run monitor.yml --repo Mr-HRJ/resnode-radar --ref main` when authorized. Inspect the actual Actions run and resulting public JSON, not just workflow configuration.
- The Worker reads `Mr-HRJ/resnode-radar/main/data/products.json`, with a short edge cache. Inventory publication may take a brief period to reach the site.
- Provider blocking or unavailable stock is an observed source outcome, not automatically a failed deployment. Report actual coverage and timestamps; do not promise every provider exposes stock.
