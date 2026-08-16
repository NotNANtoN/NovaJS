import * as t from 'io-ts';
import { Component } from 'nova_ecs/component';
import { set } from 'nova_ecs/datatypes/set';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';

/**
 * The player's Nova control bits (see ncb.ts): the set of bit numbers
 * (b0 - b9999) that are currently set. Bits are player-scoped state;
 * they live on the player's ship entity and follow the player when
 * they trade ships.
 */
export const ControlBitsType = set(t.number);
export type ControlBits = t.TypeOf<typeof ControlBitsType>;

export const ControlBitsComponent = new Component<ControlBits>('ControlBitsComponent');

/**
 * The player's active ränks (see rank_logic.ts): the set of global ränk ids
 * (e.g. 'nova:147') currently active. Ranks are set and cleared by the same
 * control-bit set strings the bits are (the `Kxxx` / `Lxxx` operators), so
 * they are player-scoped state with exactly the same lifecycle: they live on
 * the player's ship entity, follow the player when they trade ships, and
 * reach peers only as committed component state.
 */
export const ActiveRanksType = set(t.string);
export type ActiveRanks = t.TypeOf<typeof ActiveRanksType>;

export const ActiveRanksComponent =
    new Component<ActiveRanks>('ActiveRanksComponent');

export const NCBPlugin: Plugin = {
    name: 'NCBPlugin',
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }
        world.addComponent(ControlBitsComponent);
        deltaMaker.addComponent(ControlBitsComponent, {
            componentType: ControlBitsType,
        });
        world.addComponent(ActiveRanksComponent);
        deltaMaker.addComponent(ActiveRanksComponent, {
            componentType: ActiveRanksType,
        });
    }
};
