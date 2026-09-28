/**
 * Emits output according to the JSON output contract in §5.4.
 *
 * @param {Object} data
 * @param {string} data.repository Name of repository
 * @param {string} data.packageManager Detected package manager
 * @param {string} [data.command='list'] Invoked command
 * @param {Array} data.events Normalized DependencyEvent array
 * @returns {string} Formatted JSON string
 */
export function renderJson(data) {
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
