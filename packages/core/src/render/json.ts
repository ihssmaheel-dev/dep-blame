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
export function renderJson(data: RenderJsonData): string {
  const output = {
    schemaVersion: 1,
    repository: data.repository || '',
    packageManager: data.packageManager || 'npm',
    generatedAt: new Date().toISOString(),
    command: data.command || 'list',
    events: data.events || []
  };

  return JSON.stringify(output, null, 2);
}
