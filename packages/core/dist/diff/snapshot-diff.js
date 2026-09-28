/**
 * Diffs two snapshot maps and produces normalized DependencyEvents.
 *
 * @param prevSnapshot Previous dependencies map
 * @param currSnapshot Current dependencies map
 * @param commitInfo Commit metadata
 * @param manifest Path to manifest file
 * @returns Array of DependencyEvent
 */
export function diffSnapshots(prevSnapshot, currSnapshot, commitInfo, manifest) {
    const events = [];
    const shortSha = commitInfo.commit.length > 7 ? commitInfo.commit.slice(0, 7) : commitInfo.commit;
    const prev = prevSnapshot || new Map();
    const curr = currSnapshot || new Map();
    // Find added and updated
    for (const [name, current] of curr.entries()) {
        if (!prev.has(name)) {
            events.push({
                package: name,
                type: 'added',
                to: current.version,
                date: commitInfo.date,
                commit: shortSha,
                author: commitInfo.author,
                message: commitInfo.message,
                manifest,
                depType: current.depType,
                isDirect: current.isDirect ?? true
            });
        }
        else {
            const previous = prev.get(name);
            if (previous.version !== current.version || previous.depType !== current.depType) {
                events.push({
                    package: name,
                    type: 'updated',
                    from: previous.version,
                    to: current.version,
                    date: commitInfo.date,
                    commit: shortSha,
                    author: commitInfo.author,
                    message: commitInfo.message,
                    manifest,
                    depType: current.depType,
                    isDirect: current.isDirect ?? true
                });
            }
        }
    }
    // Find removed
    for (const [name, previous] of prev.entries()) {
        if (!curr.has(name)) {
            events.push({
                package: name,
                type: 'removed',
                from: previous.version,
                date: commitInfo.date,
                commit: shortSha,
                author: commitInfo.author,
                message: commitInfo.message,
                manifest,
                depType: previous.depType,
                isDirect: previous.isDirect ?? true
            });
        }
    }
    return events;
}
/**
 * Generates low-fidelity lockfile updated event for pnpm/yarn in v0.1 compatibility.
 */
export function createLockfileLowFiEvent(commitInfo, manifest) {
    const shortSha = commitInfo.commit.length > 7 ? commitInfo.commit.slice(0, 7) : commitInfo.commit;
    return {
        package: '(lockfile)',
        type: 'updated',
        date: commitInfo.date,
        commit: shortSha,
        author: commitInfo.author,
        message: commitInfo.message || 'resolved versions changed',
        manifest,
        depType: 'dependencies',
        isDirect: false
    };
}
//# sourceMappingURL=snapshot-diff.js.map