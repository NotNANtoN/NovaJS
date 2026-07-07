import { WireWorldSnapshot } from "nova_ecs/plugins/snapshot_plugin";
import { InputRecord } from "./simulation_input.js";

export { InputRecord } from "./simulation_input.js";

/** A wire snapshot of the room's state at a tick: the starting point
 * for reconstruction, in place of replaying from genesis. */
export interface ArchiveBaseline {
    tick: number;
    snapshot: WireWorldSnapshot;
}

/**
 * Peers hash their world every this many ticks for desync detection.
 * The server's archive sim hashes the same ticks, so it can vote.
 */
export const STATE_HASH_INTERVAL = 60;

/**
 * Rollback protocol messages travel on the same room channel as the
 * legacy multiplayer messages, wrapped in a `rollback` envelope. The
 * legacy Message codec is a t.partial, so it decodes these as empty
 * messages and ignores them; likewise this side ignores everything
 * without the envelope.
 */
export type RollbackProtocolMessage =
    | { kind: 'inputs', record: InputRecord }
    /** The server's clock, broadcast periodically. */
    | { kind: 'tickSync', tick: number }
    /** Ask the server for the input log from a tick (late join). */
    | { kind: 'inputLogRequest', fromTick: number }
    | { kind: 'inputLog', records: InputRecord[] }
    /** Join: the input log up to the server's current tick, plus the
     * newest archived baseline when the server has one. The joiner
     * replays the log over the baseline (or the deterministic genesis
     * world when there is none). */
    | { kind: 'joinRequest' }
    | {
        kind: 'catchUp', tick: number, records: InputRecord[],
        baseline?: ArchiveBaseline,
    }
    /** A peer's world hash for a settled tick (peer -> server). */
    | { kind: 'stateHash', tick: number, hash: string }
    /** The relay saw peers disagree about a tick's state
     * (server -> everyone). Non-canonical peers resync. */
    | { kind: 'desync', tick: number, hashes: [string, string][] };

export function wrapRollbackMessage(message: RollbackProtocolMessage): unknown {
    return { rollback: message };
}

export function unwrapRollbackMessage(raw: unknown): RollbackProtocolMessage | undefined {
    const envelope = raw as { rollback?: RollbackProtocolMessage } | undefined;
    return envelope?.rollback;
}

/**
 * Which hash in a desync report is the true state: the input log
 * deterministically defines it, but nobody simulated the log twice
 * client-side, so the report votes. The most common hash wins; ties
 * break first toward a `preferred` reporter (the server, whose archive
 * sim *is* the log's true simulation), then toward the lowest peerId.
 * Every peer computes the same answer from the same report, so exactly
 * the diverged minority resyncs.
 */
export function canonicalDesyncHash(hashes: [string, string][],
    preferred?: ReadonlySet<string>): string | undefined {
    const groups = new Map<string, string[]>();
    for (const [peerId, hash] of hashes) {
        groups.set(hash, [...(groups.get(hash) ?? []), peerId]);
    }
    let best: {
        hash: string, count: number,
        preferred: boolean, lowestPeer: string,
    } | undefined;
    for (const [hash, peers] of groups) {
        const candidate = {
            hash,
            count: peers.length,
            preferred: peers.some(peer => preferred?.has(peer) ?? false),
            lowestPeer: [...peers].sort()[0]!,
        };
        const wins = !best
            || candidate.count > best.count
            || (candidate.count === best.count && (
                (candidate.preferred && !best.preferred)
                || (candidate.preferred === best.preferred
                    && candidate.lowestPeer < best.lowestPeer)));
        if (wins) {
            best = candidate;
        }
    }
    return best?.hash;
}
