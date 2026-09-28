import { spawn } from 'node:child_process';

/**
 * Batch-reads manifest blobs from git using a single `git cat-file --batch` process.
 *
 * @param {string} repoRoot Absolute path to git repository root
 * @param {Array<{ commit: string, path: string }>} requests Array of commit and path pairs
 * @returns {Promise<Map<string, string | null>>} Map of `<commit>:<path>` to file content (or null if missing)
 */
export async function batchReadBlobs(repoRoot, requests) {
  const results = new Map();
  if (!requests || requests.length === 0) {
    return results;
  }

  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let buffer = Buffer.alloc(0);
    let requestIndex = 0;
    let expectedHeader = null; // { objectId, type, size, headerLength }

    child.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (requestIndex < requests.length) {
        if (!expectedHeader) {
          // Find newline for header
          const newlineIndex = buffer.indexOf(0x0a); // '\n'
          if (newlineIndex === -1) {
            break; // Wait for full header
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

          // Header format: "<sha> <type> <size>"
          const parts = headerLine.split(' ');
          if (parts.length < 3) {
            child.kill();
            return reject(new Error(`Unexpected git cat-file header: "${headerLine}"`));
          }

          const objectId = parts[0];
          const type = parts[1];
          const size = parseInt(parts[2], 10);
          const headerLength = newlineIndex + 1;

          expectedHeader = { objectId, type, size, headerLength, key };
        }

        // We have a header, check if we have the content + trailing newline
        const totalNeeded = expectedHeader.headerLength + expectedHeader.size + 1;
        if (buffer.length < totalNeeded) {
          break; // Wait for more data
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
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      if (code !== 0 && requestIndex < requests.length) {
        reject(new Error(`git cat-file --batch exited with code ${code}: ${stderr}`));
      } else {
        resolve(results);
      }
    });

    // Write all requests to stdin
    for (const req of requests) {
      child.stdin.write(`${req.commit}:${req.path}\n`);
    }
    child.stdin.end();
  });
}
