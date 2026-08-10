import 'jasmine';
import { isLeft } from 'fp-ts/lib/Either.js';
import { MockGameData } from 'novadatainterface/mock_game_data';
import { getDefaultShipData } from 'novadatainterface/ship_data';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { ReturnWhenTargetRemovedComponent } from '../nova_plugin/bay_plugin.js';
import { completeEntity } from '../nova_plugin/entity_data_loader.js';
import { EscortCommandComponent } from '../nova_plugin/escort_command.js';
import {
    OwnerComponent, SourceComponent,
} from '../nova_plugin/fire_weapon_plugin.js';
import { FiringGroupComponent } from '../nova_plugin/firing_group.js';
import { ArmorComponent } from '../nova_plugin/health_plugin.js';
import { makeShip } from '../nova_plugin/make_ship.js';
import { makeSystem } from '../nova_plugin/make_system.js';
import {
    formationSlotPosition, FormationComponent,
} from '../nova_plugin/npc_ai_plugin.js';
import {
    EscortLandingComponent, PlayerEscortComponent,
} from '../nova_plugin/player_escort.js';
import { EscortLandedEvent } from '../nova_plugin/player_escort_plugin.js';
import { deriveEntityComponents } from '../nova_plugin/entity_factory.js';
import { ShipPhysicsComponent } from '../nova_plugin/ship_plugin.js';
import { Stat } from '../nova_plugin/stat.js';
import {
    CarriedEscort, deployedFightersBySource, prepareCarriedEscort,
    prepareCarriedEscorts, takeCarriedEscorts,
} from './landed_escorts.js';

const PLAYER = 'player';
const SHIP_ID = 'test:ship';

/**
 * Capability components that are derived from ship data and outfits and
 * are deliberately NOT serializer-carried (see snapshot_policies): the
 * addEntity input path re-derives them with deriveEntityComponents, so a
 * carried escort legitimately comes back without them.
 */
const DERIVED_COMPONENTS = new Set([
    'ShipPhysicsComponent', 'CloakComponent', 'CloakScannerComponent',
    'IffComponent', 'RepairComponent',
]);

function movement(x: number, y: number, rotation = 0) {
    return {
        accelerating: 0,
        position: new Position(x, y),
        rotation: new Angle(rotation),
        turnBack: false,
        turning: 0,
        velocity: new Vector(0, 0),
    };
}

async function makeFixture() {
    const gameData = new MockGameData();
    gameData.data.Ship.map.set(SHIP_ID, {
        ...getDefaultShipData(),
        id: SHIP_ID,
    });
    await gameData.data.Ship.get(SHIP_ID);
    const world = await makeSystem('test:system', gameData, undefined,
        { npcs: false });
    const serializer = world.resources.get(SerializerResource)!;

    async function makeEscort(setup: (ship: Entity) => void = () => { }) {
        const ship = makeShip(gameData.data.Ship.map.get(SHIP_ID)!);
        ship.components.set(MovementStateComponent, movement(500, 500));
        setup(ship);
        await completeEntity(world, ship);
        return ship;
    }

    return { world, gameData, serializer, makeEscort };
}

function componentNames(entity: Entity): string[] {
    return [...entity.components.keys()].map(c => c.name).sort();
}

describe('carried escort roster', () => {
    it('takes only the named player\'s escorts, in order', () => {
        const roster: CarriedEscort[] = [
            { player: 'a', uuid: '1', entity: new Entity() },
            { player: 'b', uuid: '2', entity: new Entity() },
            { player: 'a', uuid: '3', entity: new Entity() },
        ];
        const taken = takeCarriedEscorts(roster, 'a');
        expect(taken.map(escort => escort.uuid)).toEqual(['1', '3']);
        expect(roster.map(escort => escort.uuid)).toEqual(['2']);
    });

    it('counts landed deployed fighters by their carrier', async () => {
        const { makeEscort } = await makeFixture();
        const fighter = async (source: string) => await makeEscort(ship => {
            ship.components.set(SourceComponent, source);
            ship.components.set(OwnerComponent, { owner: source });
            ship.components.set(ReturnWhenTargetRemovedComponent, undefined);
        });
        const roster: CarriedEscort[] = [
            { player: PLAYER, uuid: '1', entity: await fighter(PLAYER) },
            { player: PLAYER, uuid: '2', entity: await fighter(PLAYER) },
            { player: PLAYER, uuid: '3', entity: await fighter('carrier') },
            // A hired escort is not a deployed fighter.
            { player: PLAYER, uuid: '4', entity: await makeEscort() },
        ];
        expect(deployedFightersBySource(roster))
            .toEqual(new Map([[PLAYER, 2], ['carrier', 1]]));
    });
});

