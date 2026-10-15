import * as t from 'io-ts';
import { Component } from 'nova_ecs/component';
import { map } from 'nova_ecs/datatypes/map';
import {
    ReplicationMergeContext,
    replicationPolicies,
} from 'nova_ecs/plugins/multiplayer_plugin';

const WeaponState = t.intersection([t.type({
    count: t.number,
    firing: t.boolean,
}), t.partial({
    target: t.string,
})]);
export type WeaponState = t.TypeOf<typeof WeaponState>;

export const WeaponsState = map(t.string /* weapon id */, WeaponState);
export type WeaponsState = t.TypeOf<typeof WeaponsState>;
export const WeaponsStateComponent = new Component<WeaponsState>('WeaponsStateComponent');

function mergeWeaponStateIntent(
    local: WeaponsState,
    remote: WeaponsState,
    context: ReplicationMergeContext,
): WeaponsState {
    if (!(local instanceof Map) || !(remote instanceof Map)) {
        return remote;
    }

    if (context.peerIsAdmin && context.owner === context.localUuid) {
        // The local owner keeps its live trigger edge while accepting all
        // server-authored weapon inventory/result fields.
        const merged = new Map(remote);
        for (const [weaponId, localState] of local) {
            const remoteState = merged.get(weaponId);
            if (remoteState && typeof remoteState === 'object'
                && typeof localState?.firing === 'boolean') {
                merged.set(weaponId, {
                    ...remoteState,
                    firing: localState.firing,
                });
            }
        }
        return merged;
    }

    if (context.localIsAdmin && !context.peerIsAdmin
        && context.source === context.owner) {
        // A client may only update firing on weapons the server already knows.
        // Counts, targets, additions, and other result fields remain server
        // authored even if a malicious/old client sends a complete component.
        const merged = new Map(local);
        for (const [weaponId, remoteState] of remote) {
            const localState = merged.get(weaponId);
            if (localState && typeof localState === 'object'
                && typeof remoteState?.firing === 'boolean') {
                merged.set(weaponId, {
                    ...localState,
                    firing: remoteState.firing,
                });
            }
        }
        return merged;
    }

    return remote;
}

replicationPolicies.register(WeaponsStateComponent, {
    codec: WeaponsState,
    authority: 'entity-owner',
    merge: mergeWeaponStateIntent,
    captureClientIntent: (states) =>
        states instanceof Map
            ? new Map([...states].map(([id, state]) => [id, state.firing]))
            : undefined,
    restoreClientIntent: (states, firing) => {
        if (!(states instanceof Map) || !(firing instanceof Map)) {
            return;
        }
        for (const [id, value] of firing) {
            const state = states.get(id);
            if (state) {
                state.firing = value;
            }
        }
    },
    // The server derives weapon result state from authoritative outfits. Keep
    // only the trigger intent from a client's first entity state until that
    // derived component exists.
    acceptInitialOwnerState: false,
    allowOwnerRemoval: false,
    relayOwnerChanges: true,
});
