import 'jasmine';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Entity } from 'nova_ecs/entity';
import { MovementPlugin, MovementStateComponent, MovementType } from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';
import { TimePlugin } from 'nova_ecs/plugins/time_plugin';
import { World } from 'nova_ecs/world';
import { MockGameData } from 'novadatainterface/MockGameData';
import { getDefaultSystemData } from 'novadatainterface/SystemData';
import { AsteroidPlugin, makeOre } from './asteroid_plugin';
import {
    ASTEROID_SPAWN_MIN_RADIUS,
    offscreenAsteroidSpawn,
} from './asteroid_spawn_plugin';
import { EntityBudgetPlugin } from './entity_budget';
import {
    applyConquestPocketSystems,
    AURORAN_GOVT,
    clearConquestBotTransfers,
    CONQUEST_AURORA_SYSTEM,
    CONQUEST_ORE_SCATTER_DELAY_MS,
    CONQUEST_SOL_SYSTEM,
    ConquestBotComponent,
    ConquestModePlugin,
    conquestOreCreditValue,
    drainConquestBotTransfers,
    enqueueConquestBotTransfer,
    ensureConquestPocketState,
    FEDERATION_GARRISON_TIERS,
    FEDERATION_GOVT,
    FEDERATION_UPGRADE_TIERS,
    AURORAN_GARRISON_TIERS,
    oppositeConquestSystem,
    pickUniqueConquestCallsign,
    playerConquestFaction,
} from './conquest_mode';
import { GameDataResource } from './game_data_resource';
import { SystemIdResource } from './system_id_resource';
import { applyJumpBrakingControls, calculateJumpArrival, isValidNextHop } from './jump_plugin';
import { artworkUrl } from '../client/artwork_url';
import { PlatformResource } from './platform_plugin';
import {
    createInitialPlayerState,
    PlayerStateComponent,
} from './player_state';
import { classifyOutfitCategory, isPurchaseAvailable } from '../spaceport/availability';
import { getDefaultPlanetData } from 'novadatainterface/PlanetData';
import { DeathEvent, LastAttackerComponent } from './death_plugin';
import { ShipComponent, ShipDataComponent } from './ship_plugin';
import { getDefaultShipData } from 'novadatainterface/ShipData';
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

        // Sol (Earth) stocks Federation, gates 0-cr Vell-os behind Attunement license, and blocks Auroran & Polaris
        expect(isPurchaseAvailable(fedDestroyer, earth, state)).toBeTrue();
        expect(isPurchaseAvailable(vellosDart, earth, state)).toBeFalse();
        const attunedOutfits = new Map([['conquest:vellos_dart_license', { count: 1 }]]);
        expect(isPurchaseAvailable(vellosDart, earth, state, attunedOutfits)).toBeTrue();
        expect(isPurchaseAvailable(auroraCruiser, earth, state)).toBeFalse();
        expect(isPurchaseAvailable(polarisManta, earth, state)).toBeFalse();

        // Aurora stocks Auroran, blocks Federation/Vell-os & Polaris
        expect(isPurchaseAvailable(auroraCruiser, aurora, state)).toBeTrue();
        expect(isPurchaseAvailable(fedDestroyer, aurora, state)).toBeFalse();
        expect(isPurchaseAvailable(vellosDart, aurora, state, attunedOutfits)).toBeFalse();
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

    it('turns inertialess Vell-os ships directly toward the jump vector without spinning around to retro-thrust', () => {
        const movement: import('nova_ecs/plugins/movement_plugin').MovementState = {
            position: new Position(1500, 0),
            velocity: new Vector(-200, 150),
            rotation: new Angle(Math.PI),
            accelerating: 1,
            turning: 0,
            turnBack: false,
            turnTo: null,
            targetSpeed: 250,
        };
        const destVector = new Vector(1, 0);
        applyJumpBrakingControls(movement, 375, destVector, MovementType.INERTIALESS);

        expect(movement.turnBack).toBeFalse();
        expect(movement.velocity.length).toBe(0);
        expect(movement.targetSpeed).toBe(0);
        expect((movement.turnTo as Angle)?.angle).toBeCloseTo(destVector.angle.angle, 6);
    });

    it('appends cache-busting version query string to conquest:* artwork URLs', () => {
        expect(artworkUrl('PictImage', 'conquest:hyperthrusters'))
            .toContain('?v=4');
        expect(artworkUrl('PictImage', 'nova:6000'))
            .not.toContain('?v=');
    });

    it('cleanly removes ConquestModePlugin before EntityBudgetPlugin during world.removeAllPlugins() on hyperjump', async () => {
        const world = new World();
        world.resources.set(GameDataResource, new MockGameData());
        world.resources.set(SystemIdResource, CONQUEST_SOL_SYSTEM);
        world.resources.set(PlatformResource, 'node');
        await world.addPlugin(TimePlugin);
        await world.addPlugin(EntityBudgetPlugin);
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(MovementPlugin);
        await world.addPlugin(ConquestModePlugin);

        await expectAsync(world.removeAllPlugins()).toBeResolved();
    });

    it('assigns unique faction callsigns, excludes civilian traders from upgrade tiers, and transfers raiding bots across pocket systems', () => {
        clearConquestBotTransfers();
        expect(FEDERATION_UPGRADE_TIERS[0]).toBe('nova:187'); // Fed Scout Ship (no civilian Shuttle)
        expect(FEDERATION_UPGRADE_TIERS).not.toContain('nova:128' as any);

        const used = new Set<string>();
        for (let i = 0; i < 10; i++) {
            const name = pickUniqueConquestCallsign(FEDERATION_GOVT, used);
            expect(used.has(name)).toBeFalse();
            used.add(name);
        }
        const auroranName = pickUniqueConquestCallsign(AURORAN_GOVT, used);
        expect(auroranName.length).toBeGreaterThan(2);

        enqueueConquestBotTransfer({
            from: CONQUEST_AURORA_SYSTEM,
            to: CONQUEST_SOL_SYSTEM,
            departurePosition: [-1800, 420],
            botState: {
                callsign: auroranName,
                mode: 'attack',
                factionGovt: AURORAN_GOVT,
                homeSystem: CONQUEST_AURORA_SYSTEM,
                tier: 3,
                gatheredCredits: 2500,
                lastModeSwitchAt: 1000,
                upgradePending: false,
                squadId: 'squad-alpha',
            },
        });

        const drained = drainConquestBotTransfers(CONQUEST_SOL_SYSTEM);
        expect(drained.length).toBe(1);
        expect(drained[0].botState.callsign).toBe(auroranName);
        expect(drained[0].botState.tier).toBe(3);
        expect(drained[0].botState.squadId).toBe('squad-alpha');
        expect(drained[0].departurePosition).toEqual([-1800, 420]);
        expect(drainConquestBotTransfers(CONQUEST_SOL_SYSTEM).length).toBe(0);

        // Sol-spawned player has FEDERATION_GOVT, so Auroran defenders in Aurora recognize them as hostile
        const solPlayer = createInitialPlayerState();
        solPlayer.gameMode = 'conquest';
        ensureConquestPocketState(solPlayer);
        solPlayer.currentSystem = CONQUEST_AURORA_SYSTEM;
        expect(playerConquestFaction(solPlayer, 'nova:144')).toBe(FEDERATION_GOVT);
        expect(playerConquestFaction(solPlayer, 'nova:144') !== AURORAN_GOVT).toBeTrue();

        // Off-screen asteroid spawn places rocks outside every player's view with inward velocity
        const p1 = [{ position: new Position(0, 0) }, {}] as const;
        const p2 = [{ position: new Position(900, 0) }, {}] as const;
        for (let i = 0; i < 20; i++) {
            const { position, velocity } = offscreenAsteroidSpawn([p1, p2]);
            expect(position.subtract(p1[0].position).length)
                .toBeGreaterThanOrEqual(ASTEROID_SPAWN_MIN_RADIUS - 50);
            expect(position.subtract(p2[0].position).length)
                .toBeGreaterThanOrEqual(ASTEROID_SPAWN_MIN_RADIUS - 50);
            expect(velocity.length).toBeGreaterThan(35);
            // Velocity points inward toward the system interior (dot product with -position > 0)
            const inwardDot = (-position.x) * velocity.x + (-position.y) * velocity.y;
            expect(inwardDot).toBeGreaterThan(0);
        }
    });

    it('awards direct combat kill bounties and drops Salvage Core chunks when an enemy ship is destroyed', async () => {
        const world = new World();
        world.resources.set(GameDataResource, new MockGameData());
        world.resources.set(SystemIdResource, CONQUEST_SOL_SYSTEM);
        world.resources.set(PlatformResource, 'node');
        await world.addPlugin(TimePlugin);
        await world.addPlugin(EntityBudgetPlugin);
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(MovementPlugin);
        await world.addPlugin(AsteroidPlugin);
        await world.addPlugin(ConquestModePlugin);

        const playerState = createInitialPlayerState();
        playerState.gameMode = 'conquest';
        playerState.credits = 10_000;
        playerState.kills = 0;

        const playerEnt = new Entity('Player Viper')
            .addComponent(PlayerStateComponent, playerState)
            .addComponent(ShipComponent, { id: 'nova:144' })
            .addComponent(MultiplayerData, { owner: 'peer-1' })
            .addComponent(MovementStateComponent, {
                position: new Position(0, 0),
                velocity: new Vector(0, 0),
                rotation: new Angle(0),
                turning: 0,
                turnBack: false,
                accelerating: 0,
            });
        world.entities.set('player-1', playerEnt);

        const enemyShipData = {
            ...getDefaultShipData(),
            id: 'nova:156',
            name: 'Phoenix',
            cost: 100_000,
        };
        const enemyEnt = new Entity('Auroran Raider')
            .addComponent(ShipComponent, { id: 'nova:156' })
            .addComponent(ShipDataComponent, enemyShipData)
            .addComponent(LastAttackerComponent, 'player-1')
            .addComponent(ConquestBotComponent, {
                callsign: "Kar'Vosh",
                mode: 'attack',
                factionGovt: AURORAN_GOVT,
                homeSystem: CONQUEST_AURORA_SYSTEM,
                tier: 1,
                gatheredCredits: 0,
                lastModeSwitchAt: 0,
                upgradePending: false,
            })
            .addComponent(MultiplayerData, { owner: 'server' })
            .addComponent(MovementStateComponent, {
                position: new Position(120, -80),
                velocity: new Vector(0, 0),
                rotation: new Angle(0),
                turning: 0,
                turnBack: false,
                accelerating: 0,
            });
        world.entities.set('enemy-1', enemyEnt);

        const time = world.resources.get(TimeResource)!;
        world.emitNow(DeathEvent, time, ['enemy-1']);

        // Bounty: 35% of 100,000 = 35,000 cr
        const updatedPlayer = world.entities.get('player-1')!.components.get(PlayerStateComponent)!;
        expect(updatedPlayer.credits).toBe(45_000);
        expect(updatedPlayer.kills).toBe(1);
    });

    it('configures permanent Homeworld Defense Fleet Garrisons with Carriers, Destroyers/Cruisers, and Gunboats', () => {
        const fedGarrisonIds = FEDERATION_GARRISON_TIERS.map(t => FEDERATION_UPGRADE_TIERS[t]);
        expect(fedGarrisonIds).toContain('nova:143'); // Fed Carrier
        expect(fedGarrisonIds).toContain('nova:141'); // Fed Destroyer
        expect(fedGarrisonIds).toContain('nova:172'); // RAGE Gunboat
        expect(fedGarrisonIds).toContain('nova:142'); // Fed Patrol Boat

        const aurGarrisonIds = AURORAN_GARRISON_TIERS.map(t => [
            'nova:155',
            'nova:156',
            'nova:138',
            'nova:152',
            'nova:154',
            'nova:153',
        ][t]);
        expect(aurGarrisonIds).toContain('nova:153'); // Aurora Carrier
        expect(aurGarrisonIds).toContain('nova:154'); // Aurora Cruiser
        expect(aurGarrisonIds).toContain('nova:152'); // Abomination
        expect(aurGarrisonIds).toContain('nova:138'); // Argosy
    });
});
