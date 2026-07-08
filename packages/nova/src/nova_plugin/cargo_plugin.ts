import * as t from 'io-ts';
import { Component } from 'nova_ecs/component';
import { map } from 'nova_ecs/datatypes/map';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { Provide } from 'nova_ecs/provide';
import { ShipComponent } from './ship_plugin.js';

/**
 * What a ship is carrying: commodity key -> tons. This is the seed of
 * the future cargo/trading system. There is no full commodity model or
 * trading UI yet; the only source of cargo today is scooping asteroid
 * debris (see asteroid_plugin.ts), which uses the commodity keys
 * produced by the röid parser ("cargo:<0-5>" for standard cargo types,
 * "junk:<globalID>" for jünk commodities). A future trading system
 * should reuse this component and key scheme.
 *
 * Capacity is not stored here: a ship's cargo space is
 * ShipPhysicsComponent.freeCargo (base hull space plus freeCargo from
 * outfits), so it stays consistent with outfit changes.
 */
export const CargoType = map(t.string, t.number);
export type Cargo = t.TypeOf<typeof CargoType>;
export const CargoComponent = new Component<Cargo>('Cargo');

/** Total tons used in a cargo hold. */
export function cargoUsed(cargo: Cargo): number {
    let used = 0;
    for (const count of cargo.values()) {
        used += count;
    }
    return used;
}

const ShipCargoProvider = Provide({
    name: "ShipCargoProvider",
    provided: CargoComponent,
    args: [ShipComponent] as const,
    factory: () => new Map<string, number>(),
});

export const CargoPlugin: Plugin = {
    name: 'CargoPlugin',
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }
        // Registers with the serializer too, so cargo crosses wire
        // snapshots and rollback snapshots round-trip it.
        deltaMaker.addComponent(CargoComponent, {
            componentType: CargoType,
        });
        world.addSystem(ShipCargoProvider);
    }
};
