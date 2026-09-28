#!/usr/bin/env node

process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) return;
  console.warn(warning);
});

import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
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

const portRaw = values.port ? String(values.port).trim() : '4321';
const port = parseInt(portRaw, 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`Error: invalid --port "${values.port}". Expected 0-65535.`);
  process.exit(1);
}
const host = values.host || '127.0.0.1';
if (typeof host !== 'string' || /[\s;|&$`'"\\]/.test(host) || host.length > 255) {
  console.error(`Error: invalid --host "${values.host}".`);
  process.exit(1);
}
if (host === '0.0.0.0' || host === '::') {
  console.warn('Warning: binding to all interfaces. Prefer 127.0.0.1 unless you need LAN access.');
}

function openBrowser(url) {
  // No shell interpolation: argv only, so --host can't inject commands.
  try {
    if (process.platform === 'win32') {
      execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
    } else if (process.platform === 'darwin') {
      execFile('open', [url], { windowsHide: true }, () => {});
    } else {
      execFile('xdg-open', [url], { windowsHide: true }, () => {});
    }
  } catch {
    // Browser launch is best-effort.
  }
}

async function main() {
  try {
    const { url } = await startServer({ port, host, cwd: process.cwd() });
    console.log(`\n  \x1b[1m\x1b[36mdep-blame UI\x1b[0m is running at: \x1b[1m\x1b[32m${url}\x1b[0m\n`);
    console.log(`  Press Ctrl+C to stop the server.\n`);

    if (!values['no-open']) {
      openBrowser(url);
    }
  } catch (err) {
    console.error(`Failed to start UI server: ${err.message}`);
    process.exit(1);
  }
}

main();
