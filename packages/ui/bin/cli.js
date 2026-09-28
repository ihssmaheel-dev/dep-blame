#!/usr/bin/env node

process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) return;
  console.warn(warning);
});

import { parseArgs } from 'node:util';
import { exec } from 'node:child_process';
import { startServer } from '../src/server.js';

const options = {
  port: { type: 'string', short: 'p' },
  host: { type: 'string' },
  'no-open': { type: 'boolean' }
};

let values;
try {
  values = parseArgs({ options, allowPositionals: true }).values;
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

const port = values.port ? parseInt(values.port, 10) : 4321;
const host = values.host || '127.0.0.1';

async function main() {
  try {
    const { url } = await startServer({ port, host, cwd: process.cwd() });
    console.log(`\n  \x1b[1m\x1b[36mdep-blame UI\x1b[0m is running at: \x1b[1m\x1b[32m${url}\x1b[0m\n`);
    console.log(`  Press Ctrl+C to stop the server.\n`);

    if (!values['no-open']) {
      // Cross-platform open browser
      const startCmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      exec(`${startCmd} ${url}`, { windowsHide: true }, () => {});
    }
  } catch (err) {
    console.error(`Failed to start UI server: ${err.message}`);
    process.exit(1);
  }
}

main();
