import { getDefaultGovtData } from 'novadatainterface/GovtData';
import { MockGameData } from 'novadatainterface/MockGameData';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { getDefaultSystemData } from 'novadatainterface/SystemData';
import { createInitialPlayerState } from '../nova_plugin/player_state';
import { starmapPanelData } from '../spaceport/starmap_content';
import {
    PilotTargetPictureCache,
    RETAIL_MENU_ACTIONS,
    RETAIL_MENU_IDLE_FRAME,
    RETAIL_MENU_ROLLOVER_FRAMES,
    buildPilotStatBlock,
    menuRolloverFrame,
    nextMenuRolloverState,
    requestPilotTargetPicture,
} from './start_menu_model';

describe('start menu pilot statistics', () => {
    function fixture() {
        const gameData = new MockGameData();
        const state = createInitialPlayerState();
        state.pilotName = 'Shane Pierrot';
        state.shipName = 'Ring of Glory';
        state.shipId = 'nova:900';
        state.currentSystem = 'nova:901';
        state.kills = 8;
        state.legalRecords = { 'nova:128': -21 };

        gameData.data.Ship.map.set('nova:900', {
            ...getDefaultShipData(),
            id: 'nova:900',
            name: 'Shuttle',
            pict: 'nova:5000',
            targetPict: 'nova:3000',
        });
        const system = {
            ...getDefaultSystemData(),
            id: 'nova:901',
            name: 'Sol',
            government: 128,
        };
        gameData.data.System.map.set(system.id, system);
        const government = {
            ...getDefaultGovtData(),
            id: 'nova:128',
            name: 'Federation',
            crimeTolerance: 20,
            initialRecord: 0,
        };
        gameData.data.Govt.map.set(government.id, government);
        return { gameData, state, system, government };
    }

    it('assembles all six fields and matches the starmap legal wording',
        async () => {
            const { gameData, state, system, government } = fixture();
            const stats = await buildPilotStatBlock(state, gameData);
            const mapLegalStatus = starmapPanelData({
                system,
                currentSystemId: system.id,
                known: true,
                government,
                legalRecords: state.legalRecords,
            }).legalStatus;

            expect(stats?.left).toEqual([
                { label: 'Pilot Name', value: 'Shane Pierrot' },
                { label: 'Ship Name', value: 'Ring of Glory' },
                { label: 'Ship Class', value: 'Shuttle' },
            ]);
            expect(stats?.right).toEqual([
                {
                    label: 'Legal status in current system',
                    value: mapLegalStatus!,
                },
                { label: 'Combat Rating', value: 'Good Ability' },
                { label: 'Current Date', value: '18 October 1177 NC' },
            ]);
        });

    it('renders no stat labels when no pilot is loaded', async () => {
        const stats = await buildPilotStatBlock(undefined, new MockGameData());

        expect(stats).toBeUndefined();
    });

    it('degrades an unknown ship id without dropping the other fields',
        async () => {
            const { gameData, state } = fixture();
            state.shipId = 'nova:missing';

            const stats = await buildPilotStatBlock(state, gameData);

            expect(stats?.left[2]).toEqual({
                label: 'Ship Class',
                value: 'Unknown',
            });
            expect(stats?.right.length).toBe(3);
        });

    it('requests targeting art only for a resolved pilot ship', async () => {
        const { gameData, state } = fixture();
        const imageRequest = spyOn(gameData.data.PictImage, 'get')
            .and.callThrough();

        const stats = await buildPilotStatBlock(state, gameData);
        expect(imageRequest).not.toHaveBeenCalled();

        expect(await requestPilotTargetPicture(stats, gameData))
            .toBe('nova:3000');
        expect(imageRequest).toHaveBeenCalledOnceWith('nova:3000');
    });

    it('does not request an image when the resolved ship has no target PICT',
        async () => {
            const { gameData, state } = fixture();
            gameData.data.Ship.map.set('nova:900', {
                ...gameData.data.Ship.map.get('nova:900')!,
                targetPict: undefined,
            });
            const imageRequest = spyOn(gameData.data.PictImage, 'get')
                .and.callThrough();

            const stats = await buildPilotStatBlock(state, gameData);

            expect(await requestPilotTargetPicture(stats, gameData))
                .toBeUndefined();
            expect(imageRequest).not.toHaveBeenCalled();
        });

    it('does not request an image without a pilot or a known ship',
        async () => {
            const { gameData, state } = fixture();
            const imageRequest = spyOn(gameData.data.PictImage, 'get')
                .and.callThrough();

            expect(await requestPilotTargetPicture(undefined, gameData))
                .toBeUndefined();
            state.shipId = 'nova:missing';
            const stats = await buildPilotStatBlock(state, gameData);
            expect(await requestPilotTargetPicture(stats, gameData))
                .toBeUndefined();
            expect(imageRequest).not.toHaveBeenCalled();
        });

    it('silently ignores a failed targeting PICT load', async () => {
        const { gameData, state } = fixture();
        spyOn(gameData.data.PictImage, 'get')
            .and.rejectWith(new Error('missing PICT'));
        const stats = await buildPilotStatBlock(state, gameData);

        expect(await requestPilotTargetPicture(stats, gameData))
            .toBeUndefined();
    });

    it('caches targeting picture work until the pilot ship changes',
        async () => {
            const { gameData, state } = fixture();
            const stats = (await buildPilotStatBlock(state, gameData))!;
            const cache = new PilotTargetPictureCache<string>();
            const load = jasmine.createSpy('load')
                .and.callFake(async () => stats.targetPict);

            await cache.get(stats, load);
            await cache.get(stats, load);
            expect(load).toHaveBeenCalledTimes(1);

            await cache.get({ ...stats, shipId: 'nova:901' }, load);
            expect(load).toHaveBeenCalledTimes(2);
        });
});

