import path from 'node:path';

/**
 * Resolve a fixture from the repository root without depending on Bazel.
 *
 * NOVAJS_ROOT is set by the lightweight root test runner so this continues
 * to work when esbuild bundles a test into a temporary file.
 */
export function fixturePath(relative: string): string {
    const root = process.env.NOVAJS_ROOT
        ?? path.resolve(__dirname, '..');
    return path.resolve(root, relative.replace(/^novajs\//, ''));
}
