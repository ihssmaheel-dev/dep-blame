import type { DependencyEvent } from '../types.js';
export interface RenderTableOptions {
    verbose?: boolean;
    collapseThreshold?: number;
}
/**
 * Renders dependency events into a clean, aligned ANSI table string.
 */
export declare function renderEventTable(events: DependencyEvent[], options?: RenderTableOptions): string;
//# sourceMappingURL=table.d.ts.map