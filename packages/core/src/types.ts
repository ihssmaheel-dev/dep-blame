export type DependencyEventType = 'added' | 'updated' | 'removed';

export type DepType =
  | 'dependencies'
  | 'devDependencies'
  | 'peerDependencies'
  | 'optionalDependencies';

export interface DependencyEntry {
  version: string;
  depType: DepType;
  isDirect?: boolean;
}

export interface DependencyEvent {
  package: string;
  type: DependencyEventType;
  from?: string;
  to?: string;
  date: string; // ISO 8601
  commit: string; // short SHA (7 characters)
  author: string;
  message: string;
  manifest: string;
  depType: DepType;
  isDirect?: boolean;
}

export interface CommitInfo {
  commit: string;
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
}

export interface EngineResult {
  repository: string;
  branch?: string;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  events: DependencyEvent[];
  isShallow: boolean;
  cached: boolean;
  durationMs?: number;
}

export interface StoreInterface {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  insertEvents(events: DependencyEvent[]): void;
  queryEvents(filter?: FilterOptions): DependencyEvent[];
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
