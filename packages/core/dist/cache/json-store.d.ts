import type { DependencyEvent, FilterOptions, StoreInterface } from '../types.js';
interface JsonCacheData {
    meta: Record<string, string>;
    events: DependencyEvent[];
}
export declare class JsonStore implements StoreInterface {
    filePath: string;
    data: JsonCacheData;
    constructor(filePath: string);
    load(): void;
    save(): void;
    getMeta(key: string): string | null;
    setMeta(key: string, value: string): void;
    insertEvents(events: DependencyEvent[]): void;
    queryEvents(filter?: FilterOptions): DependencyEvent[];
    clear(): void;
    close(): void;
}
export {};
//# sourceMappingURL=json-store.d.ts.map