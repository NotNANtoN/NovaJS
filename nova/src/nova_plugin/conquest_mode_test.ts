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
import { AsteroidPlugin, enforceOreEntityCap, makeOre, MAX_ACTIVE_ORE_ENTITIES, OreComponent } from './asteroid_plugin';
import {
    ASTEROID_SPAWN_MIN_RADIUS,
    offscreenAsteroidSpawn,
} from './asteroid_spawn_plugin';
import { EntityBudgetPlugin, EntityBudgetResource, createEntityBudget } from './entity_budget';
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
import { classifyOutfitCategory, formatShopItemDescription, isPurchaseAvailable } from '../spaceport/availability';
import { isDraft } from 'immer';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import {
    init as initNovaWasm,
    sweptCirclePolygonTime,
    sweptPolygonPolygonTime,
} from '../../../nova_wasm';
import { computeBoardingCaptureChance } from './boarding_plugin';
import { computeShipDeathShockwave } from './ship_death_blast';
import { DeathPlugin } from './death_plugin';
import { ArmorComponent, ShieldComponent } from './health_plugin';
import { Stat } from './stat';
import { getDefaultPlanetData } from 'novadatainterface/PlanetData';
import { DeathEvent, LastAttackerComponent, PlayerDeathComponent } from './death_plugin';
import { ShipComponent, ShipDataComponent } from './ship_plugin';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { createProvocationState, NpcHostilitySystems, ProvocationResource, recordProvocation } from './npc_hostility';
import { GovtComponent, NpcAIComponent } from './npc_components';
import { TargetComponent } from './target_component';
import { OutfitsStateComponent } from './outfit_plugin';
import { PlanetComponent } from './planet_plugin';
import { BASIC_ESCAPE_POD_SHIP_ID } from './escape_pod';

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

    it('strips retail license requirement sentences in Galactic Conquest mode and computes realistic crew boarding odds', () => {
        const retailViperDesc = 'The Viper is a fast interceptor. To purchase a Viper, you must possess a valid Federation Heavy Weapons License.';
        expect(formatShopItemDescription(retailViperDesc, 'nova:144', true))
            .toBe('The Viper is a fast interceptor.');
        expect(formatShopItemDescription(retailViperDesc, 'nova:144', false))
            .toBe(retailViperDesc);

        const shuttleVsWarship = computeBoardingCaptureChance({
            playerCrew: 1,
            marinePlatoons: 0,
            playerKills: 0,
            victimCrew: 12,
            isDerelict: false,
        });
        const frigateWithMarinesVsFighter = computeBoardingCaptureChance({
            playerCrew: 20,
            marinePlatoons: 2,
            playerKills: 15,
            victimCrew: 2,
            isDerelict: false,
        });
        expect(shuttleVsWarship).toBeLessThan(0.15);
        expect(frigateWithMarinesVsFighter).toBeGreaterThan(0.75);
    });

    it('scales ship explosion blast damage by ship mass/armor (Leviathan vs Shuttle) and damages both player and NPC ships', async () => {
        const shuttleData = {
            ...getDefaultShipData(),
            id: 'nova:128',
            name: 'Shuttle',
            largeExplosion: false,
            physics: { ...getDefaultShipData().physics, mass: 20, armor: 50, shield: 100 },
        };
        const leviathanData = {
            ...getDefaultShipData(),
            id: 'nova:131',
            name: 'Leviathan',
            largeExplosion: true,
            physics: { ...getDefaultShipData().physics, mass: 600, armor: 600, shield: 800 },
        };

        const shuttleWave = computeShipDeathShockwave(shuttleData)!;
        const leviathanWave = computeShipDeathShockwave(leviathanData)!;
        expect(leviathanWave.radius).toBeGreaterThan(shuttleWave.radius * 2);
        expect(leviathanWave.shieldDamage).toBeGreaterThan(shuttleWave.shieldDamage * 4);

        const world = new World();
        world.resources.set(GameDataResource, new MockGameData());
        world.resources.set(SystemIdResource, CONQUEST_SOL_SYSTEM);
        world.resources.set(PlatformResource, 'node');
        await world.addPlugin(TimePlugin);
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(MovementPlugin);
        await world.addPlugin(DeathPlugin);

        const dyingLeviathan = new Entity('Dying Leviathan')
            .addComponent(ShipComponent, { id: 'nova:131' })
            .addComponent(ShipDataComponent, leviathanData)
            .addComponent(MovementStateComponent, {
                position: new Position(0, 0),
                velocity: new Vector(0, 0),
                rotation: new Angle(0),
                turning: 0,
                turnBack: false,
                accelerating: 0,
            });
        const nearbyPlayer = new Entity('Nearby Player')
            .addComponent(ShipComponent, { id: 'nova:144' })
            .addComponent(PlayerStateComponent, createInitialPlayerState())
            .addComponent(ShieldComponent, new Stat({ current: 300, max: 300, recharge: 0 }))
            .addComponent(ArmorComponent, new Stat({ current: 200, max: 200, recharge: 0 }))
            .addComponent(MovementStateComponent, {
                position: new Position(90, 0),
                velocity: new Vector(0, 0),
                rotation: new Angle(0),
                turning: 0,
                turnBack: false,
                accelerating: 0,
            });
        const nearbyNpc = new Entity('Nearby NPC')
            .addComponent(ShipComponent, { id: 'nova:155' })
            .addComponent(ShieldComponent, new Stat({ current: 300, max: 300, recharge: 0 }))
            .addComponent(ArmorComponent, new Stat({ current: 200, max: 200, recharge: 0 }))
            .addComponent(MovementStateComponent, {
                position: new Position(0, -110),
                velocity: new Vector(0, 0),
                rotation: new Angle(0),
                turning: 0,
                turnBack: false,
                accelerating: 0,
            });

        world.entities.set('leviathan', dyingLeviathan);
        world.entities.set('player', nearbyPlayer);
        world.entities.set('npc', nearbyNpc);

        const time = world.resources.get(TimeResource)!;
        world.emitNow(DeathEvent, time, ['leviathan']);

        expect(nearbyPlayer.components.get(ShieldComponent)!.current).toBeLessThan(100);
        expect(nearbyNpc.components.get(ShieldComponent)!.current).toBeLessThan(120);
    });

    it('bypasses Immer Proxy drafts on MovementStateComponent and runs Rust/Wasm swept collision kernels', async () => {
        await initNovaWasm();
        const poly = new Float32Array([-10, -10, 10, -10, 10, 10, -10, 10]);
        const tCircle = sweptCirclePolygonTime(-50, 0, 10, poly, 0, 0, 100, 0);
        expect(tCircle).toBeCloseTo(0.3, 4);
        const tPoly = sweptPolygonPolygonTime(poly, -50, 0, poly, 0, 0, 100, 0);
        expect(tPoly).toBeCloseTo(0.3, 4);

        const world = new World();
        await world.addPlugin(TimePlugin);
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(MovementPlugin);
        const deltaMaker = world.resources.get(DeltaResource)!;

        const ship = new Entity('plain-movement-ship').addComponent(MovementStateComponent, {
            position: new Position(10, 20),
            velocity: new Vector(5, 0),
            rotation: new Angle(0),
            turning: 0,
            turnBack: false,
            accelerating: 0,
        });
        world.entities.set('ship', ship);

        // Initial snapshot consumes full state without wrapping MovementState in an Immer Proxy
        const initialDelta = deltaMaker.getDelta(ship);
        expect(initialDelta?.componentStates?.has(MovementStateComponent.name)).toBeTrue();
        const mov = ship.components.get(MovementStateComponent)!;
        expect(isDraft(mov)).toBeFalse();

        // Mutating turning in-place on the plain object still produces a MovementStateDelta
        mov.turning = 1;
        expect(deltaMaker.isDirty(ship)).toBeTrue();
        const stepDelta = deltaMaker.getDelta(ship);
        expect(stepDelta?.componentDeltas?.has(MovementStateComponent.name)).toBeTrue();
        expect(isDraft(ship.components.get(MovementStateComponent))).toBeFalse();
    });

    it('clears allied Federation hostility, LastAttackerComponent, and TargetComponent when a Conquest player dies and respawns', async () => {
        const world = new World();
        const gameData = new MockGameData();
        const shuttleHull = {
            ...getDefaultShipData(),
            id: BASIC_ESCAPE_POD_SHIP_ID,
            name: 'Shuttle',
            outfits: {},
        };
        const carrierHull = {
            ...getDefaultShipData(),
            id: 'nova:143',
            name: 'Fed Carrier',
            outfits: {},
        };
        gameData.data.Ship.map.set(BASIC_ESCAPE_POD_SHIP_ID, shuttleHull);
        gameData.data.Ship.map.set('nova:143', carrierHull);
        await gameData.data.Ship.get(BASIC_ESCAPE_POD_SHIP_ID);
        await gameData.data.Ship.get('nova:143');
        world.resources.set(GameDataResource, gameData);
        world.resources.set(SystemIdResource, CONQUEST_SOL_SYSTEM);
        world.resources.set(PlatformResource, 'node');
        const provocations = createProvocationState();
        world.resources.set(ProvocationResource, provocations);

        await world.addPlugin(TimePlugin);
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(MovementPlugin);
        await world.addPlugin(EntityBudgetPlugin);
        await world.addPlugin(DeathPlugin);
        world.addSystem(NpcHostilitySystems.playerDeathCleanup);
        await world.addPlugin(ConquestModePlugin);

        const playerState = createInitialPlayerState();
        playerState.gameMode = 'conquest';
        playerState.shipId = 'nova:144';
        playerState.currentSystem = CONQUEST_SOL_SYSTEM;
        playerState.lastLandedSystem = CONQUEST_SOL_SYSTEM;
        playerState.legalRecords = { 'nova:128': -50 };

        const playerEnt = new Entity('Player')
            .addComponent(PlayerStateComponent, playerState)
            .addComponent(ShipComponent, { id: 'nova:144' })
            .addComponent(ShipDataComponent, shuttleHull)
            .addComponent(OutfitsStateComponent, new Map())
            .addComponent(ShieldComponent, new Stat({ current: 100, max: 100, recharge: 0 }))
            .addComponent(ArmorComponent, new Stat({ current: 100, max: 100, recharge: 0 }))
            .addComponent(MultiplayerData, { owner: 'player-1' })
            .addComponent(MovementStateComponent, {
                position: new Position(100, 0),
                velocity: new Vector(0, 0),
                rotation: new Angle(0),
                turning: 0,
                turnBack: false,
                accelerating: 0,
            });
        world.entities.set('player-1', playerEnt);

        const fedBot = new Entity('Fed Carrier')
            .addComponent(ShipComponent, { id: 'nova:143' })
            .addComponent(ShipDataComponent, carrierHull)
            .addComponent(NpcAIComponent, undefined)
            .addComponent(GovtComponent, { id: FEDERATION_GOVT })
            .addComponent(TargetComponent, { target: undefined })
            .addComponent(LastAttackerComponent, 'player-1')
            .addComponent(ConquestBotComponent, {
                callsign: 'Capt. Vance',
                mode: 'attack',
                factionGovt: FEDERATION_GOVT,
                homeSystem: CONQUEST_SOL_SYSTEM,
                tier: 9,
                gatheredCredits: 0,
                lastModeSwitchAt: 0,
                upgradePending: false,
                garrison: true,
            })
            .addComponent(MultiplayerData, { owner: 'server' })
            .addComponent(MovementStateComponent, {
                position: new Position(200, 0),
                velocity: new Vector(0, 0),
                rotation: new Angle(0),
                turning: 0,
                turnBack: false,
                accelerating: 0,
            });
        world.entities.set('fed-bot-1', fedBot);

        // 1. With ProvocationResource present and unprovoked, a stale LastAttackerComponent
        // alone (e.g. from an accidental stray hit below the 3% threshold) must not trigger
        // allied fleet retaliation.
        world.step();
        expect(fedBot.components.get(TargetComponent)?.target).toBeUndefined();

        // 2. When sustained fire provokes the Federation fleet, the bot targets the player.
        const time = world.resources.get(TimeResource)!;
        recordProvocation(provocations, FEDERATION_GOVT, 'player-1', time.time, 'fed-bot-1', 'sustained-fire');
        world.step();
        expect(fedBot.components.get(TargetComponent)?.target).toBe('player-1');

        // 3. Player dies: hostility, LastAttackerComponent, and TargetComponent are cleared.
        world.emitNow(DeathEvent, time, ['player-1']);
        expect(playerEnt.components.has(PlayerDeathComponent)).toBeTrue();
        expect(fedBot.components.has(LastAttackerComponent)).toBeFalse();
        expect(fedBot.components.get(TargetComponent)?.target).toBeUndefined();

        // 4. Advance past respawn timer: player respawns with clean legal record,
        // and the allied Federation bot does NOT re-target the respawned player!
        const deathState = playerEnt.components.get(PlayerDeathComponent)!;
        time.fixedDelta_ms = 3_000;
        time.time = (deathState.respawnAt ?? time.time) + 100;
        world.step();
        world.step();

        expect(playerEnt.components.has(PlayerDeathComponent)).toBeFalse();
        expect(playerEnt.components.get(PlayerStateComponent)?.legalRecords?.['nova:128']).toBe(0);
        expect(fedBot.components.get(TargetComponent)?.target).toBeUndefined();
    });

    it('caps simultaneous floating OreComponent entities via enforceOreEntityCap', () => {
        const entities = new Map<string, Entity>();
        for (let i = 0; i < MAX_ACTIVE_ORE_ENTITIES; i++) {
            const ore = makeOre('nova:130', 'Metal', 1, new Position(i, 0), undefined, 100 + i);
            entities.set(`ore-${i}`, ore);
        }
        expect(entities.size).toBe(MAX_ACTIVE_ORE_ENTITIES);

        enforceOreEntityCap(entities, 3);
        expect(entities.size).toBe(MAX_ACTIVE_ORE_ENTITIES - 3);
        expect(entities.has('ore-0')).toBeFalse();
        expect(entities.has('ore-1')).toBeFalse();
        expect(entities.has('ore-2')).toBeFalse();
    });

    it('spawns home garrison and miner bots at a planet and requires flying back to a planet to upgrade hulls', () => {
        const world = new World('conquest-planet-spawn-test');
        const gameData = new MockGameData();
        for (const id of ['nova:187', 'nova:144', 'nova:143', 'nova:141', 'nova:172', 'nova:142']) {
            gameData.data.Ship.map.set(id, {
                ...getDefaultShipData(),
                id,
                name: `Hull ${id}`,
                outfits: {},
            });
        }
        world.resources.set(GameDataResource, gameData);
        world.resources.set(SystemIdResource, CONQUEST_SOL_SYSTEM);
        world.resources.set(PlatformResource, 'node');
        world.resources.set(EntityBudgetResource, createEntityBudget('modern'));
        world.addPlugin(DeltaPlugin);
        world.addPlugin(TimePlugin);
        world.addPlugin(MovementPlugin);
        world.addPlugin(ConquestModePlugin);

        const earthPos = new Position(-120, 180);
        world.entities.set(
            'planet-earth',
            new Entity('Earth')
                .addComponent(PlanetComponent, {
                    id: 'nova:128',
                    name: 'Earth',
                    inhabited: true,
                    canLand: true,
                })
                .addComponent(MovementStateComponent, {
                    position: earthPos,
                    velocity: new Vector(0, 0),
                    rotation: new Angle(0),
                    turning: 0,
                    turnBack: false,
                    accelerating: 0,
                }),
        );

        const playerState = createInitialPlayerState();
        playerState.gameMode = 'conquest';
        playerState.currentSystem = CONQUEST_SOL_SYSTEM;
        world.entities.set(
            'player-1',
            new Entity('Player')
                .addComponent(PlayerStateComponent, playerState)
                .addComponent(MultiplayerData, { owner: 'client-1' })
                .addComponent(MovementStateComponent, {
                    position: new Position(0, 0),
                    velocity: new Vector(0, 0),
                    rotation: new Angle(0),
                    turning: 0,
                    turnBack: false,
                    accelerating: 0,
                }),
        );

        world.step();

        const spawnedBots = [...world.entities.values()].filter(e =>
            e.components.has(ConquestBotComponent));
        expect(spawnedBots.length).toBeGreaterThan(0);
        for (const bot of spawnedBots) {
            const mov = bot.components.get(MovementStateComponent)!;
            const distFromEarth = mov.position.subtract(earthPos).length;
            expect(distFromEarth).toBeLessThan(1e-3);
        }

        // Now place a miner bot far out in open space with enough credits to upgrade:
        // it must fly back toward Earth (upgradePending = true) instead of morphing in open space!
        const minerBot = new Entity('Miner')
            .addComponent(ShipComponent, { id: 'nova:187' })
            .addComponent(TargetComponent, { target: undefined })
            .addComponent(MultiplayerData, { owner: 'server' })
            .addComponent(ConquestBotComponent, {
                callsign: 'Lt. Mercer',
                mode: 'gather',
                factionGovt: FEDERATION_GOVT,
                homeSystem: CONQUEST_SOL_SYSTEM,
                tier: 0,
                gatheredCredits: 25_000,
                lastModeSwitchAt: 0,
                upgradePending: false,
            })
            .addComponent(MovementStateComponent, {
                position: new Position(900, -900),
                velocity: new Vector(0, 0),
                rotation: new Angle(0),
                turning: 0,
                turnBack: false,
                accelerating: 0,
            });
        world.entities.set('miner-1', minerBot);

        world.step();
        const minerState = minerBot.components.get(ConquestBotComponent)!;
        expect(minerState.upgradePending).toBeTrue();
        expect(minerState.tier).toBe(0);
        expect(minerBot.components.get(ShipComponent)?.id).toBe('nova:187');

        // Move the miner to Earth so it docks and completes the upgrade at the planet!
        minerBot.components.get(MovementStateComponent)!.position = new Position(earthPos.x, earthPos.y);
        world.step();
        expect(minerState.upgradePending).toBeFalse();
        expect(minerState.tier).toBe(1);
        expect(minerBot.components.get(ShipComponent)?.id).toBe('nova:144');
    });
});
