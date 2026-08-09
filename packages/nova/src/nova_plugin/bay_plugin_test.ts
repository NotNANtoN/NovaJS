import 'jasmine';
import { MockGameData } from 'novadatainterface/mock_game_data';
import { getDefaultOutfitData } from 'novadatainterface/outfit_data';
import { getDefaultShipData, getDefaultShipPhysics, ShipData } from 'novadatainterface/ship_data';
import { BayWeaponData, getDefaultBayWeaponData } from 'novadatainterface/weapon_data';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { World } from 'nova_ecs/world';
import { BayFighterComponent, EXIT_KICK, startReturnHome } from './bay_plugin.js';
import { CollisionEvent } from './collision_interaction.js';
import { completeEntity } from './entity_data_loader.js';
import { OwnerComponent, SourceComponent } from './fire_weapon_plugin.js';
import { makeShip } from './make_ship.js';
import { makeSystem } from './make_system.js';
import { OutfitsStateComponent } from './outfit_plugin.js';
import { WeaponsStateComponent } from './weapons_state.js';

const CARRIER_ID = 'test:carrier';
const FIGHTER_SHIP_ID = 'test:fighterShip';
const BAY_ID = 'test:bay';
const BAY_OUTFIT_ID = 'test:bayOutfit';
// Two fighter outfits supplying the SAME bay, so the lowest-sorted-id
// consume/refund policy is observable. 'A' sorts before 'B'.
const FIGHTER_A_ID = 'test:fighterA';
const FIGHTER_B_ID = 'test:fighterB';
const CARRIER_UUID = 'test carrier uuid';

/**
 * A system holding one carrier with a single bay. `fighterCounts` is the
 * preinstalled fighter load (the outfits a bay spends as ammo).
 */
async function makeTestWorld({ fighterCounts = { [FIGHTER_A_ID]: 2 },
    maxAmmo = 4, bays = 1 }: {
        fighterCounts?: { [id: string]: number },
        maxAmmo?: number,
        bays?: number,
    } = {}) {
    const gameData = new MockGameData();

    const bay: BayWeaponData = {
        ...getDefaultBayWeaponData(),
        id: BAY_ID,
        shipID: FIGHTER_SHIP_ID,
        // What the parser now produces for a bay: its ammo is its
        // fighters, held by outfits whose ammoFor is the bay itself.
        ammoType: ['weapon', BAY_ID],
        maxAmmo,
        fireGroup: 'secondary',
        // Reloaded every step.
        reload: 1,
    };
    gameData.data.Weapon.map.set(BAY_ID, bay);

    gameData.data.Outfit.map.set(BAY_OUTFIT_ID, {
        ...getDefaultOutfitData(),
        id: BAY_OUTFIT_ID,
        weapons: { [BAY_ID]: 1 },
    });
    for (const id of [FIGHTER_A_ID, FIGHTER_B_ID]) {
        gameData.data.Outfit.map.set(id, {
            ...getDefaultOutfitData(),
            id,
            ammoFor: BAY_ID,
        });
    }

    // The launched fighter's ship data.
    gameData.data.Ship.map.set(FIGHTER_SHIP_ID, {
        ...getDefaultShipData(),
        id: FIGHTER_SHIP_ID,
    });

    const carrierData: ShipData = {
        ...getDefaultShipData(),
        id: CARRIER_ID,
        outfits: { [BAY_OUTFIT_ID]: bays, ...fighterCounts },
        physics: { ...getDefaultShipPhysics() },
    };
    gameData.data.Ship.map.set(CARRIER_ID, carrierData);

    // npcs: false — a controlled battlefield, so the only entities that
    // appear are the carrier and what its bay launches.
    const world = await makeSystem('test:system', gameData, undefined,
        { npcs: false });
    const carrier = makeShip(carrierData);
    // A known position and a real velocity, so an inherited launch
    // velocity is distinguishable from a dead stop.
    carrier.components.set(MovementStateComponent, {
        accelerating: 0,
        position: new Position(0, 0),
        rotation: new Angle(0),
        turnBack: false,
        turning: 0,
        velocity: new Vector(120, -45),
    });
    await completeEntity(world, carrier);
    world.entities.set(CARRIER_UUID, carrier);

    // Let the provide systems attach weapon state, outfits, etc.
    await stepWorld(world, 2);

    return { world, carrier, gameData };
}

async function stepWorld(world: World, steps: number) {
    for (let i = 0; i < steps; i++) {
        world.step();
        await new Promise(resolve => setImmediate(resolve));
    }
}

