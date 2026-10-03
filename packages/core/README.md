<p align="center">
  <img src="ui/logo.svg" width="128" alt="dep-blame logo">
</p>

<h1 align="center">dep-blame</h1>

<p align="center">
  <b><code>git blame</code>, but for your dependencies.</b><br>
  See exactly how your project's dependencies changed over time — what changed, when, by whom, and in which commit.
</p>

<p align="center">
[![npm version](https://img.shields.io/npm/v/dep-blame)](https://www.npmjs.com/package/dep-blame)
[![node](https://img.shields.io/node/v/dep-blame)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
</p>

```bash
npx dep-blame                 # chronological event list
npx dep-blame pkg react       # full lifecycle of one package
npx dep-blame calendar        # terminal month grid
npx dep-blame stats           # churn statistics
npx dep-blame ui              # visual dashboard (bundled, no extra install)
npx dep-blame ci --since origin/main --fail-on-removal
npx dep-blame list --limit 50 --json
```

Zero required runtime dependencies. Node.js ≥ 20. Fully offline — no registry lookups, no telemetry.

Full documentation (CLI reference, CI, cache, monorepos, dashboard, API, troubleshooting): [dep-blame on GitHub](https://github.com/ihssmaheel-dev/dep-blame#readme).

Large scans stream baseline and HEAD contents one file at a time; combined
manifest size may exceed 64 MiB. Individual blobs remain limited to 64 MiB
before allocation. Library consumers can use the exported `streamReadBlobs`
async iterator for large totals; `batchReadBlobs` retains a 64 MiB map limit.

## Commands

| Command | Description |
|---|---|
| `list` *(default)* | Flat chronological event list |
| `pkg <name>` | Archaeology view for one package, with HEAD status (`Active at HEAD` / `Not declared at HEAD` / `HEAD unknown`) |
| `calendar` | Terminal month-grid visualization |
| `stats` | Totals, declared vs resolved counts, top-5 packages and authors |
| `added` / `updated` / `removed` | Type-filtered lists |
| `changes` | Time-windowed list (with `--since 30d`) |
| `ci` | PR-scoped summary for review gates |
| `ui` | Launch the bundled visual dashboard (`--port`, `--host`, `--no-open`) |

## Options

| Flag | Description |
|---|---|
| `--since <ref\|window>` | `7d`, `30d`, `2w`, `6mo`, `1y`, `12h`, ISO date — or a git ref for `ci` |
| `--workspace <name>` | Segment-aware workspace filter (e.g. `--workspace web`) |
| `--source <manifest\|lockfile>` | Declared (`package.json`) vs resolved (lockfile) evidence |
| `--direct-only` | Direct dependencies only (yarn entries are resolved-only and excluded) |
| `--limit <n>` / `--page <n>` | Bounded queries (`0`–`1000`; JSON reports `total`) |
| `--months` | Month aggregates in JSON for bounded calendars |
| `--verbose` | Expand collapsed bulk workspace updates |
| `--json` / `--csv` | Stable `schemaVersion: 1` JSON; spreadsheet-safe CSV |
| `--fail-on-removal` | *(CI)* exit `1` when a removal is detected (exit `2` = unresolvable base) |
| `--clear-cache` / `--no-cache` | Rebuild index / scan a throwaway store |
| `--cache-dir <path>` | Override cache location (`<git-common-dir>/dep-blame/` by default) |
| `-p, --port <n>` / `--host <addr>` / `--no-open` | *(ui only)* Dashboard serve options |

## Dashboard (bundled)

The zero-framework visual dashboard ships inside this same package — timeline table, calendar, per-package archaeology drawer, search, filters, JSON export, dark/light themes. No extra install:

```bash
dep-blame ui
dep-blame ui --port 4321 --host 127.0.0.1 --no-open
dep-blame-ui --port 4321   # identical alias, same package
```

Loopback-only by default (`DEP_BLAME_ALLOW_LAN=1` for LAN), strict Host/Origin checks, CSP without inline scripts, no emails or tokens in browser payloads. `DEP_BLAME_AVATARS=0` disables all hosting requests for fully offline mode. Full endpoint and configuration reference: [dep-blame on GitHub](https://github.com/ihssmaheel-dev/dep-blame#web-dashboard).

## Supported formats

| File | Detail |
|---|---|
| `package.json` (root + workspaces) | All four dependency sections; section moves are explicit `updated` events with `depTypeFrom` |
| `package-lock.json` (v1/v2/v3) | Resolved versions incl. nested installs; direct-only by default |
| `pnpm-lock.yaml` | Every workspace importer tracked separately |
| `yarn.lock` (Classic + Berry) | Full resolved tree as `isDirect: false` |
| `bun.lock` (text) | Workspace-aware; binary `bun.lockb` is reported and skipped, never guessed |

Events carry `source: "manifest"` (declared intent) or `"lockfile"` (resolved reality) — independent streams, even within one commit. Lockfile deletion ends resolution history with a warning, never fake removals. When one name resolves to several versions, all are kept in `resolutions` with `ambiguous: true` instead of silently collapsing.

The optional `yaml` dependency (installed by default) powers pnpm/Yarn parsing. With `--omit=optional` installs those lockfiles yield low-fidelity `(lockfile)` events plus an install hint.

## History semantics

- Each commit diffs against **its own first parent** — merges report exactly what the merge introduced into that parent’s history.
- Archaeology shows original commit authors and merge commit authors separately. A readable incoming snapshot matching the result earns a verified integration label; other merge results use a general merge-change label.
- Summaries distinguish commits from file events and evidence files. "First recorded" describes the scanned history, not a guaranteed original introduction. Git author metadata is not identity authentication.
- JSON adds optional `commitParents` and `changeOrigin` fields; CSV appends both columns. Cache schema v5 rebuilds older caches once to populate them.
- Corrupt manifests keep the last-good snapshot and warn; they never invent churn.
- Warnings plus a `truncated` flag ship on every human-readable command and in `--json`. Incomplete scans never look complete.

## Cache

SQLite (`node:sqlite` on Node ≥ 22.5) with an equivalent JSON fallback. Incremental (`cachedHEAD..HEAD`), rewrite-aware, atomically promoted with a generation pointer, PID-locked for concurrent scans. See the [full docs](https://github.com/ihssmaheel-dev/dep-blame#cache).

## CI

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0 # shallow clones hide dependency history
- run: npx dep-blame ci --since origin/main --fail-on-removal
```

## Requirements

Node.js ≥ 20 · Git on `PATH` · Zero required runtime dependencies