describe('carried escort round trip', () => {
    it('preserves every component across land -> carry -> depart',
        async () => {
            const { world, serializer, makeEscort } = await makeFixture();
            // A deployed bay fighter with battle damage: the state that
            // must survive a landing (rebuilding from a ship id would
            // lose all of it).
            const escort = await makeEscort(ship => {
                ship.components.set(OwnerComponent, { owner: PLAYER });
                ship.components.set(SourceComponent, PLAYER);
                ship.components.set(ReturnWhenTargetRemovedComponent,
                    undefined);
                ship.components.set(FormationComponent,
                    { leader: PLAYER, slot: 2 });
                ship.components.set(EscortCommandComponent,
                    { command: 'holdPosition' });
                ship.components.set(PlayerEscortComponent,
                    { player: PLAYER, parent: PLAYER, detached: true });
                // Battle damage. Set directly: the armor Stat is normally
                // provided by a Provide system when the world steps, and
                // this fixture never adds the entity to a world.
                ship.components.set(ArmorComponent, new Stat({
                    current: 17, max: 100, min: 0, recharge: 0,
                }));
            });
            const before = componentNames(escort);

            // Out through the real carry event codec (the path the
            // simulation bridge uses), including the structuredClone the
            // worker boundary performs.
            const encoded = structuredClone(serializer.encodeEvent(
                EscortLandedEvent, {
                entity: escort, uuid: 'fighter', player: PLAYER,
                planet: 'planet test:planet',
            }));
            const decoded = serializer.decodeEvent(EscortLandedEvent, encoded);
            if (isLeft(decoded)) {
                throw new Error('Failed to decode the carry event');
            }
            const carried: CarriedEscort = {
                player: decoded.right.player,
                uuid: decoded.right.uuid,
                entity: decoded.right.entity,
            };
            expect(carried.uuid).toEqual('fighter');
            expect(carried.player).toEqual(PLAYER);

            // Back in beside the relaunched player.
            const leader = new Entity();
            leader.components.set(MovementStateComponent, movement(100, 200));
            const restored = prepareCarriedEscort(carried, PLAYER, leader, 3,
                'peer');
            expect(restored).toBeDefined();

            // Nothing persistent dropped, nothing invented beyond the
            // escort wiring this function is documented to (re)stamp.
            // The capability components the serializer deliberately does
            // not carry (ship physics, cloak/scanner/IFF/repair — all
            // derived from outfits) are re-derived on insertion by the
            // addEntity input path; that is asserted below.
            expect(componentNames(restored!))
                .toEqual([...before, 'FiringGroup', 'MultiplayerData']
                    .filter(name => !DERIVED_COMPONENTS.has(name)).sort());
            expect(restored!.components.get(ArmorComponent)?.current)
                .toEqual(17);
            // Bay identity intact, so return-to-bay still works after
            // departure.
            expect(restored!.components.get(OwnerComponent))
                .toEqual({ owner: PLAYER });
            expect(restored!.components.get(SourceComponent)).toEqual(PLAYER);
            expect(restored!.components.has(ReturnWhenTargetRemovedComponent))
                .toBeTrue();
            // Re-stationed, in formation, command reset, player's group.
            expect(restored!.components.get(FormationComponent))
                .toEqual({ leader: PLAYER, slot: 3 });
            expect(restored!.components.get(EscortCommandComponent))
                .toEqual({ command: 'formation' });
            expect(restored!.components.get(FiringGroupComponent))
                .toEqual({ group: PLAYER });
            // The stale detached flag is gone: it is attached again.
            expect(restored!.components.get(PlayerEscortComponent))
                .toEqual({ player: PLAYER, parent: PLAYER });
            expect(restored!.components.has(EscortLandingComponent))
                .toBeFalse();
            const restoredMovement =
                restored!.components.get(MovementStateComponent)!;
            expect(restoredMovement.position).toEqual(formationSlotPosition(
                new Position(100, 200), new Angle(0), 3));

            // Re-insertion re-derives the capability components, so the
            // escort flies again with its physics intact.
            deriveEntityComponents(world, restored!);
            expect(restored!.components.has(ShipPhysicsComponent)).toBeTrue();
        });

    it('keeps a carrier escort and its fighters together in a batch',
        async () => {
            const { makeEscort } = await makeFixture();
            const carrier = await makeEscort(ship => {
                ship.components.set(PlayerEscortComponent,
                    { player: PLAYER, parent: PLAYER });
            });
            const wing = await makeEscort(ship => {
                ship.components.set(OwnerComponent, { owner: 'old carrier' });
                ship.components.set(SourceComponent, 'old carrier');
                ship.components.set(ReturnWhenTargetRemovedComponent,
                    undefined);
                ship.components.set(PlayerEscortComponent,
                    { player: PLAYER, parent: 'old carrier' });
            });
            const leader = new Entity();
            leader.components.set(MovementStateComponent, movement(0, 0));

            let minted = 0;
            // The wing is listed FIRST, so the batch has to defer it until
            // its carrier has a station.
            const prepared = prepareCarriedEscorts([
                { player: PLAYER, uuid: 'old wing', entity: wing },
                { player: PLAYER, uuid: 'old carrier', entity: carrier },
            ], PLAYER, leader, 0, () => `new-${minted++}`);

            expect(prepared.map(entry => entry.uuid).sort())
                .toEqual(['new-0', 'new-1']);
            const carrierUuid = prepared.find(
                entry => entry.entity === carrier)!.uuid;
            // The carrier flies on the player; the wing flies on the
            // carrier's NEW uuid, and its bay references follow.
            expect(carrier.components.get(FormationComponent))
                .toEqual({ leader: PLAYER, slot: 0 });
            expect(wing.components.get(FormationComponent))
                .toEqual({ leader: carrierUuid, slot: 0 });
            expect(wing.components.get(OwnerComponent))
                .toEqual({ owner: carrierUuid });
            expect(wing.components.get(SourceComponent)).toEqual(carrierUuid);
            expect(wing.components.get(PlayerEscortComponent))
                .toEqual({ player: PLAYER, parent: carrierUuid });
            // The flock root stays the player for firing immunity.
            expect(wing.components.get(FiringGroupComponent))
                .toEqual({ group: PLAYER });
        });

    it('attaches an escort whose carrier is not in the batch to the player',
        async () => {
            const { makeEscort } = await makeFixture();
            const orphan = await makeEscort(ship => {
                ship.components.set(PlayerEscortComponent,
                    { player: PLAYER, parent: 'carrier that died' });
            });
            const leader = new Entity();
            leader.components.set(MovementStateComponent, movement(0, 0));
            const prepared = prepareCarriedEscorts(
                [{ player: PLAYER, uuid: 'orphan', entity: orphan }],
                PLAYER, leader, 4, () => 'new-orphan');
            expect(prepared.length).toEqual(1);
            expect(orphan.components.get(FormationComponent))
                .toEqual({ leader: PLAYER, slot: 4 });
        });

    it('skips an escort with no movement state', async () => {
        const leader = new Entity();
        leader.components.set(MovementStateComponent, movement(0, 0));
        expect(prepareCarriedEscort(
            { player: PLAYER, uuid: '1', entity: new Entity() },
            PLAYER, leader, 0)).toBeUndefined();
    });
});
