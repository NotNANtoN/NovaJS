import 'jasmine';
import * as PIXI from 'pixi.js';
import { Entity } from 'nova_ecs/entity';
import { Subject } from 'rxjs';
import { MockGameData } from 'novadatainterface/MockGameData';
import { getDefaultMissionData } from 'novadatainterface/MissionData';
import { getDefaultPlanetData } from 'novadatainterface/PlanetData';
import { getDefaultSystemData } from 'novadatainterface/SystemData';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { createInitialPlayerState, PlayerStateComponent } from '../nova_plugin/player_state';
import { OutfitsStateComponent } from '../nova_plugin/outfit_plugin';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import { MissionBbs, MissionInfo } from './mission_bbs';
import { TradeCenter } from './trade_center';
import { Spaceport } from './spaceport';
import { statusBarCargoText } from '../display/status_bar_content';

describe('spaceport sidebar status bar synchronization', () => {
    let gameData: MockGameData;
    let controlEvents: Subject<ControlEvent>;

    beforeEach(() => {
        gameData = new MockGameData();
        controlEvents = new Subject<ControlEvent>();

        // Provide sprite stubs required by Menu and Button components
        (gameData as any).spriteFromPict = () => new PIXI.Sprite(PIXI.Texture.EMPTY);
        (gameData as any).spriteFromPictAsync = async () => new PIXI.Sprite(PIXI.Texture.EMPTY);
        (gameData as any).textureFromPict = () => PIXI.Texture.EMPTY;
        (gameData as any).textureFromPictAsync = async () => PIXI.Texture.EMPTY;

        spyOn(PIXI.CanvasTextMetrics, 'measureText').and.returnValue({
            width: 50,
            height: 12,
            lines: ['test'],
            lineHeight: 12,
            maxLineWidth: 50,
            fontProperties: { ascent: 10, descent: 2, fontSize: 12 },
        } as any);

        // Set up minimal system and planets
        const earth = { ...getDefaultPlanetData(), id: 'nova:earth', name: 'Earth', canLand: true, inhabited: true };
        const mars = { ...getDefaultPlanetData(), id: 'nova:mars', name: 'Mars', canLand: true, inhabited: true };
        gameData.data.Planet.map.set('nova:earth', earth);
        gameData.data.Planet.map.set('nova:mars', mars);

        const sol = {
            ...getDefaultSystemData(),
            id: 'nova:sol',
            name: 'Sol',
            planets: ['nova:earth', 'nova:mars'],
        };
        gameData.data.System.map.set('nova:sol', sol);

        gameData.data.Ship.map.set('nova:128', {
            ...getDefaultShipData(),
            id: 'nova:128',
            cargoCapacity: 50,
        });
    });

    it('immediately calls onUpdateShip and updates free cargo when accepting a mission in MissionBbs', () => {
        const bbs = new MissionBbs(gameData as any, 'nova:earth', controlEvents);
        const state = createInitialPlayerState();
        state.currentSystem = 'nova:sol';
        state.cargoCapacity = 50;
        state.credits = 10_000;

        const ship = new Entity()
            .addComponent(PlayerStateComponent, state)
            .addComponent(OutfitsStateComponent, new Map());

        (bbs as any).setInput(ship);
        (bbs as any).world = {
            systems: [gameData.data.System.map.get('nova:sol')],
            planets: [gameData.data.Planet.map.get('nova:earth'), gameData.data.Planet.map.get('nova:mars')],
            governments: [],
            planetNames: new Map([['nova:earth', 'Earth'], ['nova:mars', 'Mars']]),
            systemNames: new Map([['nova:sol', 'Sol']]),
        };

        const mission1 = {
            ...getDefaultMissionData(),
            id: 'nova:cargo_mission_1',
            name: 'Deliver Medical Supplies',
            cargoType: 3,
            cargoQty: 30,
            payVal: 50_000,
            travelStel: 2, // Mars
            returnStel: -1,
        };

        const mission2 = {
            ...getDefaultMissionData(),
            id: 'nova:cargo_mission_2',
            name: 'Deliver Machine Parts',
            cargoType: 4,
            cargoQty: 25,
            payVal: 40_000,
            travelStel: 2, // Mars
            returnStel: -1,
        };

        (bbs as any).offers = [
            {
                mission: mission1,
                resolved: { travelDestination: 'nova:mars', returnDestination: 'nova:mars' },
                available: true,
            },
            {
                mission: mission2,
                resolved: { travelDestination: 'nova:mars', returnDestination: 'nova:mars' },
                available: true,
            },
        ];
        (bbs as any).selectionIndex = 0;

        let updateCallCount = 0;
        let lastUpdatedShip: Entity | undefined;
        bbs.onUpdateShip = (updatedShip) => {
            updateCallCount++;
            lastUpdatedShip = updatedShip;
        };

        // Accept the first mission (30 tons)
        (bbs as any).acceptSelected();

        expect(updateCallCount).toBeGreaterThanOrEqual(1);
        expect(lastUpdatedShip).toBe(ship);

        const updatedState = ship.components.get(PlayerStateComponent)!;
        expect(updatedState.holds.length).toBe(1);
        expect(updatedState.holds[0].tons).toBe(30);

        // Status bar cargo reading should immediately reflect 20 tons free
        const cargoText = statusBarCargoText(updatedState);
        expect(cargoText.free).toBe('20');

        // Remaining mission requires 25 tons, which exceeds the 20 tons now free,
        // so its available flag must have been updated to false
        const remainingOffers = (bbs as any).offers;
        expect(remainingOffers.length).toBe(1);
        expect(remainingOffers[0].mission.id).toBe('nova:cargo_mission_2');
        expect(remainingOffers[0].available).toBe(false);
    });

    it('immediately calls onUpdateShip when buying and selling commodities in TradeCenter', () => {
        const trade = new TradeCenter(gameData as any, 'nova:earth', controlEvents);
        const state = createInitialPlayerState();
        state.cargoCapacity = 50;
        state.credits = 10_000;

        const ship = new Entity().addComponent(PlayerStateComponent, state);
        (trade as any).setInput(ship);

        (trade as any).offers = [
            { commodity: 'Food', price: 100, priceLevel: 'medium', canBuy: true, canSell: true },
        ];
        (trade as any).selectionIndex = 0;

        let updateCount = 0;
        trade.onUpdateShip = () => {
            updateCount++;
        };

        // Buy 10 tons of Food
        (trade as any).buySelected(10);
        expect(updateCount).toBe(1);
        expect(state.credits).toBe(9_000);
        expect(statusBarCargoText(state).free).toBe('40');

        // Sell 5 tons of Food
        (trade as any).sellSelected(5);
        expect(updateCount).toBe(2);
        expect(state.credits).toBe(9_500);
        expect(statusBarCargoText(state).free).toBe('45');
    });

    it('immediately calls onUpdateShip when aborting a mission in MissionInfo', () => {
        const info = new MissionInfo(gameData as any, controlEvents);
        const state = createInitialPlayerState();
        state.cargoCapacity = 50;
        state.holds = [
            { commodity: 'nova:cargo_mission', tons: 20, isMissionCargo: true },
        ];
        state.activeMissions = [
            {
                missionId: 'nova:cargo_mission',
                missionUuid: 'uuid-1',
                state: 'active',
                destination: 'nova:mars',
                cargo: { type: 1, quantity: 20 },
            },
        ];

        const ship = new Entity().addComponent(PlayerStateComponent, state);
        (info as any).setInput(ship);

        const missionData = {
            ...getDefaultMissionData(),
            id: 'nova:cargo_mission',
            canAbort: true,
        };

        (info as any).entries = [
            {
                entry: state.activeMissions[0],
                mission: missionData,
            },
        ];
        (info as any).selectionIndex = 0;

        let updateCalled = false;
        info.onUpdateShip = () => {
            updateCalled = true;
        };

        (info as any).abortSelected();
        expect(updateCalled).toBe(true);
        expect(statusBarCargoText(state).free).toBe('50');
    });

    it('wires sub-dialog onUpdateShip handlers in Spaceport', () => {
        spyOn(Spaceport.prototype, 'build').and.returnValue(Promise.resolve());
        const planet = { ...getDefaultPlanetData(), id: 'nova:earth', name: 'Earth', services: ['bar', 'trade'] };
        gameData.data.Planet.map.set('nova:earth', planet);

        const spaceport = new Spaceport(gameData as any, 'nova:earth', controlEvents);
        let spaceportUpdateCalled = false;
        spaceport.onUpdateShip = () => {
            spaceportUpdateCalled = true;
        };

        const ship = new Entity().addComponent(PlayerStateComponent, createInitialPlayerState());

        // Calling sub-dialog onUpdateShip propagates to spaceport.onUpdateShip
        (spaceport as any).missionBbs.onUpdateShip(ship);
        expect(spaceportUpdateCalled).toBe(true);

        spaceportUpdateCalled = false;
        (spaceport as any).tradeCenter.onUpdateShip(ship);
        expect(spaceportUpdateCalled).toBe(true);

        spaceportUpdateCalled = false;
        (spaceport as any).missionInfo.onUpdateShip(ship);
        expect(spaceportUpdateCalled).toBe(true);

        spaceportUpdateCalled = false;
        (spaceport as any).bar.onUpdateShip(ship);
        expect(spaceportUpdateCalled).toBe(true);
    });
});
