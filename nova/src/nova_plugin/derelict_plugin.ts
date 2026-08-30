import * as t from 'io-ts';
import { ShipData } from 'novadatainterface/ShipData';
import { Entities, GetWorld, UUID } from 'nova_ecs/arg_types';
import { AsyncSystem } from 'nova_ecs/async_system';
import { Component } from 'nova_ecs/component';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData, replicationPolicies } from 'nova_ecs/plugins/multiplayer_plugin';
import { Resource } from 'nova_ecs/resource';
import { SingletonComponent } from 'nova_ecs/world';
import { v4 as uuid } from 'uuid';
import { BoardingInventoryComponent } from './boarding_plugin';
import { DisabledComponent } from './death_plugin';
import { GameDataResource } from './game_data_resource';
import { ArmorComponent } from './health_plugin';
import { makeShip } from './make_ship';
import { PlatformResource } from './platform_plugin';
import { Stat } from './stat';
import { SystemIdResource } from './system_id_resource';

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

const DERELICT_HULL_IDS = [
    'nova:128', // Shuttle
    'nova:129', // Starbridge
    'nova:130', // Kestrel
    'nova:132', // Pirate Viper
    'nova:133', // Valkyrie
    'nova:134', // Thunderbird
];

export function makeDerelict(
    shipData: ShipData,
    position: Position,
    salvageCredits = 15_000,
) {
    const ship = makeShip(shipData);
    ship.components.set(DisabledComponent, true);
    ship.components.set(MovementStateComponent, {
        position,
        velocity: new Vector((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4),
        rotation: new Angle(Math.random() * Math.PI * 2),
        accelerating: 0,
        turning: (Math.random() - 0.5) * 0.02,
        turnBack: false,
    });
    ship.components.set(ArmorComponent, new Stat({
        current: Math.max(15, Math.floor((shipData.armor ?? 50) * 0.4)),
        max: shipData.armor ?? 50,
        recharge: 0,
    }));
    ship.components.set(MultiplayerData, { owner: 'server' });
    ship.components.set(DerelictComponent, {
        derelictId: uuid(),
        shipId: shipData.id,
        salvageCredits,
    });
    ship.components.set(BoardingInventoryComponent, {
        cargoCapacity: shipData.cargoCapacity,
        credits: salvageCredits,
        holds: [
            {
                commodity: 'Metal',
                tons: Math.max(2, Math.floor(shipData.cargoCapacity * 0.3)),
                isMissionCargo: false,
            },
            {
                commodity: 'Industrial Goods',
                tons: Math.max(1, Math.floor(shipData.cargoCapacity * 0.2)),
                isMissionCargo: false,
            },
        ],
    });
    return ship;
}

interface DerelictSpawnState {
    spawned: boolean;
}

const DerelictSpawnStateResource =
    new Resource<DerelictSpawnState>('DerelictSpawnState');

export const DerelictSpawnSystem = new AsyncSystem({
    name: 'DerelictSpawnSystem',
    args: [
        SingletonComponent,
        GameDataResource,
        SystemIdResource,
        DerelictSpawnStateResource,
        PlatformResource,
        GetWorld,
    ] as const,
    exclusive: true,
    async step(_singleton, gameData, systemId, state, platform, world) {
        if (platform !== 'node' || state.spawned) {
            return;
        }
        state.spawned = true;

        let system;
        try {
            system = await gameData.data.System.get(systemId);
        } catch {
            return;
        }

        // Uninhabited systems or systems with fewer than 2 planets have derelicts
        const isUninhabited = !system.planets || system.planets.length === 0;
        const derelictCount = isUninhabited ? 2 : (system.planets.length <= 1 ? 1 : 0);

        if (derelictCount <= 0) {
            return;
        }

        for (let i = 0; i < derelictCount; i++) {
            const hullId = DERELICT_HULL_IDS[Math.floor(Math.random() * DERELICT_HULL_IDS.length)];
            let shipData;
            try {
                shipData = await gameData.data.Ship.get(hullId);
            } catch {
                continue;
            }

            const angle = Math.random() * Math.PI * 2;
            const distance = 1400 + Math.random() * 1200;
            const position = new Position(
                Math.cos(angle) * distance,
                Math.sin(angle) * distance,
            );
            const salvage = Math.round(10_000 + Math.random() * 35_000);

            const derelict = makeDerelict(shipData, position, salvage);
            world.entities.set(uuid(), derelict);
        }
    },
});

export const DerelictPlugin: Plugin = {
    name: 'DerelictPlugin',
    build(world) {
        world.addComponent(DerelictComponent);
        const deltaMaker = world.resources.get(DeltaResource);
        if (deltaMaker) {
            deltaMaker.addComponent(DerelictComponent, {
                componentType: DerelictData,
            });
        }
        world.resources.set(DerelictSpawnStateResource, { spawned: false });
        world.addSystem(DerelictSpawnSystem);
    },
    remove(world) {
        world.removeSystem(DerelictSpawnSystem);
        world.resources.delete(DerelictSpawnStateResource);
    },
};
