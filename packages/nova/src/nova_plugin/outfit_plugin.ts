import { produce } from 'immer';
import * as t from 'io-ts';
import { OutfitData, OutfitPhysics } from 'novadatainterface/outfit_data';
import { ShipPhysics } from 'novadatainterface/ship_data';
import { Component } from 'nova_ecs/component';
import { map } from 'nova_ecs/datatypes/map';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { MovementPhysics, MovementType } from 'nova_ecs/plugins/movement_plugin';
import { ProvideFromCache } from './provide_from_cache.js';
import { registerEntityDeriver } from './entity_factory.js';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { DefaultMap } from '../common/default_map.js';
import { SimulationGameDataResource } from './game_data_resource.js';
import { Stat } from './stat.js';
import { WeaponsStateComponent, WeaponState } from './weapons_state.js';

const OutfitState = t.type({
    count: t.number,
});
export type OutfitState = t.TypeOf<typeof OutfitState>;

const OutfitsState = map(t.string /* Outfit id */, OutfitState);
export type OutfitsState = t.TypeOf<typeof OutfitsState>;

export const OutfitsStateComponent = new Component<OutfitsState>('OutfitsStateComponent');
export const AppliedOutfitsComponent = new Component<{}>('AppliedOutfitsComponent');

export function applyOutfitPhysics(basePhysics: ShipPhysics,
    outfits: Iterable<readonly [OutfitData, number /* count */]>) {
    return produce(basePhysics, (basePhysics) => {
        for (const [outfit, count] of outfits) {
            for (const [uncast, val] of Object.entries(outfit.physics)) {
                const key = uncast as keyof OutfitPhysics;
                if (basePhysics.hasOwnProperty(key)) {
                    if (typeof val === 'number') {
                        (basePhysics[key] as number) += val * count;
                    } else if (typeof val === 'boolean') {
                        // Boolean capabilities (fast jumping, inertial
                        // dampers) are granted if any outfit has them.
                        (basePhysics[key] as boolean) =
                            (basePhysics[key] as boolean) || val;
                    }
                }
            }
        }
    });
}

function deriveWeaponsState(outfits: OutfitsState,
    gameData: SimulationGameDataInterface) {
        const weaponsState = new DefaultMap<string, WeaponState>(() => ({
            count: 0,
            firing: false,
        }));

        for (const [id, state] of outfits) {
            const outfit = gameData.data.Outfit.getCached(id);
            if (!outfit) {
                // Not loaded yet; retry next step.
                return undefined;
            }

            if (outfit.weapons) {
                for (const [weaponId, count] of Object.entries(outfit.weapons)) {
                    weaponsState.get(weaponId).count += count * state.count;
                }
            }
        }
        return weaponsState;
}

const OutfitWeaponProvider = ProvideFromCache({
    name: "OutfitWeaponProvider",
    provided: WeaponsStateComponent,
    update: [OutfitsStateComponent],
    args: [OutfitsStateComponent, SimulationGameDataResource] as const,
    factory: deriveWeaponsState,
});

export const OutfitPlugin: Plugin = {
    name: "OutfitPlugin",
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }

        world.addComponent(OutfitsStateComponent);
        world.addComponent(AppliedOutfitsComponent);

        deltaMaker.addComponent(OutfitsStateComponent, {
            componentType: OutfitsState,
        });
        deltaMaker.addComponent(AppliedOutfitsComponent, {
            componentType: t.type({}),
        });

        registerEntityDeriver(world, {
            name: 'WeaponsStateDeriver',
            provided: WeaponsStateComponent,
            requires: [OutfitsStateComponent],
            derive: (entity, gameData) => deriveWeaponsState(
                entity.components.get(OutfitsStateComponent)!, gameData),
        });
        world.addSystem(OutfitWeaponProvider);
    }
};
