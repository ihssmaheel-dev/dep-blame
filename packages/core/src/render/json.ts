import type { DependencyEvent, HeadEntry } from '../types.js';

export interface RenderJsonData {
  repository?: string;
  branch?: string;
  packageManager?: string;
  command?: string;
  events: DependencyEvent[];
  warnings?: string[];
  truncated?: boolean;
  headState?: HeadEntry[];
  headStateComplete?: boolean;
}

/**
 * Emits output according to the JSON output contract in §5.4.
 * `warnings`/`truncated`/`headState` are additive and safe for
 * `schemaVersion: 1` consumers to ignore.
 */
export function renderJson(data: RenderJsonData): string {
  const output = {
    schemaVersion: 1,
    repository: data.repository || '',
    branch: data.branch || 'main',
    packageManager: data.packageManager || 'npm',
    generatedAt: new Date().toISOString(),
    command: data.command || 'list',
    events: data.events || [],
    warnings: data.warnings || [],
    ...(data.truncated ? { truncated: true } : {}),
    ...(data.headState ? { headState: data.headState } : {}),
    ...(data.headStateComplete === false ? { headStateComplete: false } : {})
  };

  return JSON.stringify(output, null, 2);
}
