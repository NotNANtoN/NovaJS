/**
 * Run a single test file.
 *
 * `npm test` bundles and runs everything, which is slow and writes to fixed
 * paths. This bundles one spec to a caller-unique temporary file so several
 * runs can proceed at once without overwriting each other's bundle.
 *
 * Usage: node scripts/one_test.mjs path/to/thing_test.ts
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { packedPngPlugin } from './packed_png_plugin.mjs';

const root = process.cwd();
const test = process.argv[2];
if (!test) {
    console.error('usage: node scripts/one_test.mjs <test file>');
    process.exit(2);
}

const outfile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'novajs-one-')), 'test.cjs');

await build({
    entryPoints: [test],
    bundle: true,
    plugins: [packedPngPlugin(root)],
    format: 'cjs',
    platform: 'node',
    target: 'node24',
    external: ['jasmine'],
    outfile,
    tsconfig: path.join(root, 'tsconfig.json'),
    logLevel: 'error',
});

const child = spawn(
    process.execPath, [path.join(root, 'scripts/run_one_test.cjs'), outfile],
    {
        cwd: root,
        env: { ...process.env, NODE_PATH: path.join(root, 'node_modules'), NOVAJS_ROOT: root },
        stdio: 'inherit',
    });
child.on('exit', code => {
    fs.rmSync(path.dirname(outfile), { recursive: true, force: true });
    process.exit(code ?? 1);
});
