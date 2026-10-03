# dep-blame — Master Build Documentation

> **See exactly how your project's dependencies changed over time.**
> `npx dep-blame` — one command, zero config, zero servers, zero accounts.

This document is the single source of truth for building `dep-blame` end to end:
architecture, data model, CLI surface, algorithms, file layout, and a phased build
order. Nothing here requires Go, Rust, Docker, a database server, or a cloud
account. **Runtime dependency count for the core CLI: 0.**

---

## 1. Product Definition

**What it is:** a CLI (and optional local web UI) that walks a repo's git history,
extracts every dependency add/update/remove event from every manifest change, caches
the result, and lets you query/visualize it instantly.

**What it is not:** a dependency updater, a vulnerability scanner, or a registry
proxy. It reads history — it never writes to `package.json`, never hits npm's
registry by default, never needs network access to function.

**One-line pitch:** `git blame`, but for your dependencies.

**Non-negotiable constraints:**
- Install time: under 2 seconds on a warm npm cache.
- Zero native compilation step. No `node-gyp`, no `postinstall` binary download.
- Cold analysis of a 10k-commit repo: under 3 seconds. Warm (cached) re-run: under 200ms.
- Core CLI has **zero runtime npm dependencies**. The UI package (§6) is a
  separate install with its own, deliberately small, footprint.
- Node ≥ 20 LTS. Use `node:sqlite` when available (Node ≥ 22.5); fall back to a
  flat-file JSON store on Node 20–21 (see §4.4).

### 1.1 Prior art check

Searched the npm registry and GitHub before committing to the name/concept.
Nothing found does what this tool does — walking git history to produce a
timestamped add/updated/removed event stream per dependency:

| Package | What it actually does | Overlap |
|---|---|---|
| `npm-historian` | Resolves what version a semver range *would have* satisfied on the npm registry at a past date | No git involved — registry-based, not history-based |
| `npm-dependency-versions` (`depver`) | Same idea as above — registry lookups pinned to a date, via `git blame` on `package.json` for the date only | Closest conceptually, but single-purpose (date lookup), not an event timeline/calendar/CLI product |
| `dep-inspector-cli` | Dependency tree, `npm audit` wrapper, outdated/vulnerability scanning, optional AI insights | Different problem entirely (health/security snapshot, not history) |
| `npm-tree` | Static dependency tree visualization | No time dimension at all |

The name `dep-blame` was not found registered on npm at the time of this
check — confirm again immediately before publishing, since registry state
changes. No direct competitor exists for "git-derived dependency change
timeline with calendar/CI views," which is good validation for building it.



## 2. Why Node-only (not Go, not Rust)

The earlier draft proposed a Go analysis engine with platform-specific npm binaries.
Reasons to reject that for this project:

| Concern | Go/multi-binary approach | Pure Node approach |
|---|---|---|
| Install | 5 platform packages + a resolver package | 1 package |
| Postinstall | download/select binary | none |
| Native compile | none (Go is precompiled) but binary distribution complexity | none — `node:sqlite` ships in the runtime |
| Git access | must vendor or shell to `git` anyway | shell to `git` directly, no extra layer |
| Contributor friction | must know Go **and** Node | Node only |
| "Ultra lightweight" claim | true at runtime, heavy at publish/CI time | true everywhere |

The performance-sensitive part of this tool is **not CPU-bound compute** — it's
**I/O**: reading git objects and parsing JSON/YAML manifests. `git` itself (written
in C, already on the user's machine) does the heavy lifting when you shell out to
it with the right flags (§5.1). Node's job is orchestration, parsing, and
diffing — all of which it does plenty fast for this workload size (hundreds to
low tens-of-thousands of relevant commits, not millions).

---

## 3. High-Level Architecture

```
                     npx dep-blame
                            │
                            ▼
                  ┌───────────────────┐
                  │   bin/cli.js      │  ← thin entrypoint, arg parsing
                  └─────────┬─────────┘
                            │
                            ▼
                  ┌───────────────────┐
                  │  core engine      │  (pure Node, zero deps)
                  │                   │
                  │  git/  → shells to system `git`, streams output
                  │  manifest/ → parses package.json + lockfiles
                  │  diff/  → snapshot A vs snapshot B → events
                  │  cache/ → node:sqlite (or JSON fallback)
                  └─────────┬─────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
         CLI renderer   JSON emitter   UI server
        (ANSI tables,   (--json flag,  (separate
         calendar art)   CI mode)       package, vanilla HTML/JS + node:http)
```

**Package split, under the `dep-blame` npm org (§6.1):**

- `dep-blame` — the CLI + engine. This is what `npx dep-blame` installs.
  Zero runtime dependencies.
- `@dep-blame/ui` — a separate, standalone package, run directly via
  `npx @dep-blame/ui` (§6). Depends on `dep-blame` for the engine, plus a
  small vanilla HTML/JS/SVG frontend — no React, no bundler. Never a
  dependency of the core package; installing the CLI never pulls this in.

Do **not** create a monorepo with 10 packages. Two packages is enough:
core and ui. Everything else is a folder inside core.

---

## 4. Core Engine Design

### 4.1 The Event Model (this is the product's IP)

Everything downstream — CLI tables, calendar, JSON, CI mode — consumes the same
flat event stream. Get this right first; everything else is a renderer.

```ts
type DependencyEvent = {
  package: string;
  type: "added" | "updated" | "removed";
  from?: string;        // omitted for "added"
  to?: string;           // omitted for "removed"
  date: string;          // ISO 8601, from commit author date
  commit: string;        // short SHA
  author: string;
  message: string;       // first line of commit message
  manifest: string;      // path, e.g. "package.json" or "apps/web/package.json"
  depType: "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies";
};
```

Store this as **the** normalized table. Every feature (`calendar`, `stats`,
`react` single-package view, `--json`) is a filter/group-by over this one array.
No feature should re-derive events from git independently.

### 4.2 Pipeline

```
0. git --version   (fail fast with a clear message if git isn't on PATH)
1. Locate repo root (walk up for .git)
2. git rev-parse --is-shallow-repository → warn if true (§5.1a)
3. Detect package manager + workspace layout (§4.5)
4. Load cache (§4.4). If cache exists and HEAD matches cached HEAD → skip to step 8.
5. git log --format=... -- <manifest paths>   (only commits touching manifests, no --follow — see §4.2a)
6. Batch-read every (commit, path) manifest blob needed via a single
   long-lived `git cat-file --batch` process (§5.1b) — NOT one `git show` per commit.
7. For each commit (oldest → newest):
     a. Parse its manifest blob(s) into a normalized snapshot: Map<name, {version, depType}>
     b. Diff snapshot(N-1) vs snapshot(N) → emit DependencyEvent[]
8. Write new events + updated HEAD pointer to cache
9. Return full event list to caller (CLI/UI/JSON)
```

Step 5 is the key performance decision: **never call `git log` without a path
filter**. Passing `-- package.json pnpm-lock.yaml ...` means git itself skips
commits that don't touch those paths — you're not diffing every commit, only
manifest-touching ones. This is what makes a 50k-commit repo with 2k dependency
commits fast: git does the filtering, Node only processes the 2k.

### 4.2a Why not `--follow`

`git log --follow` only tracks **one** path at a time — pass it multiple paths
(as any monorepo or multi-manifest run will) and git either errors or silently
drops it. Don't use it. Treat a manifest rename as a `removed` + `added` pair
instead of trying to track continuity across renames — `package.json` files
essentially never get renamed in practice, and the complexity isn't worth it.

### 4.3 Incremental scanning

On every run after the first:

```
cached HEAD = abc123
current HEAD = xyz789

git log abc123..xyz789 -- <manifest paths>   ← only NEW commits since last scan
```

Process only that delta, append events, update cached HEAD. This is why warm
runs are ~200ms regardless of total repo age — you're never re-walking history
you've already indexed.

Handle history rewrites (force-push, rebase) by checking if cached HEAD is
still an ancestor of current HEAD (`git merge-base --is-ancestor`); if not,
invalidate and do a full rescan, but warn the user this happened.

### 4.4 Cache Storage

**Primary path (Node ≥ 22.5): `node:sqlite`.**
Zero install, zero native compile, ships in the runtime. Schema:

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
-- meta: 'cached_head', 'schema_version', 'repo_root'

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package TEXT NOT NULL,
  type TEXT NOT NULL,
  from_version TEXT,
  to_version TEXT,
  date TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  author TEXT NOT NULL,
  message TEXT NOT NULL,
  manifest TEXT NOT NULL,
  dep_type TEXT NOT NULL
);

