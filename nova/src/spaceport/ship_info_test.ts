import 'jasmine';
import { PlayerState } from '../nova_plugin/player_state';
import {
    shipInfoCargo,
    shipInfoFacts,
    shipInfoMissions,
    shipInfoOutfits,
    shipInfoStanding,
} from './ship_info_content';
import { getDefaultGovtData, GovtData } from 'novadatainterface/GovtData';
import { SHIP_INFO_LAYOUT } from './ship_info_layout';

function state(overrides: Partial<PlayerState> = {}): PlayerState {
    return {
        pilotName: 'Ishmael',
        shipName: 'Pequod',
        shipId: 'nova:128',
        credits: 12345,
        gameDate: 0,
        currentSystem: 'nova:130',
        cargoCapacity: 20,
        holds: [],
        missionBits: [],
        activeMissions: [],
        landingCount: 3,
        exploredSystems: ['nova:130', 'nova:131'],
        ...overrides,
    } as unknown as PlayerState;
}

describe('pilot status content', () => {
    it('reports the pilot, ship, and holdings', () => {
        const text = shipInfoFacts(state(), 'Shuttle', 'Sol');
        expect(text).toContain('Pilot: Ishmael');
        expect(text).toContain('Ship: Pequod');
        expect(text).toContain('Type: Shuttle');
        expect(text).toContain('12,345 cr');
        expect(text).toContain('System: Sol');
        expect(text).toContain('Cargo: 0 of 20 tons');
        expect(text).toContain('Systems seen: 2');
    });

    it('falls back to the ship id when the type is unknown', () => {
        expect(shipInfoFacts(state(), undefined, undefined))
            .toContain('Type: nova:128');
    });

    it('stays readable with no pilot loaded', () => {
        expect(shipInfoFacts(undefined, undefined, undefined))
            .toContain('not available');
    });

    it('collapses duplicate outfits into counts', () => {
        const outfits = new Map([
            ['nova:1', { count: 3 }],
            ['nova:2', { count: 1 }],
        ]);
        const names = new Map([['nova:1', 'Blaster'], ['nova:2', 'Shield']]);
        const text = shipInfoOutfits(outfits, names);
        expect(text).toContain('3x Blaster');
        expect(text).toContain('Shield');
        expect(text).not.toContain('1x Shield');
    });

    it('names unknown outfits by id rather than dropping them', () => {
        expect(shipInfoOutfits(new Map([['nova:9', { count: 1 }]]), new Map()))
            .toContain('nova:9');
    });

    it('summarises the hold and marks mission cargo', () => {
        expect(shipInfoCargo(state())).toContain('Hold empty');
        const loaded = shipInfoCargo(state({
            holds: [
                { commodity: 'Food', tons: 5, isMissionCargo: false },
                { commodity: 'Documents', tons: 2, isMissionCargo: true },
            ],
        } as unknown as Partial<PlayerState>));
        expect(loaded).toContain('5t Food');
        expect(loaded).toContain('2t Documents (mission)');
    });

    it('lists only active missions', () => {
        expect(shipInfoMissions(state())).toContain('None active.');
        const withMissions = shipInfoMissions(state({
            activeMissions: [
                { missionId: 'nova:1', state: 'active' },
                { missionId: 'nova:2', state: 'failed' },
            ],
        } as unknown as Partial<PlayerState>));
        expect(withMissions).toContain('nova:1');
        expect(withMissions).not.toContain('nova:2');
    });
});

describe('pilot status layout', () => {
    it('keeps every region inside the retail 8507 slots', () => {
        // Slots measured from the artwork, in dialog-centered coordinates.
        const upper = { x: -303, y: -266.5, width: 603, height: 404 };
        const strip = { x: -303, y: 141.5, width: 603, height: 27 };
        const lower = { x: -302, y: 171.5, width: 603, height: 94 };
        const inside = (
            region: { x: number; y: number; width: number; height: number },
            slot: { x: number; y: number; width: number; height: number },
        ) => region.x >= slot.x && region.y >= slot.y
            && region.x + region.width <= slot.x + slot.width
            && region.y + region.height <= slot.y + slot.height;

        expect(inside(SHIP_INFO_LAYOUT.facts, upper)).toBeTrue();
        expect(inside(SHIP_INFO_LAYOUT.outfits, upper)).toBeTrue();
        expect(inside(SHIP_INFO_LAYOUT.summary, strip)).toBeTrue();
        expect(inside(SHIP_INFO_LAYOUT.missions, lower)).toBeTrue();
    });

    it('does not overlap the two upper columns', () => {
        const { facts, outfits } = SHIP_INFO_LAYOUT;
        expect(facts.x + facts.width).toBeLessThanOrEqual(outfits.x);
    });
});

function govt(id: string, overrides: Partial<GovtData> = {}): GovtData {
    return {
        ...getDefaultGovtData(),
        id,
        name: id,
        crimeTolerance: 20,
        ...overrides,
    };
}

describe('pilot standing content', () => {
    const governments = new Map([
        ['nova:128', govt('nova:128', {
            name: 'Federation', mediumName: 'the Federation',
        })],
        ['nova:130', govt('nova:130', { name: 'Pirates' })],
    ]);

    it('reports the combat rating and kill count', () => {
        const text = shipInfoFacts(state({ kills: 4 } as never),
            'Shuttle', 'Sol');
        expect(text).toContain('Combat rating: Average Ability');
        expect(text).toContain('Ships destroyed: 4');
    });

    it('says so when nobody has an opinion', () => {
        expect(shipInfoStanding(state(), governments))
            .toContain('No government has an opinion of you.');
    });

    it('names each government and its verdict', () => {
        const text = shipInfoStanding(state({
            legalRecords: { 'nova:128': -60, 'nova:130': 25 },
        } as never), governments);
        expect(text).toContain('the Federation: Offender');
        expect(text).toContain('Pirates: Good Citizen');
    });

    it('marks a government that now hunts the pilot', () => {
        const text = shipInfoStanding(state({
            legalRecords: { 'nova:128': -60 },
        } as never), governments);
        expect(text).toContain('(hunted)');
    });

    it('leaves a pilot within tolerance unhunted', () => {
        const text = shipInfoStanding(state({
            legalRecords: { 'nova:128': -5 },
        } as never), governments);
        expect(text).not.toContain('(hunted)');
    });

    it('lists the worst standing first', () => {
        const text = shipInfoStanding(state({
            legalRecords: { 'nova:130': 25, 'nova:128': -60 },
        } as never), governments);
        expect(text.indexOf('the Federation'))
            .toBeLessThan(text.indexOf('Pirates'));
    });

    it('falls back to the raw id for an unknown government', () => {
        const text = shipInfoStanding(state({
            legalRecords: { 'nova:999': -30 },
        } as never), governments);
        expect(text).toContain('nova:999');
    });

    it('prefers the retail ladders when they are supplied', () => {
        const text = shipInfoStanding(state({
            legalRecords: { 'nova:128': -30 },
        } as never), governments, { legal: ['a', 'b', 'c', 'zzz'] });
        expect(text).toContain('the Federation: zzz');
    });

    it('keeps the standing pane inside the frame', () => {
        const { standing, facts } = SHIP_INFO_LAYOUT;
        expect(standing.y).toBeGreaterThanOrEqual(facts.y + facts.height);
    });
});
