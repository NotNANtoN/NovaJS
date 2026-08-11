import 'jasmine';
import { getDefaultShipData } from 'novadatainterface/ship_data';
import { Entity } from 'nova_ecs/entity';
import { BoardingState } from '../nova_plugin/boarding_component.js';
import { CargoComponent } from '../nova_plugin/cargo_plugin.js';
import { FuelComponent } from '../nova_plugin/health_plugin.js';
import { ControlledByComponent } from '../nova_plugin/ship_control.js';
import { ShipDataComponent } from '../nova_plugin/ship_plugin.js';
import { Stat } from '../nova_plugin/stat.js';
import { plunderDialogContent } from './boarding_plugin.js';

/**
 * The plunder dialog's rules, read off the synced boarding state and the
 * victim entity (plunderDialogContent — the pure half of the PIXI widget).
 *
 * The load-bearing case here is Matthew's playtest bug 1: a disabled ship
 * somebody is still FLYING can be robbed but never taken, so the dialog
 * must not offer Capture Ship against one. The dialog reads the same
 * predicate the simulation's capture roll does, off the same synced
 * ControlledByComponent, so the two can never disagree.
 */

const NOTHING_TAKEN = {
    cargoTaken: false, creditsTaken: false, fuelTaken: false,
    ammoTaken: false, crimeApplied: false,
};

function boardingState(overrides: Partial<BoardingState> = {}): BoardingState {
    return {
        target: 'victim', creditsAvailable: 1000, ammoAvailable: 4,
        capture: 'none', ...NOTHING_TAKEN, ...overrides,
    };
}

function victim({ controlled = false, crew = 10 } = {}): Entity {
    const entity = new Entity('victim');
    entity.components.set(ShipDataComponent,
        { ...getDefaultShipData(), crew });
    entity.components.set(CargoComponent, new Map([['Food', 3]]));
    entity.components.set(FuelComponent,
        new Stat({ current: 200, max: 400, min: 0, recharge: 0 }));
    if (controlled) {
        entity.components.set(ControlledByComponent,
            { peerId: 'the other peer' });
    }
    return entity;
}

describe('plunder dialog content', () => {
    it('offers every booty and the capture against an NPC hulk', () => {
        const { enabledByAction, lines } =
            plunderDialogContent(boardingState(), victim(), 100);
        expect(enabledByAction['plunderCargo']).toBeTrue();
        expect(enabledByAction['plunderCredits']).toBeTrue();
        expect(enabledByAction['plunderFuel']).toBeTrue();
        expect(enabledByAction['plunderAmmo']).toBeTrue();
        expect(enabledByAction['plunderCapture']).toBeTrue();
        expect(lines.join('\n')).toContain('Capture Odds:');
    });

    describe('against a ship somebody is flying', () => {
        it('greys Capture Ship but keeps every booty action', () => {
            const { enabledByAction } = plunderDialogContent(
                boardingState(), victim({ controlled: true }), 100);
            expect(enabledByAction['plunderCapture']).toBeFalse();
            // Piracy is still on the menu.
            expect(enabledByAction['plunderCargo']).toBeTrue();
            expect(enabledByAction['plunderCredits']).toBeTrue();
            expect(enabledByAction['plunderFuel']).toBeTrue();
            expect(enabledByAction['plunderAmmo']).toBeTrue();
            expect(enabledByAction['plunderDone']).toBeTrue();
        });

        it('drops the odds readout and says why instead', () => {
            const { lines } = plunderDialogContent(
                boardingState(), victim({ controlled: true }), 100);
            const text = lines.join('\n');
            expect(text).not.toContain('Capture Odds:');
            expect(text).toContain('cannot capture');
        });

        it('greys it even after a hand-forced capture state', () => {
            // The sim can never reach 'succeeded' here; the dialog does
            // not depend on that to keep the action off the menu.
            const { enabledByAction } = plunderDialogContent(
                boardingState({ capture: 'failed' }),
                victim({ controlled: true }), 100);
            expect(enabledByAction['plunderCapture']).toBeFalse();
        });
    });

    it('greys a booty already taken, and Capture after it succeeded', () => {
        const { enabledByAction } = plunderDialogContent(
            boardingState({ cargoTaken: true, capture: 'succeeded' }),
            victim(), 100);
        expect(enabledByAction['plunderCargo']).toBeFalse();
        expect(enabledByAction['plunderCapture']).toBeFalse();
    });
});
