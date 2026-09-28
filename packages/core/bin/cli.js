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
import { runDepBlame } from '../src/engine.js';
import { getRepoRoot, resolveBaseRef } from '../src/git/repo.js';
import { renderEventTable } from '../src/render/table.js';
import { renderArchaeologyView } from '../src/render/archaeology.js';
import { renderCalendarView } from '../src/render/calendar.js';
import { renderStatsView } from '../src/render/stats.js';
import { renderCiSummary } from '../src/render/ci.js';
import { renderJson } from '../src/render/json.js';
import { c } from '../src/render/ansi.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getVersion() {
  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    return pkgJson.version;
  } catch {
    return '0.1.0';
  }
}

function parseSinceOption(since) {
  if (!since) return undefined;

  const match = since.match(/^(\d+)([dwmy])$/i);
  if (match) {
    const count = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const now = new Date();

    if (unit === 'd') now.setDate(now.getDate() - count);
    else if (unit === 'w') now.setDate(now.getDate() - count * 7);
    else if (unit === 'm') now.setMonth(now.getMonth() - count);
    else if (unit === 'y') now.setFullYear(now.getFullYear() - count);

    return now.toISOString();
  }

  const parsed = new Date(since);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return undefined;
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
  ${c.cyan('added')}                    Filter: only added events
  ${c.cyan('updated')}                  Filter: only updated events
  ${c.cyan('removed')}                  Filter: only removed events
  ${c.cyan('changes')}                  Filter changes within a time-window (use with --since)

${c.bold('OPTIONS:')}
  ${c.yellow('--since <ref|window>')}     Time window (7d, 30d...) or git ref for CI (e.g. origin/main)
  ${c.yellow('--fail-on-removal')}        (CI only) Exit non-zero if any dependency was removed
  ${c.yellow('--verbose')}                Expand collapsed bulk updates across manifests
  ${c.yellow('--json')}                   Output raw JSON matching v1 schema contract
  ${c.yellow('--no-cache')}               Force full rescan, ignore cache
  ${c.yellow('--cache-dir <path>')}       Override cache storage location
  ${c.yellow('-v, --version')}            Show version number
  ${c.yellow('-h, --help')}               Show this help message

${c.bold('EXAMPLES:')}
  $ npx dep-blame
  $ npx dep-blame pkg react
  $ npx dep-blame calendar
  $ npx dep-blame stats
  $ npx dep-blame ci --since origin/main --fail-on-removal
  $ npx dep-blame --json
`);
}

async function main() {
  const options = {
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
    json: { type: 'boolean' },
    verbose: { type: 'boolean' },
    since: { type: 'string' },
    'fail-on-removal': { type: 'boolean' },
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
    console.error(c.red(`Error: ${err.message}`));
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

  if (subCommand === 'ci') {
    let repoRoot;
    try {
      repoRoot = await getRepoRoot();
    } catch {
      console.error(c.red('Error: Not a git repository.'));
      process.exit(1);
    }

    const { baseRef, baseSha } = await resolveBaseRef(values.since, repoRoot);

    try {
      const result = await runDepBlame({
        noCache: true, // CI always runs fresh against target ref
        cacheDir: values['cache-dir']
      });

      // Filter events occurring after baseSha
      let ciEvents = result.events;
      if (baseSha) {
        // If git commit was resolved, take all events in current PR / branch
        const baseIndex = result.events.findIndex((e) => e.commit === baseSha.slice(0, 7));
        if (baseIndex !== -1) {
          ciEvents = result.events.slice(baseIndex + 1);
        }
      }

      if (values.json) {
        console.log(
          renderJson({
            repository: result.repository,
            packageManager: result.packageManager,
            command: 'ci',
            events: ciEvents
          })
        );
      } else {
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
      console.error(c.red(err.message || 'An error occurred during CI analysis.'));
      process.exit(1);
    }
  }

  if (subCommand === 'ui') {
    console.log(`
${c.bold('Launch the dep-blame visual dashboard:')}

  ${c.green('$ npx @dep-blame/ui')}

Runs a zero-config local dashboard (100% offline, zero-framework, sub-30KB).
`);
    process.exit(0);
  }

  if (values.since) {
    const sinceDate = parseSinceOption(values.since);
    if (!sinceDate) {
      console.error(c.red(`Invalid --since value: "${values.since}". Use e.g. 7d, 30d, 2w, 6m, 1y or ISO date.`));
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

  try {
    const result = await runDepBlame({
      noCache: values['no-cache'],
      cacheDir: values['cache-dir'],
      filter
    });

    if (values.json) {
      console.log(
        renderJson({
          repository: result.repository,
          packageManager: result.packageManager,
          command: subCommand,
          events: result.events
        })
      );
      return;
    }

    if (subCommand === 'pkg' && targetPkg) {
      console.log(renderArchaeologyView(targetPkg, result.events));
    } else if (subCommand === 'calendar') {
      console.log(renderCalendarView(result.events));
    } else if (subCommand === 'stats') {
      console.log(renderStatsView(result.events));
    } else {
      console.log(renderEventTable(result.events, { verbose: values.verbose }));
    }
  } catch (err) {
    console.error(c.red(err.message || 'An error occurred during dep-blame analysis.'));
    process.exit(1);
  }
}

main();
