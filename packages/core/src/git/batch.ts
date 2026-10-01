import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { BlobRequest } from '../types.js';

export interface BlobId {
  /** Resolved object ID (empty when missing). */
  oid: string;
  /** Byte size (0 when missing). */
  size: number;
  /** True when the object does not exist at the requested revision. */
  missing: boolean;
}

/**
 * Batch-reads manifest blobs from git using `git cat-file --batch`.
 * Features chunked stream parsing, backpressure handling, and timeout safeguards.
 *
 * For large histories prefer `resolveBlobOids` + fetching only changed
 * blobs: re-reading an unchanged multi-megabyte lockfile in every commit
 * is the dominant scan cost.
 *
 * @param repoRoot Absolute path to git repository root
 * @param requests Array of commit and path pairs
 * @returns Map of `<commit>:<path>` to file content string (or null if missing)
 */
export async function batchReadBlobs(
  repoRoot: string,
  requests: BlobRequest[]
): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>();
  if (!requests || requests.length === 0) {
    return results;
  }

  // To prevent extreme memory pressure, execute in chunks of 4,000 requests if needed
  const CHUNK_SIZE = 4000;
  if (requests.length > CHUNK_SIZE) {
    for (let i = 0; i < requests.length; i += CHUNK_SIZE) {
      const slice = requests.slice(i, i + CHUNK_SIZE);
      const partial = await batchReadBlobsChunk(repoRoot, slice);
      for (const [k, v] of partial) {
        results.set(k, v);
      }
    }
    return results;
  }

  return batchReadBlobsChunk(repoRoot, requests);
}

function validRequest(req: BlobRequest): boolean {
  return !!req && /^[0-9a-f]{4,64}$/i.test(req.commit) && !!req.path && !/[\r\n\0]/.test(req.path);
}

function batchReadBlobsChunk(
  repoRoot: string,
  requests: BlobRequest[]
): Promise<Map<string, string | null>> {
  // Repeated requests must not confuse response indexing or duplicate retained strings.
  if (requests.some(r => !validRequest(r))) return Promise.reject(new Error('Invalid blob request.'));
  requests = [...new Map(requests.map(r => [r.commit + ':' + r.path, r])).values()];
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], {cwd: repoRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    const results = new Map<string, string | null>();
    let requestIndex = 0;
    let headerParts: Buffer[] = [];
    let headerSize = 0;
    let body: Buffer | null = null;
    let bodyOffset = 0;
    let retainedBytes = 0;
    let settled = false;
    let stderr = '';
    const timeout = setTimeout(() => fail(new Error('git cat-file --batch timed out after 30 seconds.')), 30000);
    function fail(error: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      reject(error);
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      try {
        let pos = 0;
        while (pos < chunk.length) {
          if (requestIndex >= requests.length) throw new Error('Unexpected extra git cat-file response.');
          if (body === null) {
            const nl = chunk.indexOf(10, pos);
            const part = chunk.subarray(pos, nl < 0 ? chunk.length : nl);
            headerParts.push(part);
            headerSize += part.length;
            if (headerSize > 16384) throw new Error('Git object response header is too large.');
            if (nl < 0) break;
            const header = Buffer.concat(headerParts, headerSize).toString('utf8');
            headerParts = [];
            headerSize = 0;
            pos = nl + 1;
            const req = requests[requestIndex];
            if (header === req.commit + ':' + req.path + ' missing') {
              results.set(req.commit + ':' + req.path, null);
              requestIndex++;
              continue;
            }
            const match = /^([0-9a-f]{40,64}) blob (\d+)$/.exec(header);
            const size = match ? Number(match[2]) : NaN;
            if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid Git blob response.');
            // A repository must not trigger an unbounded single-object allocation.
            if (size > 64 * 1024 * 1024) throw new Error('Manifest blob exceeds the 64 MiB safety limit.');
            retainedBytes += size;
            if (retainedBytes > 64 * 1024 * 1024) throw new Error('Git blob batch exceeds the 64 MiB safety limit.');
            body = Buffer.allocUnsafe(size);
            bodyOffset = 0;
          }
          if (bodyOffset < body.length) {
            const count = Math.min(body.length - bodyOffset, chunk.length - pos);
            chunk.copy(body, bodyOffset, pos, pos + count);
            pos += count;
            bodyOffset += count;
          }
          if (bodyOffset === body.length && pos < chunk.length) {
            if (chunk[pos++] !== 10) throw new Error('Invalid Git blob response terminator.');
            const req = requests[requestIndex++];
            results.set(req.commit + ':' + req.path, body.toString('utf8'));
            body = null;
          }
        }
      } catch (err) { fail(err instanceof Error ? err : new Error(String(err))); }
    });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString('utf8'); });
    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0 || requestIndex !== requests.length || body !== null || headerSize > 0) {
        fail(new Error('git cat-file returned an incomplete response (exit ' + code + '): ' + stderr));
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(results);
    });
    child.stdin.on('error', () => {}); // The close handler reports early process termination.
    let writeIndex = 0;
    function writeMore() {
      if (settled) return;
      try {
        while (writeIndex < requests.length) {
          const req = requests[writeIndex++];
          if (!child.stdin.write(req.commit + ':' + req.path + '\n')) {
            child.stdin.once('drain', writeMore);
            return;
          }
        }
        child.stdin.end();
      } catch (err) { fail(err instanceof Error ? err : new Error(String(err))); }
    }
    writeMore();
  });
}

