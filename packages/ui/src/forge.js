import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const LABELS = {github: 'GitHub', gitlab: 'GitLab', gitea: 'Gitea', forgejo: 'Forgejo', bitbucket: 'Bitbucket', 'bitbucket-server': 'Bitbucket Server', unknown: 'Git host', local: 'Local Git'};
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

// Reject non-public destinations before connecting, then pin the checked IP.
// Private connections require an explicit opt-in and the configured forge origin.
export function isPublicAddress(address) {
  let ip = address.toLowerCase();
  if (net.isIP(ip) === 4) {
    const [a,b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
  }
  if (net.isIP(ip) !== 6) return false;
  ip = new URL(`http://[${ip}]/`).hostname.slice(1,-1);
  const second = parseInt(ip.split(':')[1] || '0',16);
  // Only globally routable unicast IPv6; reject special-use and transition ranges.
  return /^[23]/.test(ip) && !ip.startsWith('2001:db8:') && !ip.startsWith('3fff:') &&
    !(ip.startsWith('2001:') && second < 0x200) && !ip.startsWith('2002:');
}

export function configureRemote(remote, env = process.env) {
  if (!env.DEP_BLAME_FORGE_WEB_URL && !env.DEP_BLAME_FORGE_BASE_URL) return remote;
  const web = new URL(env.DEP_BLAME_FORGE_WEB_URL || remote.remoteUrl);
  if (!['https:','http:'].includes(web.protocol) || web.username || web.password || web.search || web.hash) throw new Error('Invalid DEP_BLAME_FORGE_WEB_URL');
  const base = new URL(env.DEP_BLAME_FORGE_BASE_URL || web.origin);
  if (base.origin !== web.origin || base.username || base.password || base.search || base.hash) throw new Error('Forge base must share the repository web origin');
  const prefix = base.pathname.replace(/\/+$/, '');
  if (!web.pathname.startsWith(prefix + '/')) throw new Error('Repository URL must be below the forge base');
  return {...remote, remoteUrl:web.href.replace(/\/+$/, ''), host:web.host,
    repoPath:web.pathname.slice(prefix.length + 1).split('/').map(decodeURIComponent).join('/'), baseUrl:base.href.replace(/\/+$/, '')};
}

export async function requestBytes(rawUrl, {method = 'GET', body, token, privateOrigin, maxBytes = 1024 * 1024, redirects = 0} = {}) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsafe forge URL');
  if (token && url.protocol !== 'https:') throw new Error('Forge tokens require HTTPS');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(hostname) ? [{address: hostname, family: net.isIP(hostname)}] :
    await Promise.race([dns.lookup(hostname, {all: true}), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Forge DNS timeout')), 4000); timer.unref(); })]);
  const allowPrivate = privateOrigin === url.origin;
  if (!addresses.length || (!allowPrivate && addresses.some(a => !isPublicAddress(a.address)))) throw new Error('Private forge requires DEP_BLAME_ALLOW_PRIVATE_FORGE=1');
  const selected = addresses[0];
  const result = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(value); };
    const headers = {'User-Agent': 'dep-blame-ui/0.1', Accept: 'application/json'};
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
    if (token) headers.Authorization = `Bearer ${token}`;
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {method, headers, agent: false,
      lookup: (_host, options, callback) => options.all ? callback(null, [selected]) : callback(null, selected.address, selected.family)
    }, res => {
      if (Number(res.headers['content-length'] || 0) > maxBytes) { res.destroy(); finish(new Error('Forge response too large')); return; }
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > maxBytes) { res.destroy(); finish(new Error('Forge response too large')); } else chunks.push(chunk); });
      res.on('end', () => finish(null, {status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks, size)}));
      res.on('error', err => finish(err));
      res.on('aborted', () => finish(new Error('Incomplete forge response')));
    });
    const timer = setTimeout(() => { req.destroy(); finish(new Error('Forge timeout')); }, 5000);
    req.on('error', err => finish(err));
    req.end(body);
  });
  if ([301,302,303,307,308].includes(result.status) && result.headers.location) {
    if (redirects >= 2 || method !== 'GET') throw new Error('Forge redirect rejected');
    const next = new URL(result.headers.location, url);
    // Revalidate every hop. Never forward a token to another origin.
    return requestBytes(next, {method, token: next.origin === url.origin ? token : undefined, privateOrigin, maxBytes, redirects: redirects + 1});
  }
  return result;
}

