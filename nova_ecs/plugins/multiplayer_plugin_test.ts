import { isDraft } from 'immer';
import * as t from 'io-ts';
import 'jasmine';
import { isRight } from 'fp-ts/Either';
import { BehaviorSubject, Subject } from 'rxjs';
import { Entities, UUID } from '../arg_types';
import { Component } from '../component';
import { Entity } from '../entity';
import { System } from '../system';
import { World } from '../world';
import { Angle } from '../datatypes/angle';
import { Position } from '../datatypes/position';
import { Vector } from '../datatypes/vector';
import { DeltaResource } from './delta_plugin';
import { MockCommunicator } from './mock_communicator';
import { SerializerResource } from './serializer_plugin';
import {
    applyMovementStateDelta,
    copyMovementState,
    MovementPhysicsComponent,
    MovementPlugin,
    RemoteMovementPresentationComponent,
    MovementState,
    MovementStateComponent,
    MovementStateDelta,
    MovementType,
} from './movement_plugin';
import { TimePlugin, TimeResource } from './time_plugin';
import {
    WeaponsState,
    WeaponsStateComponent,
} from '../../nova/src/nova_plugin/weapons_state';
import {
    Comms,
    Communicator,
    Message,
    multiplayer,
    MultiplayerData,
    MultiplayerMessageEvent,
    MultiplayerPhase,
    Peers,
} from './multiplayer_plugin';

const BarComponent = new Component<{ y: string }>("Bar");
const NonMultiplayer = new Component<{ z: string }>('NonMultiplayer');
const ServerAuthComponent = new Component<{ value: string }>('ServerAuth');

function addWeaponsReplication(world: World): void {
    world.addComponent(WeaponsStateComponent);
    world.resources.get(DeltaResource)!.addComponent(WeaponsStateComponent, {
        componentType: WeaponsState,
    });
}

function weaponEntity(owner: string, firing: boolean, count = 10): Entity {
    return new Entity()
        .addComponent(MultiplayerData, { owner })
        .addComponent(WeaponsStateComponent, new Map([
            ['test-primary', { count, firing }],
        ]));
}

interface DelayedNetworkOptions {
    readonly duplicate?: (
        source: string,
        message: unknown,
        index: number,
    ) => boolean;
    readonly drop?: (
        source: string,
        message: unknown,
        index: number,
    ) => boolean;
    readonly reorder?: boolean;
}

class DeterministicDelayedNetwork {
    private readonly communicators = new Map<string, DelayedCommunicator>();
    private readonly pending: Array<{
        deliverAt: number;
        destination: string;
        source: string;
        message: unknown;
    }> = [];
    private delayIndex = 0;
    private messageIndex = 0;
    frame = 0;
    onDeliver?: (destination: string, message: unknown) => void;

    constructor(private readonly options: DelayedNetworkOptions = {}) {}

    connect(uuid: string): DelayedCommunicator {
        const communicator = new DelayedCommunicator(uuid, this);
        this.communicators.set(uuid, communicator);
        const peers = new Set(this.communicators.keys());
        for (const connected of this.communicators.values()) {
            connected.peers.current.next(peers);
        }
        return communicator;
    }

    send(source: string, message: unknown, destination?: string | Set<string>) {
        const destinations = destination === undefined
            ? [...this.communicators.keys()].filter(uuid => uuid !== source)
            : typeof destination === 'string' ? [destination] : [...destination];
        const delays = [50, 150, 83, 117, 67, 133, 100];
        const delay = delays[this.delayIndex++ % delays.length];
        const frames = Math.ceil(delay / (1000 / 60));
        const encoded = JSON.parse(JSON.stringify(message)) as unknown;
        const index = this.messageIndex++;
        if (this.options.drop?.(source, encoded, index)) {
            return;
        }
        for (const target of destinations) {
            this.pending.push({
                deliverAt: this.frame + frames,
                destination: target,
                source,
                message: encoded,
            });
            if (this.options.duplicate?.(source, encoded, index)) {
                this.pending.push({
                    deliverAt: this.frame + frames + 1,
                    destination: target,
                    source,
                    message: encoded,
                });
            }
        }
    }

    advance(): void {
        this.frame++;
        const due = this.pending
            .filter(message => message.deliverAt <= this.frame)
            .sort((a, b) => a.deliverAt - b.deliverAt);
        if (this.options.reorder) {
            due.reverse();
        }
        for (const message of due) {
            this.onDeliver?.(message.destination, message.message);
            this.communicators.get(message.destination)?.messages.next({
                source: message.source,
                message: message.message,
            });
        }
        for (const message of due) {
            this.pending.splice(this.pending.indexOf(message), 1);
        }
    }
}

class DelayedCommunicator implements Communicator {
    readonly peers = new Peers(new BehaviorSubject(new Set<string>()));
    readonly servers = new BehaviorSubject(new Set(['server']));
    readonly messages =
        new Subject<{ source: string; message: unknown }>();
    readonly connected = new BehaviorSubject(true);

    constructor(
        readonly uuid: string,
        private readonly network: DeterministicDelayedNetwork,
    ) {}

    sendMessage(message: unknown, destination?: string | Set<string>): void {
        this.network.send(this.uuid, message, destination);
    }
}

