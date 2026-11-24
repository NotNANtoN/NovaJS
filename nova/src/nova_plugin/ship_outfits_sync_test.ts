import 'jasmine';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import { ChangeEvents, ProvidePlugin } from 'nova_ecs/provide';
import { System } from 'nova_ecs/system';
import { DeltaMaker, DeltaPlugin, DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { replicationPolicies } from 'nova_ecs/plugins/multiplayer_plugin';
import { Serializer, SerializerPlugin } from 'nova_ecs/plugins/serializer_plugin';
import { getDefaultShipData, ShipData } from 'novadatainterface/ShipData';
import { OutfitsState, OutfitsStateComponent } from './outfit_plugin';
import { ShipComponent, ShipDataComponent, ShipOutfitsProvider, ShipType } from './ship_plugin';
import './combat_resources';

describe('ShipOutfitsProvider and ShipComponent replication', () => {
    const lightning: ShipData = {
        ...getDefaultShipData(),
        id: 'nova:135',
        name: 'Lightning',
        outfits: { 'nova:438': 3, 'nova:134': 1, 'nova:135': 5 },
    };
    const pegasus: ShipData = {
        ...getDefaultShipData(),
        id: 'nova:140',
        name: 'Pegasus',
        outfits: { 'nova:128': 2 },
    };

    it('preserves player-modified outfits when ShipComponent is re-applied with the same hull id', () => {
        const world = new World('test');
        world.addPlugin(ProvidePlugin);
        world.addSystem(ShipOutfitsProvider);

        const customOutfits: OutfitsState = new Map([
            ['nova:129', { count: 2 }],
        ]);
        const ship = new Entity('player')
            .addComponent(ShipComponent, { id: 'nova:135' })
            .addComponent(ShipDataComponent, lightning)
            .addComponent(OutfitsStateComponent, customOutfits);
        world.entities.set('player', ship);
        world.step();

        // Re-setting ShipComponent with the same hull must not revert outfits to stock.
        ship.components.set(ShipComponent, { id: 'nova:135' });
        world.step();

        const after = ship.components.get(OutfitsStateComponent)!;
        expect(after.get('nova:129')?.count).toBe(2);
        expect(after.has('nova:438')).toBe(false);
        expect(after.has('nova:134')).toBe(false);
    });

    it('resets outfits to stock only once ShipDataComponent matches a newly changed hull id', () => {
        const world = new World('test');
        world.addPlugin(ProvidePlugin);
        world.addSystem(ShipOutfitsProvider);

        const customOutfits: OutfitsState = new Map([
            ['nova:129', { count: 2 }],
        ]);
        const ship = new Entity('player')
            .addComponent(ShipComponent, { id: 'nova:135' })
            .addComponent(ShipDataComponent, lightning)
            .addComponent(OutfitsStateComponent, customOutfits);
        world.entities.set('player', ship);
        world.step();

        // Hull id changes while ShipDataComponent still holds the old Lightning data:
        // must wait until Pegasus ShipDataComponent arrives instead of applying Lightning stock.
        ship.components.set(ShipComponent, { id: 'nova:140' });
        world.step();
        expect(ship.components.get(OutfitsStateComponent)?.get('nova:129')?.count).toBe(2);

        // Once Pegasus ShipDataComponent loads, outfits reset to Pegasus stock.
        ship.components.set(ShipDataComponent, pegasus);
        world.step();
        const after = ship.components.get(OutfitsStateComponent)!;
        expect(after.get('nova:128')?.count).toBe(2);
        expect(after.has('nova:129')).toBe(false);
    });

    it('initializes stock outfits when OutfitsStateComponent is absent', () => {
        const world = new World('test');
        world.addPlugin(ProvidePlugin);
        world.addSystem(ShipOutfitsProvider);

        const npc = new Entity('npc')
            .addComponent(ShipComponent, { id: 'nova:135' })
            .addComponent(ShipDataComponent, lightning);
        world.entities.set('npc', npc);
        world.step();

        const outfits = npc.components.get(OutfitsStateComponent)!;
        expect(outfits.get('nova:438')?.count).toBe(3);
        expect(outfits.get('nova:134')?.count).toBe(1);
    });

    it('does not fire ShipComponent change events on remote deltas with an unchanged hull id', () => {
        const world = new World('test');
        world.addPlugin(ProvidePlugin);
        world.addPlugin(SerializerPlugin);
        world.addPlugin(DeltaPlugin);

        let shipChanges = 0;
        world.addSystem(new System({
            name: 'CountShipChanges',
            events: [ChangeEvents.get(ShipComponent)],
            args: [ShipComponent] as const,
            step() { shipChanges++; },
        }));

        const deltaMaker = world.resources.get(DeltaResource)!;
        deltaMaker.addComponent(ShipComponent, { componentType: ShipType });

        const ship = new Entity('player')
            .addComponent(ShipComponent, { id: 'nova:135' });
        world.entities.set('player', ship);
        shipChanges = 0;

        const delta = {
            componentStates: new Map<string, unknown>([
                [ShipComponent.name, ShipType.encode({ id: 'nova:135' })],
            ]),
        };

        const shipPolicy = replicationPolicies.get(ShipComponent.name)!;
        deltaMaker.applyRemoteDelta(ship, delta, (component, local, remote) => {
            if (component === ShipComponent && shipPolicy.merge) {
                return shipPolicy.merge(local, remote, {
                    source: 'server',
                    peerIsAdmin: true,
                    localUuid: 'player',
                    localIsAdmin: false,
                    owner: 'player',
                });
            }
            return remote;
        });

        expect(shipChanges).toBe(0);
    });
});
