import * as t from "io-ts";
import {
    PersData,
    PersDataCodec,
} from "novadatainterface/PersData";
import { Component } from "nova_ecs/component";
import { Entities, GetEntity } from "nova_ecs/arg_types";
import { Plugin } from "nova_ecs/plugin";
import { Resource } from "nova_ecs/resource";
import { System } from "nova_ecs/system";
import { DeltaResource } from "nova_ecs/plugins/delta_plugin";
import { Optional } from "nova_ecs/optional";
import { AppliedDamageEvent, DeathEvent } from "./death_plugin";
import { GovtComponent } from "./npc_components";
import { makeNpc } from "./npc_plugin";
import { resolveDamageSource } from "./npc_hostility";
import {
    applyPersShipData,
    PersState,
    persShipOverrides,
    recordPersAttack,
    recordPersDestruction,
} from "./pers";
import { PlayerShipSelector } from "./player_ship_plugin";
import {
    ShipComponent,
    ShipDataComponent,
    ShipDataProvider,
} from "./ship_plugin";
import { ShipData } from "novadatainterface/ShipData";
import { WeaponsStateComponent } from "./weapons_state";

export interface PersInstance {
    data: PersData;
    state: PersState;
}

export const PersComponent =
    new Component<PersInstance>("PersComponent");

export const PersConfiguredComponent = new Component<{
    shipId: string;
}>("PersConfiguredComponent");

export const PersInvincibleComponent =
    new Component<undefined>("PersInvincibleComponent");

export const PersZeroFuelComponent =
    new Component<undefined>("PersZeroFuelComponent");

export const PersWeaponsConfiguredComponent = new Component<{
    shipId: string;
}>("PersWeaponsConfiguredComponent");

export const PersAppearanceComponent = new Component<{
    colour: number;
    shipSubtitle: string;
    hailPict: string | null;
    commQuote: number;
    hailQuote: number;
    linkMission: string | null;
}>("PersAppearanceComponent");

export const PersStateResource =
    new Resource<Map<string, PersState>>("PersStateResource");

export const PersStateCodec = t.partial({
    alive: t.boolean,
    grudge: t.boolean,
    likesPlayer: t.boolean,
    quoteShown: t.boolean,
});

export const PersInstanceCodec = t.type({
    data: PersDataCodec,
    state: PersStateCodec,
});

/**
 * Construct a normal NPC through the existing NPC machinery, then attach the
 * identity that lets the Pers systems replace its stock ship behavior.
 */
export function makePersNpc(
    stockShip: ShipData,
    pers: PersData,
    state: PersState = {},
) {
    const ship = makeNpc(applyPersShipData(stockShip, pers));
    const instance: PersInstance = {
        data: pers,
        state: { alive: true, ...state },
    };
    ship.setName(pers.name);
    ship.components.set(PersComponent, instance);
    if (pers.government >= 0) {
        ship.components.set(GovtComponent, { id: pers.government });
    }
    return ship;
}

export const ConfigurePersShip = new System({
    name: "ConfigurePersShip",
    after: [ShipDataProvider],
    args: [
        PersComponent,
        ShipComponent,
        ShipDataComponent,
        Optional(PersConfiguredComponent),
        Optional(GovtComponent),
        GetEntity,
        PersStateResource,
    ] as const,
    step(
        instance,
        ship,
        shipData,
        configured,
        government,
        entity,
        states,
    ) {
        if (configured?.shipId === ship.id) {
            return;
        }

        const knownState = states.get(instance.data.id);
        if (knownState) {
            instance.state = { ...instance.state, ...knownState };
        } else {
            states.set(instance.data.id, { ...instance.state });
        }

        Object.assign(
            shipData,
            applyPersShipData(shipData, instance.data),
        );
        entity.setName(instance.data.name);
        const overrides = persShipOverrides(instance.data);
        entity.components.set(PersAppearanceComponent, {
            colour: overrides.colour,
            shipSubtitle: overrides.shipSubtitle,
            hailPict: instance.data.hailPict,
            commQuote: instance.data.commQuote,
            hailQuote: instance.data.hailQuote,
            linkMission: instance.data.linkMission,
        });
        entity.components.set(PersConfiguredComponent, {
            shipId: ship.id,
        });

        if (overrides.invincible) {
            entity.components.set(PersInvincibleComponent, undefined);
        } else {
            entity.components.delete(PersInvincibleComponent);
        }
        if (overrides.zeroFuel) {
            entity.components.set(PersZeroFuelComponent, undefined);
        }
        if (instance.data.government >= 0) {
            if (!government || government.id !== instance.data.government) {
                entity.components.set(GovtComponent, {
                    id: instance.data.government,
                });
            }
        } else {
            entity.components.delete(GovtComponent);
        }
    },
});

