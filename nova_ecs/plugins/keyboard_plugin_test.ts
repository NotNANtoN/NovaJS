import 'jasmine';
import {
    EcsKeyboardEvent,
    KeyboardPlugin,
    shouldPreventKeyboardDefault,
    shouldReportKeyboardEvent,
} from './keyboard_plugin';
import { World } from '../world';

type EventListener = (event: unknown) => void;

class FakeEventTarget {
    readonly listeners = new Map<string, Set<EventListener>>();

    addEventListener(type: string, listener: EventListener) {
        let listeners = this.listeners.get(type);
        if (!listeners) {
            listeners = new Set();
            this.listeners.set(type, listeners);
        }
        listeners.add(listener);
    }

    removeEventListener(type: string, listener: EventListener) {
        this.listeners.get(type)?.delete(listener);
    }

    dispatch(type: string, event: unknown = {}) {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }
}

interface FakeDocument extends FakeEventTarget {
    hidden: boolean;
    visibilityState: DocumentVisibilityState;
}

function keyboardEvent(
    code: string,
    type: 'keydown' | 'keyup',
    modifiers: Record<string, boolean> = {},
    repeat = false,
): KeyboardEvent {
    let prevented = false;
    return {
        code,
        key: code,
        type,
        repeat,
        ctrlKey: modifiers.Control ?? false,
        altKey: modifiers.Alt ?? false,
        metaKey: modifiers.Meta ?? false,
        shiftKey: modifiers.Shift ?? false,
        getModifierState: (modifier: string) => modifiers[modifier] ?? false,
        preventDefault: () => {
            prevented = true;
        },
        get defaultPrevented() {
            return prevented;
        },
    } as unknown as KeyboardEvent;
}

