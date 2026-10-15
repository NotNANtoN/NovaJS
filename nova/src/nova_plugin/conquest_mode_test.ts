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
    CONQUEST_ORE_SCATTER_DELAY_MS,
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
import { classifyOutfitCategory, isPurchaseAvailable } from '../spaceport/availability';
import { getDefaultPlanetData } from 'novadatainterface/PlanetData';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';

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

    it('lets freshly shattered asteroid ore scatter for CONQUEST_ORE_SCATTER_DELAY_MS before being scooped', () => {
        const world = new World();
        world.resources.set(GameDataResource, new MockGameData());
        world.resources.set(PlatformResource, 'node');
        world.addPlugin(TimePlugin);
        world.addPlugin(EntityBudgetPlugin);
        world.addPlugin(DeltaPlugin);
        world.addPlugin(MovementPlugin);
        world.addPlugin(AsteroidPlugin);

        const time = world.resources.get(TimeResource)!;
        time.fixedDelta_ms = 16;
        time.time = 1_000;

        const state = createInitialPlayerState();
        state.gameMode = 'conquest';
        state.credits = 5_000;

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

        const ore = makeOre(
            'nova:128',
            'Metal',
            2,
            new Position(15, 0),
            new Vector(0, 0),
            1_000,
        );
        ore.components.set(MultiplayerData, { owner: 'server' });
        world.entities.set('ore-fresh', ore);

        // Immediately after shatter (t = 1,100ms), ore is still scattering
        time.time = 1_100;
        world.step();
        expect(world.entities.has('ore-fresh')).toBeTrue();
        expect(player.components.get(PlayerStateComponent)!.credits).toBe(5_000);

        // After scatter delay elapses, flying over the package scoops it
        time.time = 1_000 + CONQUEST_ORE_SCATTER_DELAY_MS + 50;
        world.step();
        expect(world.entities.has('ore-fresh')).toBeFalse();
        expect(player.components.get(PlayerStateComponent)!.credits).toBe(9_800);
    });

    it('unlocks Federation/Vell-os ships on Sol and Auroran ships on Aurora while excluding Polaris gear and classifying outfitter categories', () => {
        const earth = { ...getDefaultPlanetData(), id: 'nova:128', name: 'Earth', techLevel: 10 };
        const aurora = { ...getDefaultPlanetData(), id: 'nova:382', name: 'Aurora', techLevel: 17 };
        const state = createInitialPlayerState();
        state.gameMode = 'conquest';

        const fedDestroyer = {
            id: 'nova:141',
            techLevel: 14,
            cost: 2_500_000,
            displayWeight: 50,
            buyRandom: 50,
            availabilityNCB: 'b4000',
            require: [1, 0],
        };
        const vellosDart = {
            id: 'nova:173',
            techLevel: 1,
            cost: 500_000,
            displayWeight: 40,
            buyRandom: 50,
            availabilityNCB: 'b200',
        };
        const auroraCruiser = {
            id: 'nova:154',
            techLevel: 17,
            cost: 2_800_000,
            displayWeight: 50,
            buyRandom: 50,
            availabilityNCB: 'b5000',
        };
        const polarisManta = {
            id: 'nova:161',
            techLevel: 19,
            cost: 1_500_000,
            displayWeight: 50,
            buyRandom: 50,
            availabilityNCB: '',
        };
        const polarisOrganicShield = {
            id: 'nova:194',
            techLevel: 9,
            price: 600_000,
            displayWeight: 40,
            availabilityNCB: '',
        };
        const hyperthrusters = {
            id: 'conquest:hyperthrusters',
            techLevel: 1,
            price: 35_000,
            displayWeight: 90,
            availabilityNCB: '',
        };
        const shieldMatrix = {
            id: 'conquest:shield_overcharger',
            techLevel: 1,
            price: 45_000,
            displayWeight: 90,
            availabilityNCB: '',
        };
        const lightBlaster = {
            id: 'nova:128',
            techLevel: 4,
            price: 5_000,
            displayWeight: 50,
            availabilityNCB: '',
            weapons: { 'nova:128': 1 },
        };

        // Sol (Earth) stocks Federation + Vell-os, blocks Auroran & Polaris
        expect(isPurchaseAvailable(fedDestroyer, earth, state)).toBeTrue();
        expect(isPurchaseAvailable(vellosDart, earth, state)).toBeTrue();
        expect(isPurchaseAvailable(auroraCruiser, earth, state)).toBeFalse();
        expect(isPurchaseAvailable(polarisManta, earth, state)).toBeFalse();

        // Aurora stocks Auroran, blocks Federation/Vell-os & Polaris
        expect(isPurchaseAvailable(auroraCruiser, aurora, state)).toBeTrue();
        expect(isPurchaseAvailable(fedDestroyer, aurora, state)).toBeFalse();
        expect(isPurchaseAvailable(vellosDart, aurora, state)).toBeFalse();
        expect(isPurchaseAvailable(polarisManta, aurora, state)).toBeFalse();

        // Outfitter blocks Polaris organic gear, stocks Conquest & faction items
        expect(isPurchaseAvailable(polarisOrganicShield, earth, state)).toBeFalse();
        expect(isPurchaseAvailable(polarisOrganicShield, aurora, state)).toBeFalse();
        expect(isPurchaseAvailable(hyperthrusters, earth, state)).toBeTrue();
        expect(isPurchaseAvailable(hyperthrusters, aurora, state)).toBeTrue();

        // Outfitter category classification
        expect(classifyOutfitCategory(lightBlaster)).toBe('weapons');
        expect(classifyOutfitCategory(shieldMatrix)).toBe('defenses');
        expect(classifyOutfitCategory(hyperthrusters)).toBe('upgrades');
    });
});
