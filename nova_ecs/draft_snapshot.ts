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
        return cloneJson(recovered);
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

function cloneJson<T>(value: T): T {
    if (value === undefined || value === null || typeof value !== 'object') {
        return value;
    }
    try {
        return JSON.parse(JSON.stringify(value)) as T;
    } catch {
        return value;
    }
}
