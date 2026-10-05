# Equal-version updates in dep-blame 0.3.0

Investigated: 2026-10-05. Fix status: local, unreleased.
Follow-up: [full history accuracy check](HISTORY-ACCURACY-REPORT.md) found and
corrected a separate partial-parent-state bug. The final totals below include it.

## What happened

The reported `@fastify/static` rows are false updates. The npm v2/v3 parser
inferred a direct dependency's section from installed package flags rather than
the root declarations in `package-lock.json`. npm can change those flags while
leaving the declared section and version unchanged.

For commit `90a1ddef47b0f6dc5d11dabfa493e4d1f5de4a29`, compared with first parent
`7331a0865ac44f65c154b9ded6858ac9cd636799`:

| Evidence | Before | After |
| --- | --- | --- |
| package.json section/range | dependencies / ^10.1.3 | dependencies / ^10.1.3 |
| Lockfile root section/range | dependencies / ^10.1.3 | dependencies / ^10.1.3 |
| Installed version | 10.1.3 | 10.1.3 |
| Installed peer flag | true | absent |

The old parser invented `peerDependencies → dependencies` from that flag change.
There is no version or declared-section update for this package in that commit.
The correction removes the event rather than disguising it in the UI.

The registry's `latest` tag was verified as 0.3.0. The affected running server was
queried directly. The faulty parser/diff behavior predates the 0.3.0 performance
changes; those changes are preserved.

## Equal versions can still represent a real change

- A dependency can move between dependencies and devDependencies at the same
  version. This remains an `updated` event with `depTypeFrom`.
- A lockfile can gain or lose another installed version while its representative
  version stays the same. This remains an update, showing both complete sets.
  For example, typescript changed from `{5.9.3}` to `{5.9.3, 6.0.2}`.
- Reordering or repeating an otherwise identical resolution set is ignored.
- Legacy evidence without a known reason is labelled as metadata changed;
  unavailable version evidence is labelled unavailable rather than guessed.

## Corrections implemented

1. Root npm dependency declarations determine the direct dependency section,
   with the same section precedence as the package.json parser. Installed flags
   remain a fallback for resolved-only entries and legacy v1 data.
2. Resolution updates retain `resolutionsFrom` and `resolutions`, including
   singleton sets. Ordinary single-version comparisons avoid set allocation,
   sorting, and JSON comparisons.
3. The table's Change column, version filter, calendar tooltips, archaeology,
   Markdown, CLI, JSON and CSV explain the actual evidence. Unchanged versions
   use neutral text instead of a red/green equal-version arrow.
4. Per-commit lifecycle grouping includes both resolution sets, keeping different
   workspace evidence distinct. Merge classification compares canonical sets.
5. SQLite full and paged reads use one metadata decoder; paged results no longer
   drop resolution arrays.
6. Cache schema v7 rebuilds v5/interim v6 indexes once, removing stale false rows. JSON stays
   at schemaVersion 1 with an additive optional field; CSV appends resolutionsFrom.

## Verification on the affected repository

Repository HEAD: `078090f83d9c8c27692c2fea196a3c99e7a4d902`.
Corrected scans used an isolated cache, leaving the running 0.3.0 server untouched.

| Measure | Running 0.3.0 | Corrected scan |
| --- | ---: | ---: |
| Total dependency file events | 3,855 | 1,131 |
| Updated events with equal scalar versions | 1,333 | 23 |
| Equal-version events carrying section moves | 1,323 | 12 |
| Equal-version resolution-set changes | 10 | 11 |
| Equal-version events without an explained reason | 10 | 0 |

The initial npm-only correction removed 1,312 false equal-version section events
and recovered one previously missed real qrcode section move at `f96dec8`.
That stage produced 2,544 events, but the follow-up raw-parent check exposed a
separate source of false additions. After both corrections there are 1,131 events,
matching direct Git-parent comparisons with no extra or missing events. The 12
section events are declared/resolved evidence for real qrcode moves; the 11
equal-version set changes retain full version sets. The false @fastify/static
event at 90a1dde is absent.

The initial npm-only cold, warm and throwaway scans matched; the final complete
correction also returns identical cold and warm event arrays.
The repository reports 38 notices, all about multiple installed versions; the
verification scan reports no unreadable-blob notices.

## Tests and packaging

- Final full suite: 114/114 passed.
- Regression fixtures cover npm flag churn, actual section moves, resolution
  growth/shrinkage, order independence, cold/warm/incremental/paged reads,
  SQLite/JSON v5 migration, lifecycle grouping, CLI, Markdown and escaping.
- Fresh local tarball installed with optional dependencies omitted: CLI, UI,
  engine, API, fonts, CSP and LICENSE smoke checks passed; resolution before/after
  evidence survives the installed package.
- Browser inspection confirms the actual reason is visible in the table and
  archaeology drawer. The UI size, CSP and inline-handler gates pass.

## Release action

Publish this correction as a new patch release, such as 0.3.1. Published 0.3.0
remains affected until users upgrade; clearing its cache alone cannot fix the
parser. The upgraded code rebuilds old caches automatically. No package has
been published by this investigation.

Reference: [npm package-lock documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/)
describes the root package entry and installed dependency-tree metadata.
