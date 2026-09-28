import type { DependencyEvent } from '../types.js';
export interface RenderJsonData {
    repository?: string;
    packageManager?: string;
    command?: string;
    events: DependencyEvent[];
}
/**
 * Emits output according to the JSON output contract in §5.4.
 */
export declare function renderJson(data: RenderJsonData): string;
//# sourceMappingURL=json.d.ts.map