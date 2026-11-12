# Official catalog coverage and collection boundaries

The 2026-11-12 comparison with VPSBBC exposed several separate problems: login/homepage seeds, unsupported product markup, client-loaded public APIs, and providers absent from the directory. A failed HTML read does not establish that a provider publishes no data.

VPSBBC's permitted `https://vpsbbc.com/llms-full.txt` listed 218 plans across ten providers during inspection. Its availability labels are not unit counts, and its upstream collector implementation is not public. This project does not import those labels as official stock.

## Supported official sources

| Provider | Source | Interpretation |
| --- | --- | --- |
| EVOXT | `https://evoxt.com/pricing/` | Separate Standard, Premium, and Premium Plus plan variants. Public prices/specifications; generic Deploy links do not establish stock. |
| V.PS | `https://v.ps/products/{cloud,mini,performance}-kvm-vps/` | Individual cards, published country labels, EUR monthly/annual prices. Marketing `offerCount` is the number of offers, not remaining inventory. Other product families are outside this configured scope. |
| ZgoCloud | Hong Kong AMD and Los Angeles AMD Optimised groups at `clients.zgovps.com` | Separate product/billing-cycle identities. Explicit sold-out text overrides enabled Continue controls. Continue establishes an order entry, not a unit count. |
| BERO HOST | `https://bero-host.de/server/prepaid-ryzen-vserver-mieten` | German prices and sibling sold-out overlays. Preserve VAT and 30-day prepaid terms; selectable packages with no stock assertion remain unknown. |
| Spartan Host | Seattle Premium, Seattle CMIN2 and Dallas Premium groups at `billing.spartanhost.net` | Read actual billing groups. Marketing-page purchase links cannot override explicit sold-out stock in the store. Other groups are not claimed as covered. |
| Neburst | `https://neburst.com/api/v1/public/pricing/cloud` | Region/shape/billing combinations, public offering-availability signals, integer-cent prices and matching automatic promotions. A false cell in the full region/shape matrix does not establish a sold-out regional SKU. No unit count is inferred. |
| Skyline Connect | `https://api.skylineconnect.io/v1/api/payment/payment_product_list` | Public anonymous product-list request. Separate billing SKUs; preserve base/configurable prices. `stocks`, `stocksSold`, and `enable` are retained as evidence without inventing remaining inventory. |

Neburst's public client sends a current timestamp, a request ID derived from the URL path, method, timestamp and actual user agent, and a fresh random anonymous device marker. The collector reproduces that public request format without importing browser cookies, account credentials or trace tokens. Bare requests can return HTTP 493 with an empty payload; this is a failed read, not an empty product catalog.

Skyline's public browser client encrypts a fresh nonce, timestamp and `group_id: "0"` using a published RSA public key. The collector reads the configured first-party client script on every run and uses the same anonymous request format. It does not use a private key, account credential, browser cookie, or captured request token. A changed script URL/key format or API redirect fails visibly.

Vendor-specific parsers are bounded and fail visibly when expected schemas change. `coverageNote` is shown in provider details where only selected families are configured. New records do not become synthetic restock events.

## Diagnostics

Generic catalog discovery respects a valid official-host HTML `<base href>` for navigation and orders while retaining the fetched-page provenance. Obvious aggregate headings and resource add-ons are excluded from products.

Diagnostics distinguish a challenge, HTTP denial, rate limiting, login redirect, and a page with no parsed products. A successful HTTP response with no products retains its actual URL/status and has no invented order entry.

Normal browser loads of DMIT's public pricing page and VMISS's store remained restricted during inspection. LightLayer's account catalog redirected to the client area; its marketing application only exposed partial offers. ISIF's advertised public product API returned a challenge. Taipei101's calculator example is not a fixed purchasable plan. These results must not be converted into either stock or sellouts.

## Runtime verification

Run a bounded live subset by creating a temporary working directory with `monitor/sources.json` containing only the selected configured sources, then execute the absolute `scripts/monitor.mjs` path with that directory as cwd. The collector writes only that directory's `data/products.json`. Keep pacing, use `MONITOR_FETCH_RETRIES=0`, and validate the generated payload with the normal validator from the same cwd. Do not pass unimplemented CLI flags and accidentally crawl every source.

The GitHub workflow is scheduled at minutes 7 and 37. Changing a cron expression or enabling a workflow is not proof of timer execution: verify an actual Actions run with `event: schedule`, and check the published timestamp. Manual dispatch independently verifies the collector and publication path.
