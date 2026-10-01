import fs from 'node:fs';
import path from 'node:path';

export interface ScanLock {
  release(): void;
}

const LOCK_DIR = 'scan.lock';
const STALE_MS = 60 * 1000;
const WAIT_MS = 15000;
const POLL_MS = 100;

/**
 * Cross-process scan lock via atomic directory creation (`mkdir` is
 * atomic on POSIX and Windows). Prevents two concurrent scans from
 * interleaving events in the same cache. Stale locks (crashed
 * processes) are reclaimed after {@link STALE_MS}.
 */
export async function acquireScanLock(baseDir: string): Promise<ScanLock> {
  try {
    fs.mkdirSync(baseDir, { recursive: true });
  } catch {
    // Base dir may be read-only; locking is best-effort then.
    return { release: () => {} };
  }

  const lockPath = path.join(baseDir, LOCK_DIR);
  const deadline = Date.now() + WAIT_MS;

  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      try {
        fs.writeFileSync(path.join(lockPath, 'pid'), String(process.pid), 'utf8');
      } catch {
        // Best-effort marker only.
      }
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try {
            fs.rmSync(lockPath, { recursive: true, force: true });
          } catch {
            // Ignore cleanup failures.
          }
        }
      };
    } catch (err: any) {
      if (err?.code !== 'EEXIST') {
        // Locking unsupported here; proceed unlocked (server serializes anyway).
        return { release: () => {} };
      }
      if (isStale(lockPath) || Date.now() >= deadline) {
        if (isStale(lockPath)) {
          try {
            fs.rmSync(lockPath, { recursive: true, force: true });
            continue;
          } catch {
            // Fall through to waiting.
          }
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `Another dep-blame scan is in progress for this repository (${lockPath}). ` +
              `Wait for it to finish or remove the directory if the process crashed.`
          );
        }
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}

function isStale(lockPath: string): boolean {
  try {
    const st = fs.statSync(lockPath);
    return Date.now() - st.mtimeMs > STALE_MS;
  } catch {
    return true;
  }
}
