import type { ControlEvent } from '../nova_plugin/controls_plugin';

/** The pilot dialogs retail opens from the cockpit. */
export type PilotDialogAction = 'properties' | 'missions' | 'hail';

export interface PilotDialog<T> {
    readonly container: {
        readonly visible: boolean;
        readonly position: {
            set(x: number, y: number): unknown;
        };
    };
    show(input: T): Promise<T>;
}

export interface DialogScreenSize {
    x: number;
    y: number;
}

/**
 * Only a fresh keypress opens a dialog, and only while it is closed. Holding
 * the key down would otherwise reopen it the moment its own handler closed it.
 */
export function isDialogStartEdge(
    controlEvent: readonly ControlEvent[],
    action: PilotDialogAction,
    visible: boolean,
): boolean {
    return !visible && controlEvent.some(event =>
        event.action === action && event.state === 'start');
}

export async function handlePilotDialogEvent<T>(
    controlEvent: readonly ControlEvent[],
    action: PilotDialogAction,
    dialog: PilotDialog<T>,
    screenSize: DialogScreenSize,
    input: T,
): Promise<void> {
    if (!isDialogStartEdge(controlEvent, action, dialog.container.visible)) {
        return;
    }
    dialog.container.position.set(screenSize.x / 2, screenSize.y / 2);
    await dialog.show(input);
}
