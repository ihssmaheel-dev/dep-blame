# Changelog

All notable changes to `dep-blame` (CLI, engine, and bundled dashboard) are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0 minors may carry breaking cache-schema or JSON additions; additive
JSON fields (`total`, `generation`, `months`, `headState`) never break
`schemaVersion: 1` consumers.

## [Unreleased]

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
- Dashboard gzip budget **40 → 44 KiB** (still ~1/3 of any framework baseline): accounts for the full-detail GitHub brand mark and per-commit lifecycle grouping, both irreducible product requirements.

[Unreleased]: https://github.com/ihssmaheel-dev/dep-blame/compare/dep-blame-v0.1.0...HEAD
[0.1.0]: https://github.com/ihssmaheel-dev/dep-blame/releases/tag/dep-blame-v0.1.0
