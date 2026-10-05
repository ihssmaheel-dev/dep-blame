import type {
  CommitInfo,
  DependencyEntry,
  DependencyEvent,
  DepType,
  EventSource
} from '../types.js';

export interface DiffOptions {
  /** Defaults to 'manifest'. Lockfile diffs must pass 'lockfile'. */
  source?: EventSource;
  /** Originating lockfile when a lockfile resolves deps for another manifest. */
  lockfile?: string;
}

/** Canonical set: a representative version alone is not a full multi-version diff. */
export function resolutionSet(entry: { version: string; resolutions?: string[] }): string[] {
  return [...new Set(entry.resolutions?.length ? entry.resolutions : [entry.version])].sort();
}

/**
 * Diffs two snapshot maps and produces normalized DependencyEvents.
 *
 * A depType-only move (same version, different section) is an `updated`
 * event carrying `depTypeFrom` so category changes are explicit.
 */
export function diffSnapshots(
  prevSnapshot: Map<string, DependencyEntry> | undefined,
  currSnapshot: Map<string, DependencyEntry> | undefined,
  commitInfo: CommitInfo,
  manifest: string,
  options: DiffOptions = {}
): DependencyEvent[] {
  const events: DependencyEvent[] = [];
  const source: EventSource = options.source || 'manifest';
  const full = commitInfo.commit;
  const shortSha = full.length > 7 ? full.slice(0, 7) : full;

  const prev = prevSnapshot || new Map<string, DependencyEntry>();
  const curr = currSnapshot || new Map<string, DependencyEntry>();

  const base = (extra: Partial<DependencyEvent>): DependencyEvent =>
    ({
      package: '',
      type: 'added',
      date: commitInfo.date,
      commit: shortSha,
      commitFull: full,
      commitParents: [...(commitInfo.parents || [])],
      changeOrigin: (commitInfo.parents || []).length > 1 ? 'merge-change' : 'direct',
      author: commitInfo.author,
      message: commitInfo.message,
      manifest,
      depType: 'dependencies' as DepType,
      source,
      isDirect: true,
      ...(options.lockfile ? { lockfile: options.lockfile } : {}),
      ...extra
    }) as DependencyEvent;

  // Find added and updated
  for (const [name, current] of curr.entries()) {
    if (!prev.has(name)) {
      events.push(
        base({
          package: name,
          type: 'added',
          to: current.version,
          depType: current.depType,
          isDirect: current.isDirect ?? true,
          ...(current.resolutions ? { resolutions: [...current.resolutions] } : {}),
          ...(current.ambiguous ? { ambiguous: true } : {})
        })
      );
    } else {
      const previous = prev.get(name)!;
      // The common single-version path needs no arrays, sets, sorting, or JSON.
      const hasResolutionSets = !!(previous.resolutions?.length || current.resolutions?.length);
      const before = hasResolutionSets ? resolutionSet(previous) : undefined;
      const after = hasResolutionSets ? resolutionSet(current) : undefined;
      const setsDiffer = hasResolutionSets && JSON.stringify(before) !== JSON.stringify(after);
      const resolutionsChanged = setsDiffer;
      const versionChanged = previous.version !== current.version && (!hasResolutionSets || setsDiffer);
      if (versionChanged || previous.depType !== current.depType || resolutionsChanged) {
        events.push(
          base({
            package: name,
            type: 'updated',
            from: previous.version,
            to: current.version,
            depType: current.depType,
            ...(previous.depType !== current.depType ? { depTypeFrom: previous.depType } : {}),
            isDirect: current.isDirect ?? true,
            ...(current.resolutions ? { resolutions: [...current.resolutions] } : {}),
            ...(resolutionsChanged ? { resolutionsFrom: before, resolutions: after } : {}),
            ...(current.ambiguous ? { ambiguous: true } : {})
          })
        );
      }
    }
  }

  // Find removed
  for (const [name, previous] of prev.entries()) {
    if (!curr.has(name)) {
      events.push(
        base({
          package: name,
          type: 'removed',
          from: previous.version,
          depType: previous.depType,
          ...(previous.resolutions ? { resolutions: [...previous.resolutions] } : {}),
          ...(previous.ambiguous ? { ambiguous: true } : {}),
          isDirect: previous.isDirect ?? true
        })
      );
    }
  }

  return events;
}

/**
 * Generates low-fidelity lockfile updated event when the optional parser
 * is unavailable. Never used for lockfile *deletion* — lost resolution
 * info is a warning, not a removal.
 */
export function createLockfileLowFiEvent(commitInfo: CommitInfo, manifest: string): DependencyEvent {
  const full = commitInfo.commit;
  const shortSha = full.length > 7 ? full.slice(0, 7) : full;
  return {
    package: '(lockfile)',
    type: 'updated',
    date: commitInfo.date,
    commit: shortSha,
    commitFull: full,
    commitParents: [...(commitInfo.parents || [])],
    changeOrigin: (commitInfo.parents || []).length > 1 ? 'merge-change' : 'direct',
    author: commitInfo.author,
    message: commitInfo.message || 'resolved versions changed',
    manifest,
    depType: 'dependencies' as DepType,
    source: 'lockfile' as EventSource,
    isDirect: false
  };
}
