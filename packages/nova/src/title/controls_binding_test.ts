import 'jasmine';
import { isLeft } from 'fp-ts/lib/Either.js';
import {
    Controls, getActions, SavedControls,
} from '../nova_plugin/controls.js';
import {
    bindControl, ControlsOverride, mergeControls, primaryBinding,
} from './client_prefs.js';

/**
 * The editor -> live-controls path, end to end at the layer it lives in:
 * an override map goes through mergeControls + the Controls codec, and
 * the result is queried with the same getActions the key handler uses.
 *
 * The bug this pins: `getActions` returns EVERY action bound to a code,
 * so binding an action onto an occupied key used to leave both firing,
 * which is what made rebindings look like they "did not take effect".
 */

/** A representative slice of the served controls.json. */
const BASE: Record<string, unknown> = {
    accelerate: 'ArrowUp',
    turnLeft: 'ArrowLeft',
    turnRight: 'ArrowRight',
    hyperjump: 'KeyJ',
    nextSecondary: 'KeyW',
    fireSecondary: ['ControlLeft', 'ShiftLeft'],
    // A menu action deliberately sharing a key with a flight control:
    // these live in different contexts and must NOT be displaced.
    up: 'ArrowUp',
};

/** The actions the preferences editor exposes for rebinding. */
const REBINDABLE = ['accelerate', 'turnLeft', 'turnRight', 'hyperjump',
    'nextSecondary', 'fireSecondary'];

function live(override: ControlsOverride): Controls {
    const decoded = SavedControls.pipe(Controls)
        .decode(mergeControls(BASE, override));
    if (isLeft(decoded)) {
        throw new Error('controls failed to decode');
    }
    return decoded.right;
}

/** getActions only reads `code` and modifier state. */
function press(controls: Controls, code: string): string[] {
    return getActions(controls,
        { code, getModifierState: () => false } as unknown as KeyboardEvent);
}

describe('control rebinding', () => {
    describe('primaryBinding', () => {
        it('reads the served default', () => {
            expect(primaryBinding('accelerate', BASE, {})).toBe('ArrowUp');
        });

        it('reads the first key of a multi-key default', () => {
            expect(primaryBinding('fireSecondary', BASE, {}))
                .toBe('ControlLeft');
        });

        it('prefers an override', () => {
            expect(primaryBinding('accelerate', BASE, { accelerate: 'KeyZ' }))
                .toBe('KeyZ');
        });

        it('reports an explicitly unbound action as empty', () => {
            expect(primaryBinding('accelerate', BASE, { accelerate: '' }))
                .toBe('');
        });

        it('is empty for an action with no binding at all', () => {
            expect(primaryBinding('nothing', BASE, {})).toBe('');
        });
    });

    describe('bindControl displacement', () => {
        it('takes the key from the rebindable action that had it', () => {
            const next = bindControl(BASE, {}, 'fireSecondary', 'KeyJ',
                REBINDABLE);
            expect(next['fireSecondary']).toBe('KeyJ');
            // hyperjump owned KeyJ and must give it up.
            expect(next['hyperjump']).toBe('');
        });

        it('leaves context-scoped actions alone', () => {
            // 'up' is a menu action sharing ArrowUp with accelerate; it is
            // not in the editor, so it keeps its key.
            const next = bindControl(BASE, {}, 'turnLeft', 'ArrowUp',
                REBINDABLE);
            expect(next['turnLeft']).toBe('ArrowUp');
            expect(next['accelerate']).toBe('');
            expect(next['up']).toBeUndefined();
        });

        it('does not displace the action being bound', () => {
            const next = bindControl(BASE, {}, 'accelerate', 'ArrowUp',
                REBINDABLE);
            expect(next['accelerate']).toBe('ArrowUp');
        });

        it('does not mutate the input override', () => {
            const override: ControlsOverride = {};
            bindControl(BASE, override, 'fireSecondary', 'KeyJ', REBINDABLE);
            expect(override).toEqual({});
        });

        it('displaces a previously-overridden action too', () => {
            const first = bindControl(BASE, {}, 'turnLeft', 'KeyG',
                REBINDABLE);
            const second = bindControl(BASE, first, 'turnRight', 'KeyG',
                REBINDABLE);
            expect(second['turnRight']).toBe('KeyG');
            expect(second['turnLeft']).toBe('');
        });
    });

    describe('editor edit -> live bindings', () => {
        it('a rebound key fires ONLY the rebound action', () => {
            const override = bindControl(BASE, {}, 'fireSecondary', 'KeyJ',
                REBINDABLE);
            const controls = live(override);
            expect(press(controls, 'KeyJ')).toEqual(['fireSecondary']);
        });

        it('the displaced action no longer fires on its old key', () => {
            const override = bindControl(BASE, {}, 'fireSecondary', 'KeyJ',
                REBINDABLE);
            const controls = live(override);
            expect(press(controls, 'KeyJ')).not.toContain('hyperjump');
        });

        it('the rebound action stops firing on its old key', () => {
            const override = bindControl(BASE, {}, 'accelerate', 'KeyZ',
                REBINDABLE);
            const controls = live(override);
            expect(press(controls, 'KeyZ')).toEqual(['accelerate']);
            expect(press(controls, 'ArrowUp')).not.toContain('accelerate');
        });

        it('keeps the menu action on a shared key after a rebind', () => {
            const override = bindControl(BASE, {}, 'turnLeft', 'ArrowUp',
                REBINDABLE);
            const controls = live(override);
            const actions = press(controls, 'ArrowUp');
            expect(actions).toContain('turnLeft');
            // The menu binding survives; the flight one was displaced.
            expect(actions).toContain('up');
            expect(actions).not.toContain('accelerate');
        });

        it('replaces a multi-key default with the single new key', () => {
            const override = bindControl(BASE, {}, 'fireSecondary', 'KeyJ',
                REBINDABLE);
            const controls = live(override);
            expect(press(controls, 'ControlLeft')).toEqual([]);
            expect(press(controls, 'ShiftLeft')).toEqual([]);
        });

        it('an untouched action keeps its served default', () => {
            const controls = live(
                bindControl(BASE, {}, 'accelerate', 'KeyZ', REBINDABLE));
            expect(press(controls, 'ArrowRight')).toContain('turnRight');
        });

        it('no overrides reproduces the served bindings exactly', () => {
            const controls = live({});
            expect(press(controls, 'ArrowUp').sort())
                .toEqual(['accelerate', 'up']);
            expect(press(controls, 'KeyJ')).toEqual(['hyperjump']);
        });
    });
});