export const ApplyPersWeapons = new System({
    name: "ApplyPersWeapons",
    after: [ConfigurePersShip],
    args: [
        PersComponent,
        ShipComponent,
        WeaponsStateComponent,
        Optional(PersWeaponsConfiguredComponent),
        GetEntity,
    ] as const,
    step(instance, ship, weapons, configured, entity) {
        if (configured?.shipId === ship.id) {
            return;
        }
        instance.data.weaponTypes.forEach((weaponId, index) => {
            const count = instance.data.weaponCounts[index] ?? 0;
            if (!weaponId || count === 0) {
                return;
            }
            const current = weapons.get(weaponId) ?? {
                count: 0,
                firing: false,
            };
            current.count += count;
            weapons.set(weaponId, current);
        });
        entity.components.set(PersWeaponsConfiguredComponent, {
            shipId: ship.id,
        });
    },
});

export const RecordPersAttack = new System({
    name: "RecordPersAttack",
    events: [AppliedDamageEvent],
    args: [
        AppliedDamageEvent,
        PersComponent,
        Entities,
        PersStateResource,
    ] as const,
    step({ shield, armor, damager }, instance, entities, states) {
        if (shield <= 0 && armor <= 0) {
            return;
        }
        const source = resolveDamageSource(damager, entities);
        const attacker = source
            && entities.get(source.attacker);
        if (!attacker) {
            return;
        }
        if (!attacker.components.has(PlayerShipSelector)) {
            return;
        }
        instance.state = recordPersAttack(
            instance.data, instance.state);
        states.set(instance.data.id, instance.state);
    },
});

export const RecordPersDestruction = new System({
    name: "RecordPersDestruction",
    events: [DeathEvent],
    args: [PersComponent, PersStateResource] as const,
    step(instance, states) {
        const state = recordPersDestruction(
            instance.data, instance.state);
        instance.state = state;
        states.set(instance.data.id, state);
    },
});

export const PersPlugin: Plugin = {
    name: "PersPlugin",
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error("Expected delta maker resource to exist");
        }
        world.addComponent(PersComponent);
        world.addComponent(PersConfiguredComponent);
        world.addComponent(PersInvincibleComponent);
        world.addComponent(PersZeroFuelComponent);
        world.addComponent(PersWeaponsConfiguredComponent);
        world.addComponent(PersAppearanceComponent);
        world.resources.set(PersStateResource, new Map());
        deltaMaker.addComponent(PersComponent, {
            componentType: PersInstanceCodec,
        });
        world.addSystem(ConfigurePersShip);
        world.addSystem(ApplyPersWeapons);
        world.addSystem(RecordPersAttack);
        world.addSystem(RecordPersDestruction);
    },
    remove(world) {
        world.removeSystem(ConfigurePersShip);
        world.removeSystem(ApplyPersWeapons);
        world.removeSystem(RecordPersAttack);
        world.removeSystem(RecordPersDestruction);
        world.resources.delete(PersStateResource);
    },
};
