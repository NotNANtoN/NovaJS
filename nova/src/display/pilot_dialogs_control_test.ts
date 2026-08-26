import type { ControlEvent } from '../nova_plugin/controls_plugin';
import {
    handlePilotDialogEvent,
    isDialogStartEdge,
} from './pilot_dialogs_control';

function makeDialog(visible = false) {
    return {
        container: {
            visible,
            position: { set: jasmine.createSpy('set') },
        },
        show: jasmine.createSpy('show').and.resolveTo('entity'),
    };
}

const start = (action: string): ControlEvent[] =>
    [{ action, state: 'start' } as ControlEvent];

describe('pilot dialog controls', () => {
    it('opens on a fresh keypress', () => {
        expect(isDialogStartEdge(start('properties'), 'properties', false))
            .toBeTrue();
    });

    it('ignores the key while its dialog is already open', () => {
        expect(isDialogStartEdge(start('properties'), 'properties', true))
            .toBeFalse();
    });

    it('ignores the key being released', () => {
        const events = [{ action: 'properties', state: false } as ControlEvent];
        expect(isDialogStartEdge(events, 'properties', false)).toBeFalse();
    });

    it('ignores key repeats so holding the key does not reopen it', () => {
        const events =
            [{ action: 'properties', state: 'repeat' } as ControlEvent];
        expect(isDialogStartEdge(events, 'properties', false)).toBeFalse();
    });

    it('does not confuse the two dialogs', () => {
        expect(isDialogStartEdge(start('missions'), 'properties', false))
            .toBeFalse();
    });

    it('centers and shows the dialog with the player entity', async () => {
        const dialog = makeDialog();
        await handlePilotDialogEvent(
            start('missions'), 'missions', dialog, { x: 800, y: 600 },
            'entity');
        expect(dialog.container.position.set).toHaveBeenCalledWith(400, 300);
        expect(dialog.show).toHaveBeenCalledWith('entity');
    });

    it('leaves the dialog alone for unrelated controls', async () => {
        const dialog = makeDialog();
        await handlePilotDialogEvent(
            start('hyperjump'), 'missions', dialog, { x: 800, y: 600 },
            'entity');
        expect(dialog.show).not.toHaveBeenCalled();
    });
});
