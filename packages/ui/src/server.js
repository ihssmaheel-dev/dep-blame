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
 * @param {Object} [options]
 * @param {number} [options.port=4321]
 * @param {string} [options.host='127.0.0.1']
 * @param {string} [options.cwd=process.cwd()]
 * @returns {Promise<{ server: http.Server, url: string, close: () => Promise<void> }>}
 */
export function startServer(options = {}) {
  const { port = 4321, host = '127.0.0.1', cwd = process.cwd() } = options;

  const htmlContent = fs.readFileSync(HTML_PATH, 'utf8');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || host}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
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
          'Access-Control-Allow-Origin': '*'
        });
        res.end(json);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' ? address.port : port;
      const serverUrl = `http://${host}:${actualPort}`;
      resolve({
        server,
        url: serverUrl,
        close: () => new Promise((resClose) => server.close(resClose))
      });
    });
  });
}
