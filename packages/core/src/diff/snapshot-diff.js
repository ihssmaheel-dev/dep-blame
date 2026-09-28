/**
 * @typedef {Object} DependencyEntry
 * @property {string} version
 * @property {string} depType
 */

/**
 * @typedef {Object} CommitInfo
 * @property {string} commit Full or short SHA
 * @property {string} date ISO 8601 date string
 * @property {string} author Author name
 * @property {string} message Commit subject line
 */

/**
 * @typedef {Object} DependencyEvent
 * @property {string} package
 * @property {'added' | 'updated' | 'removed'} type
 * @property {string} [from]
 * @property {string} [to]
 * @property {string} date
 * @property {string} commit Short commit SHA
 * @property {string} author
 * @property {string} message
 * @property {string} manifest
 * @property {'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies'} depType
 */

/**
 * Diffs two snapshot maps and produces normalized DependencyEvents.
 *
 * @param {Map<string, DependencyEntry>} prevSnapshot
 * @param {Map<string, DependencyEntry>} currSnapshot
 * @param {CommitInfo} commitInfo
 * @param {string} manifest Path to manifest file
 * @returns {DependencyEvent[]}
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
        depType: current.depType
      });
    } else {
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
          depType: current.depType
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
        depType: previous.depType
      });
    }
  }

  return events;
}

/**
 * Generates low-fidelity lockfile updated event for pnpm/yarn in v0.1.
 *
 * @param {CommitInfo} commitInfo
 * @param {string} manifest
 * @returns {DependencyEvent}
 */
export function createLockfileLowFiEvent(commitInfo, manifest) {
  const shortSha = commitInfo.commit.length > 7 ? commitInfo.commit.slice(0, 7) : commitInfo.commit;
  return {
    package: '(lockfile)',
    type: 'updated',
    date: commitInfo.date,
    commit: shortSha,
    author: commitInfo.author,
    message: commitInfo.message || 'resolved versions changed — run with full pnpm/yarn support for package-level detail',
    manifest,
    depType: 'dependencies'
  };
}
