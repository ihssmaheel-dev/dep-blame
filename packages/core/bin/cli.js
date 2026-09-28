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
import { renderEventTable } from '../src/render/table.js';
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
  ${c.cyan('pkg <package>')}            Full history of one package
  ${c.cyan('added')}                    Filter: only added events
  ${c.cyan('updated')}                  Filter: only updated events
  ${c.cyan('removed')}                  Filter: only removed events

${c.bold('OPTIONS:')}
  ${c.yellow('--since <window>')}         Time window (e.g. 7d, 30d, 2w, 6m, 1y, or ISO date)
  ${c.yellow('--verbose')}                Expand collapsed bulk updates across manifests
  ${c.yellow('--json')}                   Output raw JSON matching v1 schema contract
  ${c.yellow('--no-cache')}               Force full rescan, ignore cache
  ${c.yellow('--cache-dir <path>')}       Override cache storage location
  ${c.yellow('-v, --version')}            Show version number
  ${c.yellow('-h, --help')}               Show this help message

${c.bold('EXAMPLES:')}
  $ npx dep-blame
  $ npx dep-blame list --since 30d
  $ npx dep-blame pkg react
  $ npx dep-blame --verbose
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

  if (values.since) {
    const sinceDate = parseSinceOption(values.since);
    if (!sinceDate) {
      console.error(c.red(`Invalid --since value: "${values.since}". Use e.g. 7d, 30d, 2w, 6m, 1y or ISO date.`));
      process.exit(1);
    }
    filter.since = sinceDate;
  }

  if (subCommand === 'added' || subCommand === 'updated' || subCommand === 'removed') {
    filter.type = subCommand;
  } else if (subCommand === 'pkg') {
    const pkgName = positionals[1];
    if (!pkgName) {
      console.error(c.red(`Error: Missing package name for 'pkg' command.`));
      console.error(`Usage: dep-blame pkg <package-name>`);
      process.exit(1);
    }
    filter.package = pkgName;
  } else if (subCommand !== 'list') {
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
    } else {
      console.log(renderEventTable(result.events, { verbose: values.verbose }));
    }
  } catch (err) {
    console.error(c.red(err.message || 'An error occurred during dep-blame analysis.'));
    process.exit(1);
  }
}

main();