class DeferredSerializeCommunicator implements Communicator {
    readonly peers = new Peers(new BehaviorSubject(
        new Set(['server', 'owner'])));
    readonly servers = new BehaviorSubject(new Set(['server']));
    readonly messages =
        new Subject<{ source: string; message: unknown }>();
    readonly connected = new BehaviorSubject(true);
    readonly sent: unknown[] = [];
    readonly uuid = 'server';

    sendMessage(message: unknown): void {
        // Model a real transport that serializes after the ECS step has
        // finalized and revoked its Immer drafts.
        this.sent.push(message);
    }
}

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
        world1.addComponent(MovementStateComponent);
        world2.addComponent(MovementStateComponent);
        world1.addComponent(ServerAuthComponent);
        world2.addComponent(ServerAuthComponent);
        world1delta.addComponent(MovementStateComponent, { componentType: MovementState });
        world2delta.addComponent(MovementStateComponent, { componentType: MovementState });
        world1delta.addComponent(ServerAuthComponent, {
            componentType: t.type({ value: t.string }),
        });
        world2delta.addComponent(ServerAuthComponent, {
            componentType: t.type({ value: t.string }),
        });
    });

    it('adds the comms component to the singleton entity', () => {
        expect([...world1.singletonEntity.components.keys()]
            .map(component => component.name)).toContain('Comms');
    });

    it('keeps movement metadata optional for legacy peers', () => {
        const decoded = Message.decode({});

        expect(isRight(decoded)).toBeTrue();
        if (isRight(decoded)) {
            expect(decoded.right.movementSequences).toBeUndefined();
        }
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

    it('stops forwarding communicator messages after plugin removal', async () => {
        const communicator = new MockCommunicator('teardown uuid');
        const world = new World('teardown');
        const plugin = multiplayer(communicator);
        let forwarded = 0;
        world.events.get(MultiplayerMessageEvent).subscribe(() => forwarded++);

        await world.addPlugin(plugin);
        communicator.messages.next({
            source: 'peer',
            message: {},
        });
        expect(forwarded).toBe(1);

        await world.removePlugin(plugin);
        communicator.messages.next({
            source: 'peer',
            message: {},
        });
        expect(forwarded).toBe(1);
    });

    it('survives the server removing an entity in the step it appeared', () => {
        // A client builds its own planets, so the server can order one removed
        // in the very step it first exists. This used to throw, and because it
        // throws inside world.step() the whole game stopped advancing.
        world2.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);
        const uuid = 'planet nova:465';
        world2.entities.set(uuid, new Entity()
            .addComponent(MultiplayerData, { owner: 'world2 uuid' })
            .addComponent(BarComponent, { y: 'a planet' }));
        world2.singletonEntity.components.get(Comms)!.messages.push({
            source: 'world1 uuid',
            message: { remove: [uuid] } as never,
        });

        expect(() => world2.step()).not.toThrow();
        expect(world2.entities.has(uuid)).toBeFalse();

        // The world keeps running afterwards.
        expect(() => world2.step()).not.toThrow();
    });

    it('does not let admin deltas overwrite client-owned movement state', () => {
        world1.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);
        world2.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);

        const movement = (rotation: number, turning: number): MovementState => ({
            position: new Position(0, 0),
            velocity: new Vector(0, 0),
            rotation: new Angle(rotation),
            turning,
            turnBack: false,
            accelerating: 0,
        });
        const uuid = 'client-owned ship';
        world2.entities.set(uuid, new Entity()
            .addComponent(MultiplayerData, { owner: 'world2 uuid' })
            .addComponent(MovementStateComponent, movement(0, 0)));

        // Establish the entity on the admin and let it send its initial state.
        world2.step();
        world1.step();
        world1.step();
        world2.step();
        for (let i = 0; i < 3; i++) {
            world1.step();
            world2.step();
        }

        const serverEntity = world1.entities.get(uuid)!;
        const clientEntity = world2.entities.get(uuid)!;
        const serverMovement = serverEntity.components.get(MovementStateComponent)!;
        const clientMovement = clientEntity.components.get(MovementStateComponent)!;

        clientMovement.rotation = new Angle(1);
        clientMovement.turning = 1;
        serverMovement.rotation = new Angle(2);
        serverMovement.turning = -1;
        serverEntity.components.set(ServerAuthComponent, {
            value: 'server-authored update',
        });
        world1.step();
        world2.step();
        world1.step();
        world2.step();

        expect(clientEntity.components.get(MovementStateComponent)!.rotation.angle)
            .toBeCloseTo(1);
        expect(clientEntity.components.get(ServerAuthComponent)!.value)
            .toBe('server-authored update');
    });

    it('does not let full-state resync overwrite client-owned movement', () => {
        world1.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);
        world2.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);

        const movement = (rotation: number): MovementState => ({
            position: new Position(0, 0),
            velocity: new Vector(0, 0),
            rotation: new Angle(rotation),
            turning: rotation,
            turnBack: false,
            accelerating: 0,
        });
        const uuid = 'full-state-client-owned ship';
        world2.entities.set(uuid, new Entity()
            .addComponent(MultiplayerData, { owner: 'world2 uuid' })
            .addComponent(MovementStateComponent, movement(1)));

        world2.step();
        world1.step();
        for (let i = 0; i < 4; i++) {
            world1.step();
            world2.step();
        }

        const serverEntity = world1.entities.get(uuid)!;
        serverEntity.components.set(MovementStateComponent, movement(2));
        serverEntity.components.set(ServerAuthComponent, {
            value: 'full-state server update',
        });
        const serializer = world1.resources.get(SerializerResource)!;
        const fullState = Message.encode({
            state: new Map([[uuid, serializer.encode(serverEntity)]]),
        }) as unknown as Message;
        world1Communicator.sendMessage(fullState, 'world2 uuid');
        world2.step();

        expect(world2.entities.get(uuid)!.components
            .get(MovementStateComponent)!.rotation.angle).toBeCloseTo(1);
        expect(world2.entities.get(uuid)!.components
            .get(ServerAuthComponent)!.value)
            .toBe('full-state server update');
    });

    it('preserves held weapon firing through a stale server full state', () => {
        world1.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);
        world2.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);
        addWeaponsReplication(world1);
        addWeaponsReplication(world2);

        const uuid = 'full-state-weapon-owner';
        world2.entities.set(uuid, weaponEntity('world2 uuid', true));
        world2.step();

        const serverState = weaponEntity('world2 uuid', false, 7);
        serverState.components.set(ServerAuthComponent, {
            value: 'server cooldown update',
        });
        const serializer = world1.resources.get(SerializerResource)!;
        world1Communicator.sendMessage(Message.encode({
            state: new Map([[uuid, serializer.encode(serverState)]]),
        }) as Message, 'world2 uuid');
        world2.step();

        const state = world2.entities.get(uuid)!.components
            .get(WeaponsStateComponent)!;
        expect(state.get('test-primary')!.firing).toBeTrue();
        expect(state.get('test-primary')!.count).toBe(7);
        expect(world2.entities.get(uuid)!.components
            .get(ServerAuthComponent)!.value)
            .toBe('server cooldown update');
    });

    it('preserves held weapon firing through a stale server delta', () => {
        world1.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);
        world2.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);
        addWeaponsReplication(world1);
        addWeaponsReplication(world2);

        const uuid = 'delta-weapon-owner';
        world2.entities.set(uuid, weaponEntity('world2 uuid', true));
        world2.step();

        world1Communicator.sendMessage(Message.encode({
            delta: new Map([[uuid, {
                componentDeltas: new Map([
                    [WeaponsStateComponent.name, [
                        {
                            op: 'replace',
                            path: ['test-primary', 'count'],
                            value: 6,
                        },
                        {
                            op: 'replace',
                            path: ['test-primary', 'firing'],
                            value: false,
                        },
                    ]],
                ]),
            }]]),
        }) as Message, 'world2 uuid');
        world2.step();

        const state = world2.entities.get(uuid)!.components
            .get(WeaponsStateComponent)!;
        expect(state.get('test-primary')!.firing).toBeTrue();
        expect(state.get('test-primary')!.count).toBe(6);
    });

    it('retains and sends a local weapon keyup intent', () => {
        world1.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);
        world2.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);
        addWeaponsReplication(world1);
        addWeaponsReplication(world2);

        const uuid = 'keyup-weapon-owner';
        world2.entities.set(uuid, weaponEntity('world2 uuid', true));
        world2.step();
        world1.step();
        // A real server derives this component from the authoritative outfit
        // provider after rejecting the client's initial result fields.
        world1.entities.get(uuid)!.components.set(
            WeaponsStateComponent,
            new Map([['test-primary', { count: 10, firing: false }]]),
        );
        world1.step();
        world2.step();

        world2.entities.get(uuid)!.components
            .get(WeaponsStateComponent)!.get('test-primary')!.firing = false;
        world2.step();
        world1.step();

        expect(world1.entities.get(uuid)!.components
            .get(WeaponsStateComponent)!.get('test-primary')!.firing)
            .toBeFalse();
        expect(JSON.stringify(world1Communicator.allMessages))
            .toContain('"firing":false');
    });

    it('accepts only owner firing and relays authoritative weapon state', () => {
        const observerCommunicator = new MockCommunicator('observer uuid');
        const peers = world1Communicator.mockPeers;
        peers.set('observer uuid', observerCommunicator);
        observerCommunicator.mockPeers = peers;
        const peerUuids = new Set(peers.keys());
        world1Communicator.peers.current.next(peerUuids);
        world2Communicator.peers.current.next(peerUuids);
        observerCommunicator.peers.current.next(peerUuids);

        const observer = new World('observer');
        observer.addPlugin(multiplayer(observerCommunicator));
        observer.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);
        world1.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);
        world2.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);
        addWeaponsReplication(world1);
        addWeaponsReplication(world2);
        addWeaponsReplication(observer);

        const uuid = 'mixed-authority-weapon';
        world1.entities.set(
            uuid,
            weaponEntity('world2 uuid', false, 10),
        );
        world1.step();
        world2.step();
        observer.step();
        world1.step();
        world2.step();
        observer.step();

        const ownerState = world2.entities.get(uuid)!.components
            .get(WeaponsStateComponent)!;
        ownerState.get('test-primary')!.count = 999;
        ownerState.get('test-primary')!.target = 'client-forged-target';
        ownerState.get('test-primary')!.firing = true;
        world2.step();
        world1.step();
        observer.step();

        const serverState = world1.entities.get(uuid)!.components
            .get(WeaponsStateComponent)!.get('test-primary')!;
        const observerState = observer.entities.get(uuid)!.components
            .get(WeaponsStateComponent)!.get('test-primary')!;
        expect(serverState.firing).toBeTrue();
        expect(observerState.firing).toBeTrue();
        expect(serverState.count).toBe(10);
        expect(observerState.count).toBe(10);
        expect(serverState.target).toBeUndefined();
        expect(observerState.target).toBeUndefined();

        world2.entities.get(uuid)!.components
            .get(WeaponsStateComponent)!.get('test-primary')!.firing = false;
        world2.step();
        world1.step();
        observer.step();

        expect(world1.entities.get(uuid)!.components
            .get(WeaponsStateComponent)!.get('test-primary')!.firing)
            .toBeFalse();
        expect(observer.entities.get(uuid)!.components
            .get(WeaponsStateComponent)!.get('test-primary')!.firing)
            .toBeFalse();
    });

    it('relays weapon intent without retaining revoked Immer proxies', () => {
        const communicator = new DeferredSerializeCommunicator();
        const server = new World('deferred-serialization-server');
        server.addPlugin(multiplayer(communicator));
        server.singletonEntity.components.get(Comms)!.admins =
            new Set(['server']);
        addWeaponsReplication(server);

        const uuid = 'deferred-weapon-relay';
        server.entities.set(uuid, weaponEntity('owner', false, 10));
        server.step();
        communicator.sent.length = 0;

        communicator.messages.next({
            source: 'owner',
            message: Message.encode({
                delta: new Map([[uuid, {
                    componentDeltas: new Map([[
                        WeaponsStateComponent.name,
                        [{
                            op: 'replace',
                            path: ['test-primary', 'firing'],
                            value: true,
                        }],
                    ]]),
                }]]),
            }),
        });
        server.step();

        expect(() => JSON.stringify(communicator.sent)).not.toThrow();
        expect(server.entities.get(uuid)!.components
            .get(WeaponsStateComponent)!.get('test-primary')!.firing)
            .toBeTrue();
    });

    it('applies server weapon results to observers while relaying firing intent', () => {
        world1.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);
        world2.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);
        addWeaponsReplication(world1);
        addWeaponsReplication(world2);

        const uuid = 'observer-weapon-state';
        world2.entities.set(uuid, weaponEntity('other owner', false));
        world2.step();

        const serverState = weaponEntity('other owner', true, 4);
        const serializer = world1.resources.get(SerializerResource)!;
        world1Communicator.sendMessage(Message.encode({
            state: new Map([[uuid, serializer.encode(serverState)]]),
        }) as Message, 'world2 uuid');
        world2.step();

        const state = world2.entities.get(uuid)!.components
            .get(WeaponsStateComponent)!;
        expect(state.get('test-primary')!.firing).toBeTrue();
        expect(state.get('test-primary')!.count).toBe(4);
    });

    it('preserves the client/server gameplay authority contract over time', () => {
        world1.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);
        world2.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);

        world1.addPlugin(TimePlugin);
        world2.addPlugin(TimePlugin);
        world1.addPlugin(MovementPlugin);
        world2.addPlugin(MovementPlugin);
        world1.resources.get(TimeResource)!.fixedDelta_ms = 1000 / 60;
        world2.resources.get(TimeResource)!.fixedDelta_ms = 1000 / 60;

        const world1Delta = world1.resources.get(DeltaResource)!;
        const world2Delta = world2.resources.get(DeltaResource)!;
        world1.addComponent(WeaponsStateComponent);
        world2.addComponent(WeaponsStateComponent);
        world1Delta.addComponent(WeaponsStateComponent, {
            componentType: WeaponsState,
        });
        world2Delta.addComponent(WeaponsStateComponent, {
            componentType: WeaponsState,
        });

        const physics = {
            maxVelocity: 100,
            turnRate: 0.25,
            acceleration: 10,
            movementType: MovementType.INERTIAL,
        };
        const movement = (x = 0): MovementState => ({
            position: new Position(x, 0),
            velocity: new Vector(10, 0),
            rotation: new Angle(0),
            turning: 0,
            turnBack: false,
            accelerating: 0,
        });
        const playerUuid = 'authority-player';
        world2.entities.set(playerUuid, new Entity()
            .addComponent(MultiplayerData, { owner: 'world2 uuid' })
            .addComponent(MovementStateComponent, movement())
            .addComponent(MovementPhysicsComponent, physics)
            .addComponent(WeaponsStateComponent, new Map([
                ['test-primary', { count: 10, firing: false }],
            ])));

        // Establish the client-owned ship on the authoritative server.
        world2.step();
        world1.step();
        world1.entities.get(playerUuid)!.components.set(
            WeaponsStateComponent,
            new Map([['test-primary', { count: 10, firing: false }]]),
        );
        world1.step();
        world2.step();
        expect(world1.entities.has(playerUuid)).toBeTrue();
        const messagesBeforeInput = world1Communicator.allMessages.length;
        const serverMessagesBeforeInput =
            world2Communicator.allMessages.length;

        const clientRotations: number[] = [];
        const clientMovement = world2.entities.get(playerUuid)!.components
            .get(MovementStateComponent)!;
        clientMovement.turning = 1;
        for (let step = 0; step < 120; step++) {
            world2.step();
            clientRotations.push(world2.entities.get(playerUuid)!.components
                .get(MovementStateComponent)!.rotation.angle);
            world1.step();
        }

        for (let i = 1; i < clientRotations.length; i++) {
            expect(clientRotations[i]).toBeGreaterThan(clientRotations[i - 1]);
        }
        const serverRotation = world1.entities.get(playerUuid)!.components
            .get(MovementStateComponent)!.rotation.angle;
        expect(serverRotation).toBeCloseTo(clientRotations.at(-1)!, 2);
        expect(world1Communicator.allMessages.length - messagesBeforeInput)
            .toBeLessThan(30);
        expect(JSON.stringify(world2Communicator.allMessages
            .slice(serverMessagesBeforeInput))).toContain('MovementState');

        const clientWeapons = world2.entities.get(playerUuid)!.components
            .get(WeaponsStateComponent)!;
        clientWeapons.get('test-primary')!.firing = true;
        world2.step();
        world1.step();
        expect(world1.entities.get(playerUuid)!.components
            .get(WeaponsStateComponent)!.get('test-primary')!.firing).toBeTrue();

        const npcUuid = 'authority-npc';
        world1.entities.set(npcUuid, new Entity()
            .addComponent(MultiplayerData, { owner: 'world1 uuid' })
            .addComponent(MovementStateComponent, movement(20))
            .addComponent(MovementPhysicsComponent, physics));
        world1.step();
        world2.step();
        expect(world2.entities.has(npcUuid)).toBeTrue();

        const clientNpcPositions: number[] = [];
        for (let step = 0; step < 120; step++) {
            world1.step();
            world2.step();
            clientNpcPositions.push(world2.entities.get(npcUuid)!.components
                .get(MovementStateComponent)!.position.x);
        }
        for (let i = 1; i < clientNpcPositions.length; i++) {
            expect(clientNpcPositions[i])
                .toBeGreaterThanOrEqual(clientNpcPositions[i - 1]);
        }
        expect(clientNpcPositions.at(-1)!)
            .toBeGreaterThan(clientNpcPositions[0]);
    });

    it('restamps client movement in the server clock domain before relaying', () => {
        const network = new DeterministicDelayedNetwork();
        const serverCommunicator = network.connect('server');
        const ownerCommunicator = network.connect('owner');
        const observerCommunicator = network.connect('observer');
        const server = new World('restamp server');
        const owner = new World('restamp owner');
        const observer = new World('restamp observer');
        for (const [world, communicator, timeValue] of [
            [server, serverCommunicator, 0],
            [owner, ownerCommunicator, 10_000],
            [observer, observerCommunicator, 20_000],
        ] as const) {
            world.addPlugin(multiplayer(communicator));
            world.addPlugin(TimePlugin);
            world.addPlugin(MovementPlugin);
            const time = world.resources.get(TimeResource)!;
            time.time = timeValue;
            time.fixedDelta_ms = 1000 / 60;
        }

        const uuid = 'restamped-player';
        owner.entities.set(uuid, new Entity()
            .addComponent(MultiplayerData, { owner: 'owner' })
            .addComponent(MovementStateComponent, {
                position: new Position(0, 0),
                velocity: new Vector(30, 0),
                rotation: new Angle(0),
                turning: 0,
                turnBack: false,
                accelerating: 0,
            })
            .addComponent(MovementPhysicsComponent, {
                maxVelocity: 100,
                turnRate: 0.5,
                acceleration: 10,
                movementType: MovementType.INERTIAL,
            }));

        let relayedSentAt: number | undefined;
        let relayedMovementTime: number | undefined;
        network.onDeliver = (destination, rawMessage) => {
            if (destination !== 'observer') {
                return;
            }
            const decoded = Message.decode(rawMessage);
            if (!isRight(decoded)
                || decoded.right.sentAt === undefined
                || decoded.right.sentAt >= 5_000
                || !decoded.right.movementTimestamps?.has(uuid)) {
                return;
            }
            const movement = decoded.right.delta?.get(uuid)
                ?.componentDeltas?.has(MovementStateComponent.name)
                || decoded.right.delta?.get(uuid)
                    ?.componentStates?.has(MovementStateComponent.name);
            if (movement) {
                relayedSentAt = decoded.right.sentAt;
                relayedMovementTime = decoded.right.movementTimestamps!.get(uuid);
            }
        };

        // Deliver the initial owner state and establish the server entity.
        for (let frame = 0; frame < 60; frame++) {
            owner.step();
            server.step();
            observer.step();
            network.advance();
        }
        owner.entities.get(uuid)!.components
            .get(MovementStateComponent)!.turning = 1;

        for (let frame = 0; frame < 90; frame++) {
            owner.step();
            server.step();
            observer.step();
            network.advance();
        }

        expect(server.entities.has(uuid)).toBeTrue();
        expect(relayedSentAt).toBeDefined();
        expect(relayedMovementTime).toBeDefined();
        expect(relayedSentAt!).toBeLessThan(5_000);
        expect(relayedMovementTime!).toBeLessThan(5_000);
        expect(relayedMovementTime!).not.toBe(10_000);
    });

    it('interpolates every remote frame across delayed jittered snapshots', () => {
        const network = new DeterministicDelayedNetwork();
        const serverCommunicator = network.connect('server');
        const clientCommunicator = network.connect('client');
        const server = new World('delayed server');
        const client = new World('delayed client');
        server.addPlugin(multiplayer(serverCommunicator));
        client.addPlugin(multiplayer(clientCommunicator));
        server.addPlugin(TimePlugin);
        client.addPlugin(TimePlugin);
        server.addPlugin(MovementPlugin);
        client.addPlugin(MovementPlugin);
        for (const world of [server, client]) {
            const time = world.resources.get(TimeResource)!;
            time.time = 0;
            time.fixedDelta_ms = 1000 / 60;
        }

        const physics = {
            maxVelocity: 120,
            turnRate: 0.35,
            acceleration: 18,
            movementType: MovementType.INERTIAL,
        };
        const npcUuid = 'delayed-authoritative-npc';
        server.entities.set(npcUuid, new Entity()
            .addComponent(MultiplayerData, { owner: 'server' })
            .addComponent(MovementStateComponent, {
                position: new Position(0, 0),
                velocity: new Vector(60, 0),
                rotation: new Angle(Math.PI / 2),
                turning: 0,
                turnBack: false,
                accelerating: 0,
            })
            .addComponent(MovementPhysicsComponent, physics));

        let directApplicationBackwardEstimate = 0;
        let deliveredMovement: MovementState | undefined;
        network.onDeliver = (destination, rawMessage) => {
            if (destination !== 'client') {
                return;
            }
            const decodedMessage = Message.decode(rawMessage);
            if (!isRight(decodedMessage)) {
                return;
            }
            const encodedState = decodedMessage.right.state?.get(npcUuid)
                ?.components.find(
                    ([name]) => name === MovementStateComponent.name)?.[1];
            const decodedState = MovementState.decode(encodedState);
            if (isRight(decodedState)) {
                deliveredMovement = decodedState.right;
            }
            const delta = decodedMessage.right.delta?.get(npcUuid);
            const encodedMovement = delta?.componentDeltas
                ?.get(MovementStateComponent.name);
            const decodedMovement = MovementStateDelta.decode(encodedMovement);
            const timestamp = decodedMessage.right.movementTimestamps
                ?.get(npcUuid);
            if (isRight(decodedMovement) && deliveredMovement
                && timestamp !== undefined) {
                deliveredMovement = copyMovementState(deliveredMovement);
                applyMovementStateDelta(
                    deliveredMovement, decodedMovement.right);
                const age = client.resources.get(TimeResource)!.time - timestamp;
                directApplicationBackwardEstimate = Math.max(
                    directApplicationBackwardEstimate,
                    Math.max(0, deliveredMovement.velocity.x * age / 1000),
                );
            }
        };

        const samples: number[] = [];
        for (let frame = 0; frame < 360; frame++) {
            const serverMovement = server.entities.get(npcUuid)!.components
                .get(MovementStateComponent)!;
            if (frame === 90) {
                serverMovement.turning = 0.5;
                serverMovement.accelerating = 0.5;
            } else if (frame === 210) {
                serverMovement.turning = 0;
                serverMovement.accelerating = 0;
            }
            server.step();
            network.advance();
            client.step();
            const clientMovement = client.entities.get(npcUuid)?.components
                .get(MovementStateComponent);
            if (clientMovement) {
                samples.push(clientMovement.position.x);
            }
        }

        let maxBackwardFrame = 0;
        let directionChanges = 0;
        let previousDirection = 0;
        for (let i = 1; i < samples.length; i++) {
            const displacement = samples[i] - samples[i - 1];
            maxBackwardFrame = Math.max(maxBackwardFrame, -displacement);
            const direction = Math.abs(displacement) < 1e-9
                ? 0 : Math.sign(displacement);
            if (direction !== 0 && previousDirection !== 0
                && direction !== previousDirection) {
                directionChanges++;
            }
            if (direction !== 0) {
                previousDirection = direction;
            }
        }
        console.info(
            `[remote-motion-profile] direct-snap-estimate=${
                directApplicationBackwardEstimate.toFixed(3)}px `
            + `buffered-max-backward=${maxBackwardFrame.toFixed(6)}px `
            + `frames=${samples.length}`,
        );

        expect(samples.length).toBeGreaterThan(300);
        expect(directApplicationBackwardEstimate).toBeGreaterThan(3);
        expect(maxBackwardFrame).toBeLessThan(0.01);
        expect(directionChanges).toBe(0);
        expect(client.entities.get(npcUuid)!.components
            .has(RemoteMovementPresentationComponent)).toBeTrue();
    });

    it('stops interpolating an entity once the client owns it', () => {
        const network = new DeterministicDelayedNetwork();
        const serverCommunicator = network.connect('server');
        const clientCommunicator = network.connect('client');
        const server = new World('handoff server');
        const client = new World('handoff client');
        server.addPlugin(multiplayer(serverCommunicator));
        client.addPlugin(multiplayer(clientCommunicator));
        server.addPlugin(TimePlugin);
        client.addPlugin(TimePlugin);
        server.addPlugin(MovementPlugin);
        client.addPlugin(MovementPlugin);
        for (const world of [server, client]) {
            const time = world.resources.get(TimeResource)!;
            time.time = 0;
            time.fixedDelta_ms = 1000 / 60;
        }

        const uuid = 'handoff-ship';
        server.entities.set(uuid, new Entity()
            .addComponent(MultiplayerData, { owner: 'server' })
            .addComponent(MovementStateComponent, {
                position: new Position(0, 0),
                velocity: new Vector(60, 0),
                rotation: new Angle(0),
                turning: 0,
                turnBack: false,
                accelerating: 0,
            })
            .addComponent(MovementPhysicsComponent, {
                maxVelocity: 120,
                turnRate: 0.35,
                acceleration: 18,
                movementType: MovementType.INERTIAL,
            }));

        for (let frame = 0; frame < 60; frame++) {
            server.step();
            client.step();
            network.advance();
        }
        expect(client.entities.get(uuid)!.components
            .has(RemoteMovementPresentationComponent)).toBeTrue();

        server.entities.get(uuid)!.components
            .set(MultiplayerData, { owner: 'client' });
        for (let frame = 0; frame < 60; frame++) {
            server.step();
            client.step();
            network.advance();
        }

        // A stale snapshot buffer would keep MovementSystem from integrating
        // this entity, leaving the newly owned ship stepping between old
        // server samples instead of responding to local input.
        expect(client.entities.get(uuid)!.components
            .has(RemoteMovementPresentationComponent)).toBeFalse();
    });

    it('keeps remote movement ordered across skew, jitter, duplication, and loss', () => {
        for (const clockSkew of [-500, 500]) {
            let movementPacket = 0;
            let droppedMovementPackets = 0;
            const network = new DeterministicDelayedNetwork({
                reorder: true,
                duplicate: (source, rawMessage) => {
                    if (source !== 'server') {
                        return false;
                    }
                    const decoded = Message.decode(rawMessage);
                    return isRight(decoded)
                        && (decoded.right.movementSequences?.size ?? 0) > 0;
                },
                drop: (source, rawMessage) => {
                    if (source !== 'server') {
                        return false;
                    }
                    const decoded = Message.decode(rawMessage);
                    if (!isRight(decoded)
                        || (decoded.right.movementSequences?.size ?? 0) === 0) {
                        return false;
                    }
                    const packet = movementPacket++;
                    // Lose a bounded three-packet burst after the initial
                    // state, while retaining later recovery snapshots.
                    const dropped = packet >= 6 && packet < 9;
                    if (dropped) {
                        droppedMovementPackets++;
                    }
                    return dropped;
                },
            });
            const serverCommunicator = network.connect('server');
            const clientCommunicator = network.connect('client');
            const server = new World(`skewed server ${clockSkew}`);
            const client = new World(`skewed client ${clockSkew}`);
            for (const world of [server, client]) {
                world.addPlugin(multiplayer(
                    world === server ? serverCommunicator : clientCommunicator));
                world.addPlugin(TimePlugin);
                world.addPlugin(MovementPlugin);
                const time = world.resources.get(TimeResource)!;
                time.time = world === server ? 0 : clockSkew;
                time.fixedDelta_ms = 1000 / 60;
            }

            const physics = {
                maxVelocity: 120,
                turnRate: 0.35,
                acceleration: 18,
                movementType: MovementType.INERTIAL,
            };
            const npcUuid = `ordered-remote-${clockSkew}`;
            server.entities.set(npcUuid, new Entity()
                .addComponent(MultiplayerData, { owner: 'server' })
                .addComponent(MovementStateComponent, {
                    position: new Position(0, 0),
                    velocity: new Vector(60, 0),
                    rotation: new Angle(Math.PI / 2),
                    turning: 0,
                    turnBack: false,
                    accelerating: 0,
                })
                .addComponent(MovementPhysicsComponent, physics));

            const samples: number[] = [];
            for (let frame = 0; frame < 720; frame++) {
                server.step();
                network.advance();
                client.step();
                const movement = client.entities.get(npcUuid)?.components
                    .get(MovementStateComponent);
                if (movement) {
                    samples.push(movement.position.x);
                }
            }

            let maxBackward = 0;
            let maxForward = 0;
            for (let index = 1; index < samples.length; index++) {
                const displacement = samples[index] - samples[index - 1];
                maxBackward = Math.max(maxBackward, -displacement);
                maxForward = Math.max(maxForward, displacement);
            }
            expect(samples.length).toBeGreaterThan(600);
            expect(droppedMovementPackets).toBe(3);
            expect(maxBackward).toBeLessThan(0.01);
            // A lost burst may temporarily hold the last extrapolated sample,
            // but must not create an unbounded catch-up jump.
            expect(maxForward).toBeLessThan(20);
            expect(samples.at(-1)!).toBeGreaterThan(samples[0]);
        }
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

    it('resets per-entity movement sequencing after removal and re-add', () => {
        const uuid = 'reused-movement-entity';
        const movement = (): MovementState => ({
            position: new Position(0, 0),
            velocity: new Vector(1, 0),
            rotation: new Angle(0),
            turning: 0,
            turnBack: false,
            accelerating: 0,
        });
        const readSequence = () => [...world2Communicator.allMessages]
            .reverse()
            .map(raw => Message.decode(
                (raw as { message: unknown }).message))
            .filter(isRight)
            .map(decoded => decoded.right.movementSequences?.get(uuid))
            .find(sequence => sequence !== undefined);

        world1.entities.set(uuid, new Entity()
            .addComponent(MultiplayerData, { owner: 'world1 uuid' })
            .addComponent(MovementStateComponent, movement()));
        world1.step();
        expect(readSequence()).toBe(1);

        world1.entities.delete(uuid);
        world1.step();

        world1.entities.set(uuid, new Entity()
            .addComponent(MultiplayerData, { owner: 'world1 uuid' })
            .addComponent(MovementStateComponent, movement()));
        world1.step();

        expect(readSequence()).toBe(1);
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

    it('sends full state on interest entry and removes state on exit', () => {
        world1.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);
        world2.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);
        const movementAt = (x: number): MovementState => ({
            position: new Position(x, 0),
            velocity: new Vector(0, 0),
            rotation: new Angle(0),
            turning: 0,
            turnBack: false,
            accelerating: 0,
        });
        world1.entities.set('client-centre', new Entity()
            .addComponent(MultiplayerData, { owner: 'world2 uuid' })
            .addComponent(MovementStateComponent, movementAt(0)));
        world1.entities.set('inside', new Entity()
            .addComponent(MultiplayerData, { owner: 'world1 uuid' })
            .addComponent(MovementStateComponent, movementAt(5_900))
            .addComponent(BarComponent, { y: 'complete inside state' }));
        world1.entities.set('outside', new Entity()
            .addComponent(MultiplayerData, { owner: 'world1 uuid' })
            .addComponent(MovementStateComponent, movementAt(6_100))
            .addComponent(BarComponent, { y: 'complete entering state' }));

        world1.step();
        world2.step();

        expect(world2.entities.has('inside')).toBeTrue();
        expect(world2.entities.has('outside')).toBeFalse();

        world1.entities.get('outside')!.components
            .get(MovementStateComponent)!.position = new Position(5_999, 0);
        world1.step();
        world2.step();

        expect(world2.entities.get('outside')?.components.get(BarComponent))
            .toEqual({ y: 'complete entering state' });

        world1.entities.get('outside')!.components
            .get(MovementStateComponent)!.position = new Position(6_100, 0);
        world1.step();
        world2.step();

        expect(world2.entities.has('outside')).toBeFalse();
    });

    it('never filters an entity owned by the receiving peer', () => {
        world1.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);
        world2.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);
        const movementAt = (x: number): MovementState => ({
            position: new Position(x, 0),
            velocity: new Vector(0, 0),
            rotation: new Angle(0),
            turning: 0,
            turnBack: false,
            accelerating: 0,
        });
        world1.entities.set('client-centre', new Entity()
            .addComponent(MultiplayerData, { owner: 'world2 uuid' })
            .addComponent(MovementStateComponent, movementAt(0)));
        world1.entities.set('far-owned', new Entity()
            .addComponent(MultiplayerData, { owner: 'world2 uuid' })
            .addComponent(MovementStateComponent, movementAt(9_000))
            .addComponent(BarComponent, { y: 'owned at any distance' }));

        world1.step();
        world2.step();

        expect(world2.entities.get('far-owned')?.components.get(BarComponent))
            .toEqual({ y: 'owned at any distance' });
    });

    it('removes entities owned by a leaving peer and accepts re-introduced state', () => {
        world1.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);
        world2.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);

        world2.entities.set('player2', new Entity()
            .addComponent(MultiplayerData, { owner: 'world2 uuid' })
            .addComponent(BarComponent, { y: 'player two' }));

        world2.step();
        world1.step();

        expect(world1.entities.has('player2')).toBeTrue();

        // Simulate world2 leaving the room
        world2.entities.delete('player2');
        world1Communicator.peers.leave.next('world2 uuid');
        expect(world1.entities.has('player2')).toBeFalse();

        // Re-introduce player2 from a fresh world session
        world1.step();
        world1Communicator.peers.join.next('world2 uuid');
        const world2Fresh = new World('world2Fresh');
        world2Fresh.addPlugin(multiplayer(world2Communicator, err => { throw new Error(err); }));
        world2Fresh.addComponent(BarComponent);
        const world2FreshDelta = world2Fresh.resources.get(DeltaResource)!;
        world2FreshDelta.addComponent(BarComponent, { componentType: t.type({ y: t.string }) });
        world2Fresh.singletonEntity.components.get(Comms)!.admins =
            new Set(['world1 uuid']);

        world2Fresh.entities.set('player2', new Entity()
            .addComponent(MultiplayerData, { owner: 'world2 uuid' })
            .addComponent(BarComponent, { y: 'player two returned' }));
        world2Fresh.step();
        world1.step();

        expect(world1.entities.has('player2')).toBeTrue();
        expect(world1.entities.get('player2')?.components.get(BarComponent))
            .toEqual({ y: 'player two returned' });
    });
});