CREATE INDEX idx_events_package ON events(package);
CREATE INDEX idx_events_date ON events(date);
```

**Fallback path (Node 20–21):** a single JSON file at the same location
(`{events: [...], meta: {...}}`), read/written with `fs.readFileSync` +
`JSON.parse`/`stringify`. Slower for large repos but zero-dependency and
correct. Detect capability at runtime:

```js
let db;
try {
  const { DatabaseSync } = await import("node:sqlite");
  db = new DatabaseSync(cachePath);
} catch {
  db = new JsonFallbackStore(cachePath.replace(".db", ".json"));
}
```

Give both stores the same small interface (`getMeta`, `setMeta`, `insertEvents`,
`queryEvents(filter)`) so the rest of the codebase never branches on which one
is active.

**Cache location:** resolve via `git rev-parse --git-common-dir` (not a
hardcoded `.git/`) and store at `<git-common-dir>/dep-blame/cache.db` (or
`.json`). Using `--git-common-dir` rather than `--git-dir` matters for `git
worktree` setups — each worktree has its own `.git` *file* pointing at
`<main-repo>/.git/worktrees/<name>/`, so a naive `.git/dep-blame/` path
would create a separate, incomplete cache per worktree instead of sharing
one. `--git-common-dir` always resolves to the one true repo directory
regardless of which worktree you're in. Add a `--cache-dir` flag for
remaining edge cases (read-only `.git` in some CI containers).

### 4.5 Manifest & Package Manager Detection

Detect in this order, first match wins per directory:

| Lockfile present | Package manager |
|---|---|
| `bun.lock` / `bun.lockb` | bun |
| `pnpm-lock.yaml` | pnpm |
| `yarn.lock` | yarn |
| `package-lock.json` | npm |
| none, only `package.json` | npm (assumed) |

**Monorepo detection:** presence of `pnpm-workspace.yaml`, `turbo.json`,
`nx.json`, `lerna.json`, or a `workspaces` field in root `package.json`. When
detected, resolve the workspace glob patterns and track **every**
`package.json` under them as a separate `manifest` in the event model (already
modeled in §4.1 — this is why `manifest` is a field on every event, not a
global setting).

A bulk dependency bump across 30+ workspace packages in one commit produces
30+ events with the same commit SHA. Don't let the default `list` renderer
explode into a 500-line table for that — group consecutive same-commit events
into a single collapsed line (`"30 manifests updated in abc123 — chore: bump deps"`)
by default, and expand to the full per-package list only with `--verbose`.

**Parsing `package.json`:** trivial, `JSON.parse`. Diffs
`dependencies`/`devDependencies`/etc. and is the backbone of v0.1.

**`package-lock.json` also belongs in v0.1, not v0.2.** It's pure JSON —
parsing cost is effectively zero, no new dependency, and npm is still the
majority package manager. Skipping it for "later" buys nothing.

**The pnpm gap is real and needs a v0.1 mitigation.** A pnpm user running
`pnpm update react` gets an unchanged `package.json` (still `^18.0.0`) and an
updated `pnpm-lock.yaml`. Without full YAML lockfile parsing, `dep-blame`
would show *nothing* for that — which reads as "broken," not "honest," to a
first-time user on the fastest-growing package manager in the ecosystem.
Mitigate cheaply in v0.1: if a commit touches `pnpm-lock.yaml` or
`yarn.lock` but the corresponding `package.json` is unchanged, emit one
low-fidelity event instead of silence:

```json
{ "package": "(lockfile)", "type": "updated", "manifest": "pnpm-lock.yaml",
  "message": "resolved versions changed — run with full pnpm support (v0.2) for package-level detail" }
```

Imprecise, but "something happened here" beats silence. Full pnpm/yarn
resolution lands properly in v0.2.

**Parsing lockfiles in full (v0.2+):**
- `bun.lock` — JSON-ish (JSONC-like), trivial with a comment-stripping pass.
- `pnpm-lock.yaml` / `yarn.lock` — real YAML. This is the **one place** a
  dependency is justified. Use a minimal pure-JS YAML parser (`yaml` package,
  ~40kb, zero transitive deps) rather than hand-rolling a YAML parser — hand-
  rolling YAML is a correctness trap not worth the dependency savings. Mark
  this as the CLI's only optional dependency, lazy-loaded only when a pnpm or
  yarn lockfile is actually detected (`await import("yaml")`), so npm/bun-only
  users never pay for it.

  Handle the case where it's declared but missing (e.g. installed with
  `npm install --omit=optional`, common in CI): catch the `import()` rejection
  and print a clear fix instead of a raw `MODULE_NOT_FOUND` stack trace —
  ```
  ⚠ pnpm-lock.yaml detected but the `yaml` parser isn't installed.
    Run: npm install yaml   (or reinstall without --omit=optional)
  ```

---

## 5. CLI Design

### 5.1 The `git` invocation

Shell out via `node:child_process` `execFile` (never `exec` — avoid shell
injection and quoting bugs), streaming stdout where possible for large repos:

```js
const { execFile } = require("node:child_process");

function gitLog(repoRoot, sincePath, paths) {
  const args = [
    "log",
    "--follow",
    "--format=%H%x1f%ai%x1f%an%x1f%s%x1e",  // unit/record separators, not JSON
    sincePath ? `${sincePath}..HEAD` : "HEAD",
    "--",
    ...paths,
  ];
  // execFile, parse stdout by \x1e records, split fields by \x1f
}
```

Use `%x1f` (unit separator) / `%x1e` (record separator) instead of a
delimiter like `|` or `,` — commit messages can contain anything, control
characters can't appear in normal text, so this parses safely with a plain
`.split()`, no regex, no edge cases.

### 5.1a Fail fast on missing git / shallow clones

Both checks happen once, at pipeline start, before anything else:

```js
try {
  await execFile("git", ["--version"]);
} catch {
  console.error("dep-blame requires git on PATH. Install git and try again.");
  process.exit(1);
}

const { stdout } = await execFile("git", ["rev-parse", "--is-shallow-repository"]);
if (stdout.trim() === "true") {
  console.warn("⚠ Shallow clone detected — history may be incomplete.");
  console.warn("  In GitHub Actions: actions/checkout with fetch-depth: 0");
}
```

Shallow clones (GitHub Actions' `fetch-depth: 1` default) are the single most
likely cause of "it just shows nothing" bug reports in CI. Five lines here
prevents most of them.

### 5.1b Reading manifest content at scale — `git cat-file --batch`, not `git show` per commit

**Do not** call `git show <sha>:<path>` once per (commit, path) pair. A repo
with 2,000 manifest-touching commits across 3 workspace packages is 6,000
subprocess spawns — at ~5–15ms of process-spawn overhead each, that alone
blows past the 3-second cold-scan target before any parsing happens.

Instead, open **one** long-lived `git cat-file --batch` process for the whole
scan, write every `<sha>:<path>` request to its stdin (newline-delimited),
and read the corresponding blob content back from stdout in order. This is
git's own batch object-reading interface, built exactly for this:

```js
const { spawn } = require("node:child_process");

const batch = spawn("git", ["cat-file", "--batch"], { cwd: repoRoot, windowsHide: true });

// write requests
for (const { sha, path } of requests) {
  batch.stdin.write(`${sha}:${path}\n`);
}
batch.stdin.end();

