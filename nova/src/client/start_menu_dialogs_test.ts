import { createInitialPlayerState } from '../nova_plugin/player_state';
import { EncodedEntity } from 'nova_ecs/plugins/serializer_plugin';
import {
    buildPilotChoices,
    canEnterShip,
    controlReference,
} from './start_menu_dialogs';
import {
    isStartMenuActionDisabled,
    menuPresentationForRetailAssets,
    pilotDeathNotice,
    pilotQuarantineNotice,
} from './start_menu';

describe('start menu action state', () => {
    it('shows the usable fallback while retail artwork loads', () => {
        expect(menuPresentationForRetailAssets('loading')).toBe('fallback');
        expect(menuPresentationForRetailAssets('ready')).toBe('retail');
        expect(menuPresentationForRetailAssets('unavailable'))
            .toBe('fallback');
    });

    it('only enables Enter Ship when a pilot is selected', () => {
        expect(canEnterShip(undefined)).toBeFalse();
        expect(canEnterShip(createInitialPlayerState())).toBeTrue();
    });

    it('requires a dead pilot to restore a snapshot or start over', () => {
        const dead = createInitialPlayerState();
        dead.diedAt = 12_345;
        const restored = createInitialPlayerState();

        expect(canEnterShip(dead)).toBeFalse();
        expect(canEnterShip(restored)).toBeTrue();
        expect(pilotDeathNotice(dead)).toContain('LOAD A SAVED PILOT');
        expect(buildPilotChoices(dead, []).length).toBe(0);
        expect(buildPilotChoices(dead, [{
            id: 'landing',
            createdAt: 10_000,
            reason: 'landing',
        }]).map(choice => choice.id)).toEqual(['landing']);
    });

    it('describes record and file quarantine distinctly', () => {
        const record = pilotQuarantineNotice('record');
        const file = pilotQuarantineNotice('file');
        expect(record).not.toBe(file);
        // The pilot must be told their save still exists, or they will
        // assume it is gone and start over.
        for (const notice of [record, file]) {
            expect(notice).toContain('NOTHING WAS DELETED');
            expect(notice).toContain('REPORT THIS');
        }
        // Only a whole-file failure makes saving impossible.
        expect(file).toContain('NOTHING CAN BE SAVED');
        expect(record).not.toContain('NOTHING CAN BE SAVED');
        expect(pilotQuarantineNotice('none')).toBeUndefined();
        expect(pilotQuarantineNotice(undefined)).toBeUndefined();
    });

    it('blocks play actions but keeps recovery available during quarantine',
        () => {
        for (const quarantine of ['record', 'file'] as const) {
            expect(isStartMenuActionDisabled(
                'New Pilot', undefined, quarantine)).toBeTrue();
            expect(isStartMenuActionDisabled(
                'Enter Ship', createInitialPlayerState(), quarantine))
                .toBeTrue();
            expect(isStartMenuActionDisabled(
                'Open Pilot', undefined, quarantine)).toBeFalse();
            expect(isStartMenuActionDisabled(
                'Quit Nova', undefined, quarantine)).toBeFalse();
            expect(isStartMenuActionDisabled(
                'Set Prefs', undefined, quarantine)).toBeFalse();
            expect(isStartMenuActionDisabled(
                'About Nova', undefined, quarantine)).toBeFalse();
        }
    });

    it('lists the current pilot first and snapshots newest-first', () => {
        const current = createInitialPlayerState();
        current.pilotName = 'Current Captain';
        current.currentSystem = 'nova:130';
        const ship: EncodedEntity = {
            components: [['Ship', { id: current.shipId }]],
        };

        const choices = buildPilotChoices(current, [
            {
                id: 'older',
                createdAt: 100,
                reason: 'landing',
                pilotName: 'Older Captain',
                currentSystem: 'nova:134',
            },
            {
                id: 'newer',
                createdAt: 200,
                reason: 'manual',
                pilotName: 'Newer Captain',
                currentSystem: 'nova:136',
            },
        ], undefined, ship);

        expect(choices.map(choice => choice.id))
            .toEqual(['current', 'newer', 'older']);
        expect(choices[0]).toEqual(jasmine.objectContaining({
            pilotName: 'Current Captain',
            currentSystem: 'nova:130',
            savedAt: 200,
            ship,
        }));
        expect(choices[1]).toEqual(jasmine.objectContaining({
            pilotName: 'Newer Captain',
            currentSystem: 'nova:136',
        }));
    });

    it('keeps snapshot metadata useful with an older server response', () => {
        const current = createInitialPlayerState();
        current.pilotName = 'Fallback Captain';
        current.currentSystem = 'nova:130';

        const choices = buildPilotChoices(current, [{
            id: 'legacy',
            createdAt: 100,
            reason: 'landing',
        }]);

        expect(choices[1]).toEqual(jasmine.objectContaining({
            pilotName: 'Fallback Captain',
            currentSystem: 'nova:130',
        }));
    });

    it('formats configured control bindings for the read-only reference', () => {
        const reference = controlReference({
            accelerate: 'KeyI',
            friendlyTarget: {
                key: 'Tab',
                modifiers: ['Alt'],
            },
        });

        expect(reference.find(entry => entry.action === 'Accelerate')?.binding)
            .toBe('I');
        expect(reference.find(entry => entry.action === 'Fire primary')?.binding)
            .toBe('Space');
    });
});
