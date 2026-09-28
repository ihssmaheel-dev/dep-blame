import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runDepBlame, getRepoRemoteInfo, detectPackageManager } from 'dep-blame';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HTML_PATH = path.join(__dirname, 'index.html');

/**
 * Discovers internal workspace/repo packages from all workspace manifests.
 * Returns an object mapping package name -> relative directory (e.g. { "dep-blame": "packages/core" }).
 *
 * @param {string} repoDir
 * @returns {Record<string, string>}
 */
function getWorkspacePackageMap(repoDir) {
  const pkgs = {};
  try {
    const pmInfo = detectPackageManager(repoDir);
    for (const mPath of pmInfo.manifestPaths || []) {
      if (mPath.endsWith('package.json')) {
        const full = path.join(repoDir, mPath);
        if (fs.existsSync(full)) {
          try {
            const content = JSON.parse(fs.readFileSync(full, 'utf8'));
            if (content.name) {
              const dir = path.dirname(mPath).replace(/\\/g, '/');
              pkgs[content.name] = dir === '.' ? '' : dir;
            }
          } catch {}
        }
      }
    }
  } catch {}
  return pkgs;
}

/**
 * Maps author names to detailed author info including username, email, avatar URL, and profile URL.
 *
 * @param {string} repoDir
 * @param {string|null} repoOwner
 * @param {string} repoHost
 * @returns {Promise<Record<string, { name: string; username: string; email: string; avatarUrl: string; profileUrl: string }>>}
 */
async function getAuthorMap(repoDir, repoOwner, repoHost = 'github.com') {
  const map = {};
  try {
    const { stdout } = await execFileAsync('git', ['log', '--format=%an%x1f%ae', '--all'], {
      cwd: repoDir,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    });

    const lines = stdout.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const [name, email] = line.split('\x1f').map(s => (s || '').trim());
      if (!name || map[name]) continue;

      let username = '';

      // 1. GitHub noreply email (e.g. 12345+username@users.noreply.github.com)
      const ghMatch = email.match(/(?:^|\+)([^@+]+)@users\.noreply\.github\.com$/i);
      if (ghMatch) {
        username = ghMatch[1];
      }

      // 2. Author name is already a single-word handle
      if (!username && /^[a-zA-Z0-9_\-]+$/.test(name)) {
        username = name;
      }

      // 3. Fallback from email local-part
      if (!username && email) {
        const localPart = email.split('@')[0];
        if (localPart && localPart !== 'undefined') {
          username = localPart;
        }
      }

      map[name] = {
        name,
        email,
        username: username || repoOwner || name.toLowerCase().replace(/[^a-z0-9_-]/g, ''),
        avatarUrl: '',
        profileUrl: ''
      };
    }

    const authors = Object.keys(map);
    // If only 1 author in repository and repoOwner is set, map to repoOwner
    if (authors.length === 1 && repoOwner) {
      map[authors[0]].username = repoOwner;
    }

    const cleanHost = repoHost || 'github.com';
    for (const name of authors) {
      const a = map[name];
      if (cleanHost.includes('github') && a.username) {
        a.avatarUrl = `https://${cleanHost}/${encodeURIComponent(a.username)}.png?size=64`;
        a.profileUrl = `https://${cleanHost}/${encodeURIComponent(a.username)}`;
      } else if (cleanHost.includes('gitlab') && a.username) {
        a.avatarUrl = `https://${cleanHost}/${encodeURIComponent(a.username)}.png`;
        a.profileUrl = `https://${cleanHost}/${encodeURIComponent(a.username)}`;
      } else if (a.username) {
        a.avatarUrl = `https://github.com/${encodeURIComponent(a.username)}.png?size=64`;
        a.profileUrl = `https://${cleanHost}/${encodeURIComponent(a.username)}`;
      } else {
        a.profileUrl = repoOwner ? `https://${cleanHost}/${encodeURIComponent(repoOwner)}` : '#';
      }
    }
  } catch {}

  return map;
}

async function loadFullData(cwd, onProgress) {
  const remotePromise = getRepoRemoteInfo(cwd).catch(() => ({
    remoteUrl: null,
    owner: null,
    repo: null,
    host: 'github.com'
  }));
  const workspacePackages = getWorkspacePackageMap(cwd);

  const [remoteInfo, result] = await Promise.all([
    remotePromise,
    runDepBlame({ cwd, silent: true, onProgress })
  ]);

  const authors = await getAuthorMap(cwd, remoteInfo.owner, remoteInfo.host);

  return {
    schemaVersion: 1,
    repository: result.repository,
    branch: result.branch || 'main',
    packageManager: result.packageManager,
    remoteUrl: remoteInfo.remoteUrl,
    repoOwner: remoteInfo.owner,
    repoHost: remoteInfo.host || 'github.com',
    workspacePackages,
    authors,
    generatedAt: new Date().toISOString(),
    events: result.events
  };
}

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
          'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data: https:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; script-src 'unsafe-inline'"
        });
        res.end(htmlContent);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/events/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          'X-Content-Type-Options': 'nosniff'
        });

        res.write(': connected\n\n');

        try {
          const data = await loadFullData(cwd, (p) => {
            res.write(`event: progress\ndata: ${JSON.stringify(p)}\n\n`);
          });

          res.write(`event: complete\ndata: ${JSON.stringify(data)}\n\n`);
          res.end();
        } catch (err) {
          res.write(`event: error\ndata: ${JSON.stringify({ error: err && err.message ? err.message : 'Analysis failed' })}\n\n`);
          res.end();
        }
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/events') {
        try {
          const data = await loadFullData(cwd);
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Content-Type-Options': 'nosniff'
          });
          res.end(JSON.stringify(data));
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
