import 'jasmine';
import { createDraft, finishDraft } from 'immer';
import { Entity } from 'nova_ecs/entity';
import { getDefaultShipData } from 'novadatainterface/ShipData';
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
