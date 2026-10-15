import { current, isDraft, original } from 'immer';

/**
 * A plain copy of component data that is safe to keep past the end of the
 * current step.
 *
 * Components are handed to systems as Immer drafts so changes can be turned
 * into deltas. Those drafts are revoked once the step finishes, and every
 * later read of one throws `Cannot perform 'get' on a proxy that has been
 * revoked`. Anything that outlives its step — an `async` system that awaits
 * game data, or a dialog that awaits before rendering what it read — has to
 * take a copy first.
 *
 * `current()` is not enough: nested arrays and objects on the snapshot can
 * still be draft proxies, and a revoked root no longer reports as a draft.
 * JSON-clone the detached value so later reads cannot touch a proxy.
 */
export function plainSnapshot<T>(value: T): T {
    if (value === undefined || value === null) {
        return value;
    }
    const recovered = recoverDraft(value);
    if (recovered !== undefined) {
        return clonePlainValue(recovered);
    }
    return value;
}

/**
 * Unwraps any top-level or nested Immer draft proxies in `value` while
 * leaving non-draft class instances (such as PIXI display objects) intact.
 */
export function unwrapDraftsDeep<T>(value: T, seen = new WeakSet<object>()): T {
    if (value === undefined || value === null || typeof value !== 'object') {
        return value;
    }
    const recovered = recoverDraft(value);
    if (recovered !== undefined) {
        return clonePlainValue(recovered);
    }
    if (seen.has(value as object)) {
        return value;
    }
    seen.add(value as object);
    if (value instanceof Map) {
        for (const [k, v] of value.entries()) {
            const unwrapped = unwrapDraftsDeep(v, seen);
            if (unwrapped !== v) {
                value.set(k, unwrapped);
            }
        }
        return value;
    }
    if (value instanceof Set) {
        const items = [...value.values()];
        let changed = false;
        const next = items.map(item => {
            const unwrapped = unwrapDraftsDeep(item, seen);
            if (unwrapped !== item) changed = true;
            return unwrapped;
        });
        if (changed) {
            value.clear();
            for (const item of next) value.add(item);
        }
        return value;
    }
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            const unwrapped = unwrapDraftsDeep(value[i], seen);
            if (unwrapped !== value[i]) {
                value[i] = unwrapped;
            }
        }
        return value;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto === null || proto === Object.prototype) {
        const record = value as Record<string, unknown>;
        for (const [k, v] of Object.entries(record)) {
            const unwrapped = unwrapDraftsDeep(v, seen);
            if (unwrapped !== v) {
                record[k] = unwrapped;
            }
        }
    }
    return value;
}

function recoverDraft<T>(value: T): T | undefined {
    try {
        if (isDraft(value)) {
            return current(value as object) as T;
        }
    } catch {
        // A revoked proxy can throw from isDraft/current.
    }
    if (typeof value === 'object' && !isReadable(value as object)) {
        try {
            const base = original(value as object);
            if (base !== undefined) {
                return base as T;
            }
        } catch {
            // Immer has already dropped the mapping for this proxy.
        }
    }
    return undefined;
}

function isReadable(value: object): boolean {
    try {
        Reflect.get(value, 'constructor');
        return true;
    } catch {
        return false;
    }
}

function clonePlainValue<T>(value: T): T {
    if (value === undefined || value === null || typeof value !== 'object') {
        return value;
    }
    if (value instanceof Map) {
        const copy = new Map();
        for (const [k, v] of value.entries()) {
            copy.set(k, clonePlainValue(v));
        }
        return copy as unknown as T;
    }
    if (value instanceof Set) {
        const copy = new Set();
        for (const v of value.values()) {
            copy.add(clonePlainValue(v));
        }
        return copy as unknown as T;
    }
    if (Array.isArray(value)) {
        return value.map(item => clonePlainValue(item)) as unknown as T;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto === null || proto === Object.prototype) {
        const copy: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
            copy[k] = clonePlainValue(v);
        }
        return copy as unknown as T;
    }
    try {
        return JSON.parse(JSON.stringify(value)) as T;
    } catch {
        return value;
    }
}