export function hostingInfo(remote, providerOverride = '') {
  if (!remote?.remoteUrl) return {provider: 'local', label: 'Local Git', host: '', url: null};
  const url = new URL(remote.remoteUrl);
  const publicHosts = {'github.com': 'github', 'gitlab.com': 'gitlab', 'bitbucket.org': 'bitbucket', 'codeberg.org': 'forgejo', 'gitea.com': 'gitea'};
  const provider = Object.hasOwn(LABELS, providerOverride) && !['local','unknown'].includes(providerOverride) ? providerOverride : publicHosts[url.hostname] || 'unknown';
  if (provider === 'bitbucket-server') url.pathname = url.pathname.replace(/^\/scm\/([^/]+)\/([^/]+)$/i, '/projects/$1/repos/$2');
  return {provider, label: LABELS[provider], host: url.host, url: url.href.replace(/\/$/, '')};
}

function safeProfile(value, origin) {
  try { const u = new URL(value, origin); return u.origin === origin && !u.username && !u.password ? u.href : null; } catch { return null; }
}
function rasterType(bytes) {
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0,4).toString('ascii') === 'RIFF' && bytes.subarray(8,12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/** A per-server, bounded, lazy account directory. Git emails stay server-side. */
export function createForgeDirectory(cwd, options = {}) {
  const env = options.env || process.env;
  const offline = env.DEP_BLAME_AVATARS === '0';
  const transport = options.request || requestBytes;
  let remote = null, hosting = hostingInfo(null), detection = null, allowed = new Set(), generation = '';
  let pending = 0, imageBytes = 0, pausedUntil = 0;
  const identities = new Map(), avatars = new Map(), inflight = new Map();
  const waiting = [];
  const getHosting = () => ({...hosting, avatarsEnabled: !offline});
  const limited = async work => {
    if (pending >= 3) await new Promise(resolve => waiting.push(resolve));
    else pending++;
    try { return await work(); } finally { if (waiting.length) waiting.shift()(); else pending--; }
  };
  const touch = (map, key, value, max) => { map.delete(key); map.set(key, value); while (map.size > max) map.delete(map.keys().next().value); };
  function setRepository(info, events) {
    const next = info?.remoteUrl || '';
    if (next !== generation) { identities.clear(); avatars.clear(); inflight.clear(); imageBytes = 0; pausedUntil = 0; detection = null; }
    if (next !== generation || !remote) hosting = hostingInfo(info, env.DEP_BLAME_FORGE_PROVIDER);
    generation = next; remote = info;
    allowed = new Set(events.map(e => e.commitFull).filter(sha => SHA.test(sha || '')));
  }
  const privateOrigin = () => env.DEP_BLAME_ALLOW_PRIVATE_FORGE === '1' && remote?.remoteUrl ? new URL(remote.remoteUrl).origin : undefined;
  const baseUrl = () => remote.baseUrl || new URL(remote.remoteUrl).origin;
  async function json(url, body, useToken = true) {
    const result = await transport(url, {method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
      token: useToken ? env.DEP_BLAME_FORGE_TOKEN : undefined, privateOrigin: privateOrigin()});
    if (result.status === 429 || result.status === 403) {
      const reset = Number(result.headers['x-ratelimit-reset']) * 1000;
      pausedUntil = Math.max(Date.now() + 60000, Math.min(reset || Date.now() + 60000, Date.now() + 3600000));
    }
    if (result.status !== 200) throw new Error('Forge account unavailable');
    return JSON.parse(result.bytes.toString('utf8'));
  }
  async function detect(sha) {
    if (hosting.provider !== 'unknown' || offline) return;
    if (!detection) detection = (async () => {
      const origin = baseUrl();
      try {
        const version = await json(origin + '/api/v1/version', undefined, false);
        if (typeof version.version === 'string') {
          let provider = 'gitea';
          try { const forgejo = await json(origin + '/api/forgejo/v1/version', undefined, false); if (typeof forgejo.version === 'string') provider = 'forgejo'; } catch {}
          hosting = hostingInfo(remote, provider); return;
        }
      } catch {}
      try {
        const value = await gitlab(sha, false);
        if (value.data && Object.hasOwn(value.data, 'project') && !value.errors) { hosting = hostingInfo(remote, 'gitlab'); return; }
      } catch {}
      try {
        const meta = await json(origin + '/api/v3/meta', undefined, false);
        if (typeof meta.installed_version === 'string') { hosting = hostingInfo(remote, 'github'); return; }
      } catch {}
      try {
        const meta = await json(origin + '/rest/api/latest/application-properties', undefined, false);
        if (typeof meta.version === 'string' && meta.buildNumber != null) hosting = hostingInfo(remote, 'bitbucket-server');
      } catch {}
    })();
    await detection;
  }
  const projectPath = () => remote.repoPath || new URL(remote.remoteUrl).pathname.slice(1).split('/').map(decodeURIComponent).join('/');
  function gitlab(sha, useToken = true) {
    return json(baseUrl() + '/api/graphql', {query: 'query($path: ID!, $ref: String!) { project(fullPath: $path) { repository { commit(ref: $ref) { author { username avatarUrl webUrl } } } } }', variables: {path: projectPath(), ref: sha}}, useToken);
  }
  async function account(sha) {
    const origin = new URL(remote.remoteUrl).origin, parts = projectPath().split('/').map(encodeURIComponent).join('/');
    let user;
    if (hosting.provider === 'gitlab') {
      const value = await gitlab(sha); user = value.data?.project?.repository?.commit?.author;
      return user ? {username: user.username, profileUrl: safeProfile(user.webUrl, origin), avatar: user.avatarUrl} : null;
    }
    if (['github','gitea','forgejo'].includes(hosting.provider)) {
      const base = hosting.provider === 'github' ? (new URL(origin).hostname === 'github.com' ? 'https://api.github.com' : baseUrl() + '/api/v3') : baseUrl() + '/api/v1';
      const value = await json(`${base}/repos/${parts}/commits/${sha}`); user = value.author;
      if (!user?.login || user.id == null) return null;
      return {username: user.login, profileUrl: safeProfile(user.html_url || origin + '/' + encodeURIComponent(user.login), origin), avatar: user.avatar_url};
    }
    if (hosting.provider === 'bitbucket') {
      const value = await json(`https://api.bitbucket.org/2.0/repositories/${parts}/commit/${sha}`); user = value.author?.user;
      return user?.account_id ? {username: user.nickname || user.display_name, profileUrl: safeProfile(user.links?.html?.href, origin), avatar: user.links?.avatar?.href} : null;
    }
    if (hosting.provider === 'bitbucket-server') {
      const match = projectPath().match(/^(?:scm\/)?([^/]+)\/([^/]+)$/);
      if (!match) return null;
      const value = await json(`${baseUrl()}/rest/api/latest/projects/${encodeURIComponent(match[1])}/repos/${encodeURIComponent(match[2])}/commits/${sha}`);
      user = value.author;
      // Git-only Person objects have no ID/slug and must remain unmatched.
      return user?.id != null && user.slug ? {username: user.name || user.slug, profileUrl: origin + '/users/' + encodeURIComponent(user.slug), avatar: origin + '/users/' + encodeURIComponent(user.slug) + '/avatar.png?size=64'} : null;
    }
    return null;
  }
  async function storeAvatar(raw, scope) {
    if (!raw) return null;
    const url = new URL(raw, remote.remoteUrl), origin = new URL(remote.remoteUrl).origin;
    const publicCdn = ['avatars.githubusercontent.com', 'secure.gravatar.com', 'www.gravatar.com', 'gravatar.com', 'avatar-management--avatars.us-west-2.prod.public.atl-paas.net'];
    if (url.origin !== origin && !(url.protocol === 'https:' && publicCdn.includes(url.hostname))) return null;
    const key = crypto.createHash('sha256').update(scope + url.href).digest('hex');
    if (avatars.has(key)) {
      if (avatars.get(key).until > Date.now()) return '/api/avatars/' + key;
      imageBytes -= avatars.get(key).bytes.length; avatars.delete(key);
    }
    const result = await transport(url.href, {privateOrigin: privateOrigin(), maxBytes: 512 * 1024,
      token: url.origin === origin ? env.DEP_BLAME_FORGE_TOKEN : undefined});
    const type = rasterType(result.bytes);
    if (result.status !== 200 || !type || scope !== generation) return null;
    while (avatars.size >= 128 || imageBytes + result.bytes.length > 16 * 1024 * 1024) {
      const old = avatars.keys().next().value; imageBytes -= avatars.get(old).bytes.length; avatars.delete(old);
    }
    avatars.set(key, {bytes: result.bytes, type, until: Date.now() + 3600000}); imageBytes += result.bytes.length;
    return '/api/avatars/' + key;
  }
  async function resolveIdentity(key, shas, scope) {
    const cached = identities.get(key);
    if (cached && cached.until > Date.now() && (!cached.profile?.avatarUrl || avatars.has(cached.profile.avatarUrl.split('/').pop()))) { touch(identities, key, cached, 512); return cached.profile; }
    if (inflight.has(key)) return inflight.get(key);
    const promise = limited(async () => {
      let profile = null;
      for (const sha of shas.slice(0,3)) {
        if (Date.now() < pausedUntil || scope !== generation) break;
        try { profile = await account(sha); if (profile) break; } catch {}
      }
      if (profile) {
        try { profile.avatarUrl = await storeAvatar(profile.avatar, scope); } catch { profile.avatarUrl = null; }
        delete profile.avatar;
      }
      if (scope === generation) touch(identities, key, {profile, until: Date.now() + (profile ? 3600000 : 300000)}, 512);
      return profile;
    }).finally(() => inflight.delete(key));
    inflight.set(key, promise); return promise;
  }
  async function resolve(commits) {
    if (!Array.isArray(commits) || commits.length > 20 || commits.some(sha => !SHA.test(sha) || !allowed.has(sha))) throw new Error('Invalid history commits');
    const profiles = Object.create(null), unique = [...new Set(commits)];
    if (offline || !remote?.remoteUrl || !unique.length) return {hosting: getHosting(), profiles};
    // Concurrent browser requests join cached work, with a bounded queue.
    if (waiting.length > 100) return {hosting: getHosting(), profiles};
    await detect(unique[0]);
    if (hosting.provider === 'unknown') return {hosting: getHosting(), profiles};
    const scope = generation;
    const {stdout} = await execFileAsync('git', ['log','--no-walk','-z','--format=%H%x00%an%x00%ae', ...unique, '--'], {cwd, windowsHide: true, maxBuffer: 1024 * 1024, timeout: 5000});
    const fields = stdout.split('\0'), groups = new Map();
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const sha = fields[i]; if (!SHA.test(sha) || !allowed.has(sha)) continue;
      const key = fields[i+1] + '\0' + fields[i+2];
      if (!groups.has(key)) groups.set(key, []); groups.get(key).push(sha);
    }
    await Promise.all([...groups].map(async ([key, shas]) => { const profile = await resolveIdentity(key, shas, scope); for (const sha of shas) profiles[sha] = profile; }));
    return {hosting: getHosting(), profiles};
  }
  return {setRepository, resolve, getHosting, getAvatar: key => {
    const value = avatars.get(key);
    if (value && value.until < Date.now()) { imageBytes -= value.bytes.length; avatars.delete(key); return null; }
    if (value) { avatars.delete(key); avatars.set(key, value); } return value;
  }};
}
