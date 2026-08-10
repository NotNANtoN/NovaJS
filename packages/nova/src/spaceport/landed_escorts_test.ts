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
    JumpComponent, MultiJumpContinueComponent,
} from '../nova_plugin/jump_plugin.js';
import { GateArrivalComponent } from '../nova_plugin/gate_transit_plugin.js';
import {
    CarriedEscort, deployedFightersBySource, escortsAccountedFor,
    carriedBatchMustHold, carriedBatchSettled, gateArrivalPending,
    multiJumpChainContinues, multiJumpChainSettled, prepareCarriedEscort,
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

describe('multi-jump chain roster policy', () => {
    /** A player entity mid-jump with `autoJumpsLeft` budget remaining. */
    function jumping(autoJumpsLeft?: number) {
        const player = new Entity();
        player.components.set(JumpComponent, {
            to: 'test:destination',
            stage: 'arriving',
            direction: 0,
            ...(autoJumpsLeft === undefined ? {} : { autoJumpsLeft }),
        });
        return player;
    }

    it('holds a batch while the chain has budget left', () => {
        expect(multiJumpChainContinues(jumping(2))).toBeTrue();
        expect(multiJumpChainContinues(jumping(1))).toBeTrue();
    });

    it('releases a batch on the last hop of a chain', () => {
        expect(multiJumpChainContinues(jumping(0))).toBeFalse();
        expect(multiJumpChainContinues(jumping())).toBeFalse();
        // An ordinary single jump, and a gate transit (no JumpComponent at
        // all — jumpTo serves both).
        expect(multiJumpChainContinues(new Entity())).toBeFalse();
    });

    it('calls the chain settled only when neither jump component is set',
        () => {
            expect(multiJumpChainSettled(new Entity())).toBeTrue();
            // Mid-sequence in the origin system.
            expect(multiJumpChainSettled(jumping(1))).toBeFalse();
            // The one step between arriving and the next hop beginning.
            const continuing = new Entity();
            continuing.components.set(MultiJumpContinueComponent, { left: 1 });
            expect(multiJumpChainSettled(continuing)).toBeFalse();
        });

    /**
     * Matthew's item 2: escorts must come out of a wormhole/hypergate IN
     * FORMATION with the player.
     *
     * A hyperspace jump sets its arrival kinematics at DEPARTURE, so the
     * player entity already holds its destination station when a batch is
     * placed on it. A GATE arrival cannot — the exit is the destination
     * gate's spöb, which only exists once the destination world is up, so
     * GateArrivalSystem teleports the player on its first tick there.
     * Placing a batch before that put the escorts in formation around the
     * player's ORIGIN-system position. The batch is therefore held over a
     * pending gate arrival exactly as it is over a multi-jump chain.
     */
    describe('gate arrivals hold the batch until the player is placed', () => {
        /** A player entity still carrying its gate arrival marker. */
        function arrivingAtGate() {
            const player = new Entity();
            player.components.set(GateArrivalComponent, {
                destinationSpob: 'nova:1', emergenceAngle: null,
                randomDraw: 0.25,
            });
            return player;
        }

        it('recognizes a pending gate arrival', () => {
            expect(gateArrivalPending(arrivingAtGate())).toBeTrue();
            expect(gateArrivalPending(new Entity())).toBeFalse();
        });

        it('holds a batch entering a system through a gate', () => {
            expect(carriedBatchMustHold(arrivingAtGate())).toBeTrue();
        });

        it('does not release the batch until the marker clears', () => {
            const player = arrivingAtGate();
            expect(carriedBatchSettled(player)).toBeFalse();
            // GateArrivalSystem deletes the marker on the tick it
            // teleports the ship to the gate's emergence point.
            player.components.delete(GateArrivalComponent);
            expect(carriedBatchSettled(player)).toBeTrue();
        });

        it('leaves the ordinary hyperspace arrival alone (no regression)',
            () => {
                // No gate marker: a plain jump arrival is released at once,
                // because its station is already correct.
                expect(carriedBatchMustHold(new Entity())).toBeFalse();
                expect(carriedBatchSettled(new Entity())).toBeTrue();
            });

        it('holds for a chain and a gate independently', () => {
            const both = arrivingAtGate();
            both.components.set(MultiJumpContinueComponent, { left: 1 });
            expect(carriedBatchSettled(both)).toBeFalse();
            both.components.delete(MultiJumpContinueComponent);
            expect(carriedBatchSettled(both)).toBeFalse();
            both.components.delete(GateArrivalComponent);
            expect(carriedBatchSettled(both)).toBeTrue();
        });
    });

    it('ends a chain that ran out of route or fuel', () => {
        // MultiJumpContinueSystem consumes its marker whatever the outcome,
        // so a blocked continuation leaves the player with neither
        // component — which is exactly the release signal.
        const blocked = new Entity();
        blocked.components.set(MultiJumpContinueComponent, { left: 3 });
        expect(multiJumpChainSettled(blocked)).toBeFalse();
        blocked.components.delete(MultiJumpContinueComponent);
        expect(multiJumpChainSettled(blocked)).toBeTrue();
    });

    /**
     * The client's take/hold/insert decision, as jumpTo and
     * flushCarriedJumpEscorts make it (browser.ts), run headlessly over a
     * whole chain. The point under test is that the batch is never put down
     * in a system the chain is about to leave, and is put down exactly once
     * in the one it ends in.
     */
    it('lands the batch in the final system of a chain, and only there',
        () => {
            let held: CarriedEscort[] = [
                { player: PLAYER, uuid: 'e1', entity: new Entity() },
                { player: PLAYER, uuid: 'e2', entity: new Entity() },
            ];
            const insertedIn: string[] = [];

            // Three hops of a two-extra-jump chain: budget 2 -> 1 -> 0.
            for (const [system, budget] of
                [['mid a', 2], ['mid b', 1], ['final', 0]] as const) {
                const arriving = jumping(budget);
                const taken = takeCarriedEscorts(held, PLAYER);
                held = [];
                if (multiJumpChainContinues(arriving)) {
                    held = taken; // Rides on to the next hop.
                } else if (taken.length > 0) {
                    insertedIn.push(system);
                }
            }

            expect(insertedIn).toEqual(['final']);
            expect(held.length).toEqual(0);
        });

    it('releases a held batch when the chain ends early', () => {
        // The chain claimed more hops but the next one was blocked, so the
        // player settles where it is. The standing flush is what puts the
        // batch down: settled player, batch taken, roster emptied.
        const held: CarriedEscort[] = [
            { player: PLAYER, uuid: 'e1', entity: new Entity() },
        ];
        expect(multiJumpChainSettled(new Entity())).toBeTrue();
        const taken = takeCarriedEscorts(held, PLAYER);
        expect(taken.map(({ uuid }) => uuid)).toEqual(['e1']);
        expect(held.length).toEqual(0);
    });
});

describe('escort convergence invariant', () => {
    function carried(uuid: string, player = PLAYER): CarriedEscort {
        return { player, uuid, entity: new Entity() };
    }

    it('accounts for escorts in the world and in rosters', () => {
        const landed = [carried('a')];
        const jumpingRoster = [carried('b')];
        const audit = escortsAccountedFor(PLAYER, ['a', 'b', 'c'], ['c'],
            [landed, jumpingRoster]);
        expect(audit.inWorld).toEqual(['c']);
        expect(audit.inRoster).toEqual(['a', 'b']);
        expect(audit.stranded).toEqual([]);
    });

    it('reports an escort that is in neither as stranded', () => {
        const audit = escortsAccountedFor(PLAYER, ['a', 'lost'], ['a'], []);
        expect(audit.stranded).toEqual(['lost']);
    });

    it('does not count another player\'s roster entries', () => {
        // A shared roster's other-peer entries must never make this
        // player's missing escort look accounted for.
        const shared = [carried('theirs', 'other player'),
            carried('lost', 'other player')];
        const audit = escortsAccountedFor(PLAYER, ['lost'], [], [shared]);
        expect(audit.stranded).toEqual(['lost']);
    });

    it('holds across a gate transit: the whole flock is in the roster', () => {
        // EscortFollowGateSystem sweeps everything, including a zero-energy
        // hull, so nothing is left behind in the origin system.
        const roster = [carried('flyer'), carried('noEnergy')];
        const audit = escortsAccountedFor(PLAYER, ['flyer', 'noEnergy'], [],
            [roster]);
        expect(audit.stranded).toEqual([]);
        expect(audit.inRoster).toEqual(['flyer', 'noEnergy']);
    });
});
