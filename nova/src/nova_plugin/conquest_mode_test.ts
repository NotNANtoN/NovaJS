import 'jasmine';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Entity } from 'nova_ecs/entity';
import { MovementPlugin, MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';
import { TimePlugin } from 'nova_ecs/plugins/time_plugin';
import { World } from 'nova_ecs/world';
import { MockGameData } from 'novadatainterface/MockGameData';
import { getDefaultSystemData } from 'novadatainterface/SystemData';
import { AsteroidPlugin, makeOre } from './asteroid_plugin';
import { EntityBudgetPlugin } from './entity_budget';
import {
    applyConquestPocketSystems,
    CONQUEST_AURORA_SYSTEM,
    CONQUEST_SOL_SYSTEM,
    conquestOreCreditValue,
    ensureConquestPocketState,
    oppositeConquestSystem,
} from './conquest_mode';
import { GameDataResource } from './game_data_resource';
import { calculateJumpArrival, isValidNextHop } from './jump_plugin';
import { PlatformResource } from './platform_plugin';
import {
    createInitialPlayerState,
    PlayerStateComponent,
} from './player_state';

describe('Galactic Conquest Two-System Pocket & Lateral Jump Arrival', () => {
    it('preserves lateral offset when hyperjumping from a lower or upper point in System A to System B', () => {
        const sol: [number, number] = [-45, 0];
        const aurora: [number, number] = [45, 0];
        const radius = 1_400;

        // Jumping from a lower point (y = +500) in Sol arrives at y = +500 in Aurora
        const lowerArrival = calculateJumpArrival(
            sol,
            aurora,
            radius,
            100,
            new Position(-2_000, 500),
        );
        expect(lowerArrival.position.y).toBeCloseTo(500, 5);
        expect(lowerArrival.position.x).toBeLessThan(0);
        expect(Math.hypot(lowerArrival.position.x, lowerArrival.position.y))
            .toBeCloseTo(radius, 5);

        // Jumping from an upper point (y = -600) in Sol arrives at y = -600 in Aurora
        const upperArrival = calculateJumpArrival(
            sol,
            aurora,
            radius,
            100,
            new Position(-2_000, -600),
        );
        expect(upperArrival.position.y).toBeCloseTo(-600, 5);
        expect(upperArrival.position.x).toBeLessThan(0);
        expect(Math.hypot(upperArrival.position.x, upperArrival.position.y))
            .toBeCloseTo(radius, 5);
    });

    it('configures the Sol <-> Aurora two-system pocket and direct 1-hop link', () => {
        const state = createInitialPlayerState();
        state.gameMode = 'conquest';
        state.currentSystem = 'nova:999';
        ensureConquestPocketState(state);

        expect(state.currentSystem).toBe(CONQUEST_SOL_SYSTEM);
        expect(state.exploredSystems).toContain(CONQUEST_SOL_SYSTEM);
        expect(state.exploredSystems).toContain(CONQUEST_AURORA_SYSTEM);
        expect(oppositeConquestSystem(CONQUEST_SOL_SYSTEM)).toBe(CONQUEST_AURORA_SYSTEM);
        expect(oppositeConquestSystem(CONQUEST_AURORA_SYSTEM)).toBe(CONQUEST_SOL_SYSTEM);

        const rawSystems = [
            { ...getDefaultSystemData(), id: CONQUEST_SOL_SYSTEM, name: 'Sol', links: ['nova:129'] },
            { ...getDefaultSystemData(), id: CONQUEST_AURORA_SYSTEM, name: 'Aurora', links: ['nova:316'] },
            { ...getDefaultSystemData(), id: 'nova:129', name: 'Alpha Centauri', links: [CONQUEST_SOL_SYSTEM] },
        ];
        const pocket = applyConquestPocketSystems(rawSystems, 'conquest');
        expect(pocket.map(s => s.id)).toEqual([CONQUEST_SOL_SYSTEM, CONQUEST_AURORA_SYSTEM]);
        expect(pocket[0].links).toEqual([CONQUEST_AURORA_SYSTEM]);
        expect(pocket[1].links).toEqual([CONQUEST_SOL_SYSTEM]);

        expect(isValidNextHop(rawSystems[0], CONQUEST_AURORA_SYSTEM, undefined, false)).toBeFalse();
        expect(isValidNextHop(rawSystems[0], CONQUEST_AURORA_SYSTEM, undefined, true)).toBeTrue();
    });

    it('auto-collects asteroid ore directly into credits in Conquest mode without requiring a Cargo Scoop outfit', () => {
        const world = new World();
        world.resources.set(GameDataResource, new MockGameData());
        world.resources.set(PlatformResource, 'node');
        world.addPlugin(TimePlugin);
        world.addPlugin(EntityBudgetPlugin);
        world.addPlugin(DeltaPlugin);
        world.addPlugin(MovementPlugin);
        world.addPlugin(AsteroidPlugin);

        const state = createInitialPlayerState();
        state.gameMode = 'conquest';
        state.credits = 10_000;

        const player = new Entity('player')
            .addComponent(PlayerStateComponent, state)
            .addComponent(MultiplayerData, { owner: 'peer-1' })
            .addComponent(MovementStateComponent, {
                position: new Position(0, 0),
                velocity: new Vector(0, 0),
                rotation: new Angle(0),
                accelerating: 0,
                turning: 0,
                turnBack: false,
            });
        world.entities.set('player', player);

        const ore = makeOre('nova:140', 'Crystal', 3, new Position(20, 0));
        ore.components.set(MultiplayerData, { owner: 'server' });
        world.entities.set('ore-1', ore);

        world.step();

        const expectedGain = conquestOreCreditValue('Crystal', 3, false);
        expect(expectedGain).toBe(10_800);
        expect(player.components.get(PlayerStateComponent)!.credits).toBe(20_800);
        expect(player.components.get(PlayerStateComponent)!.holds.length).toBe(0);
        expect(world.entities.has('ore-1')).toBeFalse();
    });
});
