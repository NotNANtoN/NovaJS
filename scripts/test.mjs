import { readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
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
// These specs require a browser-backed Pixi renderer, legacy global state, or
// a native dependency shape that esbuild cannot reproduce. Keep them active
// for their native environments, but skip them from this Node-only suite.
const skipReasons = new Map([
    ['/nova/src/display/display_plugin_test.ts', 'browser-only Pixi renderer'],
    ['/novaparse/test/NovaParse_test.ts', 'legacy lamejs loader'],
    ['/novaparse/test/resource_parsers/SndResource_test.ts',
        'legacy lamejs loader'],
    ['/novaparse/test/resource_parsers/PNGCompare_test.ts',
        'expects globals from RledResource_test'],
    ['/nova/src/communication/SocketChannelServer_test.ts',
        'native ws module shape'],
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
let failures = 0;
for (const [index, test] of tests.entries()) {
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
                stdio: 'inherit',
            });
            child.on('close', code => resolve(code ?? 1));
        });
        if (result !== 0) {
            failures++;
        }
    } catch (error) {
        failures++;
        console.error(`Failed to build ${path.relative(root, test)}`, error);
    } finally {
        await rm(output, { force: true });
    }
}
console.log(`Ran ${tests.length} test files; ${failures} failed.`);
process.exitCode = failures === 0 ? 0 : 1;
