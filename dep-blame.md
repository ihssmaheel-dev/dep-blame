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