/**
 * Cheap sizing pass over `git cat-file --batch-check`: resolves every
 * request to its object ID and byte size without transferring contents.
 * Lets callers skip re-fetching blobs they already hold and pack
 * windows by bytes. Missing objects map to `{ oid: '', size: 0,
 * missing: true }`. Never throws for missing objects; rejects only when
 * git itself fails or a request is malformed.
 */
export function resolveBlobOids(
  repoRoot: string,
  requests: BlobRequest[]
): Promise<Map<string, BlobId>> {
  const results = new Map<string, BlobId>();
  if (!requests || requests.length === 0) {
    return Promise.resolve(results);
  }
  if (requests.some(r => !validRequest(r))) return Promise.reject(new Error('Invalid blob request.'));
  requests = [...new Map(requests.map(r => [r.commit + ':' + r.path, r])).values()];

  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let buffer = '';
    const decoder = new StringDecoder('utf8');
    let requestIndex = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error('git cat-file --batch-check timed out after 30 seconds.'));
      }
    }, 30000);

    const cleanup = () => {
      clearTimeout(timeout);
      settled = true;
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      buffer += decoder.write(chunk);
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        const req = requests[requestIndex++];
        if (!req) { cleanup(); child.kill(); reject(new Error('Extra Git object response.')); return; }
        const key = `${req.commit}:${req.path}`;
        if (line === req.commit + ':' + req.path + ' missing') {
          results.set(key, { oid: '', size: 0, missing: true });
          continue;
        }
        const parts = line.split(' ');
        const size = Number(parts[2]);
        if (!/^[0-9a-f]{40,64}$/.test(parts[0]) || parts[1] !== 'blob' || parts.length !== 3 || !Number.isSafeInteger(size) || size < 0) { cleanup(); child.kill(); reject(new Error('Invalid Git object sizing response.')); return; }
        results.set(key, {
          oid: parts[0] || '',
          size: Number.isInteger(size) && size >= 0 ? size : 0,
          missing: false
        });
      }
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      cleanup();
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      cleanup();
      if (code !== 0) {
        reject(new Error(`git cat-file --batch-check exited with code ${code}: ${stderr}`));
        return;
      }
      if (requestIndex !== requests.length || buffer.length > 0) {
        reject(new Error('git cat-file --batch-check returned an incomplete response.'));
        return;
      }
      resolve(results);
    });

    child.stdin.on('error', () => {});

    for (const req of requests) {
      if (!validRequest(req)) {
        cleanup();
        child.kill();
        reject(new Error(`Invalid blob request: ${JSON.stringify(req)}`));
        return;
      }
    }

    let writeIndex = 0;
    function writeMore() {
      if (settled) return;
      try {
        while (writeIndex < requests.length) {
          const req = requests[writeIndex++];
          if (!child.stdin.write(req.commit + ':' + req.path + '\n')) {
            child.stdin.once('drain', writeMore);
            return;
          }
        }
        child.stdin.end();
      } catch (err) {
        if (!settled) { cleanup(); child.kill(); reject(err); }
      }
    }
    writeMore();
  });
}