describe('start menu rollover state', () => {
    it('maps every button to a frame distinct from the idle frame', () => {
        const frames = RETAIL_MENU_ACTIONS.map(
            action => RETAIL_MENU_ROLLOVER_FRAMES[action],
        );

        expect(frames).toEqual([0, 1, 2, 3, 4, 5]);
        expect(new Set(frames).size).toBe(RETAIL_MENU_ACTIONS.length);
        expect(frames).not.toContain(RETAIL_MENU_IDLE_FRAME);
        expect(RETAIL_MENU_IDLE_FRAME).toBe(6);
    });

    it('does not retain a stale icon as keyboard focus moves away', () => {
        let state = nextMenuRolloverState(
            {},
            { type: 'focus', action: 'New Pilot' },
        );
        state = nextMenuRolloverState(
            state,
            { type: 'focus', action: 'Open Pilot' },
        );
        state = nextMenuRolloverState(
            state,
            { type: 'blur', action: 'New Pilot' },
        );
        expect(menuRolloverFrame(state))
            .toBe(RETAIL_MENU_ROLLOVER_FRAMES['Open Pilot']);

        state = nextMenuRolloverState(
            state,
            { type: 'blur', action: 'Open Pilot' },
        );
        expect(menuRolloverFrame(state)).toBe(RETAIL_MENU_IDLE_FRAME);
    });

    it('keeps the destination icon across a pointer transition', () => {
        let state = nextMenuRolloverState(
            {},
            { type: 'pointer-enter', action: 'Quit Nova' },
        );
        state = nextMenuRolloverState(
            state,
            { type: 'pointer-leave', action: 'Quit Nova' },
        );
        state = nextMenuRolloverState(
            state,
            { type: 'pointer-enter', action: 'Set Prefs' },
        );

        expect(menuRolloverFrame(state))
            .toBe(RETAIL_MENU_ROLLOVER_FRAMES['Set Prefs']);
    });
});
