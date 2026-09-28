# dep-blame

> **`git blame`, but for your dependencies.**  
> See exactly how your project's dependencies changed over time.  
> `npx dep-blame` — one command, zero config, zero servers, zero accounts.

---

## What is dep-blame?

`dep-blame` walks your repository's git history, extracts every dependency addition, update, and removal event from manifest and lockfile changes, caches the result, and lets you query and visualize it instantly in the terminal or web UI.

- **Zero runtime dependencies** in the core CLI.
- **Sub-3s cold scans** on large repositories via `git cat-file --batch`.
- **Sub-200ms warm runs** powered by an incremental cache (`node:sqlite` or flat JSON).
- **Multi-ecosystem lockfile support** — `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, and `bun.lock`.
- **Monorepo ready** — tracks root and workspace manifests independently with collapsed bulk rendering.
- **100% offline** — never writes to `package.json`, never hits external registries by default.

---

## Quick Start

```bash
# Run directly without installing
npx dep-blame

# View chronological dependency history
npx dep-blame list

# Investigate full history of a specific package ("archaeology" view)
npx dep-blame pkg react

# Terminal month-grid visualization
npx dep-blame calendar

# Churn statistics and most modified packages
npx dep-blame stats

# CI mode with PR diff summary
npx dep-blame ci --since origin/main

# Output JSON matching v1 schema contract
npx dep-blame --json

# Launch the lightweight local visual dashboard
npx @dep-blame/ui
```

---

## GitHub Actions (CI)

Track dependency changes and guard against unintended dependency removals on Pull Requests:

```yaml
name: Dependency Review
on: [pull_request]

jobs:
  dep-blame:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # Full history needed for git-derived analysis
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx dep-blame ci --since origin/main --fail-on-removal
```

---

## Monorepo Layout

This repository is organized as a lightweight workspace:

- [`packages/core`](./packages/core) — Published as `dep-blame`. The core analysis engine and zero-dependency CLI.
- [`packages/ui`](./packages/ui) — Published as `@dep-blame/ui`. The standalone vanilla web UI dashboard.

---

## Architecture & Documentation

For complete technical specifications, architecture decisions, and roadmap, see [dep-blame.md](./dep-blame.md).

---

## License

[MIT](./LICENSE)
