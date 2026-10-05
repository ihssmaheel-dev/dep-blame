# Dependency history accuracy: @types/mathjs

Verified 2026-10-05 at repository HEAD
`078090f83d9c8c27692c2fea196a3c99e7a4d902`.
Status: corrected and verified; npm release pending.

## Verdict on the supplied export

The pasted export was not fully correct. Its 21 commits / 27 file events / 9
merge commits included 15 false additions. At `0165f05`, it also labelled the
lockfile's real `9.4.1 → 9.4.2` update as an addition. Two merge-change labels
had incomplete incoming-parent evidence and are now verified integrations.

All listed authors matched Git's recorded author metadata. The issue was lost
dependency state, not an incorrectly read author name.

## Correct, readable history

| Date | Commit | Dependency change | Git author role / name |
| --- | --- | --- | --- |
| 2025-12-18 | 80f66e6 | Added: declared ^9.4.1, installed 9.4.1 | Commit author / Mohamed Ismail S |
| 2026-04-07 | 0165f05 | Updated: declared ^9.4.1 → ^9.4.2, installed 9.4.1 → 9.4.2 | Commit author / Mohamed Ismail S |
| 2026-04-07 | 94aee12 | Integrated the existing update into another branch | Merge author / Monisha |
| 2026-04-07 | 8101fd7 | Integrated the existing update into another branch | Merge author / muthuraman2002 |
| 2026-04-07 | 8262000 | Integrated the existing update into another branch | Merge author / Lalithambigai N |
| 2026-04-09 | 47f46ec | Integrated the existing update into another branch | Merge author / Pazhaniraj VJ |

Correct totals: **6 commits, 12 file events, 4 merge commits**. Each commit has
separate manifest and lockfile evidence. The four integrations do not mean four
independently authored upgrades.

## Root cause and fix

Git's path-filtered history omits commits that do not touch dependency files.
The engine seeds those omitted parents with partial snapshots. It previously
loaded only the files touched by their immediate children. A later descendant
could touch a different dependency file that already existed, but that file was
absent from the inherited snapshot. The comparison then invented an addition.

The correction propagates future file requirements backwards through the
first-parent chain before preparing baselines. Merge parents also receive the
files needed to verify incoming dependency changes. Reads are limited to the
required paths; parsed states remain shared and pruned at the DAG frontier.

Separately, independently streamed Git log chunks are ordered by actual parent
edges after combining them. Concatenating chunks could put a child before its
parent in repositories with more than 50 manifest paths.

Cache schema **v7** forces a rebuild of v5 and interim v6 history. Restart with
the corrected code before using the exported counts. A running older process
continues to use its loaded implementation.

## Verification

- Both newly added small Git fixtures failed before the parent-state correction
  and passed afterwards.
- Full suite: **114/114 passed**, including cold/warm/incremental scans,
  multi-path chunk ordering, merge evidence, and both cache migrations.
- A separate check read **1,244 Git file revisions across 474 dependency-file
  commits**, constructing each comparison directly from the commit and its
  actual parents rather than inherited engine state. It matched all **1,131**
  resulting events: **zero extra events, zero missing events**, including their
  types, versions, sections, resolution sets, merge context, dates and authors.
- The corrected cold and warm event arrays match exactly.
- No unreadable revisions were encountered in that direct check. The 38
  repository notices concern multiple installed versions, not @types/mathjs
  parse failures.

## How to read the output

- **Added / Updated / Removed:** differences from that commit's first parent.
- **Manifest:** declared version or range in package.json.
- **Lockfile:** installed versions recorded in the lockfile.
- **Merge integration:** the dependency state matches a readable incoming parent.
- **Merge author:** Git's recorded author of the merge, which may differ from the
  original change author.

The Markdown export now includes these explanations and distinguishes
repository-level notices from package-specific evidence. Verification supports
this repository at the stated HEAD; it is not a claim of perfection for every
possible repository or unavailable historical blob.
