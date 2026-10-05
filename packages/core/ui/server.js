import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createForgeDirectory, configureRemote } from './forge.js';
import { runDepBlame, getRepoRemoteInfo, detectPackageManager, getCurrentHead, buildDependencyFlow, pageDependencyFlow, flowManifestForEvent } from 'dep-blame';

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
// History and fonts work offline; optional avatars are proxied through this origin.
const CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
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
  const pkgs = Object.create(null);
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
function getAuthorMapFromEvents(events) {
  const names = new Set();
  for (const e of events || []) {
    if (e && e.author) names.add(e.author);
  }
  const map = Object.create(null);
  for (const name of names) map[name] = {name, username: '', profileUrl: null};
  return map;
}

async function loadFullData(cwd, onProgress, forge) {
  const capturedHead = await getCurrentHead(cwd).catch(() => null);
  const remotePromise = getRepoRemoteInfo(cwd).catch(() => ({
    remoteUrl: null,
    owner: null,
    repo: null,
    host: ''
  }));
  const workspacePackages = getWorkspacePackageMap(cwd);

  const [remoteInfo, result] = await Promise.all([
    remotePromise,
    runDepBlame({ cwd, silent: true, onProgress })
  ]);

  const authors = getAuthorMapFromEvents(result.events);
  const finalHead = await getCurrentHead(cwd).catch(() => null);
  if (capturedHead !== finalHead) throw new Error('Repository HEAD changed during analysis. Use Sync to capture a consistent history.');
  const configuredRemote = configureRemote(remoteInfo);
  forge.setRepository(configuredRemote, result.events);

  return {
    schemaVersion: 1,
    generation: String(result.generation || capturedHead || 'empty'),
    historyHead: capturedHead,
    repository: result.repository,
    branch: result.branch || 'main',
    packageManager: result.packageManager,
    remoteUrl: forge.getHosting().url,
    repoOwner: remoteInfo.owner,
    repoHost: configuredRemote.host || '',
    hosting: forge.getHosting(),
    workspacePackages,
    authors,
    warnings: result.warnings || [],
    truncated: Boolean(result.truncated),
    isShallow: Boolean(result.isShallow),
    headState: result.headState || [],
    headStateComplete: result.headStateComplete !== false,
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
export async function startServer(options = {}) {
  const { port = 4321, host = '127.0.0.1', cwd = process.cwd() } = options;

  const safePort = Number(port);
  // 0 = OS-assigned ephemeral port (tests, parallel runs). 1-65535 = fixed.
  if (!Number.isInteger(safePort) || safePort < 0 || safePort > 65535) {
    throw new Error(`Invalid port: ${port}. Expected 0-65535.`);
  }
  if (typeof host !== 'string' || host.length === 0 || host.length > 255 || !/^[a-zA-Z0-9.:\[\]-]+$/.test(host)) {
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
  const flowCssContent = fs.readFileSync(path.join(__dirname, 'flow.css'), 'utf8');

  // Single-flight scans: concurrent dashboard loads share one analysis
  // instead of interleaving full-history scans against the cache.
  /** @type {Promise<any> | null} */
  let inflightScan = null;
  let latestData = null;
  const flowCache = new Map();
  const flowControllers = new Set();
  const forge = createForgeDirectory(cwd);
  let authorQueries = 0;
  const progressListeners = new Set();
  let lastProgress = null;
  function scanOnce() {
    if (!inflightScan) {
      lastProgress = null;
      inflightScan = loadFullData(cwd, p => {
        lastProgress = p;
        for (const listener of progressListeners) listener(p);
      }, forge).then(data => {
        if (latestData?.generation !== data.generation) flowCache.clear();
        latestData = data;
        return data;
      }).finally(() => { inflightScan = null; lastProgress = null; });
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
      const authority = String(req.headers.host || '');
      let requestOrigin;
      try {
        const parsed = new URL('http://' + authority);
        if (!authority || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Invalid Host');
        const actualPort = server.address()?.port;
        if (Number(parsed.port || 80) !== actualPort) throw new Error('Invalid port');
        const reqHost = parsed.hostname;
        const configuredHost = headerHostname(host) || host;
        const wildcard = host === '0.0.0.0' || host === '::';
        const localAddress = String(req.socket.localAddress || '').replace(/^::ffff:/, '');
        const hostOk = isLoopbackHost(reqHost) || reqHost === configuredHost ||
          (wildcard && reqHost.replace(/^\[|\]$/g, '') === localAddress);
        if (!hostOk) throw new Error('Invalid Host');
        requestOrigin = parsed.origin;
        if (req.headers.origin && req.headers.origin !== requestOrigin) throw new Error('Invalid Origin');
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new Error('Cross-site request');
      } catch {
        res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('Forbidden');
        return;
      }
      const url = new URL(req.url, requestOrigin);
      if (req.method === 'GET' && url.pathname === '/flow.css') {
        const { body, headers } = gzipIfAccepted(req, flowCssContent, 'text/css; charset=utf-8',
          { 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        res.writeHead(200, { ...headers, 'Content-Length': Buffer.byteLength(body) }); res.end(body); return;
      }

      if (req.method === 'GET' && url.pathname === '/api/dependency-flow') {
        const reply = (status, payload) => {
          const { body, headers } = gzipIfAccepted(req, JSON.stringify(payload), 'application/json; charset=utf-8',
            { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          res.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(body) }); res.end(body);
        };
        const q = url.searchParams, packageName = q.get('package'), manifest = q.get('manifest');
        const offset = q.get('offset') || '0', limit = q.get('limit') || '50';
        if (!packageName || packageName.length > 512 || !manifest || manifest.length > 1024 ||
          !/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset)) || !/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) {
          reply(400, { error: 'Provide a package, exact manifest, nonnegative offset and limit from 1 to 100.' }); return;
        }
        try {
          const data = inflightScan ? await inflightScan : latestData || await scanOnce();
          if (q.get('generation') && q.get('generation') !== data.generation) {
            reply(409, { error: 'History changed. Use Sync before opening this flow again.' }); return;
          }
          const events = data.events.filter(e => e.package === packageName && flowManifestForEvent(e) === manifest);
          const manifests = [...new Set(data.events.filter(e => e.package === packageName).map(flowManifestForEvent))].sort();
          if (!events.length || !data.historyHead) { reply(404, { error: 'No recorded dependency history for this manifest.' }); return; }
          const key = JSON.stringify([data.generation, packageName, manifest]);
          let entry = flowCache.get(key);
          if (!entry) {
            if (flowControllers.size >= 2) { reply(429, { error: 'Other dependency flows are being prepared. Try again shortly.' }); return; }
            const controller = new AbortController(); flowControllers.add(controller);
            entry = { nodes: 0, promise: buildDependencyFlow(cwd, events, { package: packageName, manifest,
              head: data.historyHead, headState: data.headState, headStateComplete: data.headStateComplete,
              truncated: data.truncated || data.isShallow, signal: controller.signal }).then(flow => {
                entry.nodes = flow.nodes.length;
                // Retain at most four packages / 10,000 nodes; oversize flows
                // are served without keeping another permanent history copy.
                let total = [...flowCache.values()].reduce((n, e) => n + e.nodes, 0);
                for (const [oldKey, old] of flowCache) {
                  if (flowCache.size <= 4 && total <= 10000) break;
                  if (oldKey === key && entry.nodes <= 10000) continue;
                  flowCache.delete(oldKey); total -= old.nodes;
                }
                return flow;
              }).catch(err => { if (flowCache.get(key) === entry) flowCache.delete(key); throw err; })
              .finally(() => flowControllers.delete(controller)) };
          }
          flowCache.delete(key); flowCache.set(key, entry);
          const flow = await entry.promise;
          if (latestData?.generation !== data.generation) { reply(409, { error: 'History changed. Use Sync before opening this flow again.' }); return; }
          if (res.destroyed) return;
          reply(200, { schemaVersion: 1, generation: data.generation, manifests,
            ...pageDependencyFlow(flow, Number(offset), Number(limit)) });
        } catch (err) { if (!res.destroyed) reply(500, { error: err?.message || 'Could not prepare dependency flow.' }); }
        return;
      }

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

      // Bundled brand mark (same-origin, immutable). Static artwork with no
      // scripts — safe to serve as an image under the existing img-src policy.
      if (req.method === 'GET' && url.pathname === '/logo.svg') {
        let logoBytes;
        try {
          logoBytes = fs.readFileSync(path.join(__dirname, 'logo.svg'));
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }
        if (logoBytes.includes('<script')) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Invalid asset');
          return;
        }
        const { body, headers } = gzipIfAccepted(req, logoBytes, 'image/svg+xml', {
          'Cache-Control': 'public, max-age=31536000, immutable',
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

      // Bundled Manrope variable font (same-origin, immutable). woff2 is
      // already compressed; served as-is with a year-long cache.
      if (req.method === 'GET' && url.pathname.startsWith('/fonts/')) {
        const name = url.pathname.slice('/fonts/'.length);
        if (!/^[a-z0-9-]+\.woff2$/i.test(name)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }
        const fontPath = path.join(__dirname, 'fonts', name);
        let fontBytes;
        try {
          fontBytes = fs.readFileSync(fontPath);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'font/woff2',
          'Content-Length': fontBytes.length,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': CSP
        });
        res.end(fontBytes);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/authors') {
        if (authorQueries >= 6) {
          res.writeHead(429, {'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '2'});
          res.end(JSON.stringify({error: 'Author lookup busy'})); return;
        }
        authorQueries++;
        try {
          const commits = (url.searchParams.get('commits') || '').split(',').filter(Boolean);
          const data = await forge.resolve(commits);
          res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
          res.end(JSON.stringify(data));
        } catch {
          res.writeHead(400, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
          res.end(JSON.stringify({error: 'Invalid author lookup'}));
        } finally { authorQueries--; }
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/avatars/')) {
        const key = url.pathname.slice('/api/avatars/'.length);
        const avatar = /^[a-f0-9]{64}$/.test(key) ? forge.getAvatar(key) : null;
        if (!avatar) { res.writeHead(404, {'Cache-Control': 'no-store'}); res.end(); return; }
        res.writeHead(200, {'Content-Type': avatar.type, 'Content-Length': avatar.bytes.length,
          'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP});
        res.end(avatar.bytes);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/events/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          'X-Content-Type-Options': 'nosniff'
        });

        res.write(': connected\n\n');
        // Immediate stage event so the UI leaves "Connecting" before
        // the scan produces its first real progress update.
        res.write(
          `event: progress\ndata: ${JSON.stringify({ phase: 'initializing', current: 0, total: 100, message: 'Starting scan…' })}\n\n`
        );

        const sendProgress = p => {
          if (!res.destroyed && !res.writableEnded) res.write(`event: progress\ndata: ${JSON.stringify(p)}\n\n`);
        };
        progressListeners.add(sendProgress);
        res.on('close', () => progressListeners.delete(sendProgress));
        if (lastProgress) sendProgress(lastProgress);
        try {
          const data = await scanOnce();
          if (res.destroyed) return;

          res.write(`event: complete\ndata: ${JSON.stringify(data)}\n\n`);
          res.end();
        } catch (err) {
          if (res.destroyed) return;
          res.write(`event: error\ndata: ${JSON.stringify({ error: err && err.message ? err.message : 'Analysis failed' })}\n\n`);
          res.end();
        } finally { progressListeners.delete(sendProgress); }
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/events') {
        try {
          const data = await scanOnce();
          const { body, headers } = gzipIfAccepted(req, JSON.stringify(data), 'application/json; charset=utf-8', {
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store'
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

      // Bounded queries: paged events, month aggregates, and facets.
      // Same filter contract as the engine, served from the single-flight
      // scan without re-walking history per request.
      if (req.method === 'GET' && (url.pathname === '/api/events/paged' || url.pathname === '/api/months' || url.pathname === '/api/facets')) {
        try {
          const data = await scanOnce();
          const q = url.searchParams;
          const f = {
            package: q.get('package') || undefined,
            type: q.get('type') || undefined,
            manifest: q.get('manifest') || undefined,
            workspace: q.get('workspace') || undefined,
            source: q.get('source') || undefined,
          };
          let list = data.events || [];
          if (f.package) list = list.filter((e) => e.package === f.package);
          if (f.type) list = list.filter((e) => e.type === f.type);
          if (f.manifest) list = list.filter((e) => e.manifest === f.manifest);
          if (f.workspace) list = list.filter((e) => String(e.manifest || '').split('/').includes(String(f.workspace)));
          if (f.source) list = list.filter((e) => (e.source || 'manifest') === f.source);
          if (url.pathname === '/api/events/paged') {
            const limit = Math.max(1, Math.min(1000, Number.parseInt(q.get('limit') || '100', 10) || 100));
            const offset = Math.max(0, Number.parseInt(q.get('offset') || '0', 10) || 0);
            const payload = JSON.stringify({ schemaVersion: 1, total: list.length, limit, offset, events: list.slice(offset, offset + limit) });
            const { body, headers } = gzipIfAccepted(req, payload, 'application/json; charset=utf-8', { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
            res.writeHead(200, { ...headers, 'Content-Length': Buffer.byteLength(body) });
            res.end(body);
            return;
          }
          if (url.pathname === '/api/months') {
            const buckets = new Map();
            for (const ev of list) {
              const d = new Date(ev.date);
              if (isNaN(d.getTime())) continue;
              const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
              let b = buckets.get(key);
              if (!b) { b = { month: key, total: 0, added: 0, updated: 0, removed: 0 }; buckets.set(key, b); }
              b.total++;
              if (ev.type === 'added') b.added++;
              else if (ev.type === 'updated') b.updated++;
              else if (ev.type === 'removed') b.removed++;
            }
            const payload = JSON.stringify({ schemaVersion: 1, months: [...buckets.values()].sort((a, b) => a.month < b.month ? -1 : 1) });
            const { body, headers } = gzipIfAccepted(req, payload, 'application/json; charset=utf-8', { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
            res.writeHead(200, { ...headers, 'Content-Length': Buffer.byteLength(body) });
            res.end(body);
            return;
          }
          // /api/facets
          const countBy = (fn) => {
            const m = new Map();
            for (const ev of list) { const k = fn(ev); if (k) m.set(k, (m.get(k) || 0) + 1); }
            return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count).slice(0, 200);
          };
          const payload = JSON.stringify({
            schemaVersion: 1,
            packages: countBy((e) => e.package),
            authors: countBy((e) => e.author),
            manifests: countBy((e) => e.manifest),
          });
          const { body, headers } = gzipIfAccepted(req, payload, 'application/json; charset=utf-8', { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
          res.writeHead(200, { ...headers, 'Content-Length': Buffer.byteLength(body) });
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
  server.on('close', () => { for (const controller of flowControllers) controller.abort(); flowCache.clear(); latestData = null; });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(safePort, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : safePort;
      const hostForUrl = host === '0.0.0.0' ? '127.0.0.1' : host;
      const serverUrl = `http://${hostForUrl.includes(':') ? '[' + hostForUrl + ']' : hostForUrl}:${actualPort}`;
      resolve({
        server,
        url: serverUrl,
        close: () => new Promise((resClose) => server.close(() => resClose()))
      });
    });
  });
}
