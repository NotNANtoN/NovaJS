import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Browser bundle
await esbuild.build({
    entryPoints: [path.join(__dirname, 'src/browser.ts')],
    outfile: path.join(__dirname, 'dist/src/browser_bundle.js'),
    bundle: true,
    sourcemap: true,
    platform: 'browser',
    format: 'iife',
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
    platform: 'node',
    format: 'esm',
});