// read responses — each is a header line "<sha> blob <size>\n" followed
// by exactly <size> bytes of content, then a trailing newline. Parse
// sequentially off the stdout stream in request order.
```

One process, thousands of lookups. This turns a 30–90 second cold scan into
low single-digit seconds and is the single most important performance fix in
this document.

### 5.2 Commands

```
dep-blame                      Summary view (default, no subcommand)
dep-blame list                 Flat chronological event list
dep-blame pkg <package>        Full history of one package ("archaeology" view)
dep-blame calendar             Month-grid visualization in the terminal
dep-blame stats                Aggregate counts, most-changed packages, churn rate
dep-blame added                Filter: only "added" events
dep-blame removed              Filter: only "removed" events
dep-blame updated              Filter: only "updated" events
dep-blame changes --since 30d  Time-windowed filter (accepts 7d, 2w, 6m, 1y, or ISO date)
dep-blame ui                   Print the command to launch the UI (npx @dep-blame/ui) — see §6
dep-blame ci                   CI-formatted output, supports --fail-on-removal, --since <ref>
dep-blame --json               Any command + this flag emits raw JSON instead of a rendered view
dep-blame --no-cache           Force full rescan, ignore cache
dep-blame --cache-dir <path>   Override cache location
```

**Why `pkg <name>` instead of a bare `dep-blame <name>`:** a bare positional
collides with every subcommand name — `dep-blame list` is ambiguous between
"run the list subcommand" and "show archaeology for a package literally named
list" (same problem for `stats`, `calendar`, `ci`, `added`...). Namespacing
the archaeology view under `pkg` removes the ambiguity entirely rather than
special-casing it.

Parse args with the built-in `node:util` `parseArgs` — no `commander`, no
`yargs`. It covers everything this CLI needs: positionals, boolean flags,
string flags with values.

```js
const { values, positionals } = parseArgs({
  options: {
    json: { type: "boolean" },
    since: { type: "string" },
    "no-cache": { type: "boolean" },
    "cache-dir": { type: "string" },
    "fail-on-removal": { type: "boolean" },
  },
  allowPositionals: true,
});
```

### 5.3 Terminal rendering — zero dependency

No `chalk`, no `picocolors`, no `cli-table3`. Hand-roll a ~40-line ANSI helper:

```js
const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
// respect NO_COLOR env var and !process.stdout.isTTY — disable all codes then
```

Table alignment: compute column widths with `String.prototype.padEnd`/`padStart`
over the event array — this is a handful of lines, not a library.

The calendar view (month grid with markers) is the most "designed" piece of
output — build it as a fixed 7-column grid string, one pass over the days-in-
month, placing a marker character under any day that has ≥1 event, with a
legend line below mapping markers to packages when there are multiple events
in a month.

### 5.4 JSON output contract

Every command supports `--json`. The shape is always:

```json
{
  "repository": "my-app",
  "packageManager": "pnpm",
  "generatedAt": "2026-09-27T10:00:00.000Z",
  "command": "list",
  "events": [ /* DependencyEvent[] as in §4.1 */ ]
}
```

Stable, documented, versioned via a top-level `"schemaVersion": 1` field so
downstream tools (`jq`, CI dashboards, other npm packages) can depend on it
without breaking on your future changes.

### 5.5 CI mode

`dep-blame ci` diffs against a ref (default: detect the default branch via
`git symbolic-ref refs/remotes/origin/HEAD`, or accept `--since <ref>`),
prints a compact summary (`+ added`, `↑ updated`, `- removed` lines), and
exits non-zero only when `--fail-on-removal` is passed and a removal occurred
— never fails by default, since "a dependency changed" isn't inherently bad.

---

## 6. Web UI — `@dep-blame/ui`, under the `dep-blame` npm org

### 6.1 Package split and the npm org

Create a free npm organization named **`dep-blame`** (npmjs.com → Add
Organization → public/free tier is sufficient for public scoped packages).
This reserves the `@dep-blame/` scope for everything except the flagship
CLI, which stays unscoped:

- **`dep-blame`** (unscoped) — the CLI + engine from §4–§5. Keeps the nice
  `npx dep-blame` install/run experience; unscoped names are what make
  that one-liner memorable. Zero runtime dependencies, as established.
- **`@dep-blame/ui`** — the web UI, published under the org. A real,
  independently installable/runnable package — **not** a lazily-installed
  side effect triggered by a flag on the CLI. No child-process `npm install`
  prompts, no "detect and offer to install" logic inside core. Two clean,
  separate entrypoints instead:

  ```bash
  npx dep-blame          # CLI — always available, always zero-dependency
  npx @dep-blame/ui      # UI — separate package, run directly
  ```

  `@dep-blame/ui` depends on `dep-blame` as a normal dependency (it
  imports the engine — git walking, caching, the event model from §4.1 —
  rather than re-implementing any of it) plus whatever small footprint the
  UI itself needs (§6.3). This dependency only exists inside the UI package;
  it never flows back into the core CLI's install.

  Room to grow the org later without disrupting this: `@dep-blame/vscode`,
  `@dep-blame/github-action`, etc. can all sit under the same scope
  without touching the core package's zero-dependency guarantee.

### 6.2 Why not lazy-install-on-demand

The earlier draft had `dep-blame ui` detect whether `@dep-blame/ui` was
resolvable and prompt to install it on the fly. Dropping that: it adds a
child-process `npm install` call inside the CLI (a new failure mode — network
issues, permission issues, monorepo hoisting weirdness), and it blurs the
"core CLI has zero dependencies" promise by making the CLI conditionally
dependency-aware at runtime. Two independent, clearly-named packages under
one org is simpler to reason about, simpler to document, and simpler to
`npm install -g` in CI images that only want one or the other.

### 6.3 Keep it genuinely lightweight — no React, no bundler, no Vite

The instinct to reach for React + Vite here is the wrong default for what
this UI actually needs to render: a table, a calendar grid, and a couple of
simple charts, all driven by one JSON payload (§5.4) that's already sitting
in memory. That's well within what vanilla JS handles cleanly, and skipping
a framework is what keeps the "won't take up much space" promise honest
rather than aspirational:

- **One self-contained HTML page.** No build step, no bundler — the whole
  UI is a single `.html` file with inline `<style>` and `<script>`, served
  as-is. Nothing to compile at publish time, nothing to hydrate at runtime.
- **No charting library.** Hand-rolled inline SVG for the calendar grid and
  any bar/timeline charts — same philosophy as the CLI's hand-rolled ANSI
  tables (§5.3), just rendered as SVG instead of text. A dependency-change
  timeline is bars and dots; it does not need Chart.js or Recharts.
- **Size budget:** total page weight (HTML + CSS + JS, gzipped) stays under
  100KB, and the goal is closer to 20–30KB in practice. Enforce this as an
  actual CI check (`gzip -c dist/index.html | wc -c`, fail the build past
  the budget) rather than a one-time intention — budgets that aren't
  enforced drift.
- **No external requests at runtime.** No CDN-hosted fonts, no analytics,
  no telemetry. System font stack only (`-apple-system, "Segoe UI",
  sans-serif`), so the page renders identically whether or not the machine
  has internet access — appropriate for a tool that already promises to
  work fully offline.

### 6.4 Server

`npx @dep-blame/ui` spawns a plain `node:http` server (no Express, no
Fastify — unjustifiable weight for one static page plus one JSON endpoint):

```
GET  /              → the single HTML page (embedded in the package, served as a string/buffer)
GET  /api/events     → calls the `dep-blame` engine, returns the §5.4 JSON contract
```

Binds to `127.0.0.1` only by default — never `0.0.0.0` — unless an explicit
`--host` flag is passed. No telemetry, no outbound requests, matching the
core CLI's offline-by-default posture.

### 6.5 Visual design direction

Dark-themed, minimalist, information-dense without feeling cluttered —
closer to a well-made terminal dashboard than a typical "AI-generated"
admin panel template (no gradient hero banners, no stock-icon sidebar, no
card-with-shadow-on-everything). Concretely:

- Monospace or near-monospace type for data (package names, versions,
  SHAs); a plain system sans for headings/labels — echoes the CLI's own
  fixed-width tables so the two surfaces feel like the same product.
- One accent color used sparingly for `added`/`updated`/`removed` state
  (green/amber/red, same mapping as the CLI's ANSI colors in §5.3) — no
  decorative color elsewhere.
- The calendar and single-package archaeology views (§5.2) are the two
  screens worth designing carefully; everything else can be a plain table.
  Build those two first, let the rest follow the same visual language.

---

## 7. Repository Layout

```
dep-blame/
├── packages/
│   ├── core/                     ← published as `dep-blame`
│   │   ├── bin/
│   │   │   └── cli.js
│   │   ├── src/
│   │   │   ├── git/
│   │   │   │   ├── log.js        (execFile wrapper, record parsing)
│   │   │   │   └── show.js       (read file at commit)
│   │   │   ├── manifest/
│   │   │   │   ├── detect.js     (package manager + workspace detection)
│   │   │   │   ├── package-json.js
│   │   │   │   └── lockfiles/
│   │   │   │       ├── npm.js
│   │   │   │       ├── bun.js
│   │   │   │       ├── pnpm.js   (lazy `yaml` import)
│   │   │   │       └── yarn.js   (lazy `yaml` import)
│   │   │   ├── diff/
│   │   │   │   └── snapshot-diff.js   (§4.1 event model lives here)
│   │   │   ├── cache/
│   │   │   │   ├── sqlite-store.js
│   │   │   │   ├── json-store.js
│   │   │   │   └── index.js      (capability detection, unified interface)
│   │   │   ├── render/
│   │   │   │   ├── ansi.js
│   │   │   │   ├── table.js
│   │   │   │   ├── calendar.js
│   │   │   │   └── json.js
│   │   │   ├── commands/
│   │   │   │   ├── list.js
│   │   │   │   ├── package-view.js
│   │   │   │   ├── calendar.js
│   │   │   │   ├── stats.js
│   │   │   │   ├── ci.js
│   │   │   │   └── ui.js
│   │   │   └── engine.js         (orchestrates §4.2 pipeline)
│   │   ├── package.json
│   │   └── README.md
│   │
│   └── ui/                       ← published as `@dep-blame/ui` (org: dep-blame)
│       ├── bin/
│       │   └── cli.js            (spawns the node:http server, §6.4)
│       ├── src/
│       │   ├── index.html        (single self-contained page — no bundler, §6.3)
│       │   └── server.js         (node:http, serves the page + /api/events)
│       └── package.json          (depends on `dep-blame` for the engine)
│
├── fixtures/                     ← tiny throwaway git repos for tests (§8)
│   ├── added/
│   ├── removed/
│   ├── updated/
│   ├── monorepo/
│   ├── pnpm/
│   ├── yarn/
│   ├── bun/
│   └── history-rewrite/
│
├── test/
│   ├── engine.test.js
│   ├── cache.test.js
│   ├── manifest.test.js
│   └── cli.test.js
│
├── package.json                  (workspaces: ["packages/*"])
└── README.md
```

Two publishable packages. Everything else is internal. Use Node's built-in
test runner (`node --test`) — no Jest, no Vitest for the core package. Keep
the zero-dependency promise all the way down to the toolchain where it costs
nothing to do so.

---

## 8. Testing Strategy

Build tiny real git repos as fixtures — not mocked git output. Mocking `git
log` output is exactly the kind of thing that silently drifts from real git
behavior and hides bugs. Each fixture is a script that runs actual `git init`
+ a sequence of commits:

```js
// fixtures/updated/setup.js
await run("git init");
await write("package.json", pkg({ react: "18.2.0" }));
await run("git add -A && git commit -m 'add react 18'");
await write("package.json", pkg({ react: "19.0.0" }));
await run("git add -A && git commit -m 'bump react'");
```

Then assert the engine produces exactly the expected `DependencyEvent[]`
against that real repo. Required fixture coverage before v0.1 ships:

- Simple add / update / remove (one manifest, no lockfile)
- A dependency that's added then removed in the same history (net: nothing,
  but both events must still appear — history isn't collapsed)
- Monorepo with 2+ workspace packages changing independently
- A rebase/force-push scenario (cache invalidation, §4.3)
- Empty repo (no manifest ever existed) → clean empty output, no crash
- A manifest that's invalid JSON at some point in history (corrupted commit)
  → skip that commit's diff with a warning, don't crash the whole scan
- A shallow clone (`git clone --depth 1`) → warning printed, no crash, no
  false "zero history" conclusion presented as fact
- A commit that bulk-updates 10+ workspace manifests at once → collapsed
  rendering by default, full list under `--verbose`
- `yaml` optional dependency absent while a `pnpm-lock.yaml` is present →
  clear install-fix message, not a raw `MODULE_NOT_FOUND` stack

Also verify the CLI degrades gracefully (clear error, exit code 1, no stack
trace) when `git` itself isn't on `PATH` at all — simulate by running tests
with a stripped `PATH` in a subprocess.

---

## 9. Phased Build Order

Ship early, evolve. Each phase is a real, usable release.

**v0.1 — Core loop**
`package.json` + `package-lock.json` diffing (both are plain JSON — no reason
to defer npm lockfile support), low-fidelity pnpm/yarn lockfile-changed
signal (§4.5), flat `list` command, `--json`, cat-file-batched reads (§5.1b),
shallow-clone + missing-git checks (§5.1a), SQLite/JSON cache, incremental
scanning. This alone is a complete, useful, publishable tool.

**v0.2 — Package manager breadth**
Full pnpm/yarn/bun lockfile parsing, monorepo/workspace detection, per-manifest
tracking, collapsed multi-manifest commit rendering.

**v0.3 — Views**
Single-package "archaeology" view (`dep-blame pkg react`) first — it's the
feature people will actually reach for daily and the one worth showing off.
`calendar` and `stats` follow once the archaeology view is solid; a calendar
grid is a nice demo but sees far less day-to-day use in a terminal.

**v0.4 — CI mode**
`dep-blame ci`, `--fail-on-removal`, `--since <ref>`, GitHub Actions example
in README.

**v0.5 — Web UI**
Create the `dep-blame` npm org, publish `@dep-blame/ui` (§6): vanilla
HTML/JS/SVG page, `node:http` server, calendar + archaeology views built
first, enforced gzip size budget (§6.3) as a CI check from the start.

**v1.0**
Cross-platform verified. Windows needs real attention here, not just a v1.0
label — from day one: build all cache/manifest paths with `node:path` (never
a hardcoded `/`), pass `windowsHide: true` to every `execFile`/`spawn` call
(§5.1a, §5.1b) to stop console windows flashing, and don't assume `git` on
PATH resolves the same way as `git.exe`. Full fixture coverage, docs site or
thorough README, stable JSON schema (`schemaVersion: 1` frozen).

Do not start v0.2 until v0.1 is genuinely shippable. A correct tool that only
understands `package.json` is more valuable than a half-finished tool that
"eventually" understands four lockfile formats.

---

## 10. Package Metadata (for `packages/core/package.json`, the `dep-blame` package)

```json
{
  "name": "dep-blame",
  "version": "0.1.0",
  "description": "See exactly how your project's dependencies changed over time.",
  "bin": { "dep-blame": "./bin/cli.js" },
  "engines": { "node": ">=20" },
  "type": "module",
  "dependencies": {},
  "optionalDependencies": {
    "yaml": "^2.x"
  },
  "files": ["bin", "src", "README.md"]
}
```

Zero required runtime dependencies. `yaml` is optional and lazy-loaded only
when a pnpm/yarn lockfile is actually detected (§4.5) — npm-only and bun-only
users never download it, and its absence (e.g. `--omit=optional` installs)
fails with a clear message rather than a stack trace.

One easy-to-miss ESM gotcha with `"type": "module"`: Node's ESM resolver
requires **explicit file extensions** on all relative imports —
`import { gitLog } from "./git/log.js"`, never `"./git/log"`. This is a
common "works in dev, breaks the moment it's published and re-installed"
bug; enforce it with an ESLint rule (`import/extensions`) rather than relying
on remembering it.

### 10.1 UI package metadata (for `packages/ui/package.json`)

```json
{
  "name": "@dep-blame/ui",
  "version": "0.1.0",
  "description": "Lightweight local web UI for dep-blame — no build step, no framework.",
  "bin": { "dep-blame-ui": "./bin/cli.js" },
  "engines": { "node": ">=20" },
  "type": "module",
  "dependencies": {
    "dep-blame": "^0.5.0"
  },
  "files": ["bin", "src", "README.md"],
  "publishConfig": { "access": "public" }
}
```

`"publishConfig": { "access": "public" }` is required the first time you
publish a scoped package — npm defaults new scoped packages to private
(which requires a paid plan) unless told otherwise. `dep-blame` is a real
dependency here (not optional) since the UI has no reason to function
without the engine it renders.

---

## 11. Summary of Core Decisions

- **Node only**, no Go/Rust engine, no platform binaries.
- **Shell out to system `git`** with path-filtered `log` — this is where the
  real performance comes from, not from reimplementing git in JS.
- **`node:sqlite`** (Node ≥22.5) with a JSON-file fallback for older Node —
  zero-install embedded storage either way.
- **`node:util.parseArgs`** instead of a CLI framework.
- **Hand-rolled ANSI rendering** instead of a color/table library.
- **One event model** (`DependencyEvent`) feeds every view — CLI table,
  calendar, stats, JSON, CI mode, UI. Never derive events twice.
- **Incremental, cached scanning** — full walk only on first run or history
  rewrite; every subsequent run processes only new commits.
- **`package.json` + `package-lock.json` in v0.1** (both plain JSON, zero
  extra cost); full pnpm/yarn/bun lockfile parsing in v0.2, with a
  low-fidelity "lockfile changed" signal in v0.1 so pnpm/yarn users don't see
  silent nothing in the meantime.
- **Batch manifest reads with a single `git cat-file --batch` process**, never
  one `git show` per commit — this is the difference between a 3-second and a
  90-second cold scan on a real-sized repo.
- **No `--follow`** on multi-path `git log` — it silently breaks past one path.
- **`dep-blame pkg <name>`**, not a bare positional, for the archaeology
  view — avoids colliding with subcommand names.
- **Fail fast and clearly** on missing `git`, shallow clones, and a missing
  optional `yaml` dependency — each is a likely real-world failure mode, and
  each gets a specific, actionable message instead of a stack trace.
- **UI ships under the `dep-blame` npm org as `@dep-blame/ui`** — a real,
  standalone, directly-runnable package (`npx @dep-blame/ui`), not a
  lazily-installed side effect of a CLI flag. Vanilla HTML/JS/SVG, no React,
  no bundler, enforced sub-100KB gzip budget — it never affects the core
  install's size or dependency count either way.
## 12. Implementation audit and next delivery plan — 2026-10-01

This section describes the current reviewed implementation and supersedes
conflicting assumptions in the original proposal above. Earlier performance
numbers, prior-art claims and package-name availability are design assumptions,
not verified release facts. The project remains a local dependency-history tool.

### 12.1 Concept and product assessment

**dep-blame answers:** what dependency changed, when, by whom, in which commit
and manifest, and whether the change affected a declared requirement or a
lockfile resolution. The CLI, calendar, table and package archaeology drawer
are different ways to inspect the same Git evidence.

The idea is useful for investigating regressions, understanding an unfamiliar
repository, reconstructing package lifecycles, reviewing dependency changes and
explaining a dependency's current state. Its value depends on trustworthy
history reconstruction and a fast, clear interface. It is a focused package
concept; popularity and demand have not been established by this code audit.

Keep the scope centered on Git history. Revision comparisons, source evidence,
package lifecycles, author attribution, filters and reproducible exports fit.
Registry recommendations, automatic upgrades, vulnerability monitoring and
project-management features would need a separate product decision.

### 12.2 Audit scope and evidence

Reviewed the core Git readers, engine and cache paths, package/workspace and
lockfile parsers, CLI renderers, local server, browser application, styles,
package metadata, tests and CI/publish packaging. Used real disposable Git
repositories to exercise corruption, branching, merge, incremental and transport
cases. Used the browser for desktop/mobile visual and interaction verification.

Verification is evidence for the cases exercised, not a guarantee that every
possible repository, hosting version or malformed input is supported. No changes
were committed, pushed or published by this review.

### 12.3 Findings fixed in this working tree

| Area | Finding and consequence | Implemented correction |
| --- | --- | --- |
| Dark theme | Tinted backgrounds, decorative grid and glow made the table visually noisy | Neutral black background, restrained gray surfaces/borders, consistent text and status colors |
| Popover positioning | A fixed popup inside a filtered/blurred ancestor was positioned or clipped incorrectly | One body-level popup, measured anchoring, viewport clamping, flip above trigger and footer clearance |
| Calendar pagination | `.pager { display: flex }` overrode the browser's styling of `hidden` | Enforced `[hidden] { display: none !important }`; calendar uses month navigation only |
| Controls | Native selects/date inputs differed by OS and theme | Custom page-size, facet and date-range panels; strict text dates, presets and keyboard calendar |
| Filter state | Multiple entry points could disagree or close after a redraw | Shared filter state, draft/apply/cancel, visible chips, reset behavior and delegated events |
| Table rendering | Every filter/page operation could repeat sorting and render excessive choices | Cached sorted results/facets, Set membership, 25/50/100 row pages, 150 ms search debounce, 200-option facet DOM cap |
| Calendar mobile layout | Long package pills and minimum cell widths overflowed narrow screens | Seven shrinkable columns, compact counts on small screens, native day buttons and clear drill-down |
| Accessibility | Dialog focus, calendar controls and filter dismissal were inconsistent | Focus trapping/return, Escape, date-grid navigation, active-view state, live pager text and visible focus |
| Labels | Dependency events were described as commits/upgrades or mixed source/type concepts | Event counts, explicit declared/resolved Source column, dependency-section moves shown separately |
| HEAD status | Unreadable HEAD or no current declaration could be mislabeled as a removal | `headStateComplete`; distinct active, not declared and unknown states |
| Dates | UTC strings and local controls could disagree | One viewer-local calendar-day convention throughout the UI |
| Export | The visible page could obscure the scope of exported history | Export all matching events with warnings/truncation and HEAD completeness; safe Markdown and CSV text |
| Git records | Delimiters in subjects and Unicode/chunk boundaries could corrupt records | NUL-delimited incremental log parsing and UTF-8 streaming decoders |
| Git blob transport | Repeated buffer concatenation and incomplete responses were costly or ambiguous | Linear body assembly, strict sizes/response counts, backpressure, timeouts and explicit transport errors |
| Blob memory | Count-only batches could retain large blobs simultaneously | Byte-aware groups, same-OID reuse and release of processed blobs; 16 MiB target batches / 64 MiB safety limits |
| Scan consistency | HEAD could change between discovery, log reading and checkpoint | Pin the starting full SHA throughout the scan and cache checkpoint |
| Incremental workspaces | Newly added/deleted workspace manifests could be missed | Discover changed workspace paths across the cached-to-current range |
| Corrupt baseline | Recovery could invent additions or drop last-good history | Recover readable first-parent snapshots or rebuild when the incremental baseline is unusable |
| Parse validity | Empty or malformed dependency sections were accepted as empty snapshots | Tri-state parsing and structural guards; undecodable data preserves last-good state and warns |
| Bun/Yarn | JSONC cleanup could alter strings; descriptors and malformed lockfiles were misread | String-aware Bun cleanup/descriptor parsing; stricter Yarn decoding and failure semantics |
| Source history | Declaration changes could suppress same-commit resolved changes | Keep both evidence streams independently |
| Cache warnings | A warm read could hide previously detected incomplete/corrupt history | Persist and restore warnings/truncation metadata |
| Cache locks | An old but live process lock could be stolen | Live PID ownership checks, dead-process reclamation and owner-token release |
| JSON transactions | Events/HEAD or in-memory state could diverge after an interrupted/disk-failed write | Transaction rollback and atomic rename; propagate write failure |
| Invalid cache | Partially valid rows could retain a misleading checkpoint | Invalidate malformed cache generations and bump schema to version 3 |
| Workspace paths | Globs/symlinks could walk outside the repository or repeatedly visit directories | Realpath boundary and visited-directory checks |
| Output safety | Terminal control sequences and spreadsheet formulas could escape intended display | Terminal sanitization; RFC CSV quoting plus formula neutralization |
| Local server | Host/Origin validation needed exact authority and port checks | Loopback default, strict Host/Origin/Sec-Fetch-Site validation, explicit LAN opt-in |
| Scan concurrency | Concurrent loads could race or fail to receive progress | Shared in-flight scan, per-client progress listeners and disconnect cleanup |
| Hosting attribution | Git names were treated as usernames; links assumed GitHub; no remote defaulted to GitHub | Host-specific adapters/links, verified account mapping, local-no-remote state and actual host footer |
| Profile pictures | Raw external images would weaken CSP and repeat network work | Lazy bounded account lookup, local raster image proxy, caching, initials fallback, no email/token exposure |
| Outbound security | Self-host support could otherwise become a private-network proxy | DNS validation/pinning, restricted private-origin opt-in, redirect checks, HTTPS-only token transport and response limits |
| Publication | Stale compiler output could ship removed modules; test globs differed across Node/shell versions | Clean build output, explicit test-file enumeration and isolated install/runtime smoke tests for both tarballs |

### 12.4 Remaining issues and release decisions

These are unresolved limitations. Priority reflects correctness and scale, not
whether an exploit has been demonstrated.

| Priority | Issue | Current effect | Required follow-up |
| --- | --- | --- | --- |
| P1 | Full history remains resident in the engine/API/browser | Pagination bounds DOM, not total RAM; JSON serialization/gzip/SSE completion can block or duplicate memory | Indexed queries, bounded page responses, month aggregates/facets and streaming CLI export |
| P1 | npm lockfile workspace/nested resolution coverage is incomplete | Importer attribution and multiple installed versions can be collapsed or missed | Model importer/package/resolution identities and test real npm workspace/nested fixtures |
| P1 | Maps keyed only by dependency name cannot represent all simultaneous sections/resolutions | A package in multiple dependency sections or multiple Yarn/Bun resolutions may lose information | Composite identity and explicit ambiguity/unknown fields; schema migration |
| P1 | Cache promotion involves backend files rather than an atomic generation pointer | Interruption/backend switching can leave stale JSON/SQLite/WAL generations | Generation directories and atomically switched manifest; close/checkpoint SQLite and recovery tests |
| P2 | Historic discovery has path/buffer limits and workspace YAML detection is heuristic | Large or unusual repositories can be incomplete; warnings must remain prominent | Stream discovery, explicit configurable limits and structural workspace-YAML parsing |
| P2 | Newline/CR characters in Git paths are explicitly unsupported by line-based cat-file requests | Valid but unusual paths fail rather than produce complete history | Capability-gated NUL request protocol or clear unsupported-path warning |
| P2 | Workspace/package-manager labels come partly from working-tree discovery | Labels can differ from the pinned indexed commit | Derive display metadata from that commit; expose `indexedCommit` in every output |
| P2 | Font reads, synchronous compression and slow SSE clients | Large responses or slow clients can affect responsiveness | Cache immutable bytes/compression, asynchronous response compression and bounded/throttled SSE writes |
| P2 | Drawer and month filtering still traverse/render large histories | A heavily changed package can create a large drawer | Paginated lifecycle nodes and server month/day queries |
| P2 | Hosting APIs differ by deployment/version/authentication | Some hosts need configuration; unknown accounts, protected images or unapproved CDNs retain initials | Tested adapter compatibility fixtures, clear nonblocking enrichment status and measured retry policy |
| P2 | Image limits bound compressed bytes, not every decoded image dimension | A pathological raster can still be expensive for a browser decoder | Validate dimensions or request/serve bounded thumbnails with a hardened image pipeline |
| P2 | Automated tests do not yet cover browser interaction in CI | Manual checks can regress during UI changes | A small browser regression suite for critical flows and accessibility |
| P2 | Original 10,000-commit / sub-200-ms targets are unproven | The proposal can overpromise published performance | Reproducible benchmarks across commit/event/manifest sizes and both cache backends |
| P3 | Large client file and obsolete CSS selectors/overrides | Changes are harder to reason about consistently | Extract query state, popover, calendar, table and drawer modules; remove dead CSS without adding a framework |

For publication: do not advertise complete importer/multi-resolution support,
unbounded-repository scalability or crash-safe cache generation switching until
the P1 gates pass. A limited initial release needs explicit supported-input and
resource-limit documentation. Dependency-audit success is not a security
certification of custom application code.

### 12.5 Hosting/profile behavior

Git contains names/emails, not profile photographs. The server asks the detected
host for the account associated with a commit. GitHub/Gitea-compatible REST,
GitLab GraphQL and Bitbucket adapters return a host account where available.
Git-only identities stay as initials. Matching uses server-side name/email
identities rather than names alone; repeated commits share lookups. No name is
invented as a login, and the repository owner is not assigned to all authors.

The footer shows `GitHub · github.com`, the corresponding self-hosted service
and hostname/port, `Git host · <host>` if detection is inconclusive, or `Local Git`
when no remote exists. Links use each service's commit/tree conventions.
Nested GitLab namespaces and configured installation subpaths are retained.
Unknown services copy the full commit SHA instead of guessing a commit URL.

History renders before account enrichment. Account concurrency is three;
positive/negative caches and client work are bounded. Server identity cache:
512 entries. Image cache: 128 entries / 16 MiB; individual image: 512 KiB.
At most six author-query handlers run concurrently. HTTP requests have
five-second deadlines and DNS has a four-second deadline.
A self-host detection attempt can involve several requests, so its total time
can exceed one request deadline; this does not block history rendering.

`DEP_BLAME_AVATARS=0` restores fully offline behavior. Private forge origins,
SSH/web URL differences, subpath deployments and private API access can be
configured using the settings documented in `README.md` (§Web dashboard,
§Configuration). Tokens
stay server-side and require HTTPS. Do not disable TLS verification for a local
CA; configure Node's trusted CA instead.

Live check for this repository: GitHub returned `author: null` for the initial
commit. Its rows retain initials because GitHub did not return a linked
account from which to obtain a profile picture. Other adapters were
validated with controlled fixtures, not with live installations of every host.

Primary adapter references:

- [GitHub commits API](https://docs.github.com/en/rest/commits/commits?apiversion=2022-11-28)
- [GitLab commit GraphQL type](https://gitlab.com/gitlab-org/gitlab/-/raw/master/app/graphql/types/repositories/commit_type.rb)
- [Gitea single-commit API](https://docs.gitea.com/api/operations/repo-get-single-commit/)
- [Bitbucket Cloud commits API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-commits/)
- [Bitbucket Server repository API](https://developer.atlassian.com/server/bitbucket/rest/v900/api-group-repository/)

### 12.6 UI design specification

**Hierarchy:** compact header with Export/Sync/theme controls; four event-count
cards; one toolbar with search/action/manifest/filter/view controls; applied
filter chips and honest warning notices; table or calendar; compact repository,
branch, package-manager, hosting and indexing footer.

**Color/system:** dark background #000; secondary #0a0a0a; surface #101010;
hover #1a1a1a; borders #262626; main text #f5f5f5; secondary #a3a3a3;
muted #858585. Green/amber/red indicate added/updated/removed, with accompanying
text. Use the same spacing, borders, radii, typography and focus styles for all
controls. Light theme must preserve the same hierarchy and behavior.

**Datatable:** semantic table; Date, Action, Dependency, Version diff, Source,
Manifest, Author, Commit. Fixed readable column widths, sticky header, internally
scrolling rows and a stable pager. Long values truncate with full-value titles.
Author pictures are 26 px circles, lazy decoded, with initials until loaded.
Only host-linked accounts become profile links. Page changes do not re-sort
unchanged results; filtering resets to page one. Page-size menu is custom.
Horizontal scrolling belongs inside the table on narrow screens.

**Filters:** one anchored component for toolbar and column triggers. The popup
stays within viewport/footer edges, with a limited internal list scroll area.
Facets use search plus checkable choices. Date range uses strict YYYY-MM-DD
text inputs, presets, a custom calendar and Apply/Clear. Draft changes do not
alter results until Apply. Escape cancels and returns focus; Tab stays within
the open dialog. Applied chips are the visible record of active state.

**Calendar:** month controls plus seven equal columns. No table pager. Desktop
shows a bounded preview and counts; mobile prioritizes counts. Day headers are
real buttons and empty days are disabled. Selecting a day opens the matching
table range. Latest navigates to the latest recorded month, not today's date.

**Drawer:** focus-contained package lifecycle dialog with HEAD status, source,
manifest, full commit evidence and meaningful account attribution. Escape and
close return focus. Not declared and unknown are distinct from a recorded
removal. Future large lifecycle lists need pagination.

**Responsive behavior:** 375 px must have no body horizontal overflow. KPI
cards become 2×2; toolbar wraps; calendar cells shrink; footer truncates long
repository/host strings with titles. Test 375/768/1280/1440 px and zoom. Small
screens may scroll the table internally. Never squeeze headings into ellipses
or hide the meaning of an active filter.

**Required states:** loading with real scan stages; empty repository; no matching
results; corrupt/incomplete history; scan failure with retry; syncing; avatar
loading/unmatched/offline; disabled month/day/pager controls. Network profile
failure must not turn a successful history scan into an error.

### 12.7 Implementation sequence and acceptance gates

#### Phase A — ship the current corrections after verification

1. Review this diff and the additive API fields (`hosting`, `headStateComplete`).
2. Run the complete engine/security/parser suite and both isolated tarball smoke
   installs on the Node × OS matrix; include the JSON/omit-optional fallback job.
3. Capture desktop black/light, narrow layout, anchored filters and calendar
   without pager. Check keyboard navigation, drawer focus and full export scope.
4. Document account fallback, supported parser coverage, safety limits and
   optional networking. Retain strict CSP and zero inline event handlers.

Gate: all required tests pass, tarballs contain only current modules/assets and
licenses, no credentials/private email in frontend responses, and no known
critical history regression in supported fixtures.

#### Phase B — finish history fidelity and cache durability (P1)

1. Introduce an explicit event/resolution identity: source, manifest/importer,
   dependency section, package and lock resolution locator. Preserve multiple
   sections/versions; represent unknown values rather than substituting ranges
   as resolved versions.
2. Add npm importer/nested-version fixtures, Yarn/Bun multi-resolution fixtures,
   aliases/catalog/protocol entries and dependency-section coexistence cases.
3. Migrate the cache schema deliberately; full rescan must reconstruct the same
   events as incremental scans for branch/merge/corruption fixtures.
4. Store each full scan under a new generation directory. Close/checkpoint the
   database, then atomically replace a small active-generation manifest. Readers
   pin one generation; interrupted promotions must leave the previous generation
   readable. Reclaim unreferenced generations only after reader ownership ends.

Gate: cold/warm/backend-switch outputs agree; process-kill tests before/after
promotion never combine events and HEAD from different generations; unsupported
resolution cases are warned and never reported as authoritative versions.

#### Phase C — bounded queries and performance (P1/P2)

1. Query SQLite by a normalized filter/sort contract with a stable full event-ID
   tie-breaker. Return bounded pages, total counts and an indexed-generation ID.
2. Add month/day aggregates, server-side facets and separately paged package
   lifecycles. Cursor/page requests must stay on one generation or explicitly
   restart after Sync. Exports stream all matches through the same query.
3. Route the CLI through that query contract; JSON/CSV writers honor backpressure.
   JSON fallback uses equivalent results with documented scale limitations or a
   bounded disk index rather than silently loading every event indefinitely.
4. Cache static asset bytes/compressed variants; use asynchronous compression
   for large responses. Throttle SSE progress, limit queues and handle slow or
   disconnected clients. Bound server avatar-query concurrency as well.
5. Benchmark 1k/10k/50k commits; 1k/100k/1M events; many manifests; large lockfiles;
   cold/warm/incremental; SQLite/JSON; both CLI and browser. Record medians, p95,
   peak RSS and fixture details. Set measured regression budgets.

Gate: page/month/search operations avoid full-history transfer and unbounded DOM;
exports and UI use identical filters; cancel/disconnect does not retain large
buffers; publish only performance targets actually met by repeatable evidence.

#### Phase D — UI structure and browser regression gates

1. Extract framework-free components for popup/date grid, filter state/query,
   table, calendar and lifecycle drawer. Centralize tokens and remove dead CSS.
2. Add browser tests for Apply/Cancel/Escape, date boundaries/DST, facet search
   beyond 200 options, first/last page, sorting, day drill-down, export, malicious
   repository text, avatar success/error, mobile overflow and focus restoration.
3. Add explicit nonblocking hosting-enrichment status for offline/auth/rate-limit
   cases. Validate image dimensions or serve bounded thumbnails.
4. Test keyboard-only and screen-reader semantics, reduced motion, both themes,
   long package names, nested manifests and 200% zoom.

Gate: one control style and one filter behavior everywhere; calendar pager is
always hidden; no native selects/date inputs; no clipping/body overflow; critical
browser tests run against installed tarballs as well as workspace sources.

#### Phase E — useful additions within the history concept

- **Compare two revisions:** exact declared/resolved differences, with author,
  commit and source evidence. Handle invalid/non-ancestor refs explicitly.
- **Evidence links:** open the relevant manifest/lockfile at the full indexed
  commit, with provider-specific paths; copy a reproducible CLI command.
- **Shareable local view state:** validated URL filters/sort/month for repeatable
  investigation, without embedding private author information.
- **Package lifecycle summary:** first appearance, recorded changes, removal and
  current declaration status, respecting unknown/truncated history.
- **Rename/path transitions:** explicit evidence and documented semantics for
  manifest moves, rather than accidental disappearance/re-addition.

Each feature must reuse the history/query model, preserve provenance and have a
bounded rendering/export path. Avoid features that require registry monitoring
or automatic dependency changes.

### 12.8 Measured verification results

- Full suite at this review: **76 tests passed** after adding corruption,
  concurrency, transport, source and hosting regressions. The final complete
  rerun passed after the UI/hosting changes.
- `npm audit --json`: **0 known vulnerabilities**, including development
  dependencies, when checked during this review. `--omit=dev` was also clean.
- Both packed packages were installed into an isolated directory and passed CLI,
  engine, HTTP/CSP, JavaScript and bundled-font smoke checks, with LICENSE files.
  The final avatar/server changes were repacked and the install smoke passed.
- Removed stale compiled modules from the core tarball via clean build output.
- Browser checks covered black/light themes, 375 px layout, shared filter
  positioning, draft cancel, invalid dates, source/action facets, package search
  beyond the initial facet list, page sizes/last page, drawer focus, month/day
  navigation and calendar pager hiding. A controlled local forge fixture loaded
  26 px avatars and account links. Browser coverage is manual, not a CI gate.
- JSON export payload construction was reviewed, but download completion could
  not be confirmed through the in-app browser download tool (it timed out);
  a browser download regression gate remains pending.
- Initial audit snapshot HTML + JavaScript gzip size: **36,452 bytes**, below the 40 KiB budget.
- A disposable fixture with **3 relevant commits, 1,000 declared dependencies
  and 1,100 events** measured **556 ms cold / 61.01 MiB peak RSS**, and **234 ms
  warm / 59.82 MiB peak RSS** on Windows / Node 22.23.2. Each is a single run,
  not a distribution or a 10,000-commit benchmark. The warm run exceeds the
  original 200 ms target; do not present that target as achieved.

The implemented improvements remove concrete bugs and add meaningful gates.
The P1 work above remains necessary to claim comprehensive history fidelity,
robust generation switching and bounded memory across large repositories.

Temporary audit/install artifacts remain in `.audit-pack/` and the disposable
Git fixture remains under the OS temp directory. Automatic approval review
rejected their removal with “blocked by policy”; this did not affect code or
verification results. The fixture servers were stopped.

## 13. Filter popup positioning follow-up — 2026-10-01

Reproduced a date popup overlapping its trigger at 1280 × 720: the old
placement used the full popup height and then pushed it into the viewport,
covering the toolbar when neither side could fit that height.

The shared popup now measures available space on each side of the trigger,
keeps an 8 px gap, and limits its height to the chosen side. Content scrolls
inside a separate body; the heading and Clear/Apply actions remain visible.
Right-edge popups align inward, page-size menus use a compact 160 px width,
and header/footer/viewport boundaries are respected. Placement follows
scrolling/resizing using one animation-frame update, preserves drafts, and
retains its side through facet search unless another side has substantially
more usable space.

Verified date and facet panels, toolbar-to-date navigation, right-edge commit
filters, upward page-size menus, draft retention and date selection in a
scrolled popup across desktop, 375 px mobile and short viewports. All nine UI
tests passed, syntax/whitespace checks passed, and the updated UI tarball
passed the isolated install smoke check. Current HTML + JavaScript gzip size:
**37,447 bytes**, within the 40 KiB budget. The earlier full-suite result remains
an audit snapshot; this follow-up changed only popup UI behavior and styling.


## 14. Scan state, toolbar, and calendar follow-up — 2026-10-01

- Fixed the reported premature empty-repository message: loading, ready,
  and error states are explicit and shared by Timeline and Calendar. One
  persistent progress card survives switching views; retries and the fetch
  fallback keep Sync disabled until the request finishes.
- Desktop controls occupy one row with a bounded search field and SVG
  chevrons. Narrow screens wrap without page overflow. The general Filters
  menu is visible only in Calendar; Timeline keeps its column controls.
  Clear filters now sits with the applied-filter chips.
- Manifest selection lists real paths and counts, with search in the list.
  Selection matches the full, case-sensitive path, avoiding accidental
  inclusion of nested manifests or differently cased workspace paths.
- Calendar navigation skips empty months and offers a searchable activity
  month picker. Filters with no results hide the grid and navigation. Days
  without events do not open an empty day history. Month/day buckets are
  cached per filtered result, avoiding a full-history pass on each move.
- Table and archaeology author names link to host-matched accounts. Missing
  matches remain plain names. Fixed Gitea fallback and Bitbucket Server
  profile/repository links for configured installation subpaths.
- Added four client behavior regressions using the actual script with a
  controlled stream/DOM adapter, plus a self-hosted subpath adapter test.
  The adapter tests verify behavior and do not measure browser layout.
- Browser verification used the actual HTML/JS with a controlled 3,554-event
  fixture: switching while scanning, completion in Calendar, skipping month
  gaps, direct month search, hiding empty results, exact manifest lists,
  linked authors in the table/drawer, 1280px desktop alignment, and 375px
  mobile controls/popovers. Hosting fixture profiles are simulated accounts;
  no new live-provider identity guarantee is implied.
- Verification: 81/81 full tests pass; syntax and whitespace checks pass;
  UI HTML+JS gzip transfer is 38,897 bytes (under 40 KiB). Installed tarball
  CLI, engine, API, font, CSP, and LICENSE smoke checks pass. No new runtime
  dependencies were added.

## 15. Single-package decision — 2026-10-02

Supersedes the two-package split in §6, §6.1–§6.2, §10.1, and the §7/§9
references to a `dep-blame` npm org and a separately installed
`@dep-blame/ui`. Those sections remain as the design record; this section
states what shipped instead and why.

**Decision:** one `dep-blame` package carries the CLI, the engine, and the
dashboard. There is no separate download — CLI-only users never touch the
UI, and visual users run `dep-blame ui` (or the identical same-package
`dep-blame-ui` alias bin).

**Rationale:** the dashboard is ~39KB gzipped with zero runtime
dependencies of its own, so a second package bought version-skew risk
(core/UI ranges drifting, two tags, two publish steps) for no install-size
win. Bundling keeps one version, one tag (`dep-blame-vX.Y.Z`), one publish
step, and a UI that can never disagree with its engine.

**Mapping, old → new:**

| Before (§6–§7) | Now |
|---|---|
| `packages/ui/` (`@dep-blame/ui`) | `packages/core/ui/` (shipped raw via `files`, history preserved with `git mv`) |
| `npx @dep-blame/ui` | `dep-blame ui` / `dep-blame-ui` (same package, both bins) |
| `packages/ui/bin/cli.js` flags | `dep-blame ui [--port --host --no-open]` (+ dedicated `ui --help`) |
| UI `dependencies: { dep-blame }` | Package self-reference (`import 'dep-blame'` resolves via `exports`; no cycle — `src/index.ts` does not import the server) |
| `GET /api/*` in `packages/ui/src/server.js` | Unchanged, at `packages/core/ui/server.js` (asset paths are `__dirname`-relative, so the move is behavior-preserving) |
| Tests importing `packages/ui/src/*` | Now import `packages/core/ui/*` |
| `test/pack-smoke.js` (two tarballs) | Single-tarball smoke: `bin/cli.js`, `bin/dep-blame-ui.js`, `dist/`, `ui/` assets, CSP, fonts, LICENSE |
| CI `npm pack --workspace packages/ui` | Dropped; core tarball only |
| Publish tags `dep-blame-v*` + `@dep-blame/ui-v*` | Single `dep-blame-v*` tag → one `npm publish --provenance` |
| `packages/ui/README.md` settings reference (§12.5) | Root `README.md` (§Web dashboard, §HTTP API, §Configuration) + `packages/core/README.md` dashboard section |

The zero-dependency guarantee is unchanged: the UI adds no entry to the
core package's `dependencies` (the optional `yaml` parser remains the sole
`optionalDependencies` entry), and CLI-only installs never execute UI code
— `../ui/server.js` loads only on the `ui` subcommand path.


## 15. Large-history blob batch correction (2026-10-03)

### Reproduced failure

Eight valid workspace manifests with distinct source blobs of slightly more
than 9 MiB each, separated from a bulk update by a non-manifest commit, produced
exactly the dashboard SSE error: "Git blob batch exceeds the 64 MiB safety
limit." The existing main history pass had byte-aware groups, but outside-range
parent seeding collected all source strings into a map. Incremental seeding and
HEAD reads had the same aggregate-memory problem. The main pass also rejected
an individual commit with more than 64 MiB of combined source contents.

### Implemented correction

- Added one-process, incremental Git blob iteration with stdout backpressure.
  Each yielded file is parsed before the next source body is allocated.
- Outside-range parent baselines, incremental baselines, and HEAD state now
  consume this iterator instead of retaining all source strings.
- Ordinary commits retain 16 MiB byte-packed groups and same-object reuse.
  Commits larger than that target use the iterator through the same diff logic,
  processing declarations before lockfiles and preserving first-parent semantics.
- Seeded snapshots retain resolved object IDs. Multi-importer baseline lockfiles
  compute their content hash once per file and carry a lock-level identity entry.
- Consumer cancellation and parser errors close the Git process; timeouts apply
  to Git I/O stalls rather than time spent parsing yielded contents.
- Single blobs remain capped at 64 MiB, checked before allocating their body.
  Oversized-file errors include the manifest path and abbreviated commit.
  The collecting batchReadBlobs library API remains bounded to 64 MiB in total;
  streamReadBlobs is exported for consumers with larger aggregate reads.

### Verification and limits

Real Git fixtures cover the previously failing parent batch, a bulk commit
above 72 MiB, complete cold/warm/incremental HEAD state, dashboard SSE completion
and JSON, and exact event parity with a CLI --no-cache scan. Reader fixtures
exercise Unicode, empty/missing objects, duplicate requests, 4,500 request
backpressure, early cancellation, consumer errors, and a 65 MiB single object.

The source-buffer limit is not a total RSS guarantee: decoded strings, manifest
parsers, parsed dependency maps, DAG snapshots, events, and cache serialization
also use memory. A file above 64 MiB still requires a separate parser/large-file
policy; the scanner reports the limit rather than silently skipping evidence.

Verification on Windows / Node 22.23.2: **89/89 full-suite tests passed**.
A freshly packed and installed tarball passed the CLI, dashboard, engine, API,
font, CSP, and LICENSE smoke checks; its compiled engine uses the streamed
reader and its public package export includes streamReadBlobs. Build and
whitespace checks passed. This verifies the local build; it is not an npm release.
