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
| GreenCloud | `https://www.greencloudvps.com/billing/store/{ssd-kvm-vps,budget-kvm-sale}/?language=english` | Two live public store groups with explicitly published USD monthly/annual quotes. Preserve zero and positive stock quantities; product order links without a quantity remain order-entry evidence. Other groups are outside this configured scope. |
| Neburst | `https://neburst.com/api/v1/public/pricing/cloud` | Region/shape/billing combinations, public offering-availability signals, integer-cent prices and matching automatic promotions. A false cell in the full region/shape matrix does not establish a sold-out regional SKU. No unit count is inferred. |
| Skyline Connect | `https://api.skylineconnect.io/v1/api/payment/payment_product_list` | Public anonymous product-list request with automatic Next.js `/_next/static/chunks/*.js` bundle discovery when static chunk hashes rotate across deployments. Separate billing SKUs; preserve base/configurable prices. `stocks`, `stocksSold`, and `enable` are retained as evidence without inventing remaining inventory. |
| MoonVM | `https://store.moonvm.com/cart.php` | Single-page full catalog; official product IDs survive sellouts and repeated group routes. Regions come from the containing group, not the current page title. |
| RivenCloud | `https://portal.sa.net/store/{cloud-server,cloud-server-unmetered}` | Official public storefront groups with verified stock states (`0 Available` vs purchasable order links), bypassing root login redirects without using marketing-page buttons as stock truth. |
| netcup | `https://www.netcup.com/en/server/{vps,arm-server}` | Direct official EUR VPS and ARM Server product pages without exhausting page budgets on unrelated site navigation. |

Neburst's public client sends a current timestamp, a request ID derived from the URL path, method, timestamp and actual user agent, and a fresh random anonymous device marker. The collector reproduces that public request format without importing browser cookies, account credentials or trace tokens. Bare requests can return HTTP 493 with an empty payload; this is a failed read, not an empty product catalog.

Skyline's public browser client encrypts a fresh nonce, timestamp and `group_id: "0"` using a published RSA public key. The collector reads the configured first-party client script on every run and uses the same anonymous request format. It does not use a private key, account credential, browser cookie, or captured request token. A changed script URL/key format or API redirect fails visibly.

Vendor-specific parsers are bounded and fail visibly when expected schemas change. `coverageNote` is shown in provider details where only selected families are configured. New records do not become synthetic restock events.

### 2026-11-22 recovery batch

| Provider(s) | Source | Parser |
| --- | --- | --- |
| LazyCat, NMCloud, BreaCloud, KFCHost, HHost | Anonymous product APIs loaded by each public storefront/pricing page | `spa-consoles.mjs` |
| Misaka (2 sources), HostHatch, GoldCloud | Server-rendered location inventory tables; official `js/app.js` plan data; public `/api/v1/products` | `vps-site-catalogs.mjs` |
| WebHorizon, DataOnline, ShanDun | HostBill one-step order pages; ShanDun's public product API | `billing-portal-catalogs.mjs` |
| FlawlessNode, BUG NET, LightNode (2 sources) | Pricing table; Paymenter category + product badges; regional landing pages | `page-limit-catalogs.mjs` |
| TOTHOST, VmShell, IPMELA | Exact WHMCS store groups (`discover: false`) instead of truncated crawls | generic |

Recorded as not collectable rather than guessed: NexKr, IPRaft and Geelinx (shop/catalog requires login), ISIF (product API behind a Cloudflare challenge), Langya and Taipei101 (no fixed plans), NoBrand (old store renewals only), Peekabo (CDN only), WireCat (KYC only), JCloud (Discord only). HostHatch and LightNode publish no anonymous stock, so their plans stay `unknown`. Providers whose pages return Cloudflare/WAF challenges, slider CAPTCHAs or login redirects remain `blocked`; the collector does not bypass them.

### Ubuntu follow-up: transport and dynamic catalogs

