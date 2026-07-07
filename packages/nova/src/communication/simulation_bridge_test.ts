import 'jasmine';
import * as t from 'io-ts';
import { SingletonComponent, World } from 'nova_ecs/world';
import { Component } from 'nova_ecs/component';
import { Entity } from 'nova_ecs/entity';
import { EncodedEntity, SerializerPlugin, SerializerResource, markerType } from 'nova_ecs/plugins/serializer_plugin';
import { TimePlugin } from 'nova_ecs/plugins/time_plugin';
import { System } from 'nova_ecs/system';
import { Position } from 'nova_ecs/datatypes/position';
import { FinishJumpEvent, FinishJumpEventType, JumpRouteComponent } from '../nova_plugin/jump_plugin.js';
import { LandEvent, LandEventType } from '../nova_plugin/planet_plugin.js';
import { PlayerShipSelector } from '../nova_plugin/player_ship_plugin.js';
import { ProjectileCollisionEvent, ProjectileCollisionEventType } from '../nova_plugin/projectile_plugin.js';
import { SoundEvent, SoundEventType } from '../nova_plugin/sound_plugin.js';
import {
    SimulationBridgeClient,
    SimulationBridgeHost,
} from './simulation_bridge.js';
import { emitSimulationBridgeEvent } from './simulation_bridge_events.js';

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
        world.addPlugin(TimePlugin);

        const serializer = world.resources.get(SerializerResource);
        if (!serializer) {
            throw new Error('Expected serializer resource');
        }
        serializer.addComponent(FooComponent, t.type({ x: t.number }));
        serializer.addComponent(JumpRouteComponent, t.type({ route: t.array(t.string) }));
        serializer.addComponent(PlayerShipSelector, markerType);
        serializer.addEvent(SoundEvent, SoundEventType);
        serializer.addEvent(LandEvent, LandEventType);
        serializer.addEvent(FinishJumpEvent, FinishJumpEventType(serializer));
        serializer.addEvent(ProjectileCollisionEvent, ProjectileCollisionEventType);

        const host = new SimulationBridgeHost(world, makeFakeSimulationData());
        client = new SimulationBridgeClient(host, serializer);
    });

    it('adds and removes entities through bridge commands', async () => {
        const entity = new Entity('foo').addComponent(FooComponent, { x: 3 });

        // Entity insertion and removal are tick-stamped inputs: they
        // apply when the simulation steps.
        await client.addEntity('foo-uuid', entity);
        client.step();
        const addedFrame = client.snapshot();
        expect(addedFrame.added.length).toBe(1);
        expect(addedFrame.added[0]?.[0]).toBe('foo-uuid');

        const decoded = client.decodeEntity(addedFrame.added[0]![1]);
        expect(decoded.name).toBe('foo');
        expect(decoded.components.get(FooComponent)).toEqual({ x: 3 });

        client.removeEntity('foo-uuid');
        client.step();
        const removedFrame = client.snapshot();
        expect(removedFrame.added).toEqual([]);
        expect(removedFrame.changed).toEqual([]);
        expect(removedFrame.removed).toEqual(['foo-uuid']);
    });

    it('only includes changed components in subsequent snapshots', async () => {
        const entity = new Entity('foo').addComponent(FooComponent, { x: 3 });
        await client.addEntity('foo-uuid', entity);
        client.step();
        expect(client.snapshot().added.length).toBe(1);

        const unchangedFrame = client.snapshot();
        expect(unchangedFrame.added).toEqual([]);
        expect(unchangedFrame.changed).toEqual([]);
        expect(unchangedFrame.removed).toEqual([]);

        const worldEntity = world.entities.get('foo-uuid');
        worldEntity?.components.set(FooComponent, { x: 4 });
        const changedFrame = client.snapshot();
        expect(changedFrame.added).toEqual([]);
        expect(changedFrame.changed).toEqual([
            ['foo-uuid', { changed: [['Foo', { x: 4 }]], removed: [] }],
        ]);

        worldEntity?.components.delete(FooComponent);
        const deletedComponentFrame = client.snapshot();
        expect(deletedComponentFrame.changed).toEqual([
            ['foo-uuid', { changed: [], removed: ['Foo'] }],
        ]);
    });

    it('steps the world through bridge commands', () => {
        const initialFrame = client.snapshot();

        client.step();

        const steppedFrame = client.snapshot();
        expect(steppedFrame.time?.frame).toBe((initialFrame.time?.frame ?? 0) + 1);
    });

    it('updates the player jump route through bridge commands', async () => {
        const entity = new Entity('player')
            .addComponent(FooComponent, { x: 3 })
            .addComponent(JumpRouteComponent, { route: [] });
        entity.components.set(PlayerShipSelector, undefined);

        await client.addEntity('player-uuid', entity);
        client.setPlayerJumpRoute(['nova:131', 'nova:132']);
        client.step();

        const frame = client.snapshot();
        const decoded = client.decodeEntity(frame.added[0]![1]);
        expect(decoded.components.get(JumpRouteComponent)).toEqual({
            route: ['nova:131', 'nova:132'],
        });

        client.setPlayerJumpRoute(['nova:133']);
        client.step();
        const deltaFrame = client.snapshot();
        expect(deltaFrame.changed).toEqual([
            ['player-uuid', {
                changed: [['JumpRouteComponent', { route: ['nova:133'] }]],
                removed: [],
            }],
        ]);
    });

    it('forwards cloneable events and clears them after snapshot', () => {
        world.emit(SoundEvent, { id: 'nova:weapon' });
        world.emit(LandEvent, { id: 'planet-id', uuid: 'planet-uuid' });

        const firstFrame = client.snapshot();
        expect(firstFrame.events).toEqual([
            { name: 'SoundEvent', data: { id: 'nova:weapon' } },
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

    it('does not preserve entity targets for bridged projectile collision events', () => {
        const displayWorld = new World('display test world');
        let hitCount = 0;
        let lastCollision: unknown;
        displayWorld.addSystem(new System({
            name: 'ProjectileCollisionListener',
            events: [ProjectileCollisionEvent],
            args: [ProjectileCollisionEvent, SingletonComponent] as const,
            step(collision) {
                hitCount++;
                lastCollision = collision;
            },
        }));

        const collision = {
            otherUuid: 'target-uuid',
            position: new Position(12, 34),
            projectileData: { id: 'weapon-id' } as never,
        };
        world.emit(ProjectileCollisionEvent, collision, ['missing-projectile-uuid']);

        const frame = client.snapshot();
        expect(frame.events).toEqual([
            {
                name: 'ProjectileCollision',
                data: {
                    ...collision,
                    position: { x: 12, y: 34 },
                },
            },
        ]);

        emitSimulationBridgeEvent(frame.events[0]!, client.getSerializer(), displayWorld);
        displayWorld.step();

        expect(hitCount).toBe(1);
        expect(lastCollision).toEqual(jasmine.objectContaining({
            ...collision,
            position: jasmine.any(Position),
        }));
        expect((lastCollision as { position: Position }).position.x).toBe(12);
        expect((lastCollision as { position: Position }).position.y).toBe(34);
    });
});
