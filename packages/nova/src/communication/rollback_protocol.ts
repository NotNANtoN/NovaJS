import { InputRecord } from "./simulation_input.js";

export { InputRecord } from "./simulation_input.js";

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
    | { kind: 'inputLog', records: InputRecord[] };

export function wrapRollbackMessage(message: RollbackProtocolMessage): unknown {
    return { rollback: message };
}

export function unwrapRollbackMessage(raw: unknown): RollbackProtocolMessage | undefined {
    const envelope = raw as { rollback?: RollbackProtocolMessage } | undefined;
    return envelope?.rollback;
}
