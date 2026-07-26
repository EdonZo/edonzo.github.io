# edonzo.github.io

Static host for the **AstroShort** daily discovery feed.

- `solar-explorer/latest.json` — the feed the app polls (generated daily by
  `scripts/build-feed.mjs` from an allowlist of public agency APIs: NASA EONET,
  USGS, Launch Library 2, Wikimedia On-This-Day). Every entry carries its source.
- `solar-explorer/builders.json` — the curated Builders Board content.

No user data lives here — feedback/ideas go to a private database. This repo
contains only self-generated public-API content the app displays to everyone.
