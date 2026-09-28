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
- **100% offline** — never writes to `package.json`, never hits external registries by default.

---

## Quick Start

```bash
# Run directly without installing
npx dep-blame

# View chronological dependency history
npx dep-blame list

# Investigate full history of a specific package
npx dep-blame pkg react

# Launch the lightweight local visual dashboard
npx @dep-blame/ui
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
