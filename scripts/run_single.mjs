/**
 * Build and run one *_test.ts file, using the same configuration as
 * scripts/test.mjs. Useful while iterating on a single spec.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const test = path.resolve(root, process.argv[2]);
const output = path.join('/tmp', `novajs-single-${process.pid}.cjs`);

await build({
    entryPoints: [test],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node24',
    external: ['jasmine'],
    outfile: output,
    tsconfig: path.join(root, 'tsconfig.json'),
    logLevel: 'error',
});

const child = spawn(process.execPath,
    [path.join(root, 'scripts/run_one_test.cjs'), output], {
        cwd: root,
        env: {
            ...process.env,
            NODE_PATH: path.join(root, 'node_modules'),
            NOVAJS_ROOT: root,
        },
        stdio: 'inherit',
    });
child.on('close', code => { process.exitCode = code ?? 1; });
