import 'jasmine';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';
import {
    MovementPhysicsComponent,
    MovementPlugin,
    MovementStateComponent,
    MovementType,
} from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { World } from 'nova_ecs/world';
import {
    BOARDING_MAX_RELATIVE_SPEED,
    BOARDING_STANDOFF,
    BOARDING_TRANSFER_RANGE,
    BoardingInventory,
    BoardingInventoryComponent,
    BoardingOutcomeEvent,
    BoardingRequestComponent,
    BoardingStateComponent,
    bootyCommodities,
    initialNpcInventory,
    PlayerBoardingInputSystem,
    PlayerBoardingSystem,
    PirateBoarderComponent,
    PirateBoardingSystem,
    plundersDisabledShips,
    plunderShip,
} from './boarding_plugin';
import { ControlStateEvent } from './control_state_event';
import { DisabledComponent } from './death_plugin';
import { ArmorComponent } from './health_plugin';
import { NpcAIComponent } from './npc_components';
import {
    allocateCargo,
    createInitialPlayerState,
    PlayerStateComponent,
} from './player_state';
import { PlatformResource } from './platform_plugin';
import { PlayerShipSelector } from './player_ship_plugin';
import { Stat } from './stat';
import { TargetComponent } from './target_component';
import { ShipComponent, ShipDataComponent } from './ship_plugin';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { WeaponsStateComponent } from './weapons_state';

function movementAt(
    position: Position,
    velocity = new Vector(0, 0),
    rotation = new Angle(0),
) {
    return {
        accelerating: 0,
        position,
        rotation,
        turnBack: false,
        turning: 0,
        velocity,
    };
}

async function makeWorld() {
    const world = new World('boarding-test');
    world.resources.set(TimeResource, {
        time: 0,
        delta_ms: 1_000 / 60,
        delta_s: 1 / 60,
        frame: 0,
    });
    world.resources.set(PlatformResource, 'node');
    await world.addPlugin(DeltaPlugin);
    await world.addPlugin(MovementPlugin);
    world.addSystem(PirateBoardingSystem);
    return world;
}

function pirateAt(position: Position, target: string) {
    const inventory: BoardingInventory = {
        cargoCapacity: 20,
        credits: 0,
        holds: [],
    };
    return new Entity('pirate')
        .addComponent(NpcAIComponent, undefined)
        .addComponent(PirateBoarderComponent, { enabled: true })
        .addComponent(BoardingStateComponent, { boarded: [] })
        .addComponent(BoardingInventoryComponent, inventory)
        .addComponent(TargetComponent, { target })
        .addComponent(MultiplayerData, { owner: 'server' })
        .addComponent(MovementStateComponent, movementAt(
            position, new Vector(0, 0), new Angle(Math.PI / 2)))
        .addComponent(MovementPhysicsComponent, {
            acceleration: 100,
            maxVelocity: 160,
            movementType: MovementType.INERTIAL,
            turnRate: 3,
        })
        .addComponent(ArmorComponent, new Stat({
            current: 100,
            max: 100,
            recharge: 0,
        }))
        .addComponent(WeaponsStateComponent, new Map([
            ['laser', { count: 1, firing: true, target }],
        ]));
}

