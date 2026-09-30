import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { runDepBlame, getRepoRemoteInfo, detectPackageManager } from 'dep-blame';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HTML_PATH = path.join(__dirname, 'index.html');
const APP_JS_PATH = path.join(__dirname, 'app.js');

function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === '::1' || h === '::ffff:127.0.0.1' || h === 'localhost';
}

/** Hostname portion of a Host/Origin header (no port, no brackets). */
function headerHostname(value) {
  if (!value) return '';
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function gzipIfAccepted(req, body, contentType, extraHeaders = {}) {
  const accept = String(req.headers['accept-encoding'] || '');
  if (/\bgzip\b/.test(accept)) {
    return {
      body: zlib.gzipSync(body),
      headers: {
        'Content-Type': contentType,
        'Content-Encoding': 'gzip',
        Vary: 'Accept-Encoding',
        ...extraHeaders
      }
    };
  }
  return { body, headers: { 'Content-Type': contentType, ...extraHeaders } };
}

// No inline scripts remain (see app.js), so script-src stays 'self'.
// No remote fonts, avatars, or analytics: the dashboard is fully offline.
const CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'none'",
  "object-src 'none'"
].join('; ');

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
 * Derives the author directory from cached dependency events — no
 * `git log --all` scan on the dashboard hot path, no email exposure,
 * and no remote avatar URLs (the UI renders local initials).
 */
function getAuthorMapFromEvents(events, repoOwner, repoHost = 'github.com') {
  const names = new Set();
  for (const e of events || []) {
    if (e && e.author) names.add(e.author);
  }
  const map = {};
  const singleAuthor = names.size === 1 ? Array.from(names)[0] : null;
  for (const name of names) {
    let username = '';
    const clean = name.trim().replace(/^@/, '');
    if (/^[a-zA-Z0-9_\-]+$/.test(clean)) {
      username = clean;
    } else if (singleAuthor && repoOwner) {
      username = repoOwner;
    } else if (repoOwner && names.size > 0) {
      username = clean.toLowerCase().replace(/[^a-z0-9_-]/g, '') || repoOwner;
    } else {
      username = clean.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    }
    const cleanHost = repoHost || 'github.com';
    map[name] = {
      name,
      username: username || 'author',
      profileUrl: username ? `https://${cleanHost}/${encodeURIComponent(username)}` : '#'
    };
  }
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

  const authors = getAuthorMapFromEvents(result.events, remoteInfo.owner, remoteInfo.host);

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
    warnings: result.warnings || [],
    truncated: Boolean(result.truncated),
    headState: result.headState || [],
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
  // Non-loopback binding exposes repository history (and author names)
  // to the network: require explicit opt-in, not just a warning.
  if (!isLoopbackHost(headerHostname(host) || host) && process.env.DEP_BLAME_ALLOW_LAN !== '1') {
    throw new Error(
      `Refusing to bind non-loopback host "${host}" without DEP_BLAME_ALLOW_LAN=1. ` +
        `The dashboard serves repository history with no authentication.`
    );
  }

  let htmlContent;
  try {
    htmlContent = fs.readFileSync(HTML_PATH, 'utf8');
  } catch (err) {
    throw new Error(`UI bundle missing at ${HTML_PATH}: ${err.message}`);
  }
  let appJsContent = '';
  try {
    appJsContent = fs.readFileSync(APP_JS_PATH, 'utf8');
  } catch (err) {
    throw new Error(`UI script missing at ${APP_JS_PATH}: ${err.message}`);
  }
  const htmlBytes = Buffer.byteLength(htmlContent, 'utf8');

  // Single-flight scans: concurrent dashboard loads share one analysis
  // instead of interleaving full-history scans against the cache.
  /** @type {Promise<any> | null} */
  let inflightScan = null;
  function scanOnce(onProgress) {
    if (!inflightScan) {
      inflightScan = loadFullData(cwd, onProgress).finally(() => {
        inflightScan = null;
      });
    }
    return inflightScan;
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url || req.url.length > 2048) {
        res.writeHead(414, { 'Content-Type': 'text/plain' });
        res.end('URI Too Long');
        return;
      }

      // Host validation (DNS-rebinding barrier): browser-facing routes
      // only answer for loopback hosts, the configured host, or an
      // explicitly allowed LAN bind. Spoofed Host headers get a 403.
      const reqHost = headerHostname(req.headers.host);
      const configuredHost = headerHostname(host) || host;
      const lanAllowed = process.env.DEP_BLAME_ALLOW_LAN === '1';
      const hostOk =
        !reqHost ||
        isLoopbackHost(reqHost) ||
        reqHost === String(configuredHost).toLowerCase() ||
        (lanAllowed && !isLoopbackHost(configuredHost));
      if (!hostOk) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      // Origin check for browser requests: a cross-site page must not
      // be able to read the API through the user's browser.
      const origin = req.headers.origin ? headerHostname(req.headers.origin) : '';
      if (origin && origin !== reqHost && !isLoopbackHost(origin)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host || host}`);

      if (url.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const { body, headers } = gzipIfAccepted(req, htmlContent, 'text/html; charset=utf-8', {
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': CSP
        });
        res.writeHead(200, {
          ...headers,
          'Content-Length': Buffer.byteLength(body)
        });
        res.end(body);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/app.js') {
        const { body, headers } = gzipIfAccepted(req, appJsContent, 'application/javascript; charset=utf-8', {
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': CSP
        });
        res.writeHead(200, {
          ...headers,
          'Content-Length': Buffer.byteLength(body)
        });
        res.end(body);
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
          const data = await scanOnce((p) => {
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
          const data = await scanOnce();
          const { body, headers } = gzipIfAccepted(req, JSON.stringify(data), 'application/json; charset=utf-8', {
            'X-Content-Type-Options': 'nosniff'
          });
          res.writeHead(200, {
            ...headers,
            'Content-Length': Buffer.byteLength(body)
          });
          res.end(body);
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
