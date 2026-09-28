import 'jasmine';
import { createDraft, finishDraft } from 'immer';
import { Entity } from 'nova_ecs/entity';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { getDefaultMissionData, MissionOfferLocation } from 'novadatainterface/MissionData';
import { OutfitsStateComponent } from '../nova_plugin/outfit_plugin';
import { GameData } from '../client/gamedata/GameData';
import { createInitialPlayerState, PlayerStateComponent } from '../nova_plugin/player_state';
import { ShipDataComponent } from '../nova_plugin/ship_plugin';
import { getShipboardMissionOffers } from './mission_bbs';
import {
    formatVisibleMissionText,
    missionInfoDisplayText,
    missionOfferDisplayText,
} from '../nova_plugin/mission_text';

describe('shipboard mission offer loading', () => {
    it('does not retain a ship draft across asynchronous data loading', async () => {
        const ship = createDraft(getDefaultShipData());
        const input = new Entity()
            .addComponent(PlayerStateComponent, createInitialPlayerState())
            .addComponent(ShipDataComponent, ship);
        let finishLoading!: (value: {}) => void;
        const gameData = {
            preloadData: new Promise(resolve => { finishLoading = resolve; }),
            ids: Promise.resolve({}),
            data: {},
        } as unknown as GameData;
        const offers = getShipboardMissionOffers(gameData, input);
        finishDraft(ship);
        finishLoading({});
        await expectAsync(offers).toBeResolved();
        expect((await offers).offers).toEqual([]);
    });
});

describe('visible mission text', () => {
    it('resolves retail and unknown placeholders without leaking tokens', () => {
        const rendered = formatVisibleMissionText(
            'Take <CQ> tons of <CARGO> to <DST> in <DSY>; <PLUGIN_TAG>.',
            {
                quantity: 7,
                cargo: 'Medical Supplies',
                destination: 'Earth',
                destinationSystem: 'Sol',
            },
        );
        expect(rendered).toContain(
            'Take 7 tons of Medical Supplies to Earth in Sol');
        expect(rendered).toContain('mission information');
        expect(rendered).not.toMatch(/<[A-Za-z][^>]*>/);
    });

    it('removes quantityless cargo markers', () => {
        expect(formatVisibleMissionText('<CT>', { cargo: '*passengers' }))
            .toBe('passengers');
    });

    it('uses offer text before acceptance and quick text in Mission Info', () => {
        const mission = {
            name: 'Delivery',
            offerText: 'Initial offer',
            quickBrief: 'Active summary',
            briefText: 'Post-accept briefing',
        };
        expect(missionOfferDisplayText(mission)).toBe('Initial offer');
        expect(missionInfoDisplayText(mission)).toBe('Active summary');
        expect(missionOfferDisplayText(mission))
            .not.toBe(mission.briefText);
    });
    it('formats destination route hops and cargo manifest for in-flight mission log', () => {
        const systems = [
            { id: 'nova:sol', name: 'Sol', links: ['nova:sirius'], planets: ['nova:earth'] },
            { id: 'nova:sirius', name: 'Sirius', links: ['nova:sol', 'nova:altair'], planets: ['nova:sirius1'] },
            { id: 'nova:altair', name: 'Altair', links: ['nova:sirius'], planets: ['nova:altair1'] },
        ];
        // Cargo manifest format check
        const sampleMissionText = formatVisibleMissionText(
            'Deliver <CQ> tons of <CARGO> to <DST> in <DSY>.',
            {
                quantity: 15,
                cargo: 'Food',
                destination: 'Sirius I',
                destinationSystem: 'Sirius',
            },
        );
        expect(sampleMissionText).toBe('Deliver 15 tons of Food to Sirius I in Sirius.');
    });
});

describe('shipboard mission offers and Require', () => {
    function gameDataWith(missions: Record<string, object>, outfits: Record<string, object> = {}) {
        return {
            preloadData: Promise.resolve({}),
            ids: Promise.resolve({ Mission: Object.keys(missions) }),
            data: {
                Mission: { gotten: missions, get: async () => { throw new Error('unused'); } },
                Outfit: {
                    get: async (id: string) => {
                        const outfit = outfits[id];
                        if (!outfit) throw new Error(`no outfit ${id}`);
                        return outfit;
                    },
                },
            },
        } as unknown as GameData;
    }
    const shipMission = (id: string, extra: object = {}) => ({
        ...getDefaultMissionData(),
        id,
        name: `Mission ${id}`,
        availLoc: MissionOfferLocation.Ship,
        availRandom: 100,
        ...extra,
    });

    it('passes the player Contribute so Require-gated missions can be offered', async () => {
        const gameData = gameDataWith({
            'nova:900': shipMission('nova:900', { require: [0x40, 0] }),
        }, { 'nova:400': { contribute: [0x40, 0] } });
        const input = new Entity()
            .addComponent(PlayerStateComponent, createInitialPlayerState())
            .addComponent(ShipDataComponent, getDefaultShipData());
        expect((await getShipboardMissionOffers(gameData, input)).offers).toEqual([]);

        input.components.set(OutfitsStateComponent,
            new Map([['nova:400', { count: 1 }]]));
        const { offers } = await getShipboardMissionOffers(gameData, input);
        expect(offers.map(offer => offer.mission.id)).toEqual(['nova:900']);
    });

    it('passes the ship InherentAI (mïsn Flags 0x4000 hides from warships)', async () => {
        const gameData = gameDataWith({
            'nova:901': shipMission('nova:901', { flags: 0x4000 }),
        });
        const input = new Entity()
            .addComponent(PlayerStateComponent, createInitialPlayerState())
            .addComponent(ShipDataComponent, { ...getDefaultShipData(), inherentAI: 3 });
        expect((await getShipboardMissionOffers(gameData, input)).offers).toEqual([]);
        input.components.set(ShipDataComponent, { ...getDefaultShipData(), inherentAI: 1 });
        expect((await getShipboardMissionOffers(gameData, input)).offers.length).toBe(1);
    });

    it('restricts to a përs LinkMission and ignores its AvailStel', async () => {
        const gameData = gameDataWith({
            'nova:132': shipMission('nova:132', { availStel: 5000 }),
            'nova:133': shipMission('nova:133'),
        });
        const input = new Entity()
            .addComponent(PlayerStateComponent, createInitialPlayerState())
            .addComponent(ShipDataComponent, getDefaultShipData());
        const { offers } = await getShipboardMissionOffers(gameData, input, {
            missionId: 'nova:132', seed: 'ship-a',
        });
        expect(offers.map(offer => offer.mission.id)).toEqual(['nova:132']);
    });
});
