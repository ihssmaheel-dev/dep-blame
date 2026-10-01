# @dep-blame/ui

Lightweight, local visual dashboard for `dep-blame` — no build step, no
framework. History analysis works offline; hosting avatars are optional.

```bash
npx @dep-blame/ui
npx @dep-blame/ui --port 4321 --no-open
```

## What it does

Serves a single-page dashboard on loopback (`127.0.0.1` by default):

- `GET /` — the dashboard (timeline table, calendar, per-package
  archaeology drawer; the table offers 25/50/100 rows per page)
- `GET /app.js` — client script (no inline scripts, strict CSP)
- `GET /fonts/*.woff2` — bundled Manrope variable font (same-origin, immutable)
- `GET /api/events` — the `dep-blame` engine result as JSON
- `GET /api/events/stream` — same, with SSE scan progress
- `GET /api/authors?commits=...` — lazy hosting accounts for up to 20 indexed commits
- `GET /api/avatars/<opaque-id>` — cached same-origin raster images

Responses are gzip-compressed when the client accepts it.

## Security model

- **Loopback by default.** Binding a non-loopback host requires
  `DEP_BLAME_ALLOW_LAN=1`; without it the server refuses to start.
- **Spoofed `Host` headers get 403**, and cross-site `Origin` values are
  rejected, as a DNS-rebinding barrier.
- **No inline event handlers** anywhere; repository data (package names,
  authors, messages) is rendered via `textContent`/escaped HTML plus
  delegated listeners, under a CSP without inline-script allowance.
- **No emails or tokens** in browser responses. Pictures and profile links
  come from host-linked commit accounts; Git names are never guessed as
  usernames. Avatar URLs are local proxy paths, with initials as fallback.
- **Offline history:** no remote fonts or analytics. Manrope ships as
  subsetted woff2. Set `DEP_BLAME_AVATARS=0` to disable hosting requests.
- Outbound requests validate and pin DNS addresses; private destinations
  need an explicit setting and must match the configured forge origin.
  Redirects are revalidated, credentials stay on their original origin,
  tokens require HTTPS, and SVG avatars are rejected.
- Concurrent dashboard loads share one in-flight scan instead of
  trampling the cache.

## Requirements

Node.js ≥ 20. Depends on `dep-blame` for the analysis engine.

## Controls

- Neutral black dark mode and a light theme, with bundled fonts.
- Shared filter panels, visible applied-filter chips, and custom date
  range and page-size controls. No native date picker or select menu.
- Calendar navigation uses months; table pagination is hidden in calendar
  view. Select a day to inspect its events in the table.
- JSON export contains all matching events, scan warnings, and the
  incomplete-history flag, independently of the visible table page.
- Dates in the UI use the viewer's local calendar day.

The API currently transfers the full indexed history to the browser.
Table pagination bounds rendered rows, not total browser memory.

## Hosting profiles and self-hosted services

The footer identifies the service and host. Public GitHub, GitLab, Gitea,
Codeberg/Forgejo and Bitbucket Cloud have known adapters. Other hosts are
probed through bounded service APIs; inconclusive detection says “Git host”
and shows the actual hostname. No remote says “Local Git”.

GitHub Enterprise, GitLab, Gitea/Forgejo and Bitbucket Server/Data Center
can also be configured explicitly. Environment settings:

| Setting | Purpose |
| --- | --- |
| DEP_BLAME_FORGE_PROVIDER | github, gitlab, gitea, forgejo, bitbucket, or bitbucket-server |
| DEP_BLAME_FORGE_WEB_URL | Full repository web URL, useful when SSH ports differ from web ports |
| DEP_BLAME_FORGE_BASE_URL | Installation base URL, e.g. https://code.example/gitlab for a subpath install |
| DEP_BLAME_ALLOW_PRIVATE_FORGE=1 | Permit requests to the configured forge origin on loopback or a private network |
| DEP_BLAME_FORGE_TOKEN | Optional read-only API token, kept server-side; use only with a trusted HTTPS forge |
| DEP_BLAME_AVATARS=0 | Disable all hosting API/image requests |

For a local GitLab instance (PowerShell):

```powershell
$env:DEP_BLAME_FORGE_PROVIDER = 'gitlab'
$env:DEP_BLAME_FORGE_WEB_URL = 'http://git.local:8080/group/project'
$env:DEP_BLAME_ALLOW_PRIVATE_FORGE = '1'
npx @dep-blame/ui
```

For an installation under /gitlab, set the base to the /gitlab URL and
include /gitlab in the repository web URL. Tokens require HTTPS; local
HTTP instances can resolve publicly readable accounts without a token.
Private API access, custom certificate authorities, SSH host aliases and
nonstandard web URLs may require configuration. Certificate verification
is never disabled (Node's NODE_EXTRA_CA_CERTS supports a trusted local CA).

Account lookups run after history is displayed. They share work per Git
name/email identity, keep emails on the server, limit concurrency to three,
and cache positive/negative results. The directory holds up to 512 identity
entries; images are limited to 128 entries / 16 MiB, with a 512 KiB limit
per image and five-second HTTP request deadlines. Repeated commits by the
same identity reuse the host's account mapping.

An unpushed commit, an account the API cannot identify, a private repository
without credentials, a rate limit, or an unsupported avatar CDN retains
initials. A repository owner's picture is never assigned to every author.
Bitbucket Server Git-only Person records without an account ID also retain
initials. Adapter tests use fixtures; only GitHub was exercised against a
live public service during this audit.
