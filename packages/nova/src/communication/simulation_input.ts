import { isLeft } from "fp-ts/lib/Either.js";
import { EncodedEntity, SerializerResource } from "nova_ecs/plugins/serializer_plugin";
import { World } from "nova_ecs/world";
import { ControlEvent, ControlsSubject, EcsControlEvent } from "../nova_plugin/controls_plugin.js";
import { loadEntityGameData } from "../nova_plugin/entity_data_loader.js";
import { deriveEntityComponents } from "../nova_plugin/entity_factory.js";
import { JumpRouteComponent } from "../nova_plugin/jump_plugin.js";
import { PlayerShipSelector } from "../nova_plugin/player_ship_plugin.js";
import { applyControlEvents, ControlledByComponent } from "../nova_plugin/ship_control.js";

/**
 * Everything that changes the simulation from outside is an input,
 * recorded against the tick it applies to. Inputs are the only wire
 * format rollback multiplayer needs in steady state: they are
 * structured-cloneable, and applying the same inputs at the same tick
 * to the same state is deterministic.
 *
 * Entity insertion is an input too: the entity is staged (its game
 * data loaded) *before* the input is scheduled, so applying the input
 * is synchronous. The insertion tick may vary between runs — inputs
 * are external by definition — but resimulating a recorded history
 * replays it exactly.
 */
export type SimulationInput =
    | { kind: 'control', events: ControlEvent[] }
    | { kind: 'addEntity', uuid: string, entity: EncodedEntity }
    | { kind: 'removeEntity', uuid: string }
    | { kind: 'setJumpRoute', route: string[] }
    /** Server-authored when a peer disconnects. */
    | { kind: 'removePeer', peerId: string };

/**
 * A peer's inputs for one simulation tick. The steady-state wire
 * format of rollback multiplayer, and the unit the rollback driver
 * records per tick.
 */
export interface InputRecord {
    /** Undefined only for local play before a connection exists. */
    peerId?: string;
    tick: number;
    inputs: SimulationInput[];
}

/**
 * Applies a tick's input records. Records sort by peerId so every
 * peer applies the same tick's inputs in the same order regardless of
 * arrival order.
 */
export function applyInputRecords(world: World, records: InputRecord[]) {
    const sorted = [...records].sort((a, b) => {
        const peerA = a.peerId ?? '';
        const peerB = b.peerId ?? '';
        return peerA < peerB ? -1 : peerA > peerB ? 1 : 0;
    });
    for (const record of sorted) {
        applySimulationInputs(world, record.inputs, record.peerId);
    }
}

/**
 * Loads the game data for every entity inserted by these records, so
 * applying (or replaying) them is synchronous. The originating peer
 * stages before scheduling; every *other* world applying the record —
 * a late joiner replaying the log, the server's archive — must stage
 * from the record itself before applying it.
 */
export async function loadInputRecordsGameData(
    world: World, records: InputRecord[]) {
    const serializer = world.resources.get(SerializerResource);
    if (!serializer) {
        return;
    }
    for (const record of records) {
        for (const input of record.inputs) {
            if (input.kind !== 'addEntity') {
                continue;
            }
            const decoded = serializer.decode(input.entity);
            if (!isLeft(decoded)) {
                await loadEntityGameData(world, decoded.right);
            }
        }
    }
}

/**
 * Applies a tick's inputs, in order. Called by the rollback driver
 * immediately before stepping that tick — both live and during
 * resimulation — so it must be deterministic and synchronous.
 */
export function applySimulationInputs(world: World, inputs: SimulationInput[],
    peerId?: string) {
    for (const input of inputs) {
        switch (input.kind) {
            case 'control': {
                applyControlEvents(world, peerId, input.events);
                const subject = world.resources.get(ControlsSubject);
                if (subject) {
                    for (const event of input.events) {
                        subject.next(event);
                    }
                }
                break;
            }
            case 'addEntity': {
                const serializer = world.resources.get(SerializerResource);
                if (!serializer) {
                    throw new Error('Expected serializer resource to exist');
                }
                const decoded = serializer.decode(input.entity);
                if (isLeft(decoded)) {
                    console.warn(`Dropping addEntity input for ${input.uuid}: `
                        + serializer.describeDecodeFailure(input.entity, decoded.left));
                    break;
                }
                deriveEntityComponents(world, decoded.right);
                world.entities.set(input.uuid, decoded.right);
                break;
            }
            case 'removeEntity': {
                world.entities.delete(input.uuid);
                break;
            }
            case 'removePeer': {
                for (const [uuid, entity] of [...world.entities]) {
                    if (entity.components.get(ControlledByComponent)?.peerId
                        === input.peerId) {
                        world.entities.delete(uuid);
                    }
                }
                break;
            }
            case 'setJumpRoute': {
                for (const entity of world.entities.values()) {
                    const controlled = peerId !== undefined
                        ? entity.components.get(ControlledByComponent)?.peerId === peerId
                        : entity.components.has(PlayerShipSelector);
                    if (!controlled) {
                        continue;
                    }
                    const jumpRoute = entity.components.get(JumpRouteComponent);
                    if (jumpRoute) {
                        jumpRoute.route = [...input.route];
                    }
                    break;
                }
                break;
            }
        }
    }
}
