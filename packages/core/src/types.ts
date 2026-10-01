export type DependencyEventType = 'added' | 'updated' | 'removed';

export type DepType =
  | 'dependencies'
  | 'devDependencies'
  | 'peerDependencies'
  | 'optionalDependencies';

/**
 * Where an event came from: a declared manifest (`package.json`) or a
 * resolved lockfile. Lockfile deletion never means declared packages were
 * removed — it means resolution information was lost.
 */
export type EventSource = 'manifest' | 'lockfile';

export interface DependencyEntry {
  version: string;
  depType: DepType;
  isDirect?: boolean;
  /** All resolved versions when a lockfile holds several (multi-version). */
  resolutions?: string[];
  /** True when `version` is a representative, not the full resolution set. */
  ambiguous?: boolean;
}

/**
 * Tri-state parse result. `ok: false` means the content was present but
 * unparseable (corrupt JSON/YAML, binary lockfile) — callers must retain
 * the last-good snapshot and warn, never diff against an empty map.
 * A `null` return (lockfile parsers only) means the optional parser is
 * unavailable in this install.
 */
export interface ParseResult {
  ok: boolean;
  entries: Map<string, DependencyEntry>;
  /** Extra diagnostic detail for warnings (e.g. binary lockfile, multi-version). */
  note?: string;
}

export interface DependencyEvent {
  package: string;
  type: DependencyEventType;
  from?: string;
  to?: string;
  date: string; // ISO 8601
  commit: string; // short SHA (7 characters)
  commitFull?: string; // full 40-character SHA for exact range membership
  author: string;
  message: string;
  manifest: string;
  depType: DepType;
  /** Set when an update moved the package between dependency sections. */
  depTypeFrom?: DepType;
  /** Declared intent (package.json) vs resolved reality (lockfile). */
  source: EventSource;
  /** Originating lockfile when a lockfile resolves deps for another manifest. */
  lockfile?: string;
  isDirect?: boolean;
  /** All known resolutions when several versions coexist (never silently collapsed). */
  resolutions?: string[];
  /** True when version info is partial/representative — warn, never authoritative. */
  ambiguous?: boolean;
}

export interface CommitInfo {
  commit: string;
  /** Full SHAs of direct parents (empty for root, 2+ for merges). */
  parents: string[];
  date: string;
  author: string;
  message: string;
  files: string[];
}

export interface BlobRequest {
  commit: string;
  path: string;
}

export interface FilterOptions {
  package?: string;
  type?: DependencyEventType;
  since?: string;
  manifest?: string;
  workspace?: string;
  directOnly?: boolean;
  source?: EventSource;
}

export interface PagedQuery {
  limit?: number;
  offset?: number;
}

export interface PagedResult {
  events: DependencyEvent[];
  total: number;
  limit: number;
  offset: number;
}

export interface MonthBucket {
  month: string;
  total: number;
  added: number;
  updated: number;
  removed: number;
}

export type ProgressPhase =
  | 'initializing'
  | 'discovering'
  | 'reading_commits'
  | 'analyzing'
  | 'saving'
  | 'complete';

export interface ProgressUpdate {
  phase: ProgressPhase;
  current: number;
  total: number;
  message?: string;
  detail?: string;
}

export interface EngineOptions {
  cwd?: string;
  noCache?: boolean;
  clearCache?: boolean;
  cacheDir?: string;
  filter?: FilterOptions;
  silent?: boolean;
  onProgress?: (progress: ProgressUpdate) => void;
  /** Bounded query: max events to return (0-1000, default all). */
  limit?: number;
  /** Bounded query: offset into filtered events. */
  offset?: number;
  /** Include month aggregates + generation id without extra scan. */
  includeAggregates?: boolean;
}

export interface EngineResult {
  repository: string;
  branch?: string;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  events: DependencyEvent[];
  isShallow: boolean;
  cached: boolean;
  durationMs?: number;
  /** Non-fatal diagnostics: skipped corrupt blobs, unsupported lockfiles, truncation. */
  warnings: string[];
  /** True when path discovery hit its cap — history may be incomplete. */
  truncated?: boolean;
  /** Declared dependency state at HEAD, for trustworthy active/removed status. */
  headState?: HeadEntry[];
  /** False when a declared HEAD manifest could not be decoded or read. */
  headStateComplete?: boolean;
  /** Total matching events before limit/offset (bounded-query contract). */
  total?: number;
  /** Active cache generation id (pin cursors to one generation). */
  generation?: number | null;
  /** Month aggregates for bounded calendar rendering. */
  months?: MonthBucket[];
}

/** One declared dependency at HEAD. */
export interface HeadEntry {
  manifest: string;
  package: string;
  version: string;
  depType: DepType;
}

export interface StoreInterface {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  insertEvents(events: DependencyEvent[]): void;
  queryEvents(filter?: FilterOptions): DependencyEvent[];
  queryPaged?(filter?: FilterOptions, page?: PagedQuery): PagedResult;
  monthAggregates?(filter?: FilterOptions): MonthBucket[];
  /**
   * Runs `fn` with writes coalesced: SQLite wraps in a transaction,
   * the JSON store persists once at the end.
   */
  transaction(fn: () => void): void;
  clear(): void;
  close(): void;
}

export interface DetectedPackageManager {
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  lockfile: string | null;
  manifestPaths: string[];
  isMonorepo: boolean;
  workspaceGlobs: string[];
}
