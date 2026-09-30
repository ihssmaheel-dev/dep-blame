# dep-blame

> **`git blame`, but for your dependencies.**
> See exactly how your project's dependencies changed over time.

`dep-blame` walks your repository's git history, extracts every dependency
addition, update, and removal from manifest and lockfile changes, caches the
result, and lets you query it from the terminal or as JSON/CSV.

```bash
npx dep-blame            # chronological event list
npx dep-blame pkg react  # full history of one package
npx dep-blame stats      # churn statistics
npx dep-blame ci --since origin/main --fail-on-removal
npx dep-blame --json     # machine-readable output
npx dep-blame --csv      # spreadsheet-friendly output
```

## Supported formats

| File | Detail |
|---|---|
| `package.json` (root + workspaces) | Declared ranges, all dependency sections |
| `package-lock.json` (v1/v2/v3) | Direct deps by default; resolved versions, never transitives unless asked |
| `pnpm-lock.yaml` | Every workspace importer tracked separately |
| `yarn.lock` (v1 + Berry) | Resolved tree (`isDirect: false`); first version shown when a name resolves multiply, with a warning |
| `bun.lock` (text) | Workspace-aware; binary `bun.lockb` is reported and skipped, never guessed |

Events carry `source: "manifest"` (declared intent) or `"lockfile"`
(resolved reality). Deleting a lockfile ends resolution history with a
warning — it never reports your declared packages as removed. Filter with
`--source manifest|lockfile` or `--direct-only` (note: yarn entries are
resolved-only and are excluded by `--direct-only`).

The optional `yaml` dependency powers pnpm/Yarn lockfile parsing. npm
installs it by default; with `npm install --omit=optional` those lockfiles
yield low-fidelity `(lockfile)` events plus an install hint instead.

## History semantics

- Each commit is diffed against its **own first parent**, so merges report
  exactly what the merge introduced — no phantom removals from sibling branches.
- Corrupt manifests keep the last-good snapshot and raise a warning;
  they never invent removal/addition pairs.
- `pkg <name>` status reflects **HEAD reality** (per manifest), not just the
  last chronological event.
- Warnings (shallow clones, skipped blobs, unsupported lockfiles, capped
  discovery) print on every human-readable command and ship in `--json`
  as `warnings` alongside a `truncated` flag. An incomplete scan never
  looks complete.

## Cache behavior

- Storage: `node:sqlite` when the runtime provides it, otherwise a JSON
  fallback — same queries, same filters either way.
- Location: `<git-common-dir>/dep-blame/` (shared across worktrees),
  override with `--cache-dir`.
- Warm runs reuse the cache; `--no-cache` scans a throwaway store and
  never touches or duplicates the real cache; full rescans build aside
  and promote atomically, so interrupted runs retry cleanly.
- Concurrent scans in one repository are serialized with a lock.

## Offline behavior

Fully offline. No registry lookups, no telemetry, no network requests.

## CI

```yaml
- run: npx dep-blame ci --since origin/main --fail-on-removal
```

CI scopes events to the exact `base..HEAD` commit set (full SHAs). An
empty range stays empty; an unresolvable base fails loudly (exit 2)
instead of analyzing unrelated history.

## Requirements

Node.js ≥ 20. Zero required runtime dependencies.
