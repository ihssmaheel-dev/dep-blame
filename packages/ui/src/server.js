import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDepBlame } from 'dep-blame';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HTML_PATH = path.join(__dirname, 'index.html');

/**
 * Creates and starts the local HTTP UI server.
 *
 * Binds loopback by default, validates inputs, caps URL length,
 * and never shells out.
 *
 * @param {Object} [options]
 * @param {number} [options.port=4321]
 * @param {string} [options.host='127.0.0.1']
 * @param {string} [options.cwd=process.cwd()]
 * @returns {Promise<{ server: http.Server, url: string, close: () => Promise<void> }>}
 */
export function startServer(options = {}) {
  const { port = 4321, host = '127.0.0.1', cwd = process.cwd() } = options;

  const safePort = Number(port);
  // 0 = OS-assigned ephemeral port (tests, parallel runs). 1-65535 = fixed.
  if (!Number.isInteger(safePort) || safePort < 0 || safePort > 65535) {
    throw new Error(`Invalid port: ${port}. Expected 0-65535.`);
  }
  if (typeof host !== 'string' || host.length === 0 || host.length > 255 || /[\s;|&$`]/.test(host)) {
    throw new Error(`Invalid host: ${host}`);
  }

  let htmlContent;
  try {
    htmlContent = fs.readFileSync(HTML_PATH, 'utf8');
  } catch (err) {
    throw new Error(`UI bundle missing at ${HTML_PATH}: ${err.message}`);
  }
  const htmlBytes = Buffer.byteLength(htmlContent, 'utf8');

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url || req.url.length > 2048) {
        res.writeHead(414, { 'Content-Type': 'text/plain' });
        res.end('URI Too Long');
        return;
      }
      const url = new URL(req.url, `http://${req.headers.host || host}`);

      if (url.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Content-Length': htmlBytes,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
        });
        res.end(htmlContent);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/events') {
        try {
          const result = await runDepBlame({ cwd, silent: true });
        const json = JSON.stringify({
          schemaVersion: 1,
          repository: result.repository,
          packageManager: result.packageManager,
          generatedAt: new Date().toISOString(),
          events: result.events
        });

        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Content-Type-Options': 'nosniff'
        });
        res.end(json);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
        res.end(JSON.stringify({ error: err && err.message ? err.message : 'Analysis failed' }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' });
    res.end('Not Found');
    } catch {
      try {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request');
      } catch {
        // Socket already closed.
      }
    }
  });
  // Fail fast on slowloris-style connections.
  server.requestTimeout = 15000;
  server.headersTimeout = 16000;

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(safePort, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : safePort;
      const hostForUrl = host === '0.0.0.0' ? '127.0.0.1' : host;
      const serverUrl = `http://${hostForUrl}:${actualPort}`;
      resolve({
        server,
        url: serverUrl,
        close: () => new Promise((resClose) => server.close(() => resClose()))
      });
    });
  });
}
