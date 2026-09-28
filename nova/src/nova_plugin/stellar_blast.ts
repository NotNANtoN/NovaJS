import * as t from 'io-ts';
import { Component } from 'nova_ecs/component';
import { replicationPolicies } from 'nova_ecs/plugins/multiplayer_plugin';

export interface StellarHealth {
    current: number;
    max: number;
    /** Player ship uuids that damaged the stellar since the pool last reset. */
    attackers: string[];
}
/** Server-only shared damage pool of a destroyable stellar; never replicated. */
export const StellarHealthComponent = new Component<StellarHealth>('StellarHealth');
replicationPolicies.register(StellarHealthComponent, {
    codec: t.unknown as any, authority: 'local-only',
});

export const StellarBlastCodec = t.type({ seq: t.number });
/**
 * Incremented by the server each time the stellar's pool breaks, so every
 * client in the room plays the ExplodType explosion (cosmetic only).
 */
export const StellarBlastComponent =
    new Component<t.TypeOf<typeof StellarBlastCodec>>('StellarBlast');
replicationPolicies.register(StellarBlastComponent, {
    codec: StellarBlastCodec, authority: 'server',
});
