import { Entity } from 'nova_ecs/entity';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { ReturnWhenTargetRemovedComponent } from '../nova_plugin/bay_plugin.js';
import { EscortCommandComponent } from '../nova_plugin/escort_command.js';
import {
    OwnerComponent, SourceComponent,
} from '../nova_plugin/fire_weapon_plugin.js';
import { FiringGroupComponent } from '../nova_plugin/firing_group.js';
import {
    FormationComponent, formationSlotPosition,
} from '../nova_plugin/npc_ai_plugin.js';
import {
    EscortLandingComponent, PlayerEscortComponent,
} from '../nova_plugin/player_escort.js';

/**
 * ============================================================================
 * The client's carried-escort roster
 * ============================================================================
 *
 * Escorts that left the simulation to follow their player — landed with
 * them on a planet, or departed with them into hyperspace — are held here
 * as whole serialized entities until the client puts them back
 * (browser.ts). Per-player client state, exactly like the docked player
 * ship itself (display/docked_ship.ts): the DESPAWN is simulation state
 * that every peer performs, but only the owning client keeps the roster,
 * and only it respawns them.
 *
 * Entities, not ship ids. Rebuilding an escort from its ship id would
 * silently discard damage, outfits, cargo, ionization, and — for a
 * launched fighter — its bay identity (OwnerComponent / SourceComponent /
 * ReturnWhenTargetRemovedComponent, and any future BayFighterComponent).
 * Carrying the serialized entity preserves every component the serializer
 * knows about, whether or not this module has heard of it.
 *
 * LANDED FIGHTERS ARE STILL LAUNCHED. Landing does not stow a deployed
 * fighter back into its bay (that is a normal state in the original
 * game): a landed fighter comes back out still deployed, keeps its bay
 * identity, and can still be ordered home with the returnToBay command
 * afterwards. `deployedFightersBySource` is the documented hook for bay
 * ammo accounting: it reports the landed roster's still-deployed fighters
 * per carrier so the outfitter's deployed-count can include them.
 */

export interface CarriedEscort {
    /** The player ship uuid this escort belongs to. */
    player: string;
    /** The uuid the escort had before it left the simulation. */
    uuid: string;
    /** The escort's full entity, as decoded from its carry event. */
    entity: Entity;
}

/**
 * Removes and returns the roster entries belonging to `player`, leaving
 * everyone else's entries in place. Mutates `roster` — a jump or a
 * liftoff consumes exactly one player's escorts, and in multiplayer the
 * other peers' carry events are simply not this client's business.
 */
export function takeCarriedEscorts(roster: CarriedEscort[], player: string):
    CarriedEscort[] {
    const taken: CarriedEscort[] = [];
    for (let i = roster.length - 1; i >= 0; i--) {
        if (roster[i].player === player) {
            taken.unshift(...roster.splice(i, 1));
        }
    }
    return taken;
}

/**
 * The still-deployed bay fighters in a roster, grouped by the carrier
 * (SourceComponent) that launched them. The hook for bay ammo accounting:
 * a fighter that landed with the player is still deployed, so an
 * outfitter deployed-count must include it (see the module comment).
 */
export function deployedFightersBySource(roster: readonly CarriedEscort[]):
    Map<string, number> {
    const counts = new Map<string, number>();
    for (const { entity } of roster) {
        if (!entity.components.has(ReturnWhenTargetRemovedComponent)) {
            continue;
        }
        const source = entity.components.get(SourceComponent);
        if (source === undefined) {
            continue;
        }
        counts.set(source, (counts.get(source) ?? 0) + 1);
    }
    return counts;
}

/** Where a formation leader is, for placing its followers' stations. */
interface Station {
    position: Position;
    rotation: Angle;
    velocity: Vector;
}

function stationOf(entity: Entity): Station | undefined {
    const movement = entity.components.get(MovementStateComponent);
    if (!movement) {
        return undefined;
    }
    return {
        position: Position.fromVectorLike(movement.position),
        rotation: Angle.fromAngleLike(movement.rotation),
        velocity: Vector.fromVectorLike(movement.velocity),
    };
}

/**
 * How deep a carried batch's carrier chains are followed when placing
 * stations (a fighter on a carrier escort on the player is depth 2). Same
 * bound as the flock walk.
 */
const MAX_CARRY_DEPTH = 8;

/**
 * Places one carried escort on `attachTo`'s station: formation slot,
 * command reset to 'formation' (the explicit boundary reset — see
 * player_escort_plugin's module comment), the player's firing group, and
 * the durable ownership marker.
 *
 * Every other component is left exactly as it came out of the simulation,
 * except that intra-batch uuid references (a fighter's OwnerComponent /
 * SourceComponent naming its carrier) are rewritten through `remap` — the
 * batch comes back under fresh uuids, so an un-remapped fighter could
 * never find its bay again.
 *
 * Velocity is copied from the station so a batch arriving from hyperspace
 * coasts in with the player (who arrives at top speed) instead of hanging
 * motionless in front of them.
 */
