import 'jasmine';
import { GovtData, getDefaultGovtData } from 'novadatainterface/GovtData';
import { createInitialPlayerState, PlayerState } from '../nova_plugin/player_state';
import {
    cargoHoldLabel,
    shipInfoCargo,
    shipInfoStanding,
    SHIP_INFO_STANDING_LIMIT,
} from './ship_info_content';

const CARGO_NAMES = ['Food', 'Industrial', 'Medical Supplies'];

function govt(
    name: string,
    initialRecord = 0,
    crimeTolerance = 6,
): GovtData {
    return { ...getDefaultGovtData(), name, mediumName: name, initialRecord, crimeTolerance };
}

describe('the legal record on ship info', () => {
    it('says nothing about a government the pilot has not moved', () => {
        const state = createInitialPlayerState();
        state.legalRecords = { 'nova:128': 5 };
        const text = shipInfoStanding(
            state, new Map([['nova:128', govt('Federation', 5)]]));
        expect(text).toContain('No government has an opinion');
        expect(text).not.toContain('Federation');
    });

    it('lists a government the pilot has actually offended', () => {
        const state = createInitialPlayerState();
        state.legalRecords = { 'nova:128': -40 };
        const text = shipInfoStanding(
            state, new Map([['nova:128', govt('Federation')]]));
        expect(text).toContain('Federation');
        expect(text).toContain('hunted');
    });

    it('shows one line per name, keeping the worst standing', () => {
        const state = createInitialPlayerState();
        state.legalRecords = { a: -10, b: -60, c: -30 };
        const text = shipInfoStanding(state, new Map([
            ['a', govt('Federation')],
            ['b', govt('Federation')],
            ['c', govt('Federation')],
        ]));
        const lines = text.split('\n').filter(line => line.includes('Federation'));
        expect(lines.length).toEqual(1);
    });

    it('keeps the list inside its pane and counts what it dropped', () => {
        const state = createInitialPlayerState();
        const governments = new Map<string, GovtData>();
        const records: Record<string, number> = {};
        for (let i = 0; i < SHIP_INFO_STANDING_LIMIT + 3; i++) {
            records[`g${i}`] = -10 - i;
            governments.set(`g${i}`, govt(`Govt ${i}`));
        }
        state.legalRecords = records;
        const lines = shipInfoStanding(state, governments).split('\n');
        expect(lines.filter(line => line.startsWith('Govt')).length)
            .toEqual(SHIP_INFO_STANDING_LIMIT);
        expect(lines[lines.length - 1]).toEqual('and 3 more');
    });
});

describe('naming what is in the hold', () => {
    it('leaves ordinary cargo as it is', () => {
        expect(cargoHoldLabel({ commodity: 'Food' }, [], CARGO_NAMES))
            .toEqual('Food');
    });

    it('names mission cargo from its CargoType instead of the mission id', () => {
        const label = cargoHoldLabel(
            { commodity: 'proc:65495f4:2', isMissionCargo: true },
            [{ missionId: 'proc:65495f4:2', cargo: { type: 2 } }],
            CARGO_NAMES);
        expect(label).toEqual('Medical Supplies');
    });

    it('hides an id it cannot name', () => {
        expect(cargoHoldLabel(
            { commodity: 'proc:1', isMissionCargo: true }, [], CARGO_NAMES))
            .toEqual('mission cargo');
        expect(cargoHoldLabel(
            { commodity: 'proc:1', isMissionCargo: true },
            [{ missionId: 'proc:1', cargo: { type: 99 } }], CARGO_NAMES))
            .toEqual('mission cargo');
    });

    it('keeps a mission hold that already reads as a commodity', () => {
        expect(cargoHoldLabel(
            { commodity: 'Documents', isMissionCargo: true }, [], CARGO_NAMES))
            .toEqual('Documents');
    });

    it('shows the named cargo in the hold summary', () => {
        const state: PlayerState = createInitialPlayerState();
        state.holds = [
            { commodity: 'Food', tons: 1, isMissionCargo: false },
            { commodity: 'm1', tons: 7, isMissionCargo: true },
        ];
        state.activeMissions = [{
            missionId: 'm1',
            state: 'active',
            cargo: { type: 2, quantity: 7 },
        } as PlayerState['activeMissions'][number]];
        const text = shipInfoCargo(state, CARGO_NAMES);
        expect(text).toContain('1t Food');
        expect(text).toContain('7t Medical Supplies (mission)');
    });
});
