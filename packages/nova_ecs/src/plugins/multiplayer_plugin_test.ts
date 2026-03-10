import { isDraft } from 'immer';
import * as t from 'io-ts';
import 'jasmine';
import { Entities, UUID } from '../arg_types.js';
import { Component } from '../component.js';
import { Entity } from '../entity.js';
import { System } from '../system.js';
import { World } from '../world.js';
import { DeltaResource } from './delta_plugin.js';
import { MockCommunicator } from './mock_communicator.js';
import { markerType, SerializerResource } from './serializer_plugin.js';
import {
    ExcludedMultiplayerComponentsResource,
    multiplayer,
    MultiplayerData,
    MultiplayerPhase
} from './multiplayer_plugin.js';

const BarComponent = new Component<{ y: string }>("Bar");
const NonMultiplayer = new Component<{ z: string }>('NonMultiplayer');
const MarkerComponent = new Component<undefined>('ShipControl');

describe('Multiplayer Plugin', () => {
    let world1: World;
    let world2: World;
    let world1Communicator: MockCommunicator;
    let world2Communicator: MockCommunicator;

    beforeEach(() => {
        world1Communicator = new MockCommunicator('world1 uuid');
        world2Communicator = new MockCommunicator('world2 uuid');

        const mockPeers = new Map([
            [world1Communicator.uuid as string, world1Communicator],
            [world2Communicator.uuid as string, world2Communicator],
        ]);
        world1Communicator.mockPeers = mockPeers;
        world2Communicator.mockPeers = mockPeers;

        const peers = new Set([...mockPeers.keys()]);

        function error(message: string) {
            throw new Error(message);
        }
        world1 = new World('world1');
        world1.addPlugin(multiplayer(world1Communicator, error));

        world2 = new World('world2');
        world2.addPlugin(multiplayer(world2Communicator, error));

        world1Communicator.peers.current.next(peers);
        world2Communicator.peers.current.next(peers);

        world1.addComponent(BarComponent);
        world2.addComponent(BarComponent);

        const world1delta = world1.resources.get(DeltaResource)!;
        const world2delta = world2.resources.get(DeltaResource)!;

        world1delta.addComponent(BarComponent, { componentType: t.type({ y: t.string }) });
        world2delta.addComponent(BarComponent, { componentType: t.type({ y: t.string }) });
    });

    it('adds the comms component to the singleton entity', () => {
        expect([...world1.singletonEntity.components.keys()]
            .map(component => component.name)).toContain('Comms');
    });

    it('sends new entities that it owns', async () => {
        const reports: [string, string][] = [];

        const barSystem = new System({
            name: 'BarSystem',
            args: [BarComponent] as const,
            step: () => { },
            after: [MultiplayerPhase],
        });
        world1.addSystem(barSystem);

        const reportSystem = new System({
            name: 'ReportSystem',
            args: [BarComponent, UUID] as const,
            step: (bar, uuid) => {
                reports.push([bar.y, uuid]);
            },
            after: [MultiplayerPhase],
        });
        world2.addSystem(reportSystem);

        world1.entities.set('test entity uuid', new Entity()
            .addComponent(MultiplayerData, {
                owner: 'world1 uuid',
            })
            .addComponent(BarComponent, {
                y: 'a test component',
            }));

        world1.step();
        world2.step();

        expect(reports).toEqual([['a test component', 'test entity uuid']]);
    });

    it('sends updates when an entity changes', () => {
        const reports: string[] = [];

        const barSystem = new System({
            name: 'BarSystem',
            args: [BarComponent] as const,
            step: (bar) => {
                bar.y = bar.y + ' stepped';
            },
            after: [MultiplayerPhase],
        });
        world1.addSystem(barSystem);

        const reportSystem = new System({
            name: 'ReportSystem',
            args: [BarComponent] as const,
            after: [MultiplayerPhase],
            step: (bar) => {
                reports.push(bar.y);
            }
        });
        world2.addSystem(reportSystem);

        world1.entities.set('test entity uuid', new Entity()
            .addComponent(MultiplayerData, {
                owner: 'world1 uuid',
            })
            .addComponent(BarComponent, {
                y: 'a test component',
            }));

        world1.step();
        world2.step();

        world1.step();
        world2.step();

        world1.step();
        world2.step();

        expect(reports).toEqual([
            'a test component',
            'a test component stepped',
            'a test component stepped stepped',
        ]);
    });

    it('relays new client-owned entities through the server to existing clients', () => {
        const serverCommunicator = new MockCommunicator('server');
        const client1Communicator = new MockCommunicator('client1 uuid');
        const client2Communicator = new MockCommunicator('client2 uuid');

        const mockPeers = new Map([
            [serverCommunicator.uuid as string, serverCommunicator],
            [client1Communicator.uuid as string, client1Communicator],
            [client2Communicator.uuid as string, client2Communicator],
        ]);
        serverCommunicator.mockPeers = mockPeers;
        client1Communicator.mockPeers = mockPeers;
        client2Communicator.mockPeers = mockPeers;

        const server = new World('server');
        const client1 = new World('client1');
        const client2 = new World('client2');

        function error(message: string) {
            throw new Error(message);
        }

        server.addPlugin(multiplayer(serverCommunicator, error));
        client1.addPlugin(multiplayer(client1Communicator, error));
        client2.addPlugin(multiplayer(client2Communicator, error));

        for (const world of [server, client1, client2]) {
            world.addComponent(BarComponent);
            world.resources.get(DeltaResource)!.addComponent(BarComponent, {
                componentType: t.type({ y: t.string }),
            });
        }

        serverCommunicator.peers.current.next(new Set(['client1 uuid', 'client2 uuid']));
        client1Communicator.peers.current.next(new Set(['server']));
        client2Communicator.peers.current.next(new Set(['server']));

        client2.entities.set('client2 entity uuid', new Entity()
            .addComponent(MultiplayerData, {
                owner: 'client2 uuid',
            })
            .addComponent(BarComponent, {
                y: 'from client2',
            }));

        client2.step();
        server.step();
        client1.step();

        expect(client1.entities.get('client2 entity uuid')?.components.get(BarComponent))
            .toEqual({ y: 'from client2' });
    });

    it('does not send excluded components in entity state', () => {
        const reports: boolean[] = [];

        world1.resources.set(ExcludedMultiplayerComponentsResource, new Set(['ShipControl']));
        world2.resources.set(ExcludedMultiplayerComponentsResource, new Set(['ShipControl']));
        world1.resources.get(SerializerResource)!.addComponent(MarkerComponent, markerType);
        world2.resources.get(SerializerResource)!.addComponent(MarkerComponent, markerType);

        const reportSystem = new System({
            name: 'ReportExcludedComponentSystem',
            args: [UUID] as const,
            after: [MultiplayerPhase],
            step: (uuid) => {
                reports.push(world2.entities.get(uuid)?.components.has(MarkerComponent) ?? false);
            },
        });
        world2.addSystem(reportSystem);

        world1.entities.set('test entity uuid', new Entity()
            .addComponent(MultiplayerData, {
                owner: 'world1 uuid',
            })
            .addComponent(BarComponent, {
                y: 'a test component',
            })
            .addComponent(MarkerComponent, undefined));

        world1.step();
        world2.step();

        expect(reports.every(report => report === false)).toBeTrue();
    });

    it('sends nothing if nothing has changed', () => {
        world1.step();
        world2.step();
        world1.step();
        world2.step();
        world1.step();
        world2.step();

        expect(world1Communicator.allMessages).toEqual([]);
        expect(world2Communicator.allMessages).toEqual([]);
    });

    it('removes entities that have been removed', () => {
        let remove = false;
        const removeBarSystem = new System({
            name: 'RemoveBarSystem',
            args: [Entities, UUID, BarComponent] as const,
            step: (entities, uuid) => {
                if (remove) {
                    entities.delete(uuid);
                }
            },
            before: [MultiplayerPhase],
        });

        world1.addSystem(removeBarSystem);
        const testUuid = 'test entity uuid';
        world1.entities.set(testUuid, new Entity()
            .addComponent(MultiplayerData, {
                owner: 'world1 uuid',
            })
            .addComponent(BarComponent, {
                y: 'a test component',
            }));

        world1.step();
        world2.step();

        world1.step();
        world2.step();

        expect(world2.entities.get(testUuid)!.components.get(BarComponent))
            .toEqual(world1.entities.get(testUuid)!.components.get(BarComponent))

        remove = true;
        world1.step();
        world2.step();

        expect(world2.entities.get(testUuid)).toBeUndefined();
    });


    it('drafts components of entities it owns', () => {
        const testUuid = 'test entity uuid';
        world1.entities.set(testUuid, new Entity()
            .addComponent(MultiplayerData, {
                owner: 'world1 uuid',
            }).addComponent(BarComponent, {
                y: 'a test component',
            }));

        world1.step();

        const bar = world1.entities.get(testUuid)?.components.get(BarComponent);
        expect(isDraft(bar)).toBeTrue();
    });

    it('does not draft components of entities it does not own', () => {
        const testUuid = 'test entity uuid';
        world1.entities.set(testUuid, new Entity()
            .addComponent(MultiplayerData, {
                owner: 'not me',
            }).addComponent(BarComponent, {
                y: 'a test component',
            }));

        world1.step();

        const bar = world1.entities.get(testUuid)?.components.get(BarComponent);
        expect(isDraft(bar)).toBeFalse();
    });

    it('does not draft non-multiplayer components', () => {
        const testUuid = 'test entity uuid';
        world1.entities.set(testUuid, new Entity()
            .addComponent(MultiplayerData, {
                owner: 'world1 uuid',
            }).addComponent(BarComponent, {
                y: 'a test component',
            }).addComponent(NonMultiplayer, {
                z: 'not multiplayer'
            }));

        world1.step();

        const bar = world1.entities.get(testUuid)?.components.get(BarComponent);
        expect(isDraft(bar)).toBeTrue();

        const nonMultiplaer = world1.entities.get(testUuid)?.components.get(NonMultiplayer);
        expect(isDraft(nonMultiplaer)).toBeFalse();
    });
});