describe('pirate boarding', () => {
    it('flies alongside a drifting disabled player before plundering', async () => {
        const world = await makeWorld();
        const playerState = createInitialPlayerState();
        playerState.credits = 100;
        playerState.cargoCapacity = 20;
        allocateCargo(playerState, {
            commodity: 'Food',
            tons: 8,
            isMissionCargo: false,
        });
        allocateCargo(playerState, {
            commodity: 'mission:rescue',
            tons: 2,
            isMissionCargo: true,
        });
        const victim = new Entity('victim')
            .addComponent(DisabledComponent, true)
            .addComponent(PlayerStateComponent, playerState)
            .addComponent(MovementStateComponent, movementAt(
                new Position(1_200, 0), new Vector(8, 0)))
            .addComponent(ArmorComponent, new Stat({
                current: 20,
                max: 100,
                recharge: 0,
            }));
        const pirate = pirateAt(new Position(0, 0), 'victim');
        world.entities.set('victim', victim);
        world.entities.set('pirate', pirate);

        let steps = 0;
        while (!pirate.components.get(BoardingStateComponent)!
            .boarded.includes('victim') && steps < 2_400) {
            world.step();
            steps++;
        }

        expect(steps).toBeLessThan(2_400);
        const pirateMovement =
            pirate.components.get(MovementStateComponent)!;
        const victimMovement =
            victim.components.get(MovementStateComponent)!;
        expect(victimMovement.position.subtract(pirateMovement.position).length)
            .toBeLessThanOrEqual(BOARDING_TRANSFER_RANGE);
        expect(victimMovement.velocity.subtract(pirateMovement.velocity).length)
            .toBeLessThanOrEqual(BOARDING_MAX_RELATIVE_SPEED);

        const playerAfter = victim.components.get(PlayerStateComponent)!;
        expect(playerAfter.credits).toBe(75);
        expect(playerAfter.holds.find(hold => hold.commodity === 'Food'))
            .toBeUndefined();
        expect(playerAfter.holds.find(
            hold => hold.commodity === 'mission:rescue')?.tons).toBe(2);
        const pirateInventory =
            pirate.components.get(BoardingInventoryComponent)!;
        expect(pirateInventory.credits).toBe(25);
        expect(pirateInventory.holds).toEqual([{
            commodity: 'Food',
            tons: 8,
            isMissionCargo: false,
        }]);
        expect(pirate.components.get(WeaponsStateComponent)!.get('laser')!
            .firing).toBeFalse();
        expect(pirate.components.get(TargetComponent)!.target).toBeUndefined();
        expect(pirateMovement.accelerating).toBe(1);
    });

    it('moves NPC cargo and credits without taking mission cargo', () => {
        const boarder: BoardingInventory = {
            cargoCapacity: 5,
            credits: 10,
            holds: [],
        };
        const victim: BoardingInventory = {
            cargoCapacity: 20,
            credits: 80,
            holds: [
                { commodity: 'Metal', tons: 7, isMissionCargo: false },
                { commodity: 'mission:aid', tons: 3, isMissionCargo: true },
            ],
        };

        expect(plunderShip(boarder, undefined, victim))
            .toEqual({ cargo: 5, credits: 20 });
        expect(boarder).toEqual({
            cargoCapacity: 5,
            credits: 30,
            holds: [
                { commodity: 'Metal', tons: 5, isMissionCargo: false },
            ],
        });
        expect(victim).toEqual({
            cargoCapacity: 20,
            credits: 60,
            holds: [
                { commodity: 'Metal', tons: 2, isMissionCargo: false },
                { commodity: 'mission:aid', tons: 3, isMissionCargo: true },
            ],
        });
    });

    it('recognises plunderers by the retail flag, not by name', () => {
        // Retail's Marauder government carries 0xf293 and boards, while it
        // never says "pirate"; the Federation's 0xe2b0 lacks the bit.
        expect(plundersDisabledShips({ flags: 0xf293 })).toBeTrue();
        expect(plundersDisabledShips({ flags: 0xf2b3 })).toBeTrue();
        expect(plundersDisabledShips({ flags: 0xe2b0 })).toBeFalse();
        expect(plundersDisabledShips({ flags: undefined })).toBeFalse();
    });

    it('derives cargo and money eligibility from the spawning düde flags',
        () => {
            expect(bootyCommodities(0x7f)).toEqual([
                'Food',
                'Industrial Goods',
                'Medical Supplies',
                'Luxury Goods',
                'Metal',
                'Equipment',
            ]);
            expect(initialNpcInventory(
                { cargoCapacity: 20, cost: 100_000 }, 0x40))
                .toEqual({ cargoCapacity: 20, credits: 100, holds: [] });
            expect(initialNpcInventory(
                { cargoCapacity: 12, cost: 100_000 }, 0x3f).holds
                .map(hold => hold.commodity))
                .toEqual(bootyCommodities(0x3f));
            expect(initialNpcInventory(
                { cargoCapacity: 20, cost: 100_000 }, 0))
                .toEqual({ cargoCapacity: 20, credits: 0, holds: [] });
        });

    it('boards a disabled target from the player board control', () => {
        const world = new World('player-boarding-test');
        world.resources.set(PlatformResource, 'browser');
        world.resources.set(TimeResource, {
            time: 0,
            delta_ms: 1_000 / 60,
            delta_s: 1 / 60,
            frame: 0,
        });
        world.addSystem(PlayerBoardingInputSystem);

        const playerState = createInitialPlayerState();
        playerState.credits = 100;
        playerState.cargoCapacity = 20;
        const player = new Entity('player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(PlayerStateComponent, playerState)
            .addComponent(TargetComponent, { target: 'victim' })
            .addComponent(MultiplayerData, { owner: 'player' })
            .addComponent(MovementStateComponent, movementAt(
                new Position(0, 0)));
        const victimInventory: BoardingInventory = {
            cargoCapacity: 20,
            credits: 100,
            holds: [{
                commodity: 'Food',
                tons: 8,
                isMissionCargo: false,
            }],
        };
        const victim = new Entity('victim')
            .addComponent(DisabledComponent, true)
            .addComponent(MovementStateComponent, movementAt(
                new Position(BOARDING_STANDOFF, 0)))
            .addComponent(BoardingInventoryComponent, victimInventory)
            .addComponent(ArmorComponent, new Stat({
                current: 20,
                max: 100,
                recharge: 0,
            }));
        world.entities.set('player', player);
        world.entities.set('victim', victim);

        world.emitNow(ControlStateEvent, new Map([
            ['board', 'start'],
        ]));
        expect(player.components.get(BoardingRequestComponent))
            .toEqual({ target: 'victim', sequence: 1 });

        world.resources.set(PlatformResource, 'node');
        world.addSystem(PlayerBoardingSystem);
        let outcome: unknown;
        world.events.get(BoardingOutcomeEvent).subscribe(value => {
            outcome = value;
        });
        world.step();

        expect(outcome).toEqual({
            boarder: 'player',
            target: 'victim',
            sequence: 1,
            cargo: 8,
            credits: 25,
        });
        expect(playerState.credits).toBe(125);
        expect(playerState.holds).toEqual([{
            commodity: 'Food',
            tons: 8,
            isMissionCargo: false,
        }]);
        expect(victimInventory.holds).toEqual([]);
        expect(player.components.get(BoardingStateComponent))
            .toEqual({ boarded: ['victim'] });
    });

    it('captures a disabled NPC ship into player escorts when boarded', () => {
        const world = new World('player-capture-test');
        world.resources.set(PlatformResource, 'node');
        world.resources.set(TimeResource, {
            time: 0,
            delta_ms: 1_000 / 60,
            delta_s: 1 / 60,
            frame: 0,
        });

        const playerState = createInitialPlayerState();
        playerState.credits = 100;
        playerState.cargoCapacity = 20;
        playerState.kills = 50;
        const player = new Entity('player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(PlayerStateComponent, playerState)
            .addComponent(MultiplayerData, { owner: 'player' })
            .addComponent(MovementStateComponent, movementAt(new Position(0, 0)))
            .addComponent(BoardingRequestComponent, { target: 'victim', sequence: 1 });

        const shipData = {
            ...getDefaultShipData(),
            id: 'nova:130',
            name: 'Kestrel',
            crew: 5,
            cost: 200_000,
        };

        const victim = new Entity('victim')
            .addComponent(DisabledComponent, true)
            .addComponent(MovementStateComponent, movementAt(new Position(BOARDING_STANDOFF, 0)))
            .addComponent(ShipComponent, { id: 'nova:130' })
            .addComponent(ShipDataComponent, shipData)
            .addComponent(ArmorComponent, new Stat({ current: 20, max: 100, recharge: 0 }));

        world.entities.set('player', player);
        world.entities.set('victim', victim);
        world.addSystem(PlayerBoardingSystem);

        let outcome: any;
        world.events.get(BoardingOutcomeEvent).subscribe(value => {
            outcome = value;
        });
        spyOn(Math, 'random').and.returnValue(0.1);
        world.step();

        expect(outcome.target).toBe('victim');
        expect(outcome.capturedShip).toBe('Kestrel');
        expect(playerState.escorts?.length).toBe(1);
        expect(playerState.escorts?.[0].shipId).toBe('nova:130');
        expect(world.entities.has('victim')).toBeFalse();
    });

    it('reports resisted when capture roll fails', () => {
        const world = new World('player-capture-resist-test');
        world.resources.set(PlatformResource, 'node');
        world.resources.set(TimeResource, {
            time: 0,
            delta_ms: 1_000 / 60,
            delta_s: 1 / 60,
            frame: 0,
        });

        const playerState = createInitialPlayerState();
        const player = new Entity('player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(PlayerStateComponent, playerState)
            .addComponent(MultiplayerData, { owner: 'player' })
            .addComponent(MovementStateComponent, movementAt(new Position(0, 0)))
            .addComponent(BoardingRequestComponent, { target: 'victim', sequence: 1 });

        const shipData = {
            ...getDefaultShipData(),
            id: 'nova:130',
            name: 'Kestrel',
            crew: 50,
            cost: 200_000,
        };

        const victim = new Entity('victim')
            .addComponent(DisabledComponent, true)
            .addComponent(MovementStateComponent, movementAt(new Position(BOARDING_STANDOFF, 0)))
            .addComponent(ShipComponent, { id: 'nova:130' })
            .addComponent(ShipDataComponent, shipData)
            .addComponent(ArmorComponent, new Stat({ current: 20, max: 100, recharge: 0 }));

        world.entities.set('player', player);
        world.entities.set('victim', victim);
        world.addSystem(PlayerBoardingSystem);

        let outcome: any;
        world.events.get(BoardingOutcomeEvent).subscribe(value => {
            outcome = value;
        });

        spyOn(Math, 'random').and.returnValue(0.99);
        world.step();

        expect(outcome.target).toBe('victim');
        expect(outcome.resisted).toBeTrue();
        expect(outcome.capturedShip).toBeUndefined();
        expect(playerState.escorts?.length ?? 0).toBe(0);
        expect(world.entities.has('victim')).toBeTrue();
    });

    it('plunders cargo without capturing when action is plunder', () => {
        const world = new World('player-plunder-action-test');
        world.resources.set(PlatformResource, 'node');
        world.resources.set(TimeResource, {
            time: 0,
            delta_ms: 1_000 / 60,
            delta_s: 1 / 60,
            frame: 0,
        });

        const playerState = createInitialPlayerState();
        playerState.credits = 100;
        playerState.cargoCapacity = 20;
        const player = new Entity('player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(PlayerStateComponent, playerState)
            .addComponent(MultiplayerData, { owner: 'player' })
            .addComponent(MovementStateComponent, movementAt(new Position(0, 0)))
            .addComponent(BoardingRequestComponent, { target: 'victim', sequence: 1, action: 'plunder' });

        const victimInventory: BoardingInventory = {
            cargoCapacity: 20,
            credits: 200,
            holds: [{ commodity: 'Metal', tons: 5, isMissionCargo: false }],
        };
        const victim = new Entity('victim')
            .addComponent(DisabledComponent, true)
            .addComponent(MovementStateComponent, movementAt(new Position(BOARDING_STANDOFF, 0)))
            .addComponent(BoardingInventoryComponent, victimInventory)
            .addComponent(ArmorComponent, new Stat({ current: 20, max: 100, recharge: 0 }));

        world.entities.set('player', player);
        world.entities.set('victim', victim);
        world.addSystem(PlayerBoardingSystem);

        let outcome: any;
        world.events.get(BoardingOutcomeEvent).subscribe(value => {
            outcome = value;
        });
        world.step();

        expect(outcome.cargo).toBe(5);
        expect(outcome.credits).toBe(50);
        expect(outcome.capturedShip).toBeUndefined();
        expect(playerState.holds).toEqual([{ commodity: 'Metal', tons: 5, isMissionCargo: false }]);
        expect(world.entities.has('victim')).toBeTrue();
    });

    it('does not plunder or capture when action is leave', () => {
        const world = new World('player-leave-action-test');
        world.resources.set(PlatformResource, 'node');
        world.resources.set(TimeResource, {
            time: 0,
            delta_ms: 1_000 / 60,
            delta_s: 1 / 60,
            frame: 0,
        });

        const playerState = createInitialPlayerState();
        const player = new Entity('player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(PlayerStateComponent, playerState)
            .addComponent(MultiplayerData, { owner: 'player' })
            .addComponent(MovementStateComponent, movementAt(new Position(0, 0)))
            .addComponent(BoardingRequestComponent, { target: 'victim', sequence: 1, action: 'leave' });

        const victim = new Entity('victim')
            .addComponent(DisabledComponent, true)
            .addComponent(MovementStateComponent, movementAt(new Position(BOARDING_STANDOFF, 0)))
            .addComponent(ArmorComponent, new Stat({ current: 20, max: 100, recharge: 0 }));

        world.entities.set('player', player);
        world.entities.set('victim', victim);
        world.addSystem(PlayerBoardingSystem);

        let outcomeCalled = false;
        world.events.get(BoardingOutcomeEvent).subscribe(() => {
            outcomeCalled = true;
        });
        world.step();

        expect(outcomeCalled).toBeFalse();
        expect(world.entities.has('victim')).toBeTrue();
    });
});