import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(packageRoot, 'dist');
if (path.dirname(output) !== packageRoot || path.basename(output) !== 'dist') {
  throw new Error('Invalid build output directory.');
}
const require = createRequire(import.meta.url);
const compiler = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
if (!fs.existsSync(compiler)) throw new Error('TypeScript compiler is unavailable.');
// TypeScript does not remove output for source files that were deleted.
fs.rmSync(output, {recursive: true, force: true});
execFileSync(process.execPath, [compiler, '-p', path.join(packageRoot, 'tsconfig.json')], {stdio: 'inherit', windowsHide: true});
