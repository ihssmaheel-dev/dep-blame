# Contributing to dep-blame

Thanks for helping with `dep-blame`. This guide covers setup, workflow, and the repository-specific rules that keep the core CLI at zero dependencies and the dashboard secure.

Please also read the [Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you agree to it.

## Table of contents

- [Ways to contribute](#ways-to-contribute)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Repository map](#repository-map)
- [Development workflow](#development-workflow)
- [Code standards](#code-standards)
- [Testing](#testing)
- [Commit messages](#commit-messages)
- [Pull requests](#pull-requests)
- [Release process](#release-process)
- [Getting help](#getting-help)

## Ways to contribute

- **Bug reports** — real repositories reproduce best; include OS, Node version, package manager, and the smallest fixture that shows the problem.
- **Fixtures and tests** — new parsers, renderers, and edge cases need real-`git` fixture tests under `test/`.
- **Docs** — README, UI help text, error messages, and `dep-blame.md` accuracy improvements.
- **Performance** — repeatable benchmarks with fixture details (commit/event/manifest sizes, cache backend, cold vs warm, median/p95/RSS).
- **Security** — see [SECURITY.md](./SECURITY.md). **Do not open public issues for vulnerabilities.**

## Prerequisites

- **Node.js ≥ 20** (CI tests `20.x` and `22.x`; SQLite cache activates on Node ≥ 22.5)
- **Git on `PATH`**
- No native toolchain needed — there is deliberately no `node-gyp` step anywhere.

## Setup

```bash
git clone https://github.com/ihssmaheel-dev/dep-blame.git
cd dep-blame
npm install
npm run build
npm test
```

Useful commands:

| Command | Purpose |
|---|---|
| `npm run build` | Compile `packages/core` TypeScript to `dist/` |
| `npm test` | Build, then run the full suite (`node --test` via `scripts/test.mjs`) |
| `node --test test/<file>.test.js` | Run one test file |
| `node packages/core/bin/cli.js --help` | Exercise the local CLI without installing |
| `node packages/core/bin/cli.js ui --port 0 --no-open` | Start the bundled dashboard on an ephemeral port |

## Repository map

```text
packages/core/          the single publishable package: `dep-blame`
  bin/cli.js            `dep-blame` entrypoint (arg parsing, progress, exit codes)
  bin/dep-blame-ui.js   `dep-blame-ui` alias — prepends `ui`, same package
  ui/                   bundled dashboard (server.js, forge.js, app.js,
                        index.html, fonts/) shipped raw via `files`
  src/engine.ts         pipeline orchestration (the file most changes touch)
  src/git/              log streaming, cat-file batch reads, repo state
  src/manifest/         package.json + npm/pnpm/yarn/bun parsers
  src/diff/             snapshot diff → DependencyEvent[]
  src/cache/            SQLite + JSON stores, generation pointer, scan lock
  src/render/           table, calendar, stats, archaeology, json, csv, ci
test/                   81 real-git-fixture tests (never mocked `git log`)
scripts/test.mjs        Windows-safe test enumerator
dep-blame.md            architecture spec and audit log (see below)
```

`dep-blame.md` is the design record: `§1–11` is the original proposal, `§12–14` is the implementation audit with honest corrections (measured numbers, deferred P1 work). Fix code first; update the audit section when behavior intentionally changes.

## Development workflow

1. Fork and branch from `main`: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`.
2. Make focused changes — one concern per PR.
3. Add or extend fixture tests (see [Testing](#testing)).
4. Run `npm run build` and the relevant tests locally.
5. Open a PR against `main` using the template; link any related issue.

Keep PRs small enough to review in one sitting. Large refactors should be split into stacked, independently testable PRs.

## Code standards

These are hard requirements, enforced by tests or review:

1. **Zero required runtime dependencies in `packages/core`.** No new entry in `dependencies` — ever. The only exception is an `optionalDependencies` entry that is lazy-loaded and degrades with a clear message (the current `yaml` precedent).
2. **Explicit `.js` extensions** on all relative ESM imports (`./git/log.js`, never `./git/log`). The published bundle breaks otherwise.
3. **No `exec` — only `execFile`/`spawn` with argv arrays** for git subprocesses, plus `windowsHide: true` on every call.
4. **No `console.log` in library paths.** Engine code warns via the `warnOnce` channel and respects `silent`; only `bin/cli.js` writes user-facing output.
5. **Sanitize untrusted text.** Commit messages, authors, versions, and paths go through `stripControl` (terminal) or escaped HTML / `textContent` (dashboard). CSV output keeps formula neutralization. No inline event handlers in UI markup or scripts.
6. **Corrupt input warns, never invents.** Unparseable manifests keep the last-good snapshot and record a warning; lockfile deletion ends *resolution* history only. New parsers must return the tri-state contract (`ok: false` = corrupt, `null` = optional parser missing).
7. **Instant-based date comparison.** Never compare ISO strings lexicographically; use `Date.parse` with a lexicographic fallback, and `eventDayKey` (viewer-local) for calendar grouping.
8. **UI bundle budget:** `index.html` + `app.js` gzip must stay under **40 KiB** (`test/ui.test.js` enforces it). Subsetted local fonts only — no CDN.
9. **Server security invariants:** loopback-only default, strict `Host` port check + `Origin` match + `Sec-Fetch-Site` rejection, `no-store` on APIs, tokens server-side over HTTPS only. Changes touching `server.js`/`forge.js` need security-review attention in the PR.
10. **No framework creep in the UI.** Vanilla JS/CSS only. Extract modules instead of adding dependencies.

TypeScript: strict null handling, no `any` leakage into public types in `src/types.ts`. Additive JSON fields only — `schemaVersion: 1` consumers must never break.

## Testing

Tests use **real disposable git repositories** (`test/helpers/git-fixture.js`), not mocked `git log` output — mocks drift from real git behavior and hide bugs.

```bash
npm test                                   # full suite: 81 tests
node --test test/engine.test.js            # one area
node --test test/ui.test.js test/forge.test.js
```

Rules for new work:

- New parser behavior → fixture test with real commits showing add / update / remove.
- New renderer/CLI flag → test in `test/views.test.js` or `test/ci.test.js` plus a `--json` shape assertion where applicable.
- New server route → status-code, content-type, and `Host`-spoof tests in `test/ui.test.js` style.
- Bug fix → regression test that fails without the fix.
- Network-dependent behavior → controlled local fixtures/mocks, never live registries or live forge APIs (the one historical GitHub live check in the audit is documented, not a test dependency).

CI runs the matrix in [`.github/workflows/ci.yml`](./.github/workflows/ci.yml): Ubuntu/Windows/macOS × Node 20/22, plus a JSON-fallback job (`--omit=optional`) and tarball pack smoke tests. Your PR must pass all of them.

## Commit messages

Conventional, scoped, imperative — matching existing history:

```text
feat(core): bounded --limit/--page queries with total
fix(ui): pin pager footer on small viewports
fix(engine): guard baseline retry against infinite rescan
docs: rewrite README as official reference
test(cache): assert v4 migration clears stale generations
```

Scopes: `core`, `ui`, `engine`, `cache`, `git`, `manifest`, `cli`, `docs`, `test`, `ci`, `deps`.

- Subject ≤ 72 chars. Body explains *why*, not just *what*.
- Reference issues (`Fixes #123`) where applicable.
- Never commit secrets, tokens, private emails, or large fixtures.

## Pull requests

- Fill in the PR template: what changed, why, how it was tested, and any docs updated.
- Keep the diff focused; call out intentional scope trade-offs.
- Update docs alongside behavior: root `README.md`, package READMEs, and `dep-blame.md` audit notes when the change alters contracts, limits, or guarantees.
- Expect review on: zero-dep compliance, cache atomicity, date handling, output sanitization, and test coverage of unhappy paths (corrupt blobs, shallow clones, missing `yaml`, lockfile deletion, history rewrites).

## Release process

Releases are published automatically by [`.github/workflows/publish.yml`](./.github/workflows/publish.yml) when a GitHub Release is created from a version tag:

| Tag | Publishes |
|---|---|
| `dep-blame-vX.Y.Z` | `dep-blame` — CLI, engine, and bundled dashboard in one package |

The workflow verifies the tag matches `packages/core/package.json`, then runs `npm ci`, `npm run build`, `npm test`, tarball smoke tests (`test/pack-smoke.js`), and `npm publish --provenance`. One-time setup (reserving the `dep-blame` name + `NPM_TOKEN` secret) is documented at the top of the workflow file.

Maintainer checklist:

1. `npm test` green on `main`, tarballs smoke-tested.
2. Bump the version in `packages/core/package.json`.
3. Update [CHANGELOG.md](./CHANGELOG.md) under `Unreleased` → versioned section with date.
4. Create the GitHub Release from the version tag and let the workflow publish.
5. Verify from a clean directory: `npx dep-blame --version` and `dep-blame ui --help`.
6. If a publish step fails transiently, re-run it via the workflow's `workflow_dispatch` input instead of pushing a new tag.

## Getting help

- Questions and ideas: [GitHub Discussions / Issues](https://github.com/ihssmaheel-dev/dep-blame/issues) — see [SUPPORT.md](./SUPPORT.md) for what to include.
- Security issues: see [SECURITY.md](./SECURITY.md) — private report only.
