import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const commonConfig = {
    bundle: true,
    sourcemap: true,
    format: 'esm',
    target: ['es2020'],
    external: ['pixi.js', '@pixi/sound'], // Externalize large libs if served separately, or bundle them.
    // For now, let's bundle them to match the Bazel setup which likely bundled everything for the browser.
    // Actually, the previous setup might have had them as externals if using a CDN, but let's assume bundle for now unless we see index.html loading them.
    // Re-reading: The user wants to "bundle for web".
};

// Browser bundle
await esbuild.build({
    entryPoints: [path.join(__dirname, 'src/browser.ts')],
    outfile: path.join(__dirname, 'dist/src/browser_bundle.js'),
    bundle: true,
    sourcemap: true,
    platform: 'browser',
    format: 'iife', // Browser usually needs IIFE or ESM. IIFE is safer for simple script tags.
    globalName: 'NovaBrowser',
    define: {
        'process.env.NODE_ENV': '"development"'
    }
});

// Nova Parse Worker bundle
await esbuild.build({
    entryPoints: [path.join(__dirname, 'src/server/parsing/nova_parse_worker.ts')],
    outfile: path.join(__dirname, 'dist/src/server/parsing/nova_parse_worker_bundle.js'),
    bundle: true,
    sourcemap: true,
    platform: 'node', // Worker runs in Node
    format: 'esm',
    external: ['novaparse', 'comlink'] // These might need to be bundled if not available in worker context?
    // Actually, for a worker thread in Node, it can import modules if configured correctly.
    // But often it's easier to bundle everything.
    // Let's try bundling everything for the worker too, except native modules if any.
});
