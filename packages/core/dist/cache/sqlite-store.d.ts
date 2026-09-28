import { DatabaseSync } from 'node:sqlite';
import type { DependencyEvent, FilterOptions, StoreInterface } from '../types.js';
export declare class SqliteStore implements StoreInterface {
    filePath: string;
    db: DatabaseSync;
    constructor(filePath: string);
    initSchema(): void;
    getMeta(key: string): string | null;
    setMeta(key: string, value: string): void;
    insertEvents(events: DependencyEvent[]): void;
    queryEvents(filter?: FilterOptions): DependencyEvent[];
    clear(): void;
    close(): void;
}
//# sourceMappingURL=sqlite-store.d.ts.map