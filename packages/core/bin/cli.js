#!/usr/bin/env node

process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) return;
  console.warn(warning);
});

import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runDepBlame,
  getRepoRoot,
  getCurrentHead,
  resolveBaseRef,
  getCommitsInRange,
  renderEventTable,
  renderArchaeologyView,
  renderCalendarView,
  renderStatsView,
  renderCiSummary,
  renderJson,
  renderCsv,
  c,
  stripControl
} from '../dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getVersion() {
  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    return pkgJson.version || '0.1.0';
  } catch {
    return '0.1.0';
  }
}

function parseSinceOption(since) {
  if (!since) return undefined;

  const trimmed = String(since).trim();
  // Windows: 7d, 30d, 2w, 6m (months, backcompat), 1y, plus 12h, 30min, 90s.
  // `m` = months (spec backcompat); use min/mins for minutes, M/mo for months.
  const match = trimmed.match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|mo|mos|month|months|y|yr|yrs|year|years)$/i);
  if (match) {
    const count = parseInt(match[1], 10);
    if (!Number.isSafeInteger(count) || count < 0 || count > 100000) return undefined;
    const unit = match[2].toLowerCase();
    const now = new Date();

    if (['s', 'sec', 'secs', 'second', 'seconds'].includes(unit)) now.setSeconds(now.getSeconds() - count);
    else if (['min', 'mins', 'minute', 'minutes'].includes(unit)) now.setMinutes(now.getMinutes() - count);
    else if (['h', 'hr', 'hrs', 'hour', 'hours'].includes(unit)) now.setHours(now.getHours() - count);
    else if (['d', 'day', 'days'].includes(unit)) now.setDate(now.getDate() - count);
    else if (['w', 'week', 'weeks'].includes(unit)) now.setDate(now.getDate() - count * 7);
    else if (['m', 'mo', 'mos', 'month', 'months'].includes(unit)) now.setMonth(now.getMonth() - count);
    else if (['y', 'yr', 'yrs', 'year', 'years'].includes(unit)) now.setFullYear(now.getFullYear() - count);
    else return undefined;

    return now.toISOString();
  }

  const parsed = new Date(trimmed);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return undefined;
}

