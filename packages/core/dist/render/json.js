/**
 * Emits output according to the JSON output contract in §5.4.
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
//# sourceMappingURL=json.js.map