Live requests from the production VPS showed that several official storefronts reject Node's HTTP/1.1 request but serve the same anonymous page over HTTP/2. Only verified sources opt into the native HTTP/2 transport; TLS verification, official-host redirect checks, per-origin pacing, response-size limits and source deadlines remain active. SaltyFish, BreadCloud and HighEndNetwork use the published WHMCS encoded query route consistently, including after redirects. No account credentials, challenge-solving service or browser cookies are used.

| Provider | Correction and interpretation |
| --- | --- |
| DataOnline, LegendVPS | Read the existing official catalog over HTTP/2. |
| HostDare | Use the official billing directory, with complete hardware and explicit sellouts, instead of marketing-page order buttons. |
| WePC | Cover the 23 visited directory pages without the former 12-page truncation; exclude dedicated circuit and manual-service groups. |
| DigitalFyre | Read `https://console.digitalfyre.com/store/vps/`, with eight distinct SKU order links and current monthly USD prices. The old `/order/vps` seed redirected to login. An enabled product-specific order link indicates an order entry, not a published stock count. |
| Residential-Service | Include explicitly configurable VDS families, preserve starting prices, omit unpublished hardware, and retain zero stock. |
| SaltyFish, BreadCloud, HighEndNetwork | Collect public WHMCS groups and their published stock; a successfully parsed sold-out plan is not a collection failure. |
| Panstar | Follow anonymous regions → products → plans API requests. Decode the response using the encoding material in the currently published client, without hard-coding a rotating bundle or key. Preserve integer-cent prices, minimum billing cycles, stock booleans and purchase restrictions; no unit count is invented. The request/time budget preserves partial records with an explicit failure diagnostic. |
| HaloCloud | Parse the public international storefront's embedded full catalog. Map group regions, treat controlled nonpositive quantities as sold out, and ignore quantity fields when stock control is disabled. China-site login-only products remain outside coverage. |

DataWave's official product API returns an authentication failure (`code: 401`) anonymously; its public homepage has no plans. Remaining WAF/CAPTCHA/login failures stay visible. VMVM's `www.vmvm.io` returns NXDOMAIN through both Google and Cloudflare DNS; the apex `vmvm.io` has no A/AAAA answers. This is an upstream domain issue, not evidence of sold-out stock. `ENOTFOUND` now identifies the failing hostname and skips futile retries within that run; the next scheduled collection still tries again. Temporary `EAI_AGAIN` failures retain retries.

Temporary origin failures (502–504 and 520–524) receive the existing bounded retry/backoff for GET reads. Explicit challenge responses are not retried by this rule. A Cloudflare Ray ID on a 5xx page alone no longer misclassifies an upstream failure as a CAPTCHA; exhausted retries retain the HTTP error. This was prompted by a live ZoroCloud Japan group returning [HTTP 522, an origin connection timeout](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-522/).

### SKU follow-up from the production VPS (2026-11-22)

666Clouds moved to `https://www.666clouds.com/shop`. Its public Next.js payload publishes 58 native SKUs across 20 product families at verification time. Read `productId` + `planSubId`, each SKU's billing-cycle prices and integer inventory; family starting prices and stock summaries must not overwrite variant data. Zero is sold out, -1 explicitly means unlimited stock, and -1 prices disable that billing cycle. Annual-only offers retain the full annual price. Decode JSON chunks without executing page scripts; fail visibly on unsupported or incomplete schemas. Both the catalog and sampled SKU pages work directly from the VPS and through the residential exit, so no additional permanent proxy route is needed.

VMISS numeric PIDs 8/47 and published SKU paths remain challenged through the residential exit, including HTTP/2. Sampled RFC, TapHip, DMIT, Bocchi, PQS, RadoNet and PPFlight SKU URLs also remain challenged; LightLayer product IDs 316/476 still require login. HostBlazer/Zouter catalogs are challenged before a current exact SKU can be verified. VMVM still has an upstream DNS failure. These results do not establish inventory and are not converted into zero stock. The residential production allowlist remains GreenCloud and NovixLink only.

