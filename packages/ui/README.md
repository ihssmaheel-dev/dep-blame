# @dep-blame/ui

Lightweight, local visual dashboard for `dep-blame` — no build step, no
framework, no external requests.

```bash
npx @dep-blame/ui
npx @dep-blame/ui --port 4321 --no-open
```

## What it does

Serves a single-page dashboard on loopback (`127.0.0.1` by default):

- `GET /` — the dashboard (timeline table, calendar, per-package
  archaeology drawer, paginated at 100 rows/page)
- `GET /app.js` — client script (no inline scripts, strict CSP)
- `GET /fonts/*.woff2` — bundled Manrope variable font (same-origin, immutable)
- `GET /api/events` — the `dep-blame` engine result as JSON
- `GET /api/events/stream` — same, with SSE scan progress

Responses are gzip-compressed when the client accepts it.

## Security model

- **Loopback by default.** Binding a non-loopback host requires
  `DEP_BLAME_ALLOW_LAN=1`; without it the server refuses to start.
- **Spoofed `Host` headers get 403**, and cross-site `Origin` values are
  rejected, as a DNS-rebinding barrier.
- **No inline event handlers** anywhere; repository data (package names,
  authors, messages) is rendered via `textContent`/escaped HTML plus
  delegated listeners, under a CSP without inline-script allowance.
- **No emails or remote avatars** in API responses — authors get local
  initials and same-origin-safe profile links only.
- **Fully offline:** no web fonts, no CDN, no analytics. Manrope ships
  as subsetted woff2 in `src/fonts/` and is served from the package
  itself. Everything renders with zero network access.
- Concurrent dashboard loads share one in-flight scan instead of
  trampling the cache.

## Requirements

Node.js ≥ 20. Depends on `dep-blame` for the analysis engine.
