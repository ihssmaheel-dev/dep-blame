import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

export async function createTestRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-blame-test-'));

  const runGit = async (args) => {
    return await execFileAsync('git', args, { cwd: repoDir, windowsHide: true });
  };

  await runGit(['init', '-b', 'main']);
  await runGit(['config', 'user.name', 'Test Runner']);
  await runGit(['config', 'user.email', 'test@runner.local']);
  await runGit(['config', 'commit.gpgsign', 'false']);

  const commitFile = async (relPath, content, message) => {
    const fullPath = path.join(repoDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
    await runGit(['add', relPath]);
    await runGit(['commit', '-m', message]);
  };

  const cleanup = () => {
    try {
      fs.rmSync(repoDir, { recursive: true, force: true });
    } catch {
      // Windows file lock cleanup retry or ignore
    }
  };

  return {
    repoDir,
    runGit,
    commitFile,
    cleanup
  };
}
