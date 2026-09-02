import { readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { packedPngPlugin } from './packed_png_plugin.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

async function testFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules'
            && entry.name !== 'dist') {
            files.push(...await testFiles(entryPath));
        } else if (entry.isFile() && entry.name.endsWith('_test.ts')) {
            files.push(entryPath);
        }
    }
    return files.sort();
}

const discoveredTests = await testFiles(root);
const skipReasons = new Map([
    ['/nova/src/display/display_plugin_test.ts', 'browser-only Pixi renderer'],
    ['/novaparse/test/NovaParse_test.ts', 'legacy lamejs loader'],
    ['/novaparse/test/resource_parsers/SndResource_test.ts', 'legacy lamejs loader'],
    ['/nova/src/communication/SocketChannelServer_test.ts', 'native ws module shape'],
]);
const skippedTests = discoveredTests.filter(file =>
    [...skipReasons.keys()].some(suffix => file.endsWith(suffix)));
const tests = discoveredTests.filter(file => !skippedTests.includes(file));
if (tests.length === 0) {
    throw new Error('No *_test.ts files found');
}
if (skippedTests.length > 0) {
    console.warn(`Skipped ${skippedTests.length} environment-specific test(s): ${
        skippedTests.map(file => `${path.relative(root, file)} (${
            [...skipReasons.entries()].find(([suffix]) => file.endsWith(suffix))?.[1]
        })`).join(', ')}`);
}

const runner = path.join(root, 'scripts/run_one_test.cjs');
const concurrency = Math.max(2, Math.min(os.cpus().length, 8));
let failures = 0;
let completed = 0;

async function runWorker(iterator) {
    for (const [index, test] of iterator) {
        const output = path.join('/tmp',
            `novajs-test-${process.pid}-${index}.cjs`);
        try {
            await build({
                entryPoints: [test],
                bundle: true,
                plugins: [packedPngPlugin(root)],
                format: 'cjs',
                platform: 'node',
                target: 'node24',
                external: ['jasmine', 'sharp'],
                outfile: output,
                tsconfig: path.join(root, 'tsconfig.json'),
                logLevel: 'error',
            });
            const result = await new Promise(resolve => {
                const child = spawn(process.execPath, [runner, output], {
                    cwd: root,
                    env: {
                        ...process.env,
                        NODE_PATH: path.join(root, 'node_modules'),
                        NOVAJS_ROOT: root,
                    },
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                let stderr = '';
                let stdout = '';
                child.stdout.on('data', d => { stdout += d; });
                child.stderr.on('data', d => { stderr += d; });
                child.on('close', code => {
                    if (code !== 0) {
                        console.error(`\nFAILED: ${path.relative(root, test)}`);
                        if (stdout) console.log(stdout);
                        if (stderr) console.error(stderr);
                    }
                    resolve(code ?? 1);
                });
            });
            if (result !== 0) {
                failures++;
            }
        } catch (error) {
            failures++;
            console.error(`Failed to build ${path.relative(root, test)}`, error);
        } finally {
            await rm(output, { force: true });
            completed++;
            process.stdout.write(`\r[${completed}/${tests.length}] Running test suite...`);
        }
    }
}

const testIterator = tests.entries();
const workers = Array.from({ length: concurrency }, () => runWorker(testIterator));
const startTime = Date.now();
await Promise.all(workers);
const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
console.log(`\nRan ${tests.length} test files in ${elapsed}s with ${concurrency} parallel workers; ${failures} failed.`);
process.exitCode = failures === 0 ? 0 : 1;
