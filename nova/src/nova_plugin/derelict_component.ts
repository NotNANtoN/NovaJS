import * as t from 'io-ts';
import { Component } from 'nova_ecs/component';
import { replicationPolicies } from 'nova_ecs/plugins/multiplayer_plugin';

export const DerelictData = t.type({
    derelictId: t.string,
    shipId: t.string,
    salvageCredits: t.number,
});
export type DerelictData = t.TypeOf<typeof DerelictData>;

export const DerelictComponent = new Component<DerelictData>('DerelictComponent');

replicationPolicies.register(DerelictComponent, {
    codec: DerelictData,
    authority: 'server',
});