function createCliProgress(options = {}) {
  const isInteractive = Boolean(process.stderr.isTTY && !options.json && !options.silent);
  if (!isInteractive) {
    return {
      onProgress: undefined,
      done: () => {}
    };
  }

  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frameIdx = 0;
  let active = true;

  const onProgress = (p) => {
    if (!active) return;
    frameIdx = (frameIdx + 1) % spinnerFrames.length;
    const spin = c.cyan(spinnerFrames[frameIdx]);
    let bar = '';

    if (p.phase === 'analyzing' && p.total > 0) {
      const pct = Math.min(100, Math.max(0, Math.round((p.current / p.total) * 100)));
      const barWidth = 14;
      const filled = Math.round((barWidth * pct) / 100);
      const empty = barWidth - filled;
      const filledStr = '█'.repeat(filled);
      const emptyStr = '░'.repeat(empty);
      bar = ` ${c.cyan(`[${filledStr}${emptyStr}]`)} ${c.bold(`${pct}%`)} (${p.current}/${p.total} commits)`;
    } else if (p.current > 0 && p.total > 0 && p.phase !== 'complete') {
      const pct = Math.min(100, Math.max(0, Math.round((p.current / p.total) * 100)));
      bar = ` ${c.bold(`${pct}%`)}`;
    }

    const msg = p.message ? ` ${c.dim(stripControl(p.message))}` : '';
    const detail = p.detail ? ` ${c.dim(`• ${stripControl(p.detail)}`)}` : '';
    const text = `${spin} ${c.bold('dep-blame')}:${bar}${msg}${detail}`;

    const cols = process.stderr.columns || 80;
    const stripped = text.replace(/\x1b\[[0-9;]*m/g, '');
    let output = text;
    if (stripped.length > cols - 1) {
      output = `${spin} ${c.bold('dep-blame')}:${bar}${msg}`;
    }

    process.stderr.write(`\r${output}\x1b[K`);
  };

  const done = () => {
    if (!active) return;
    active = false;
    process.stderr.write('\r\x1b[K');
  };

  return { onProgress, done };
}

function showHelp() {
  console.log(`
${c.bold('dep-blame')} — git blame, but for your dependencies

${c.bold('USAGE:')}
  $ dep-blame [command] [options]

${c.bold('COMMANDS:')}
  ${c.cyan('list')}                     Flat chronological event list (default)
  ${c.cyan('pkg <package>')}            Full history of one package ("archaeology" view)
  ${c.cyan('calendar')}                 Month-grid visualization in the terminal
  ${c.cyan('stats')}                    Aggregate counts, churn rate, top modified packages
  ${c.cyan('ci')}                       CI summary view, diffing against base branch
  ${c.cyan('ui')}                       Launch instructions for the visual web dashboard
  ${c.cyan('added')}                    Filter: only added events
  ${c.cyan('updated')}                  Filter: only updated events
  ${c.cyan('removed')}                  Filter: only removed events
  ${c.cyan('changes')}                  Filter changes within a time-window (use with --since)

${c.bold('OPTIONS:')}
  ${c.yellow('--since <ref|window>')}     Time window (7d, 30d, 2w...) or git ref for CI (e.g. origin/main)
  ${c.yellow('--workspace <name>')}       Filter events to a specific workspace/manifest path
  ${c.yellow('--direct-only')}            Restrict events to direct dependencies (ignore transitives)
  ${c.yellow('--source <kind>')}          Filter by event source: manifest (declared) or lockfile (resolved)
  ${c.yellow('--fail-on-removal')}        (CI only) Exit non-zero if any dependency was removed
  ${c.yellow('--verbose')}                Expand collapsed bulk updates across manifests
  ${c.yellow('--json')}                   Output raw JSON matching v1 schema contract
  ${c.yellow('--csv')}                    Output events as CSV (for release notes, spreadsheets)
  ${c.yellow('--clear-cache')}            Wipe cached index and perform fresh scan
  ${c.yellow('--no-cache')}               Force full rescan without cache
  ${c.yellow('--cache-dir <path>')}       Override cache storage location
  ${c.yellow('-v, --version')}            Show version number
  ${c.yellow('-h, --help')}               Show this help message

${c.bold('EXAMPLES:')}
  $ npx dep-blame
  $ npx dep-blame pkg react
  $ npx dep-blame calendar
  $ npx dep-blame stats
  $ npx dep-blame ci --since origin/main --fail-on-removal
  $ npx dep-blame list --since 30d --workspace web
  $ npx dep-blame --json
`);
}

async function main() {
  const options = {
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
    json: { type: 'boolean' },
    csv: { type: 'boolean' },
    verbose: { type: 'boolean' },
    since: { type: 'string' },
    workspace: { type: 'string' },
    source: { type: 'string' },
    'direct-only': { type: 'boolean' },
    'fail-on-removal': { type: 'boolean' },
    'clear-cache': { type: 'boolean' },
    'no-cache': { type: 'boolean' },
    'cache-dir': { type: 'string' }
  };

  let values;
  let positionals;

  try {
    const parsed = parseArgs({
      options,
      allowPositionals: true
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (err) {
    console.error(c.red(`Error: ${stripControl(err.message)}`));
    console.error(`Run 'dep-blame --help' for usage.`);
    process.exit(1);
  }

  if (values.version) {
    console.log(getVersion());
    process.exit(0);
  }

  if (values.help) {
    showHelp();
    process.exit(0);
  }

  const subCommand = positionals[0] || 'list';
  const filter = {};

  if (values['direct-only']) {
    filter.directOnly = true;
  }

  if (values.workspace) {
    filter.workspace = values.workspace;
  }

  if (values.source) {
    const src = String(values.source).toLowerCase();
    if (src !== 'manifest' && src !== 'lockfile') {
      console.error(c.red(`Invalid --source value: "${values.source}". Use "manifest" or "lockfile".`));
      process.exit(1);
    }
    filter.source = src;
  }

  if (values.json && values.csv) {
    console.error(c.red('Error: --json and --csv are mutually exclusive.'));
    process.exit(1);
  }

  function printWarnings(result) {
    if (!result || !result.warnings || result.warnings.length === 0) return;
    if (values.json || values.csv) return; // machine output stays clean
    for (const w of result.warnings) {
      console.warn(c.yellow(`⚠ ${stripControl(w)}`));
    }
  }

  if (subCommand === 'ui') {
    const localUiPath = path.resolve(__dirname, '../../ui/bin/cli.js');
    if (fs.existsSync(localUiPath)) {
      const { pathToFileURL } = await import('node:url');
      await import(pathToFileURL(localUiPath).href);
      return;
    }
    console.log(`
${c.bold('Launch the dep-blame visual dashboard:')}

  ${c.green('$ npx @dep-blame/ui')}

Runs a zero-config local dashboard (100% offline, zero-framework, sub-30KB).
`);
    process.exit(0);
  }

  if (subCommand === 'ci') {
    let repoRoot;
    try {
      repoRoot = await getRepoRoot();
    } catch {
      console.error(c.red('Error: Not a git repository.'));
      process.exit(1);
    }

    const { baseRef, baseSha } = await resolveBaseRef(values.since, repoRoot);

    const progress = createCliProgress({ json: values.json || values.csv });
    try {
      // Use the incremental cache like every other command — CI runners
      // with a warm .git cache stay fast; cold runners do one full scan.
      const result = await runDepBlame({
        noCache: values['no-cache'] || false,
        clearCache: values['clear-cache'] || false,
        cacheDir: values['cache-dir'],
        filter,
        onProgress: progress.onProgress
      });
      progress.done();

      if (!baseSha) {
        console.error(
          c.red(`Error: could not resolve CI base "${baseRef}".`) +
          c.dim(`\n  Pass an explicit ref, e.g. --since origin/main, and fetch full history (fetch-depth: 0).`)
        );
        process.exit(2);
      }

      // Exact range membership on full SHAs. A null range means the range
      // could not be listed (never treated as empty); an empty set is a
      // genuine empty range and stays empty — no date fallback.
      const rangeSet = await getCommitsInRange(baseSha, repoRoot, []);
      if (rangeSet === null) {
        console.error(
          c.red(`Error: could not list commits in range ${baseSha.slice(0, 7)}..HEAD.`) +
          c.dim(`\n  The base may be missing locally (shallow clone?) — fetch full history and retry.`)
        );
        process.exit(2);
      }
      const inRange = new Set(rangeSet);
      let ciEvents = result.events.filter((e) => {
        if (e.commitFull && inRange.has(e.commitFull)) return true;
        // Back-compat for caches written before full SHAs were stored.
        if (!e.commitFull && e.commit) {
          for (const full of inRange) {
            if (full.startsWith(e.commit)) return true;
          }
        }
        return false;
      });

      if (values.json) {
        console.log(
          renderJson({
            repository: result.repository,
            branch: result.branch,
            packageManager: result.packageManager,
            command: 'ci',
            events: ciEvents,
            warnings: result.warnings,
            truncated: result.truncated
          })
        );
      } else if (values.csv) {
        console.log(renderCsv(ciEvents));
      } else {
        printWarnings(result);
        console.log(renderCiSummary(ciEvents, baseRef));
      }

      const removals = ciEvents.filter((e) => e.type === 'removed');
      if (values['fail-on-removal'] && removals.length > 0) {
        console.error(
          c.red(`\nCI Check Failed: ${removals.length} dependency removal(s) detected with --fail-on-removal enabled.`)
        );
        process.exit(1);
      }
      process.exit(0);
    } catch (err) {
      progress.done();
      console.error(c.red(stripControl(err.message) || 'An error occurred during CI analysis.'));
      process.exit(1);
    }
  }

  if (values.since) {
    const sinceDate = parseSinceOption(values.since);
    if (!sinceDate) {
      console.error(c.red(`Invalid --since value: "${values.since}". Use e.g. 7d, 30d, 2w, 6mo, 1y, 12h, 30min or ISO date.`));
      process.exit(1);
    }
    filter.since = sinceDate;
  }

  let targetPkg = null;

  if (subCommand === 'added' || subCommand === 'updated' || subCommand === 'removed') {
    filter.type = subCommand;
  } else if (subCommand === 'pkg') {
    targetPkg = positionals[1];
    if (!targetPkg) {
      console.error(c.red(`Error: Missing package name for 'pkg' command.`));
      console.error(`Usage: dep-blame pkg <package-name>`);
      process.exit(1);
    }
    filter.package = targetPkg;
  } else if (subCommand === 'calendar' || subCommand === 'stats' || subCommand === 'list' || subCommand === 'changes') {
    // Valid command
  } else {
    console.error(c.red(`Unknown command: "${subCommand}"`));
    console.error(`Run 'dep-blame --help' for available commands.`);
    process.exit(1);
  }

  const progress = createCliProgress({ json: values.json || values.csv });
  try {
    const result = await runDepBlame({
      noCache: values['no-cache'],
      clearCache: values['clear-cache'],
      cacheDir: values['cache-dir'],
      filter,
      onProgress: progress.onProgress
    });
    progress.done();

    if (values.json) {
      console.log(
        renderJson({
          repository: result.repository,
          branch: result.branch,
          packageManager: result.packageManager,
          command: subCommand,
          events: result.events,
          warnings: result.warnings,
          truncated: result.truncated,
          headState: result.headState,
          headStateComplete: result.headStateComplete
        })
      );
      return;
    }

    if (values.csv) {
      console.log(renderCsv(result.events));
      return;
    }

    printWarnings(result);

    if (subCommand === 'pkg' && targetPkg) {
      console.log(renderArchaeologyView(targetPkg, result.events, result.headState, result.headStateComplete));
    } else if (subCommand === 'calendar') {
      console.log(renderCalendarView(result.events));
    } else if (subCommand === 'stats') {
      console.log(renderStatsView(result.events));
    } else {
      console.log(renderEventTable(result.events, { verbose: values.verbose }));
    }
  } catch (err) {
    progress.done();
    console.error(c.red(stripControl(err.message) || 'An error occurred during dep-blame analysis.'));
    process.exit(1);
  }
}

main();
