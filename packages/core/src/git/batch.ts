import { spawn } from 'node:child_process';
import type { BlobRequest } from '../types.js';

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
      cleanup();
      reject(err);
    });

    child.on('close', (code) => {
      cleanup();
      if (code !== 0 && requestIndex < requests.length) {
        reject(new Error(`git cat-file --batch exited with code ${code}: ${stderr}`));
      } else {
        resolve(results);
      }
    });

    // Write requests to stdin with backpressure support
    let writeIdx = 0;
    function writeMore() {
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
    }

    writeMore();
  });
}
