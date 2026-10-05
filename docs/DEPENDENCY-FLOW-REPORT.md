# Dependency Flow implementation and verification

Date: 2026-10-05

## Delivered scope

The existing dependency drawer now has **History** and **Flow** tabs. Flow explains one dependency's changes within one owning manifest or workspace. It connects dependency states using recorded Git ancestry and readable snapshot evidence.

It remains a dependency history feature. It does not display the repository's general commit graph, unrelated source changes, installed runtime state, or security scores.

Open a dependency from the table and choose **Flow**. For a dependency present in multiple workspaces, use the searchable custom manifest picker to choose its owning `package.json`.

## What the view shows

- State cards separate declared requirements from lockfile resolutions.
- Version changes, section moves and resolution-set changes have distinct descriptions. Equal representative versions alone do not establish a version update.
- Changes introduced by ordinary commits and changes first recorded at a merge remain distinct from verified integrations.
- Verified integrations are grouped in an expandable disclosure. Its count describes the current window.
- A selected card shows full commit SHA, author recorded in Git, message, source paths, before/after evidence, and matched incoming parent snapshots.
- Solid connections describe verified continuity along a first-parent path. Dashed connections describe a verified incoming-parent integration.
- Connections outside the current window have explicit navigable references.
- The captured HEAD's declared and resolved states are shown independently of the historical cards.
- Missing evidence, unreadable snapshots and shallow history are shown as limitations. The view does not invent arrows across a gap.

## Accuracy rules

### Ancestry and provenance

The scanner records all matching readable incoming parents for a merge. The Flow builder streams `git rev-list --topo-order --parents` from the captured full HEAD SHA. It follows first-parent paths across unchanged commits and verifies matching states for the exact evidence stream before connecting two nodes.

An incoming connection requires both actual incoming-parent membership and the scanner's matching-parent snapshot evidence. Matching dates, author names or version strings are insufficient. Commit dates remain visible metadata; Git ancestry determines the ordering.

A node describes what that commit recorded relative to its first parent. An integration's author is the Git author of the integration commit. The incoming connection identifies an earlier recorded dependency state; it does not authenticate a human's identity or prove a universal original author across every branch.

### Independent evidence streams

An evidence stream includes the owning manifest, declared/resolved source, and lockfile path. Workspace boundaries and different lockfiles remain separate. Older single-map lockfile events are normalized only in the Flow model to their owning `package.json`; their raw exported events are preserved.

Continuity compares version, dependency section, and complete normalized resolution sets when available. Removed and reintroduced states are retained. Ambiguous representative versions cannot establish continuity without sufficient resolution evidence.

### Unknown baselines

Unreadable manifests preserve the last readable snapshot. An unreadable first manifest now also leaves an explicit unreadable marker, so a dependency first observed after that file is repaired is not presented as a proven introduction from an empty baseline.

### Captured HEAD

The server checks that HEAD did not change during the history scan. Flow reads current declarations and relevant lockfile evidence at that captured SHA. A deleted or unreadable lockfile is reported as unavailable evidence, rather than proof that a dependency is no longer installed.

The UI stays pinned to its completed scan until Sync. This makes history, state and navigation consistent within one generation.

## UI and accessibility

- Black dark mode and existing light-mode tokens are reused.
- Desktop shows a state column beside the evidence panel; narrow screens stack the panels.
- Tabs support arrow keys, Home and End. Cards are buttons, integrations use a disclosure, and selection changes are announced to assistive technology.
- The manifest control is a searchable custom popover, using the existing collision positioning and focus handling. A single-manifest dependency does not show an unnecessary picker.
- Loading, retryable errors and evidence gaps have explicit states.
- Client request cancellation, serial checks and generation checks prevent stale results from replacing a newer selection.
- Connectors are drawn only for visible verified endpoints. Collapsed integration cards do not leave ghost connectors behind.
- Reduced-motion preferences are respected.
- Existing host-aware author links and avatar handling are reused in the evidence panel when a hosting profile is available.

## Performance and memory

| Area | Implemented bound or behavior |
| --- | --- |
| Flow window | 50 nodes by default; API maximum 100 |
| History drawer | 50 commit cards per window |
| Single-window history | No unnecessary Earlier/Later controls |
| API cache | At most four completed models and 10,000 retained nodes |
| Concurrent ancestry preparations | At most two |
| Git ancestry read | Streamed; no full repository DAG retained |
| Ancestry state | Selected dependency nodes plus pending frontier demands |
| Ancestry timeout | 60 seconds, with process cleanup |
| Node selection | No scan and no Git process |
| Warm window navigation | Reuses the prepared model |
| Server shutdown | Aborts pending ancestry preparations |
| Assets | Bundled CSS/JS; no graph runtime dependency added |

Models larger than the retained-node budget can be served, but are evicted rather than held permanently in the Flow cache. The browser renders a bounded drawer window, while Markdown export continues to include the complete selected dependency history.

These are additional bounds for Flow and drawer rendering. The existing dashboard still receives the complete history dataset, and building a selected dependency's model still requires memory proportional to that dependency's evidence. This implementation does not claim constant memory for the entire application.

Measured asset gates: HTML 101,952 bytes against the 102,400-byte limit; combined HTML, JavaScript and Flow CSS gzip 53,246 bytes against the 57,344-byte limit. No external graph dependency was introduced. These measurements apply to this implementation snapshot.

