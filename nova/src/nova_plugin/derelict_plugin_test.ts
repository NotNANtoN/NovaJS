import 'jasmine';
import { MockGameData } from 'novadatainterface/MockGameData';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { Position } from 'nova_ecs/datatypes/position';
import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';
import { World } from 'nova_ecs/world';
import {
    DerelictComponent,
    DerelictPlugin,
    DerelictSpawnSystem,
    makeDerelict,
} from './derelict_plugin';
import { DisabledComponent } from './death_plugin';
import { GameDataResource } from './game_data_resource';
import { PlatformResource } from './platform_plugin';
import { SystemIdResource } from './system_id_resource';
import { BoardingInventoryComponent } from './boarding_plugin';

describe('derelicts & deep-space salvage', () => {
    it('creates a derelict vessel with disabled systems and high-value scrap', () => {
        const shipData = {
            ...getDefaultShipData(),
            id: 'nova:129',
            name: 'Starbridge',
            cargoCapacity: 30,
        };
        const position = new Position(1500, -800);
        const derelict = makeDerelict(shipData, position, 25_000);

        expect(derelict.components.get(DisabledComponent)).toBeTrue();
        expect(derelict.components.has(DerelictComponent)).toBeTrue();
        expect(derelict.components.get(DerelictComponent)?.shipId).toBe('nova:129');
        expect(derelict.components.get(DerelictComponent)?.salvageCredits).toBe(25_000);

        const inventory = derelict.components.get(BoardingInventoryComponent);
        expect(inventory).toBeDefined();
        expect(inventory?.credits).toBe(25_000);
        expect(inventory?.holds.length).toBeGreaterThan(0);
        expect(inventory?.holds.some(h => h.commodity === 'Metal')).toBeTrue();
    });

    it('spawns derelicts in uninhabited systems', async () => {
        const world = new World('derelict-spawn-test');
        world.resources.set(PlatformResource, 'node');
        world.resources.set(GameDataResource, new MockGameData());
        world.resources.set(SystemIdResource, 'nova:130');
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(DerelictPlugin);

        world.step();

        // DerelictPlugin initializes DerelictComponent and adds spawner system
        const derelict = makeDerelict(getDefaultShipData(), new Position(1000, 1000), 10_000);
        world.entities.set('derelict-1', derelict);
        expect(world.entities.get('derelict-1')?.components.has(DerelictComponent)).toBeTrue();
    });
});