describe('KeyboardPlugin', () => {
    let documentTarget: FakeDocument;
    let windowTarget: FakeEventTarget;
    let world: World;
    let events: KeyboardEvent[];
    let previousDocument: unknown;
    let previousWindow: unknown;

    beforeEach(async () => {
        previousDocument = (globalThis as any).document;
        previousWindow = (globalThis as any).window;
        documentTarget = Object.assign(new FakeEventTarget(), {
            hidden: false,
            visibilityState: 'visible' as DocumentVisibilityState,
        });
        windowTarget = new FakeEventTarget();
        (globalThis as any).document = documentTarget;
        (globalThis as any).window = windowTarget;
        world = new World();
        events = [];
        world.events.get(EcsKeyboardEvent).subscribe(event => {
            events.push(event);
        });
        await world.addPlugin(KeyboardPlugin);
    });

    afterEach(async () => {
        await world.removePlugin(KeyboardPlugin);
        (globalThis as any).document = previousDocument;
        (globalThis as any).window = previousWindow;
    });

    it('reports state-changing events but ignores browser key repeats', () => {
        expect(shouldReportKeyboardEvent({ repeat: false })).toBeTrue();
        expect(shouldReportKeyboardEvent({ repeat: true })).toBeFalse();
    });

    it('prevents gameplay navigation defaults even on ignored repeats', () => {
        for (const key of [
            'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Tab',
        ]) {
            expect(shouldPreventKeyboardDefault({ key })).toBeTrue();
        }
        expect(shouldPreventKeyboardDefault({ key: 'a' })).toBeFalse();
    });

    it('reports a held key once and ignores duplicate keyups', () => {
        documentTarget.dispatch('keydown', keyboardEvent('ArrowUp', 'keydown'));
        documentTarget.dispatch('keyup', keyboardEvent('ArrowUp', 'keyup'));
        documentTarget.dispatch('keyup', keyboardEvent('ArrowUp', 'keyup'));

        expect(events.map(event => event.type)).toEqual(['keydown', 'keyup']);
    });

    it('releases every held key when the window blurs', () => {
        documentTarget.dispatch('keydown', keyboardEvent('ArrowUp', 'keydown'));
        documentTarget.dispatch('keydown', keyboardEvent('ArrowLeft', 'keydown'));

        windowTarget.dispatch('blur');
        windowTarget.dispatch('blur');

        expect(events.map(event => `${event.code}:${event.type}`)).toEqual([
            'ArrowUp:keydown',
            'ArrowLeft:keydown',
            'ArrowUp:keyup',
            'ArrowLeft:keyup',
        ]);
    });

    it('releases every held key when the document becomes hidden', () => {
        documentTarget.dispatch('keydown', keyboardEvent('ArrowUp', 'keydown'));
        documentTarget.hidden = true;
        documentTarget.visibilityState = 'hidden';
        documentTarget.dispatch('visibilitychange');

        expect(events.map(event => event.type)).toEqual(['keydown', 'keyup']);
        documentTarget.dispatch('visibilitychange');
        expect(events.map(event => event.type)).toEqual(['keydown', 'keyup']);
    });

    it('suppresses repeats while preserving preventDefault', () => {
        const initial = keyboardEvent('ArrowUp', 'keydown');
        const repeat = keyboardEvent('ArrowUp', 'keydown', {}, true);
        documentTarget.dispatch('keydown', initial);
        documentTarget.dispatch('keydown', repeat);
        documentTarget.dispatch('keyup', keyboardEvent('ArrowUp', 'keyup'));

        expect(initial.defaultPrevented).toBeTrue();
        expect(repeat.defaultPrevented).toBeTrue();
        expect(events.map(event => event.type)).toEqual(['keydown', 'keyup']);
    });

    it('releases a chord when its modifier is released first', () => {
        documentTarget.dispatch('keydown',
            keyboardEvent('ControlLeft', 'keydown', { Control: true }));
        documentTarget.dispatch('keydown',
            keyboardEvent('KeyA', 'keydown', { Control: true }));
        documentTarget.dispatch('keyup',
            keyboardEvent('ControlLeft', 'keyup'));

        expect(events.map(event => `${event.code}:${event.type}`)).toEqual([
            'ControlLeft:keydown',
            'KeyA:keydown',
            'KeyA:keyup',
            'ControlLeft:keyup',
        ]);
        expect(events[2].getModifierState('Control')).toBeTrue();

        // The physical keyup arrives after the synthetic chord release.
        documentTarget.dispatch('keyup', keyboardEvent('KeyA', 'keyup'));
        expect(events).toHaveSize(4);
    });

    it('releases the action that started when a modifier changes later', () => {
        documentTarget.dispatch('keydown', keyboardEvent('KeyA', 'keydown'));
        documentTarget.dispatch('keydown',
            keyboardEvent('ControlLeft', 'keydown', { Control: true }));
        documentTarget.dispatch('keyup',
            keyboardEvent('KeyA', 'keyup', { Control: true }));

        expect(events[2].code).toBe('KeyA');
        expect(events[2].getModifierState('Control')).toBeFalse();
    });

    it('copies prototype keyboard properties to synthetic releases', () => {
        const source = keyboardEvent('ArrowUp', 'keydown');
        const prototype = {
            get code() {
                return 'ArrowUp';
            },
            get key() {
                return 'ArrowUp';
            },
            get location() {
                return 0;
            },
        };
        delete (source as any).code;
        delete (source as any).key;
        delete (source as any).location;
        Object.setPrototypeOf(source, prototype);

        documentTarget.dispatch('keydown', source);
        documentTarget.dispatch('keyup', keyboardEvent('ArrowUp', 'keyup'));

        expect(events[1].type).toBe('keyup');
        expect(events[1].code).toBe('ArrowUp');
        expect(events[1].key).toBe('ArrowUp');
        expect(events[1].location).toBe(0);
    });

    it('removes all listeners when the plugin is removed', async () => {
        await world.removePlugin(KeyboardPlugin);
        documentTarget.dispatch('keydown', keyboardEvent('ArrowUp', 'keydown'));
        windowTarget.dispatch('blur');
        documentTarget.hidden = true;
        documentTarget.visibilityState = 'hidden';
        documentTarget.dispatch('visibilitychange');

        expect(events).toEqual([]);
    });
});
