# Changelog

All notable changes to `dep-blame` (CLI, engine, and bundled dashboard) are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0 minors may carry breaking cache-schema or JSON additions; additive
JSON fields (`total`, `generation`, `months`, `headState`) never break
`schemaVersion: 1` consumers.

## [Unreleased]

## [0.3.0] — 2026-10-04

### Added

- Friendly slow-scan message: heavy histories (1000+ commits or 50+ manifests
  in the CLI; 20+ quiet seconds in the dashboard) explain the wait, the
  first-run cache build, and the seconds-fast incremental future — instead of
  looking stuck.
- Scan notices moved from a yellow banner above the table into a toolbar
  Notices button with a count and a proper modal (focus handling, Esc,
  click-outside), one notice per row with highlighted paths and commits.

### Fixed

- Large-repository scans stay live and finish faster: manifest discovery and
  commit walks stream running counts (plus elapsed-time heartbeats on quiet
  stretches) instead of freezing the terminal/SSE stream; multi-path log walks
  run with bounded parallelism; repeated lockfile blobs parse once per unique
  object via an OID-keyed cache (64 blobs / 100k entries, LRU). Walk phases
  report indeterminate totals with live counts (never a frozen static
  percent) and the analyzing stream carries a commits/sec rate. No
  event-model or output-contract changes.

## [0.2.0] — 2026-10-04

### Fixed

- Archaeology distinguishes direct commits from verified merge integrations using incoming-parent snapshots. Original additions and merge authors have separate labels in the dashboard, CLI, and Markdown export. Unreadable incoming evidence uses a general merge-change label.
- Drawer summaries distinguish commits, file events, and evidence files; "First recorded" and "Commit authors" avoid implying a known original introduction or verified identity. Mobile headers and evidence lines wrap cleanly.
- Large history scans no longer fail when branch-parent baselines, incremental baselines, HEAD manifests, or one commit total more than 64 MiB. These reads consume one file at a time with Git stdout backpressure; normal history transfers retain the 16 MiB batching target.
- Streaming blob reads close Git on cancellation or consumer errors, preserve UTF-8 across stream chunks, and apply the timeout to stalled Git I/O. Individual blobs remain capped at 64 MiB before body allocation, with path and commit in the error.
- Seeded snapshots retain blob IDs, and workspace lockfile baselines hash their source once per file, avoiding repeated transfers and per-importer hashing.

### Added

- Exported `streamReadBlobs` async iterator for library consumers whose aggregate reads exceed the bounded `batchReadBlobs` map API.
- Real Git regression fixtures above 72 MiB, covering dashboard SSE/JSON, complete HEAD state, cold and incremental scans, CLI parity, reader backpressure, cancellation, and oversized single-object rejection.

### Changed

- Cache schema **v4 → v5** persists `commitParents` and `changeOrigin`; existing caches rebuild once to recover this metadata. JSON fields are additive at `schemaVersion: 1`; CSV appends the two columns. Raw first-parent events remain complete.

## [0.1.0] — 2026-10-02

First public release: `git blame` for dependencies as a single
zero-dependency `dep-blame` package (CLI + engine + bundled dashboard).

### Added

- Single-package distribution: the dashboard now ships bundled inside `dep-blame` (`packages/core/ui/`) — no separate `@dep-blame/ui` download. `dep-blame ui [--port --host --no-open]` launches it, with `dep-blame-ui` as an identical same-package alias bin. The engine is consumed via package self-reference; the tarball carries `bin/`, `dist/`, and `ui/`.

- Bounded queries end to end: CLI `--limit` / `--page` / `--months` with `total` in JSON, engine `queryPaged` / `monthAggregates`, and dashboard endpoints `GET /api/events/paged`, `/api/months`, `/api/facets`.
- Multi-version honesty: `resolutions[]` + `ambiguous: true` on entries and events (npm nested installs, yarn multi-descriptor entries, bun multi-version packages) instead of silently collapsing to the first version.
- Atomic cache generations: WAL-checkpointed promotion, opposite-backend cleanup, and an `active.json` generation pointer (`generation`, `head`, `schema: 4`) read back as `generation` in results.
- `ci --since 7d`-style time windows filter by date instead of silently falling back to the default branch.
- Production docs: `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `SUPPORT.md`, issue/PR templates, and a rewritten official-grade `README.md`.

### Fixed

- Package archaeology (`dep-blame pkg`, dashboard drawer, Markdown export) groups same-commit manifest + lockfile evidence into one lifecycle node per commit: a dependency added in ten workspaces reads as one step (declared + resolved lines, manifests listed) instead of twenty rows. `--json`/`--csv` stay complete; grouping is render-only.

- Guarded `InvalidBaselineError` retry (single rescan, then a clear `--clear-cache` error) instead of unbounded recursion.
- Historic discovery: any `node_modules` segment filtered (was only `node_modules/.`); over-long paths mark history `truncated` instead of silently partial.
- `JsonStore.transaction` deep-copy rollback (was live-reference truncation).
- Stats timeframe uses viewer-local `eventDayKey`, consistent with calendar grouping and SQLite instant comparison.
- `getRepoState` validates `rev-parse` shape with a safe fallback; `getManifestCommits` chunks path filters (50 per invocation) against `ARG_MAX`.
- `seedMissingParents` recovery walks bounded (50); scan lock wait extended to 60s for long scans.
- Yarn Classic/Berry descriptor parsing: comma-joined descriptors split per name; quoted names handled.
- Dashboard pager: flex-column card pins the pagination footer on every viewport with safe-area padding; table height is viewport-bound (`clamp(240px, 100dvh − 360px, 560px)`) with compact mobile controls.

### Changed

- Cache schema **v3 → v4** (`resolutions`, `ambiguous` columns, new indexes on `type` / `is_direct` / `ambiguous`). Stale caches migrate by rescan.
- CSV gains `resolutions` and `ambiguous` columns (spreadsheet-safe quoting retained).
- `test/cache.test.js` asserts the current `CACHE_SCHEMA_VERSION` instead of a hardcoded `'3'`, with a Windows handle-race-tolerant cleanup.
- Dashboard gzip budget **44 → 46 KiB** (still ~1/3 of any framework baseline): accounts for the scan-notices modal and slow-scan note on top of the brand mark and per-commit lifecycle grouping, all irreducible product requirements.

[Unreleased]: https://github.com/ihssmaheel-dev/dep-blame/compare/dep-blame-v0.3.0...HEAD
[0.3.0]: https://github.com/ihssmaheel-dev/dep-blame/releases/tag/dep-blame-v0.3.0
[0.2.0]: https://github.com/ihssmaheel-dev/dep-blame/releases/tag/dep-blame-v0.2.0
[0.1.0]: https://github.com/ihssmaheel-dev/dep-blame/releases/tag/dep-blame-v0.1.0