## Diagnostics & Deduplication

Generic catalog discovery respects a valid official-host HTML `<base href>` for navigation and orders while retaining the fetched-page provenance. WHMCS store route aliases (`/store/<slug>` and `/index.php?rp=/store/<slug>`) are canonicalized to a single visit so multi-region stores (such as Boil, BestVM, YUNYOO, and BageVM) do not waste page budgets on duplicate routes. Obvious aggregate headings and resource add-ons are excluded from products.

Redirect destinations are also marked visited, without consuming another page slot. WHMCS `gid=addons`/`renewals`, `m=product_restock_notifier` subscription actions, checkout/configuration links and configured excluded paths are not crawled. NovixLink's notification links require a customer login but do not make its successfully parsed product groups incomplete. MoonVM's customer-only add-on link previously created a false provider failure, while repeated group routes inflated 14 actual plans to 59 rows. Its dedicated parser uses official IDs and group headings. HostBill quickcart offer identities deduplicate repeated marketing pages without inferring stock; aggregate headings and checkout forms are not product cards. LightLayer still redirects its catalog to login, including with an anonymous cookie session, so only that entry is rechecked instead of eleven equivalent login redirects.

WHMCS sold-out text and zero quantities override order links; disabled buttons do not establish availability. Third-party AaITR Reader records retain the quoted stock label in `raw.snapshotStatus`, but their current status is `unknown`. They cannot contribute to current available/sold-out totals.

Diagnostics distinguish a challenge, HTTP denial, rate limiting, login redirect, and a page with no parsed products. A successful HTTP response with no products retains its actual URL/status and has no invented order entry.

Normal browser loads of DMIT's public pricing page and VMISS's store remained restricted during inspection. LightLayer's account catalog redirected to the client area; its marketing application only exposed partial offers. ISIF's advertised public product API returned a challenge. Taipei101's calculator example is not a fixed purchasable plan. These results must not be converted into either stock or sellouts.

Further public-source checks on 2026-11-12 confirmed that DMIT's `https://dmit.news/feed.xml` and linked official Telegram channels expose dated operational announcements, while VMISS's officially linked `https://t.me/s/vmiss_com` exposes service notices. Neither supplied a current VPS price catalog. VMISS's 2022 launch table has no billing cycle; DMIT's 2025 compensation offer has expired eligibility deadlines. These are not current quotes. VMISS's 2026-10-10 notice also terminates HK.BGP.DC2 on 2026-10-28, so a third-party directory retaining that family is not sufficient evidence of current availability.

## Runtime verification

Run a bounded live subset with `MONITOR_ONLY=<source-id>[,<source-id>…] MONITOR_OUTPUT=/tmp/subset.json MONITOR_FETCH_RETRIES=0 npm run monitor`. Pacing still applies; the normal `data/products.json` is left untouched when `MONITOR_OUTPUT` points elsewhere. Do not pass unimplemented CLI flags and accidentally crawl every source.

Production at `vps.bnoai.com` uses the VPS `resnode-radar` daemon every 20 minutes, with direct DNS and a persistent snapshot directory. The legacy Cloudflare/GitHub path targets ten-minute UTC slots when explicitly enabled; it is not the production scheduler. The guard skips an already-published slot, not simply a young snapshot. Source budgets (default 150 s) cancel active reads and pacing/retry waits; they are not a bound on the entire queued run. Time-budget exhaustion produces an incomplete-coverage diagnostic distinct from a page limit. Snapshot validation checks unique product IDs, exact source coverage, summary counts, timestamps and stock values before atomic replacement. Debug subsets require an explicit `MONITOR_OUTPUT`. Changing a cron expression is not proof of execution: verify Cron outcomes, actual Actions runs and the published timestamp; runner queueing can delay completion.
