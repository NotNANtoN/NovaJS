import fs from 'node:fs';
import path from 'node:path';

/**
 * The retail Nova data is gitignored, so a fresh checkout — CI included — has
 * only the README under nova/Nova_Data. Specs that parse the real resources
 * mark themselves pending there instead of failing.
 */
export function retailDataPath(): string {
    const root = process.env.NOVAJS_ROOT
        ?? path.resolve(__dirname, '..');
    return path.join(root, 'nova', 'Nova_Data');
}

export function hasRetailData(): boolean {
    return fs.existsSync(path.join(retailDataPath(), 'Nova Files'));
}

/** Returns true when the caller should stop, having marked the spec pending. */
export function skipWithoutRetailData(): boolean {
    if (hasRetailData()) {
        return false;
    }
    pending('retail Nova data is not present in this checkout');
    return true;
}
