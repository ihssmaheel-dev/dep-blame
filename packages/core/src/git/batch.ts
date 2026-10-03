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

export const MAX_BLOB_BYTES = 64 * 1024 * 1024;

export interface BlobContent {
  request: BlobRequest;
  content: string | null;
  /** Resolved object ID; absent for missing objects. */
  oid?: string;
}

/**
 * Collects a small batch into a map. Retained source bytes are capped at
 * 64 MiB; use streamReadBlobs for arbitrarily large aggregate histories.
 */
export async function batchReadBlobs(
  repoRoot: string,
  requests: BlobRequest[]
): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>();
  for await (const { request, content } of readBlobStream(repoRoot, requests, MAX_BLOB_BYTES)) {
    results.set(request.commit + ':' + request.path, content);
  }
  return results;
}

/**
 * Reads one object at a time through one Git process. Awaiting the consumer
 * applies stdout backpressure; total transfer size does not affect retained
 * source memory. Individual objects remain limited to 64 MiB. Cancelling or
 * throwing in a consumer closes the process. The timeout measures Git I/O
 * stalls, not time spent parsing a yielded manifest.
 */
export function streamReadBlobs(repoRoot: string, requests: BlobRequest[]): AsyncGenerator<BlobContent> {
  return readBlobStream(repoRoot, requests);
}

function validRequest(req: BlobRequest): boolean {
  return !!req && /^[0-9a-f]{4,64}$/i.test(req.commit) && !!req.path && !/[\r\n\0]/.test(req.path);
}

async function* readBlobStream(
  repoRoot: string,
  requests: BlobRequest[],
  maxTotalBytes = Infinity
): AsyncGenerator<BlobContent> {
  if (!requests || requests.length === 0) return;
  if (requests.some(r => !validRequest(r))) throw new Error('Invalid blob request.');
  requests = [...new Map(requests.map(r => [r.commit + ':' + r.path, r])).values()];

  const child = spawn('git', ['cat-file', '--batch'], {
    cwd: repoRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  });
  const stdout = child.stdout[Symbol.asyncIterator]();
  let chunk: Buffer = Buffer.alloc(0);
  let offset = 0;
  let transferredBytes = 0;
  let stderr = '';
  let failure: Error | undefined;
  let finished = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<number | null>(resolve => child.once('close', resolve));
  function fail(error: Error) {
    if (finished || failure) return;
    failure = error;
    child.kill();
    child.stdout.destroy(error);
  }
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stderr.on('data', (data: Buffer) => {
    if (stderr.length < 8192) stderr += data.toString('utf8').slice(0, 8192 - stderr.length);
  });

  async function nextChunk(): Promise<boolean> {
    if (failure) throw failure;
    timeout = setTimeout(() => fail(new Error('git cat-file --batch stalled for 30 seconds.')), 30000);
    try {
      const next = await stdout.next();
      if (failure) throw failure;
      chunk = next.done ? Buffer.alloc(0) : next.value;
      offset = 0;
      return !next.done;
    } finally {
      clearTimeout(timeout);
      timeout = undefined;
    }
  }
  async function requireChunk() {
    if (offset < chunk.length) return;
    if (!await nextChunk()) throw new Error('git cat-file returned an incomplete response: ' + stderr);
  }
  async function readHeader(): Promise<string> {
    const parts: Buffer[] = [];
    let size = 0;
    while (true) {
      await requireChunk();
      const nl = chunk.indexOf(10, offset);
      const end = nl < 0 ? chunk.length : nl;
      const part = chunk.subarray(offset, end);
      size += part.length;
      if (size > 16384) throw new Error('Git object response header is too large.');
      parts.push(part);
      offset = nl < 0 ? end : nl + 1;
      if (nl >= 0) return Buffer.concat(parts, size).toString('utf8');
    }
  }
  async function readBody(size: number): Promise<string> {
    // Allocate only after validating the size in the Git response header.
    let body: Buffer | null = Buffer.allocUnsafe(size);
    let copied = 0;
    while (copied < size) {
      await requireChunk();
      const count = Math.min(size - copied, chunk.length - offset);
      chunk.copy(body, copied, offset, offset + count);
      offset += count;
      copied += count;
    }
    await requireChunk();
    if (chunk[offset++] !== 10) throw new Error('Invalid Git blob response terminator.');
    const content = body.toString('utf8');
    body = null;
    return content;
  }

  let writeIndex = 0;
  function writeMore() {
    if (finished || failure) return;
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

  try {
    writeMore();
    for (const request of requests) {
      const key = request.commit + ':' + request.path;
      const header = await readHeader();
      if (header === key + ' missing') {
        yield { request, content: null };
        continue;
      }
      const match = /^([0-9a-f]{40,64}) blob (\d+)$/.exec(header);
      const size = match ? Number(match[2]) : NaN;
      if (!match || !Number.isSafeInteger(size) || size < 0) throw new Error('Invalid Git blob response.');
      if (size > MAX_BLOB_BYTES) {
        throw new Error('Manifest blob exceeds the 64 MiB safety limit: ' + request.path + ' at ' + request.commit.slice(0, 7) + '.');
      }
      transferredBytes += size;
      if (transferredBytes > maxTotalBytes) throw new Error('Git blob batch exceeds the 64 MiB safety limit.');
      yield { request, content: await readBody(size), oid: match[1] };
    }
    if (offset < chunk.length || await nextChunk()) throw new Error('Unexpected extra git cat-file response.');
    const code = await closed;
    if (failure) throw failure;
    if (code !== 0) throw new Error('git cat-file exited with code ' + code + ': ' + stderr);
  } finally {
    finished = true;
    clearTimeout(timeout);
    child.stdin.destroy();
    child.stdout.destroy();
    // Also runs when a consumer stops early or its parser throws.
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
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
