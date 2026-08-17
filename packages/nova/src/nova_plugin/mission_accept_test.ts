import 'jasmine';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import { SerializerPlugin, SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { CargoComponent } from './cargo_plugin.js';
import { AcceptedMission, AcceptedMissionType, applyAcceptMission } from './mission_accept.js';
import { ActiveMission, ActiveMissionType, CreditsComponent, MissionsComponent, MAX_ACTIVE_MISSIONS } from './player_state_plugin.js';
import { ActiveRanksComponent, ControlBitsComponent } from './ncb_plugin.js';
import { OutfitsStateComponent } from './outfit_plugin.js';
import { ControlledByComponent } from './ship_control.js';

/**
 * ============================================================================
 * The in-flight mission-accept input record (shape A)
 * ============================================================================
 *
 * A përs ship offers its LinkMission when you hail it, or when you board
 * it (përs Flags 0x0200) — both in flight, where the docked
 * MissionSession/commit route does not exist. The client resolves the
 * offer (the simulation has no access to mission data at all) and bakes
 * the RESULT into a record as DELTAS; the sim applies it on every peer at
 * the same tick, enforcing the invariants it can check without that data.
 *
 * These specs pin the enforcement, since that is the whole trust boundary
 * (see mission_accept.ts's header for where it sits and why).
 */

const PEER = 'the peer';
const MISSION = 'nova:134';

function activeMission(overrides: Partial<ActiveMission> = {}): ActiveMission {
    return {
        id: MISSION, acceptedDay: 0, acceptedAt: 'nova:128',
        travelPlanet: null, returnPlanet: 'nova:128',
        cargoType: -1, cargoQty: 0, cargoLoaded: false,
        travelDone: false, deadlineDay: null, ...overrides,
    };
}

/** A world with one player ship, controlled by PEER. */
function makeWorld() {
    const world = new World();
    world.addPlugin(SerializerPlugin);
    const player = new Entity('player');
    player.components.set(ControlledByComponent, { peerId: PEER });
    player.components.set(MissionsComponent, new Map());
    player.components.set(CreditsComponent, { credits: 1000 });
    player.components.set(ControlBitsComponent, new Set<number>());
    player.components.set(ActiveRanksComponent, new Set<string>());
    player.components.set(CargoComponent, new Map());
    player.components.set(OutfitsStateComponent, new Map());
    world.entities.set('player', player);
    return { world, player };
}

function accepted(overrides: Partial<AcceptedMission> = {}): AcceptedMission {
    return {
        missionId: MISSION,
        mission: ActiveMissionType.encode(activeMission()),
        ...overrides,
    };
}

const missionsOf = (player: Entity) =>
    player.components.get(MissionsComponent)!;

describe('applyAcceptMission', () => {
    it('registers the resolved mission on the acting peer\'s ship', () => {
        const { world, player } = makeWorld();
        applyAcceptMission(world, PEER, accepted());
        expect(missionsOf(player).get(MISSION)?.returnPlanet)
            .toEqual('nova:128');
    });

    it('resolves the actor from peerId, never from the record', () => {
        // The record cannot name whose mission this is, so no peer can
        // accept one on somebody else's behalf — the same discipline
        // applyHail uses.
        const { world, player } = makeWorld();
        applyAcceptMission(world, 'a different peer', accepted());
        expect(missionsOf(player).size).toEqual(0);
    });

    it('is idempotent: a replayed record cannot pay twice', () => {
        // Load-bearing for rollback, which resimulates recorded inputs.
        const { world, player } = makeWorld();
        const record = accepted({ creditsDelta: 500 });
        applyAcceptMission(world, PEER, record);
        applyAcceptMission(world, PEER, record);
        applyAcceptMission(world, PEER, record);
        expect(missionsOf(player).size).toEqual(1);
        expect(player.components.get(CreditsComponent)!.credits)
            .toEqual(1500);
    });

    it('re-checks the 16-mission cap', () => {
        const { world, player } = makeWorld();
        const missions = missionsOf(player);
        for (let i = 0; i < MAX_ACTIVE_MISSIONS; i++) {
            missions.set(`filler:${i}`, activeMission({ id: `filler:${i}` }));
        }
        applyAcceptMission(world, PEER, accepted());
        expect(missions.has(MISSION)).toBeFalse();
        expect(missions.size).toEqual(MAX_ACTIVE_MISSIONS);
    });

    it('drops a record whose mission does not decode', () => {
        const { world, player } = makeWorld();
        applyAcceptMission(world, PEER,
            { missionId: MISSION, mission: { nonsense: true } });
        expect(missionsOf(player).size).toEqual(0);
    });

    describe('the accept\'s effects, applied as DELTAS', () => {
        it('applies a signed credit change', () => {
            const { world, player } = makeWorld();
            applyAcceptMission(world, PEER, accepted({ creditsDelta: -250 }));
            expect(player.components.get(CreditsComponent)!.credits)
                .toEqual(750);
        });

        it('clamps credits at zero: EV Nova has no debt', () => {
            const { world, player } = makeWorld();
            applyAcceptMission(world, PEER,
                accepted({ creditsDelta: -999_999 }));
            expect(player.components.get(CreditsComponent)!.credits)
                .toEqual(0);
        });

        it('composes with a concurrent change, which an absolute could not',
            () => {
                // The reason the record carries deltas: rollback can
                // resimulate the ticks between the client computing the
                // record and the sim applying it. A "set credits to 1500"
                // would silently undo the plunder below; "+500" survives.
                const { world, player } = makeWorld();
                player.components.get(CreditsComponent)!.credits -= 400;
                applyAcceptMission(world, PEER, accepted({ creditsDelta: 500 }));
                expect(player.components.get(CreditsComponent)!.credits)
                    .toEqual(1100);
            });

        it('sets and clears control bits (the OnAccept set string)', () => {
            const { world, player } = makeWorld();
            player.components.get(ControlBitsComponent)!.add(7);
            applyAcceptMission(world, PEER,
                accepted({ bitsSet: [1, 2], bitsCleared: [7] }));
            const bits = player.components.get(ControlBitsComponent)!;
            expect([...bits].sort()).toEqual([1, 2]);
        });

        it('grants and revokes ranks', () => {
            const { world, player } = makeWorld();
            player.components.get(ActiveRanksComponent)!.add('nova:200');
            applyAcceptMission(world, PEER, accepted({
                ranksGranted: ['nova:201'], ranksRevoked: ['nova:200'],
            }));
            expect([...player.components.get(ActiveRanksComponent)!])
                .toEqual(['nova:201']);
        });

        it('moves cargo, dropping keys that empty out', () => {
            const { world, player } = makeWorld();
            player.components.get(CargoComponent)!.set('Food', 3);
            applyAcceptMission(world, PEER, accepted({
                cargoDelta: [['Food', -3], ['mission:nova:134', 2]],
            }));
            const cargo = player.components.get(CargoComponent)!;
            expect(cargo.has('Food')).toBeFalse();
            expect(cargo.get('mission:nova:134')).toEqual(2);
        });

        it('moves outfits and re-derives what depends on them', () => {
            const { world, player } = makeWorld();
            player.components.get(OutfitsStateComponent)!
                .set('nova:300', { count: 1 });
            applyAcceptMission(world, PEER, accepted({
                outfitsDelta: [['nova:300', -1], ['nova:301', 2]],
            }));
            const outfits = player.components.get(OutfitsStateComponent)!;
            expect(outfits.has('nova:300')).toBeFalse();
            expect(outfits.get('nova:301')?.count).toEqual(2);
        });

        it('leaves derived state alone when no outfit moved', () => {
            const { world, player } = makeWorld();
            applyAcceptMission(world, PEER, accepted({ creditsDelta: 1 }));
            expect(player.components.has(OutfitsStateComponent)).toBeTrue();
        });
    });

    describe('the special ships that ride the record', () => {
        /** A bare serializable ship entity, encoded as the record carries
         * it. */
        function encodedShip(world: World) {
            const serializer = world.resources.get(SerializerResource)!;
            const ship = new Entity('pirate');
            return serializer.encode(ship);
        }

        it('inserts them, so the mission and its ambush land together',
            () => {
                // The Derelict Decoy's four pirates jump in the moment you
                // take the bait. They ride THIS record rather than a
                // follow-up so a reorder or a dropped second record can
                // never leave a mission whose ships never came.
                const { world, player } = makeWorld();
                applyAcceptMission(world, PEER, accepted({
                    ships: [
                        { uuid: 'pirate:1', entity: encodedShip(world) as never },
                        { uuid: 'pirate:2', entity: encodedShip(world) as never },
                    ],
                }));
                expect(world.entities.has('pirate:1')).toBeTrue();
                expect(world.entities.has('pirate:2')).toBeTrue();
                expect(missionsOf(player).has(MISSION)).toBeTrue();
            });

        it('does not insert them when the accept itself was refused', () => {
            // A record that fails the cap check must not leave its ambush
            // behind: the ships belong to a mission that never started.
            const { world, player } = makeWorld();
            const missions = missionsOf(player);
            for (let i = 0; i < MAX_ACTIVE_MISSIONS; i++) {
                missions.set(`filler:${i}`,
                    activeMission({ id: `filler:${i}` }));
            }
            applyAcceptMission(world, PEER, accepted({
                ships: [
                    { uuid: 'pirate:1', entity: encodedShip(world) as never },
                ],
            }));
            expect(world.entities.has('pirate:1')).toBeFalse();
        });
    });

    it('round-trips through its codec unchanged', () => {
        // The record reaches other peers through JSON.stringify, so every
        // field has to be JSON-safe: no Map, no Set, no Position.
        const record = accepted({
            offeredBy: 'npc:derelict', creditsDelta: -100,
            bitsSet: [3], ranksGranted: ['nova:200'],
            cargoDelta: [['Food', 2]], outfitsDelta: [['nova:300', 1]],
        });
        const wire = JSON.parse(JSON.stringify(
            AcceptedMissionType.encode(record)));
        const decoded = AcceptedMissionType.decode(wire);
        expect(decoded._tag).toEqual('Right');
        if (decoded._tag === 'Right') {
            expect(decoded.right.missionId).toEqual(MISSION);
            expect(decoded.right.offeredBy).toEqual('npc:derelict');
            expect(decoded.right.cargoDelta).toEqual([['Food', 2]]);
        }
    });
});
