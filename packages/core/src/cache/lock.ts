import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ScanLock { release(): void; }
const STALE_MS = 60_000;
const WAIT_MS = 60_000;
const POLL_MS = 100;

/** Age alone never permits stealing a live process's scan lock. */
function isStale(lockPath: string): boolean {
  try {
    const pid = Number(fs.readFileSync(path.join(lockPath, 'pid'), 'utf8'));
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return false; }
      catch (err: any) { return err?.code === 'ESRCH'; }
    }
  } catch { /* An interrupted mkdir may not have written its marker yet. */ }
  try { return Date.now() - fs.statSync(lockPath).mtimeMs > STALE_MS; }
  catch { return false; }
}

/** Atomic directory lock shared by CLI and UI scans; fail closed on I/O errors. */
export async function acquireScanLock(baseDir: string, onWait?: () => void): Promise<ScanLock> {
  fs.mkdirSync(baseDir, { recursive: true });
  const lockPath = path.join(path.resolve(baseDir), 'scan.lock');
  const deadline = Date.now() + WAIT_MS;
  let lastNotice = 0;
  for (;;) {
    let acquired = false;
    try {
      fs.mkdirSync(lockPath);
      acquired = true;
      const token = randomUUID();
      fs.writeFileSync(path.join(lockPath, 'pid'), String(process.pid), 'utf8');
      fs.writeFileSync(path.join(lockPath, 'owner'), token, 'utf8');
      let released = false;
      return { release() {
        if (released) return;
        released = true;
        try {
          if (fs.readFileSync(path.join(lockPath, 'owner'), 'utf8') === token) {
            fs.rmSync(lockPath, { recursive: true, force: true });
          }
        } catch { /* Never remove a replacement owner's directory. */ }
      } };
    } catch (err: any) {
      if (acquired) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        throw err;
      }
      if (err?.code !== 'EEXIST') throw err;
      if (isStale(lockPath)) {
        const claim = path.join(lockPath, 'reclaim');
        try {
          const fd = fs.openSync(claim, 'wx');
          fs.writeFileSync(fd, String(process.pid));
          fs.closeSync(fd);
          if (isStale(lockPath)) fs.rmSync(lockPath, { recursive: true, force: true });
          else fs.rmSync(claim, { force: true });
          continue;
        } catch {
          // Recover a reclaimer interrupted before removing the original lock.
          try {
            const pid = Number(fs.readFileSync(claim, 'utf8'));
            let dead = false;
            if (Number.isInteger(pid) && pid > 0) {
              try { process.kill(pid, 0); } catch (err: any) { dead = err?.code === 'ESRCH'; }
            } else dead = Date.now() - fs.statSync(claim).mtimeMs > STALE_MS;
            if (dead) fs.rmSync(claim, { force: true });
          } catch { /* Another contender is reclaiming it. */ }
        }
      }
      if (Date.now() >= deadline) {
        throw new Error('Another dep-blame scan is in progress for this repository (' + lockPath + '). Wait for it to finish.');
      }
      if (onWait && Date.now() - lastNotice > 2000) {
        lastNotice = Date.now();
        try { onWait(); } catch { /* Progress callbacks cannot break locking. */ }
      }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
  }
}
