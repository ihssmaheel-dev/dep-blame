export type DependencyEventType = 'added' | 'updated' | 'removed';
export type DepType = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies';
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
    date: string;
    commit: string;
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
export interface EngineOptions {
    cwd?: string;
    noCache?: boolean;
    clearCache?: boolean;
    cacheDir?: string;
    filter?: FilterOptions;
    silent?: boolean;
}
export interface EngineResult {
    repository: string;
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
//# sourceMappingURL=types.d.ts.map