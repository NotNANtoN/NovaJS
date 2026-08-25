import { Resource } from '../resource';
import { EcsEvent } from '../events';
import { Plugin } from '../plugin';


const KeyboardResource = new Resource<undefined>('KeyboardResource');

const prevented = new Set([
    'Tab',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    ' ',
]);

export const EcsKeyboardEvent = new EcsEvent<KeyboardEvent>('KeyboardEvent');
const KeyReportResource = new Resource<(event: KeyboardEvent) => void>('KeyReportResource');
const KeyboardCleanupResource = new Resource<() => void>(
    'KeyboardCleanupResource');

const modifierNames = [
    'Alt',
    'AltGraph',
    'CapsLock',
    'Control',
    'Fn',
    'FnLock',
    'Meta',
    'NumLock',
    'ScrollLock',
    'Shift',
    'Super',
    'Symbol',
    'SymbolLock',
];

interface HeldKey {
    readonly id: string;
    readonly event: KeyboardEvent;
    readonly modifiers: ReadonlyMap<string, boolean>;
}

function keyId(event: Pick<KeyboardEvent, 'code' | 'key'>): string {
    return event.code || event.key;
}

function modifierProperty(
    event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
    modifier: string,
): boolean | undefined {
    switch (modifier) {
        case 'Alt':
            return event.altKey;
        case 'Control':
            return event.ctrlKey;
        case 'Meta':
            return event.metaKey;
        case 'Shift':
            return event.shiftKey;
        default:
            return undefined;
    }
}

function modifierPressed(event: KeyboardEvent, modifier: string): boolean {
    if (typeof event.getModifierState === 'function') {
        return event.getModifierState(modifier);
    }
    return modifierProperty(event, modifier) ?? false;
}

function snapshotModifiers(event: KeyboardEvent): ReadonlyMap<string, boolean> {
    return new Map(modifierNames.map(modifier =>
        [modifier, modifierPressed(event, modifier)] as const));
}

function modifierWasReleased(
    held: HeldKey,
    event: KeyboardEvent,
): boolean {
    for (const [modifier, wasPressed] of held.modifiers) {
        if (wasPressed && !modifierPressed(event, modifier)) {
            return true;
        }
    }
    return false;
}

function syntheticKeyup(held: HeldKey): KeyboardEvent {
    const source = held.event;
    return {
        type: 'keyup',
        key: source.key,
        code: source.code,
        location: source.location,
        ctrlKey: held.modifiers.get('Control') ?? source.ctrlKey,
        altKey: held.modifiers.get('Alt') ?? source.altKey,
        metaKey: held.modifiers.get('Meta') ?? source.metaKey,
        shiftKey: held.modifiers.get('Shift') ?? source.shiftKey,
        repeat: false,
        getModifierState: (modifier: string) =>
            held.modifiers.get(modifier)
            ?? modifierPressed(source, modifier),
    } as KeyboardEvent;
}

export function shouldReportKeyboardEvent(
    event: Pick<KeyboardEvent, 'repeat'>,
): boolean {
    return !event.repeat;
}

export function shouldPreventKeyboardDefault(
    event: Pick<KeyboardEvent, 'key'>,
): boolean {
    return prevented.has(event.key);
}

export const KeyboardPlugin: Plugin = {
    name: 'KeyboardPlugin',
    build(world) {
        // Only add once
        if (world.resources.has(KeyboardResource)) {
            return;
        }
        if (world.resources.has(KeyReportResource)
            || world.resources.has(KeyboardCleanupResource)) {
            throw new Error('World already had keyboard listeners');
        }
        world.resources.set(KeyboardResource, undefined);

        const heldKeys = new Map<string, HeldKey>();

        function releaseHeldKeys() {
            const held = [...heldKeys.values()];
            heldKeys.clear();
            for (const key of held) {
                world.emit(EcsKeyboardEvent, syntheticKeyup(key));
            }
        }

        function report(event: KeyboardEvent) {
            // Prevent gameplay navigation from scrolling the document or
            // moving the caret in an input that retained focus after launch.
            // This must also run for ignored repeat events.
            if (shouldPreventKeyboardDefault(event)) {
                event.preventDefault();
            }
            // Continuous controls are held in ControlState until keyup. Browser
            // key-repeat events add no state, but each world.emit flushes the
            // complete ECS and replication pipeline. On a physical keyboard
            // that produced ~30 redundant simulation flushes per second and
            // made rendering appear frozen until the key was released.
            if (!shouldReportKeyboardEvent(event)) {
                return;
            }

            const id = keyId(event);
            if (event.type === 'keydown') {
                // Keep the first event's modifier snapshot. A repeated
                // keydown must not replace it with a later modifier state.
                if (!heldKeys.has(id)) {
                    heldKeys.set(id, {
                        id,
                        event,
                        modifiers: snapshotModifiers(event),
                    });
                }
                world.emit(EcsKeyboardEvent, event);
                return;
            }

            if (event.type !== 'keyup') {
                return;
            }

            // If a modifier is released before the gameplay key it modified,
            // the browser's eventual keyup no longer matches the configured
            // chord. Release that gameplay key using its original modifier
            // snapshot, then ignore its later physical keyup.
            for (const [heldId, held] of [...heldKeys]) {
                if (heldId !== id && modifierWasReleased(held, event)) {
                    heldKeys.delete(heldId);
                    world.emit(EcsKeyboardEvent, syntheticKeyup(held));
                }
            }

            // Unknown keyups are either duplicates or keydowns that happened
            // before this plugin was installed. Neither should create a
            // second release event.
            const held = heldKeys.get(id);
            if (held) {
                heldKeys.delete(id);
                // Match the modifier state from the keydown. This releases
                // the action that actually started even when a modifier was
                // pressed after the gameplay key or released before it.
                world.emit(EcsKeyboardEvent, syntheticKeyup(held));
            }
        }

        const onBlur = () => releaseHeldKeys();
        const onVisibilityChange = () => {
            if (document.visibilityState === 'hidden' || document.hidden) {
                releaseHeldKeys();
            }
        };
        const windowTarget = typeof window === 'undefined'
            ? undefined
            : window;

        document.addEventListener('keydown', report);
        document.addEventListener('keyup', report);
        windowTarget?.addEventListener('blur', onBlur);
        document.addEventListener('visibilitychange', onVisibilityChange);
        world.resources.set(KeyReportResource, report);
        world.resources.set(KeyboardCleanupResource, () => {
            document.removeEventListener('keydown', report);
            document.removeEventListener('keyup', report);
            windowTarget?.removeEventListener('blur', onBlur);
            document.removeEventListener(
                'visibilitychange', onVisibilityChange);
            heldKeys.clear();
        });
    },
    remove(world) {
        const report = world.resources.get(KeyReportResource);
        world.resources.get(KeyboardCleanupResource)?.();
        // Keep this fallback for worlds created before the cleanup resource
        // was installed or for a partially failed build.
        if (report && !world.resources.has(KeyboardCleanupResource)) {
            document.removeEventListener('keydown', report);
            document.removeEventListener('keyup', report);
        }
        world.resources.delete(KeyboardCleanupResource);
        world.resources.delete(KeyReportResource);
        world.resources.delete(KeyboardResource);
    }
};