function placeCarriedEscort(escort: CarriedEscort, player: string,
    attachTo: string, station: Station, slot: number,
    remap: ReadonlyMap<string, string>, ownerUuid?: string): Entity | undefined {
    const movement = escort.entity.components.get(MovementStateComponent);
    if (!movement) {
        return undefined;
    }
    escort.entity.components.set(MovementStateComponent, {
        ...movement,
        position: formationSlotPosition(station.position, station.rotation,
            slot),
        rotation: station.rotation,
        velocity: station.velocity,
        accelerating: 0,
        turning: 0,
        turnBack: false,
        turnTo: null,
    });
    escort.entity.components.set(FormationComponent,
        { leader: attachTo, slot });
    escort.entity.components.set(EscortCommandComponent,
        { command: 'formation' });
    // The firing group is the flock ROOT, so it stays the player even for
    // a fighter that re-attaches to its carrier.
    escort.entity.components.set(FiringGroupComponent, { group: player });
    escort.entity.components.set(PlayerEscortComponent,
        { player, parent: attachTo });
    escort.entity.components.delete(EscortLandingComponent);
    const owner = escort.entity.components.get(OwnerComponent);
    const remappedOwner = owner && remap.get(owner.owner);
    if (remappedOwner) {
        escort.entity.components.set(OwnerComponent, { owner: remappedOwner });
    }
    const source = escort.entity.components.get(SourceComponent);
    const remappedSource = source !== undefined
        ? remap.get(source) : undefined;
    if (remappedSource) {
        escort.entity.components.set(SourceComponent, remappedSource);
    }
    if (ownerUuid !== undefined) {
        escort.entity.components.set(MultiplayerData, { owner: ownerUuid });
    }
    return escort.entity;
}

/**
 * Prepares a single carried escort for re-insertion directly on its
 * player. The batch form below is what the client actually uses; this is
 * the simple case (and the unit under test).
 */
export function prepareCarriedEscort(escort: CarriedEscort,
    leaderUuid: string, leader: Entity, slot: number,
    ownerUuid?: string): Entity | undefined {
    const station = stationOf(leader);
    if (!station) {
        return undefined;
    }
    return placeCarriedEscort(escort, leaderUuid, leaderUuid, station, slot,
        new Map(), ownerUuid);
}

/**
 * Prepares a whole carried batch for re-insertion, minting the uuid each
 * escort will be inserted under.
 *
 * The batch is handled as a unit so that a carrier escort and the fighters
 * it had launched come back INTACT: each escort attaches to its recorded
 * parent when that parent is in the same batch (placed first, so its
 * station is known), and to the player otherwise. Their owner/source
 * references are remapped to the batch's new uuids, which keeps
 * return-to-bay working after a landing or a jump, and keeps the
 * one-hop/indirect command split (escort_command_plugin) unchanged.
 *
 * Slots run from `firstSlot` for the player's own followers, and from 0
 * for any carrier in the batch (whose formation is new too).
 */
export function prepareCarriedEscorts(escorts: readonly CarriedEscort[],
    leaderUuid: string, leader: Entity, firstSlot: number,
    mintUuid: () => string, ownerUuid?: string):
    Array<{ uuid: string, entity: Entity }> {
    const leaderStation = stationOf(leader);
    if (!leaderStation) {
        return [];
    }
    const remap = new Map<string, string>();
    for (const escort of escorts) {
        remap.set(escort.uuid, mintUuid());
    }
    const stations = new Map<string, Station>([[leaderUuid, leaderStation]]);
    const nextSlot = new Map<string, number>([[leaderUuid, firstSlot]]);
    const prepared: Array<{ uuid: string, entity: Entity }> = [];

    const place = (escort: CarriedEscort, attachTo: string) => {
        const station = stations.get(attachTo)!;
        const slot = nextSlot.get(attachTo) ?? 0;
        nextSlot.set(attachTo, slot + 1);
        const uuid = remap.get(escort.uuid)!;
        const entity = placeCarriedEscort(escort, leaderUuid, attachTo,
            station, slot, remap, ownerUuid);
        if (!entity) {
            console.warn(`Carried escort ${escort.uuid} has no movement `
                + `state; skipped`);
            return;
        }
        const ownStation = stationOf(entity);
        if (ownStation) {
            stations.set(uuid, ownStation);
        }
        prepared.push({ uuid, entity });
    };

    let remaining = [...escorts];
    for (let depth = 0; depth < MAX_CARRY_DEPTH && remaining.length > 0;
        depth++) {
        const deferred: CarriedEscort[] = [];
        for (const escort of remaining) {
            const parent = escort.entity.components
                .get(PlayerEscortComponent)?.parent;
            const carrier = parent !== undefined && parent !== escort.uuid
                ? remap.get(parent) : undefined;
            if (carrier === undefined) {
                place(escort, leaderUuid); // A direct escort of the player.
            } else if (stations.has(carrier)) {
                place(escort, carrier);
            } else {
                deferred.push(escort); // Its carrier is not placed yet.
            }
        }
        if (deferred.length === remaining.length) {
            break; // No progress (a carrier cycle): fall through below.
        }
        remaining = deferred;
    }
    // Anything whose carrier never got placed joins the player directly
    // rather than being dropped: ownership is never lost.
    for (const escort of remaining) {
        place(escort, leaderUuid);
    }
    return prepared;
}
