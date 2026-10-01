import { spawn } from 'node:child_process';
import type { BlobRequest } from '../types.js';

export interface BlobId {
  /** Resolved object ID (empty when missing). */
  oid: string;
  /** Byte size (0 when missing). */
  size: number;
  /** True when the object does not exist at the requested revision. */
  missing: boolean;
}

interface HeaderInfo {
  objectId: string;
  type: string;
  size: number;
  headerLength: number;
  key: string;
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

function batchReadBlobsChunk(
  repoRoot: string,
  requests: BlobRequest[]
): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>();

  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let buffer = Buffer.alloc(0);
    let requestIndex = 0;
    let expectedHeader: HeaderInfo | null = null;
    let isSettled = false;

    // Timeout watchdog (30 seconds)
    const timeout = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        child.kill();
        reject(new Error('git cat-file --batch timed out after 30 seconds.'));
      }
    }, 30000);

    const cleanup = () => {
      clearTimeout(timeout);
      isSettled = true;
    };

    child.stdout.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (requestIndex < requests.length) {
        if (!expectedHeader) {
          // Look for newline byte 0x0A for the header
          const newlineIndex = buffer.indexOf(0x0a);
          if (newlineIndex === -1) {
            break; // Incomplete header, wait for next chunk
          }

          const headerLine = buffer.subarray(0, newlineIndex).toString('utf8').trim();
          const req = requests[requestIndex];
          const key = `${req.commit}:${req.path}`;

          if (headerLine.endsWith('missing')) {
            results.set(key, null);
            buffer = buffer.subarray(newlineIndex + 1);
            requestIndex++;
            continue;
          }

          const parts = headerLine.split(' ');
          if (parts.length < 3) {
            cleanup();
            child.kill();
            return reject(new Error(`Unexpected git cat-file header format: "${headerLine}"`));
          }

          const objectId = parts[0];
          const type = parts[1];
          const size = parseInt(parts[2], 10);
          const headerLength = newlineIndex + 1;

          if (isNaN(size) || size < 0) {
            cleanup();
            child.kill();
            return reject(new Error(`Invalid size in git cat-file header: "${headerLine}"`));
          }

          expectedHeader = { objectId, type, size, headerLength, key };
        }

        // Check if we have header + blob content + trailing newline (size + 1 bytes)
        const totalNeeded = expectedHeader.headerLength + expectedHeader.size + 1;
        if (buffer.length < totalNeeded) {
          break; // Wait for full blob content
        }

        const contentBuf = buffer.subarray(
          expectedHeader.headerLength,
          expectedHeader.headerLength + expectedHeader.size
        );
        const content = contentBuf.toString('utf8');

        results.set(expectedHeader.key, content);

        // Advance buffer past content and trailing newline
        buffer = buffer.subarray(totalNeeded);
        expectedHeader = null;
        requestIndex++;
      }
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (isSettled) return;
      cleanup();
      reject(err);
    });

    child.on('close', (code) => {
      if (isSettled) return;
      cleanup();
      if (code !== 0 && requestIndex < requests.length) {
        reject(new Error(`git cat-file --batch exited with code ${code}: ${stderr}`));
      } else {
        // Fill any unanswered requests (e.g. short reads) with null.
        for (let i = requestIndex; i < requests.length; i++) {
          const req = requests[i];
          const key = `${req.commit}:${req.path}`;
          if (!results.has(key)) results.set(key, null);
        }
        resolve(results);
      }
    });

    // Swallow EPIPE when git exits early; close handler surfaces the error.
    child.stdin.on('error', () => {});

    // Validate requests to avoid malformed batch lines.
    for (const req of requests) {
      if (!req || !/^[0-9a-f]{4,40}$/i.test(req.commit) || !req.path || req.path.includes('\n')) {
        cleanup();
        child.kill();
        return reject(new Error(`Invalid blob request: ${JSON.stringify(req)}`));
      }
    }

    // Write requests to stdin with backpressure support
    let writeIdx = 0;
    function writeMore() {
      try {
        while (writeIdx < requests.length) {
          const req = requests[writeIdx];
          writeIdx++;
          const canContinue = child.stdin.write(`${req.commit}:${req.path}\n`);
          if (!canContinue) {
            child.stdin.once('drain', writeMore);
            return;
          }
        }
        child.stdin.end();
      } catch (err: any) {
        if (!isSettled) {
          cleanup();
          child.kill();
          reject(err);
        }
      }
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

  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let buffer = '';
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
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        const req = requests[results.size];
        if (!req) continue;
        const key = `${req.commit}:${req.path}`;
        if (line.endsWith('missing') || line.length === 0) {
          results.set(key, { oid: '', size: 0, missing: true });
          continue;
        }
        const parts = line.split(' ');
        const size = parseInt(parts[2], 10);
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
      // Trailing line without newline (should not happen, but be safe).
      if (buffer.trim().length > 0 && results.size < requests.length) {
        const req = requests[results.size];
        const key = `${req.commit}:${req.path}`;
        const line = buffer.trim();
        if (line.endsWith('missing')) {
          results.set(key, { oid: '', size: 0, missing: true });
        } else {
          const parts = line.split(' ');
          const size = parseInt(parts[2], 10);
          results.set(key, {
            oid: parts[0] || '',
            size: Number.isInteger(size) && size >= 0 ? size : 0,
            missing: false
          });
        }
      }
      // Any unanswered requests (short reads) count as missing.
      for (const req of requests) {
        const key = `${req.commit}:${req.path}`;
        if (!results.has(key)) results.set(key, { oid: '', size: 0, missing: true });
      }
      resolve(results);
    });

    child.stdin.on('error', () => {});

    for (const req of requests) {
      if (!req || !/^[0-9a-f]{4,40}$/i.test(req.commit) || !req.path || req.path.includes('\n')) {
        cleanup();
        child.kill();
        reject(new Error(`Invalid blob request: ${JSON.stringify(req)}`));
        return;
      }
    }

    try {
      for (const req of requests) {
        child.stdin.write(`${req.commit}:${req.path}\n`);
      }
      child.stdin.end();
    } catch (err: any) {
      if (!settled) {
        cleanup();
        child.kill();
        reject(err);
      }
    }
  });
}