## API and storage

New endpoint:

```text
GET /api/dependency-flow?package=<name>&manifest=<owning-manifest>&generation=<scan-generation>&offset=0&limit=50
```

The response includes a bounded node window, relevant edges, references outside the window, total count, next offset, captured HEAD state and available manifests.

- Package and manifest must match scanned dependency evidence.
- Offset must be a safe nonnegative integer; limit must be 1–100.
- Malformed parameters return 400; missing scope returns 404; a stale generation returns 409; preparation capacity exhaustion returns 429.
- Responses support gzip and use `no-store` plus `nosniff`.
- Existing loopback, Host, Origin and script CSP protections remain in place.
- Dynamic text is escaped, and event handlers use existing delegated actions.

Both cache stores now use **schema 8** and persist flow evidence. Earlier cache generations are rescanned; the API response schema remains version 1. These are separate version numbers. The npm package version remains 0.3.0 for this local unreleased work.

## Verification completed

### Automated suite

**128 tests passed; zero failed, skipped or cancelled.** The final run includes the unreadable-first-manifest and workspace popup regressions.

Coverage added or extended includes:

- Nested integrations across unchanged commits and backwards author dates.
- Independent branches with identical versions.
- Corrupt previous snapshots and an unreadable initial manifest.
- Removal, reintroduction, section moves and workspace isolation.
- Captured HEAD resolution evidence.
- Bounded API windows, gzip, parameter validation, stale generations and cache invalidation.
- Invalid HEAD and cancelled ancestry operations.
- A synthetic 10,000-node history, complete window coverage and navigable boundary references.
- JSON fallback proof persistence, reopening and paged reads.
- Tab behavior, stale UI results and bounded History navigation.
- A workspace trigger's bubbled click and clicks on its child elements keep the popup open; outside clicks close it.
- Existing CLI, scanner, cache migration, security and package behavior gates.

The synthetic large-history test checks paging correctness. It is not a measured production memory benchmark.

### Final package smoke test

A fresh tarball built from the final source was installed in a separate temporary directory with optional dependencies omitted. The installed package passed checks for CLI/UI bins, engine execution, dashboard, Flow endpoint, CSS, bundled font, CSP and LICENSE.

The tarball contained 126 files and an unpacked size of 859,197 bytes. It was verified locally; nothing was published.

### Browser and actual history checks

An isolated shared clone of the user's ERP repository was used to keep the source checkout and its cache untouched. Its captured history contained **1,131 events**.

For `@types/mathjs`, Flow showed six commit nodes: two changes and four integrations. Captured HEAD declarations showed `^9.4.2` in `devDependencies`; lockfile resolution showed `9.4.2`. For `mathjs`, the final browser check showed ten nodes: three changes and seven integrations, with captured HEAD declaration `^15.1.1` and resolution `15.2.0`.

The browser was checked at its normal desktop viewport and at 380px width. The narrow Flow panel had equal client and scroll widths (318px), with no horizontal overflow. Collapsed integrations produced no integration connectors; expanding them showed the verified incoming connections. No browser warnings or runtime errors were reported during these checks.

A separate two-workspace fixture verified the manifest popover in the real browser. It remained open, appeared 8px below its trigger within the viewport, and search plus selection switched from the API workspace's two recorded changes and HEAD `1.1.0` to the web workspace's single addition and HEAD `2.0.0`. This check exposed an outside-click handler issue that was fixed and covered by the final regression suite.

Observed localhost endpoint timings after the repository analysis was cached:

| Dependency | Initial model preparation observed | Warm response observed |
| --- | --- | --- |
| `@types/mathjs` | Already prepared | 9 ms |
| `@fastify/static` | 207 ms | 10 ms |
| `@types/node` | 181 ms | 7 ms |

These are local observations, not cross-machine guarantees or cold-scan timings.

## Remaining limits and release state

- Git author metadata is not authenticated user identity.
- Shallow history and missing evidence limit what can be established; Sync cannot recreate unavailable Git objects.
- The first uncached Flow request walks the captured HEAD's ancestry. Very large repositories may reach the explicit timeout.
- Missing hosting profile information can still produce the existing initials fallback.
- Runtime package behavior, vulnerabilities inside historical dependencies, and unrelated Git changes remain outside this feature's purpose.
- The implementation and previous fixes belong to the Unreleased changelog. No npm publication or release version bump was performed.

Restart a development UI process to load these assets. An already installed `npx dep-blame@latest` continues to use the published release until a new release is made.

## Main files

- `packages/core/src/render/dependency-flow.ts`: shared evidence model and paging.
- `packages/core/src/engine.ts`: parent snapshot proof and captured HEAD lockfile state.
- `packages/core/src/types.ts`: event evidence contract.
- `packages/core/src/cache/{sqlite-store,json-store}.ts`: schema 8 persistence.
- `packages/core/ui/server.js`: generation-pinned endpoint, cache and stylesheet serving.
- `packages/core/ui/{app.js,index.html,flow.css}`: drawer tabs, flow cards, connections and responsive styling.
- `test/dependency-flow.test.js`, `test/ui-behavior.test.js`, `test/pack-smoke.js`: correctness, UI and shipped-artifact checks.