function setFiring(carrier: Entity, firing: boolean) {
    carrier.components.get(WeaponsStateComponent)!.get(BAY_ID)!.firing = firing;
}

function outfitCount(carrier: Entity, id: string): number {
    return carrier.components.get(OutfitsStateComponent)?.get(id)?.count ?? 0;
}

/** Every live bay fighter, as [uuid, entity]. */
function fighters(world: World): [string, Entity][] {
    return [...world.entities]
        .filter(([, entity]) => entity.components.has(BayFighterComponent));
}

/** Launches exactly one fighter and returns it. */
async function launchOne(world: World, carrier: Entity) {
    const before = fighters(world).length;
    setFiring(carrier, true);
    await stepWorld(world, 1);
    setFiring(carrier, false);
    const now = fighters(world);
    expect(now.length).toBe(before + 1);
    return now[now.length - 1];
}

describe('bay weapons', () => {
    it('spends one fighter outfit per launch', async () => {
        const { world, carrier } = await makeTestWorld({
            fighterCounts: { [FIGHTER_A_ID]: 2 },
        });
        expect(outfitCount(carrier, FIGHTER_A_ID)).toBe(2);

        await launchOne(world, carrier);
        expect(outfitCount(carrier, FIGHTER_A_ID)).toBe(1);

        await launchOne(world, carrier);
        expect(outfitCount(carrier, FIGHTER_A_ID)).toBe(0);
        expect(fighters(world).length).toBe(2);
    });

    it('refuses to fire an empty bay, and fires again once restocked',
        async () => {
            const { world, carrier } = await makeTestWorld({
                fighterCounts: { [FIGHTER_A_ID]: 0 },
            });

            // Held trigger, many ticks: an empty bay launches nothing.
            setFiring(carrier, true);
            await stepWorld(world, 10);
            expect(fighters(world).length).toBe(0);
            setFiring(carrier, false);

            // Restocking makes it fire, so nothing else was blocking it.
            carrier.components.get(OutfitsStateComponent)!
                .get(FIGHTER_A_ID)!.count = 1;
            await launchOne(world, carrier);
            expect(outfitCount(carrier, FIGHTER_A_ID)).toBe(0);
        });

    it('spends the lowest-sorted supplying outfit first', async () => {
        const { world, carrier } = await makeTestWorld({
            fighterCounts: { [FIGHTER_A_ID]: 1, [FIGHTER_B_ID]: 1 },
        });
        await launchOne(world, carrier);
        // 'test:fighterA' sorts before 'test:fighterB'.
        expect(outfitCount(carrier, FIGHTER_A_ID)).toBe(0);
        expect(outfitCount(carrier, FIGHTER_B_ID)).toBe(1);
    });

    it('tags each fighter with the bay that launched it', async () => {
        const { world, carrier } = await makeTestWorld();
        const [, fighter] = await launchOne(world, carrier);
        expect(fighter.components.get(BayFighterComponent))
            .toEqual({ bayWeaponId: BAY_ID });
        expect(fighter.components.get(SourceComponent)).toBe(CARRIER_UUID);
    });

    it('launches fighters with the carrier\'s velocity plus the exit kick',
        async () => {
            const { world, carrier } = await makeTestWorld();
            const carrierVelocity = Vector.fromVectorLike(
                carrier.components.get(MovementStateComponent)!.velocity);
            const [, fighter] = await launchOne(world, carrier);

            const launched = fighter.components
                .get(MovementStateComponent)!.velocity;
            // Regression: Vector is immutable, and the launch code used
            // to call velocity.add(...) for effect and throw the result
            // away, so every fighter left the bay at a dead stop while
            // its carrier flew off at speed.
            expect(launched.length).toBeGreaterThan(1);
            // The carrier's motion is inherited, and the leftover is the
            // exit kick alone.
            const kick = launched.subtract(carrierVelocity);
            expect(kick.length).toBeCloseTo(EXIT_KICK, 4);
        });

    it('refunds exactly one fighter and removes the fighter when it docks',
        async () => {
            const { world, carrier } = await makeTestWorld({
                fighterCounts: { [FIGHTER_A_ID]: 2 },
            });
            const [uuid, fighter] = await launchOne(world, carrier);
            expect(outfitCount(carrier, FIGHTER_A_ID)).toBe(1);

            startReturnHome(fighter);
            world.emit(CollisionEvent, { other: CARRIER_UUID, initiator: true },
                [uuid]);
            await stepWorld(world, 1);

            expect(outfitCount(carrier, FIGHTER_A_ID)).toBe(2);
            expect(world.entities.has(uuid)).toBeFalse();
        });

    it('refunds to the lowest-sorted supplying outfit, mirroring the '
        + 'consume policy', async () => {
            const { world, carrier } = await makeTestWorld({
                fighterCounts: { [FIGHTER_A_ID]: 1, [FIGHTER_B_ID]: 1 },
            });
            const [uuid, fighter] = await launchOne(world, carrier);
            expect(outfitCount(carrier, FIGHTER_A_ID)).toBe(0);

            startReturnHome(fighter);
            world.emit(CollisionEvent, { other: CARRIER_UUID, initiator: true },
                [uuid]);
            await stepWorld(world, 1);

            // Back into A (the one it came out of), not B.
            expect(outfitCount(carrier, FIGHTER_A_ID)).toBe(1);
            expect(outfitCount(carrier, FIGHTER_B_ID)).toBe(1);
        });

    it('ignores a collision with anything that is not its carrier',
        async () => {
            const { world, carrier } = await makeTestWorld();
            const [uuid, fighter] = await launchOne(world, carrier);
            startReturnHome(fighter);
            world.emit(CollisionEvent,
                { other: 'some other ship', initiator: true }, [uuid]);
            await stepWorld(world, 1);

            expect(world.entities.has(uuid)).toBeTrue();
            expect(outfitCount(carrier, FIGHTER_A_ID)).toBe(1);
        });

    it('never refunds past the bay\'s capacity', async () => {
        // One bay holding one fighter: capacity is 1.
        const { world, carrier } = await makeTestWorld({
            fighterCounts: { [FIGHTER_A_ID]: 1 },
            maxAmmo: 1,
            bays: 1,
        });
        const [uuid, fighter] = await launchOne(world, carrier);
        expect(outfitCount(carrier, FIGHTER_A_ID)).toBe(0);

        // Simulate the magazine having been refilled behind the
        // fighter's back (what the outfitter's deployed-count
        // accounting exists to prevent). Docking must not overfill it.
        carrier.components.get(OutfitsStateComponent)!
            .get(FIGHTER_A_ID)!.count = 1;

        startReturnHome(fighter);
        world.emit(CollisionEvent, { other: CARRIER_UUID, initiator: true },
            [uuid]);
        await stepWorld(world, 1);

        expect(outfitCount(carrier, FIGHTER_A_ID)).toBe(1);
        // The fighter still docks; only the round is dropped.
        expect(world.entities.has(uuid)).toBeFalse();
    });

    it('caps a multi-bay carrier at MaxAmmo per bay', async () => {
        // 2 bays x MaxAmmo 2 = capacity 4.
        const { world, carrier } = await makeTestWorld({
            fighterCounts: { [FIGHTER_A_ID]: 4 },
            maxAmmo: 2,
            bays: 2,
        });
        const [uuid, fighter] = await launchOne(world, carrier);
        expect(outfitCount(carrier, FIGHTER_A_ID)).toBe(3);

        startReturnHome(fighter);
        world.emit(CollisionEvent, { other: CARRIER_UUID, initiator: true },
            [uuid]);
        await stepWorld(world, 1);
        // Room for it: 3 aboard, capacity 4.
        expect(outfitCount(carrier, FIGHTER_A_ID)).toBe(4);
    });

    it('leaves reload timing and weapon state alone when ammo changes, '
        + 'so consuming a fighter does not reset the bay\'s clock',
        async () => {
            const { world, carrier } = await makeTestWorld({
                fighterCounts: { [FIGHTER_A_ID]: 2 },
            });
            const weaponsStateBefore =
                carrier.components.get(WeaponsStateComponent);
            const localStateBefore = [...carrier.components.keys()]
                .find(c => c.name === 'WeaponsComponent');
            expect(localStateBefore).toBeDefined();
            const localBefore = carrier.components
                .get(localStateBefore!) as unknown;

            await launchOne(world, carrier);

            // Consuming ammo mutates the OutfitsState entry IN PLACE.
            // Provide's change detection only fires on component
            // REASSIGNMENT (nova_ecs/provide.ts), so WeaponsState is not
            // re-derived and the WeaponsComponent local state (reload
            // timers, burst counters) survives — the hazard behind the
            // WeaponsComponentProvider TODO in fire_weapon_plugin.ts.
            expect(carrier.components.get(WeaponsStateComponent))
                .toBe(weaponsStateBefore);
            expect(carrier.components.get(localStateBefore!) as unknown)
                .toBe(localBefore);
            // The bay is still mounted, with its count intact.
            expect(carrier.components.get(WeaponsStateComponent)!
                .get(BAY_ID)!.count).toBe(1);
        });
});
