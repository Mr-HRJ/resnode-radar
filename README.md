# ResNode Radar

This fork deploys to [Cloudflare](https://resnode-radar.haorenjie1997.workers.dev/)
and runs its own scheduled collector. See [deployment instructions](docs/cloudflare-deployment.md).
Based on [the original ResNode Radar](https://github.com/majiayu000/resnode-radar),
with its MIT license and copyright notice retained.

[![CI](https://github.com/Mr-HRJ/resnode-radar/actions/workflows/ci.yml/badge.svg)](https://github.com/Mr-HRJ/resnode-radar/actions/workflows/ci.yml)
[![Monitor VPS Sources](https://github.com/Mr-HRJ/resnode-radar/actions/workflows/monitor.yml/badge.svg)](https://github.com/Mr-HRJ/resnode-radar/actions/workflows/monitor.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

VPS stock monitor and owner-run review site for Chinese cross-border operators.

[Browse the live inventory](https://resnode-radar.haorenjie1997.workers.dev/) ·
[Quick start](#quick-start) · [Monitoring contract](docs/monitoring-spec.md)

ResNode Radar tracks provider-backed VPS availability, records parser evidence,
and renders a static frontend for quick comparison. It is intentionally
data-first: no fallback mock products are shown when live provider parsing fails.

## What It Does

- Fetches provider pages from configured sources.
- Parses stock or order-entry evidence.
- Writes normalized monitor data to `data/products.json`.
- Validates generated data before publishing it.
- Serves a static frontend from `index.html`.
- Separates ordinary VPS (`category: vps`) from residential/ISP-focused VPS (`category: home`). IP labels remain an independent filter; a native IP claim alone does not imply residential hosting.
- Provides four complete views: plan discovery, provider directory, observed stock/price changes, and a buying guide.
- Supports shareable region, route, provider, IP, currency, billing-cycle and availability filters; desktop tables/cards; responsive mobile cards; local bookmarks; and side-by-side comparison of up to four plans.
- Preserves original bills and adds an optional CNY monthly estimate using dated ECB reference rates. Unknown cycles, configurable starting prices and unavailable/stale rates do not produce converted estimates.
- Records changes between comparable collector observations, retaining up to 300 events for seven days. An initial observation establishes a baseline; a missing or blocked product does not become a sellout.

See the [product and interaction notes](docs/product-experience.md) for the browsing flows and data boundaries.

[Desktop preview](assets/site-desktop.png) · [Mobile preview](assets/site-mobile.png)

Previews show the checked-in snapshot and its original collection time, not current stock.

## What It Is Not

- Not affiliated with any listed VPS provider.
- Not a guarantee of stock, price, routing quality, or purchase success.
- Not a payment or provisioning system.
- Not a replacement for reading provider terms before ordering.

## Quick Start

Use Node.js 24 or newer. The repository includes `.nvmrc` for local version
selection.

Install dependencies:

```sh
npm ci
```

Generate static assets, update monitor data, validate it, and run the local
preview:

```sh
npm run assets
npm run monitor
npm run monitor:validate
npm run check
npm run serve
```

Open `http://127.0.0.1:4173/`.

## Public Site

Cloudflare serves the website at <https://resnode-radar.haorenjie1997.workers.dev/>.
The build uses `wrangler.json` to generate canonical URLs, `sitemap.xml`, and
`robots.txt`. Inventory is loaded from this fork's scheduled collector without
redeploying the website. See [Cloudflare deployment](docs/cloudflare-deployment.md).
The unfinished review templates retain `noindex` until real test evidence is
added. The committed preview is a screenshot, not a promise of current stock.

## Release Policy

ResNode Radar is published as a source repository and static site project, not
as an npm package. `package.json` stays `private: true` intentionally.

## Local Preview

```sh
npm run assets
npm run monitor
npm run monitor:validate
npm run check
npm run serve
```

Open `http://127.0.0.1:4173/`.

## Data Contract

Provider sources live in `monitor/sources.json`. Generated monitor output lives in `data/products.json`.

The public frontend reads `data/products.json`; it does not contain fallback mock products. If a provider blocks scraping or parsing fails, the generated record must show `blocked` or `error`.

Each generated product record should carry enough evidence for a human reader to
distinguish:

- precise positive stock count
- order entry exists but count is unstated
- provider page blocked the parser
- parser failed or produced invalid data

## Update Data

```sh
npm run monitor
npm run monitor:validate
```

## Monitoring

```sh
npm run monitor
npm run monitor:validate
```

GitHub Actions is scheduled at minutes 7 and 37 of each hour and commits `data/products.json` after collection. Check actual Actions runs and the published collection timestamp; a configured schedule alone does not prove a run occurred.

The directory contains 65 unique providers: all 57 entries from the public
[MeowVPS directory](https://meowvps.com/VPS/) observed on 2026-11-10, merged with
this site's existing providers and official ZgoCloud, BERO HOST, and Spartan Host catalogs. `providers.js` holds factual directory metadata;
`monitor/sources.json` configures an automated read for every provider. Directory
inclusion is not a claim that every provider exposes usable stock.

The collector keeps the existing provider adapters and adds bounded official
catalog parsing, USVPS24/NodeMach public page payloads, Miraigrid/100TB/Neburst/Skyline
public product APIs, and dedicated EVOXT, V.PS, ZgoCloud, BERO HOST, and Spartan
catalog adapters. See [source coverage and collection boundaries](docs/source-coverage.md).
NodeMach replaces the retired VIRCS product endpoints. Public
catalog discovery follows only configured official hosts, excludes checkout and
language mirrors, and spaces requests by 2 seconds (10 seconds for ZoroCloud).
Each generic source checks at most 12 pages unless explicitly configured.

Plans appear in the inventory view; failed reads and unparseable/login-only
catalogs appear in the provider directory with diagnostics. A positive exact
stock count, an official availability flag, and an order link are distinct
signals. No challenge or login is bypassed. A partial crawl may omit product
groups; the provider detail shows that limitation.

The responsive UI supports four views, ordinary/residential categories, provider
aliases and hardware search, region and network-route shortcuts, currency and
billing filters, removable filter chips, pagination, source details, local
bookmarks, and comparison of up to four plans. Filters are represented in the URL.
The browser rereads the published snapshot every five minutes while visible and
marks snapshots older than 90 minutes as stale. Refreshing never triggers a
provider crawl.

Original prices and billing cycles stay visible. `npm run fx:update` reads the
ECB daily XML into `data/fx.json`; the collector embeds valid rates into the
inventory payload. CNY estimates use known fixed billing periods, retain the
reference date, exclude fees/taxes, and stop converting foreign currencies when
rates exceed seven days. A failed FX update preserves the previous reference
date. It does not fabricate rates or block stock collection.

The collector also embeds `events` and `eventTracking`. Only comparable,
chronologically ordered observations can create stock/price events; unknown,
blocked, missing, or third-party snapshot records cannot create apparent
restocks or sellouts. The first run establishes an empty baseline. Bookmarks are
local browser data and do not send email or push notifications.


## License

MIT. See [LICENSE](LICENSE).
