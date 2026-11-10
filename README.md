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

GitHub Actions runs `.github/workflows/monitor.yml` every 30 minutes and commits `data/products.json` when live provider data changes.

Current adapters cover RackNerd, VIRCS, LisaHost, ZoroCloud, CstoneCloud, 学长网络, YINNET, PoloCloud, ZLIDC, and AaITR. Ordinary VPS sources include RackNerd's official KVM plan table, ZoroCloud's CN2/9929/TRI product groups, and LisaHost's non-residential groups. ZoroCloud requests are spaced by 10 seconds per origin to avoid burst rate limits. Source categories are maintained from provider catalogs in `monitor/sources.json`, independently of the frontend's IP-text classification. `available` means the parser found a provider-backed positive stock count or an official order path; when stock count is not stated, the evidence field labels it as an order entry rather than precise stock.

## License

MIT. See [LICENSE](LICENSE).
