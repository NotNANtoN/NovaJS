import 'jasmine';
import * as t from 'io-ts';
import { Component } from 'nova_ecs/component';
import { Entity } from 'nova_ecs/entity';
import { EncodedEntity, SerializerPlugin, SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { World } from 'nova_ecs/world';
import { FinishJumpEvent } from '../nova_plugin/jump_plugin.js';
import { LandEvent } from '../nova_plugin/planet_plugin.js';
import { SoundEvent } from '../nova_plugin/sound_event.js';
import {
    makeSimulationBridgeEndpoints,
    SimulationBridgeClient,
    SimulationBridgeHost,
} from './simulation_bridge.js';

const FooComponent = new Component<{ x: number }>('Foo');

function makeFakeSimulationData() {
    return {
        ids: Promise.resolve({} as never),
        data: {
            Ship: {
                getCached: () => undefined,
            },
        },
    } as never;
}

describe('SimulationBridge', () => {
    let world: World;
    let client: SimulationBridgeClient;

    beforeEach(() => {
        world = new World('bridge test world');
        world.addPlugin(SerializerPlugin);

        const serializer = world.resources.get(SerializerResource);
        if (!serializer) {
            throw new Error('Expected serializer resource');
        }
        serializer.addComponent(FooComponent, t.type({ x: t.number }));

        const endpoints = makeSimulationBridgeEndpoints();
        new SimulationBridgeHost(endpoints.simulation, world, makeFakeSimulationData());
        client = new SimulationBridgeClient(endpoints.browser, serializer);
    });

    it('adds and removes entities through bridge commands', () => {
        const entity = new Entity('foo').addComponent(FooComponent, { x: 3 });

        client.addEntity('foo-uuid', entity);
        const addedFrame = client.snapshot();
        expect(addedFrame.entities.length).toBe(1);
        expect(addedFrame.entities[0]?.[0]).toBe('foo-uuid');

        const decoded = client.decodeEntity(addedFrame.entities[0]![1]);
        expect(decoded.name).toBe('foo');
        expect(decoded.components.get(FooComponent)).toEqual({ x: 3 });

        client.removeEntity('foo-uuid');
        const removedFrame = client.snapshot();
        expect(removedFrame.entities).toEqual([]);
    });

    it('forwards cloneable events and clears them after snapshot', () => {
        world.emit(SoundEvent, { id: 'nova:weapon' });
        world.emit(LandEvent, { id: 'planet-id', uuid: 'planet-uuid' });

        const firstFrame = client.snapshot();
        expect(firstFrame.events).toEqual([
            { name: 'WeaponFire', data: { id: 'nova:weapon' } },
            { name: 'LandEvent', data: { id: 'planet-id', uuid: 'planet-uuid' } },
        ]);

        const secondFrame = client.snapshot();
        expect(secondFrame.events).toEqual([]);
    });

    it('preserves targeted entity uuids on bridged events', () => {
        world.entities.set('ship-uuid', new Entity('ship').addComponent(FooComponent, { x: 1 }));
        world.emit(LandEvent, { id: 'planet-id', uuid: 'planet-uuid' }, ['ship-uuid']);

        const frame = client.snapshot();
        expect(frame.events).toEqual([
            {
                name: 'LandEvent',
                data: { id: 'planet-id', uuid: 'planet-uuid' },
                entityUuids: ['ship-uuid'],
            },
        ]);
    });

    it('encodes entities in finishJump events', () => {
        const entity = new Entity('jumper').addComponent(FooComponent, { x: 7 });

        world.emit(FinishJumpEvent, {
            entity,
            uuid: 'ship-uuid',
            to: 'nova:200',
        });

        const frame = client.snapshot();
        expect(frame.events.length).toBe(1);
        expect(frame.events[0]?.name).toBe('FinishJumpEvent');
        if (frame.events[0]?.name !== 'FinishJumpEvent') {
            fail('Expected finishJump event');
            return;
        }

        const eventData = frame.events[0].data as { entity: EncodedEntity, uuid: string, to: string };
        const decoded = client.decodeEntity(eventData.entity);
        expect(decoded.name).toBe('jumper');
        expect(decoded.components.get(FooComponent)).toEqual({ x: 7 });
        expect(eventData.uuid).toBe('ship-uuid');
        expect(eventData.to).toBe('nova:200');
    });
});
