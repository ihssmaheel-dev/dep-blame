# @dep-blame/ui

> Local visual dashboard for [`dep-blame`](https://github.com/ihssmaheel-dev/dep-blame#readme) — no framework, no bundler, sub-40KB gzipped.

[![npm version](https://img.shields.io/npm/v/@dep-blame/ui)](https://www.npmjs.com/package/@dep-blame/ui)
[![node](https://img.shields.io/node/v/@dep-blame/ui)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

```bash
npx @dep-blame/ui
npx @dep-blame/ui --port 4321 --host 127.0.0.1 --no-open
```

| Flag | Description |
|---|---|
| `--port, -p <n>` | Port (`0` = OS-assigned) |
| `--host <addr>` | Bind address (loopback by default; LAN needs `DEP_BLAME_ALLOW_LAN=1`) |
| `--no-open` | Don't auto-open the browser |

## What it does

Timeline table (25/50/100 rows, sticky header, pinned pagination footer on every screen size), calendar with month picker and day drill-down, per-package archaeology drawer with HEAD status and commit evidence, global search, action/manifest/source filters with visible chips, dark/light themes, keyboard navigation (`/` search, `1`/`2` views, `Esc` closes), and JSON export of **all matching events** (not just the visible page).

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | Dashboard |
| `GET /app.js` | Client script (strict CSP, no inline handlers) |
| `GET /fonts/*.woff2` | Bundled Manrope font (same-origin, `immutable`) |
| `GET /api/events` | Full engine result (`schemaVersion: 1`) |
| `GET /api/events/stream` | SSE scan progress + `complete` / `error` |
| `GET /api/events/paged?limit=&offset=&package=&type=&manifest=&workspace=&source=` | Bounded page + `total` |
| `GET /api/months?...` | Month aggregates for bounded calendars |
| `GET /api/facets?...` | Top packages / authors / manifests (200-cap) |
| `GET /api/authors?commits=<sha,…>` | Lazy host-linked accounts (≤ 20 commits, ≤ 6 concurrent) |
| `GET /api/avatars/<64-hex>` | Cached same-origin raster proxy |

## Security model

- **Loopback by default.** Non-loopback binds require `DEP_BLAME_ALLOW_LAN=1` — history ships with no auth.
- **DNS-rebinding barrier:** spoofed `Host` → `403`, cross-site `Origin` rejected.
- **No inline scripts/handlers**; repo text rendered escaped; CSP enforced.
- **No emails or tokens** in browser payloads. Avatars are local proxy URLs with initials fallback; Git names are never guessed as usernames.
- **Offline history:** no CDN fonts/analytics. `DEP_BLAME_AVATARS=0` disables all hosting requests.
- Outbound forge traffic is DNS-pinned; private destinations need `DEP_BLAME_ALLOW_PRIVATE_FORGE=1` and must match the configured origin. Tokens require HTTPS. SVG avatars rejected.

## Hosting configuration

| Setting | Purpose |
|---|---|
| `DEP_BLAME_FORGE_PROVIDER` | `github` \| `gitlab` \| `gitea` \| `forgejo` \| `bitbucket` \| `bitbucket-server` |
| `DEP_BLAME_FORGE_WEB_URL` | Full repo web URL (fixes SSH/web port mismatches) |
| `DEP_BLAME_FORGE_BASE_URL` | Installation base URL (e.g. `https://code.example/gitlab`) |
| `DEP_BLAME_ALLOW_PRIVATE_FORGE=1` | Allow the configured forge origin on private networks |
| `DEP_BLAME_FORGE_TOKEN` | Read-only API token — server-side only, HTTPS only |
| `DEP_BLAME_AVATARS=0` | Fully offline mode |

```powershell
$env:DEP_BLAME_FORGE_PROVIDER = 'gitlab'
$env:DEP_BLAME_FORGE_WEB_URL = 'http://git.local:8080/group/project'
$env:DEP_BLAME_ALLOW_PRIVATE_FORGE = '1'
npx @dep-blame/ui
```

Account lookups run after history renders, share work per Git name/email identity (512-entry cache), and never block the timeline on rate limits or private repos — unmatched authors keep initials.

Full documentation: [dep-blame on GitHub](https://github.com/ihssmaheel-dev/dep-blame#readme).

## Requirements

Node.js ≥ 20. Depends on `dep-blame` for the analysis engine.
