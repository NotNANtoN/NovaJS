import { current, isDraft } from 'immer';

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
 */
export function plainSnapshot<T>(value: T): T {
    return isDraft(value) ? current(value as object) as T : value;
}
