import 'jasmine';
import { createDraft, finishDraft } from 'immer';
import { config } from 'rxjs';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { DeltaPlugin, DeltaResource, EntityDelta } from 'nova_ecs/plugins/delta_plugin';
import { MovementState, MovementStateComponent, RemoteMovementPresentationComponent } from 'nova_ecs/plugins/movement_plugin';
import { MockCommunicator } from 'nova_ecs/plugins/mock_communicator';
import {
    Message, multiplayer, MultiplayerData, replicationPolicies, ServerClockOffsetResource,
} from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { World } from 'nova_ecs/world';
import { PlatformResource } from './platform_plugin';
import { PlayerDeathComponent } from './death_plugin';
import { DestructionStartedComponent } from './destruction_state';
import { JumpStateComponent, JumpState } from './jump_plugin';
import { createInitialPlayerState, PlayerStateComponent } from './player_state';
import { ShipComponent } from './ship_plugin';
import { SystemIdResource } from './system_id_resource';
import {
    authorExternalImpulse, ExternalImpulseComponent, ExternalImpulsePlugin,
    EXTERNAL_IMPULSE_LIFETIME_MS,
} from './external_impulse';

async function fixture(id: string, owner = 'player') {
    const world = new World(id);
    const communicator = new MockCommunicator(id);
    world.resources.set(TimeResource, {
        time: 1000, delta_ms: 0, delta_s: 0, frame: 0, fixedDelta_ms: 0,
    });
    world.resources.set(PlatformResource, id === 'server' ? 'node' : 'browser');
    await world.addPlugin(DeltaPlugin);
    await world.addPlugin(ExternalImpulsePlugin);
    // Match makeSystem: gameplay plugins exist before its room communicator.
    await world.addPlugin(multiplayer(communicator));
    world.addComponent(MovementStateComponent);
    world.resources.get(DeltaResource)!.addComponent(MovementStateComponent, {
        componentType: MovementState,
    });
    const ship = new Entity('ship')
        .addComponent(MultiplayerData, { owner })
        .addComponent(MovementStateComponent, {
            position: new Position(10, 20), velocity: new Vector(120, 0),
            rotation: new Angle(0), accelerating: 0, turning: 0, turnBack: false,
        });
    world.entities.set('ship', ship);
    world.step();
    const time = world.resources.get(TimeResource)!;
    const velocity = () => ship.components.get(MovementStateComponent)!.velocity;
    const author = (x: number, y: number) => authorExternalImpulse(
        ship, ship.components.get(MovementStateComponent)!, owner, time.time, x, y);
    return { world, communicator, ship, time, velocity, author };
}

/** Exercise the real inbound policy and JSON codec with an equivalent delta. */
function deliver(target: Awaited<ReturnType<typeof fixture>>,
    source: Awaited<ReturnType<typeof fixture>>, sender = 'server', asDelta = false) {
    const state = source.ship.components.get(ExternalImpulseComponent)!;
    const delta: EntityDelta = asDelta
        ? { componentDeltas: new Map([[ExternalImpulseComponent.name, state]]) }
        : { componentStates: new Map([[ExternalImpulseComponent.name, state]]) };
    target.communicator.messages.next({
        source: sender,
        message: JSON.parse(JSON.stringify(Message.encode({
            delta: new Map([['ship', delta]]), sentAt: source.time.time,
        }))),
    });
    target.world.step();
}

function deliverFullState(target: Awaited<ReturnType<typeof fixture>>,
    source: Awaited<ReturnType<typeof fixture>>) {
    target.communicator.messages.next({
        source: 'server',
        message: JSON.parse(JSON.stringify(Message.encode({
            state: new Map([['ship', source.world.resources
                .get(SerializerResource)!.encode(source.ship)]]),
            sentAt: source.time.time,
        }))),
    });
    target.world.step();
}

describe('external movement impulses', () => {
    it('is server-authoritative and retains all batched collisions for the owning browser', async () => {
        const server = await fixture('server');
        const owner = await fixture('player');
        const observer = await fixture('observer');
        expect(replicationPolicies.get(ExternalImpulseComponent.name)?.authority).toBe('server');
        server.time.time = owner.time.time = observer.time.time = 1100;
        server.author(30, -10);
        server.author(-5, 40);
        expect(server.velocity()).toEqual(new Vector(145, 30));
        deliver(owner, server);
        deliver(observer, server);
        expect(owner.velocity()).toEqual(new Vector(145, 30));
        expect(observer.velocity()).toEqual(new Vector(120, 0));
        // Observers get the owner's resulting movement through the server,
        // rather than adding the impulse to their presentation themselves.
        deliverFullState(observer, owner);
        const snapshots = observer.ship.components
            .get(RemoteMovementPresentationComponent)!.snapshots;
        expect(snapshots[snapshots.length - 1].state.velocity)
            .toEqual(new Vector(145, 30));
        deliver(owner, server, 'server', true);
        deliverFullState(owner, server);
        owner.world.step();
        server.world.step();
        expect(owner.velocity()).toEqual(new Vector(145, 30));
        expect(server.velocity()).toEqual(new Vector(145, 30));
    });

    it('adds to current owner input, not the server movement baseline', async () => {
        const server = await fixture('server');
        const owner = await fixture('player');
        server.time.time = owner.time.time = 1100;
        owner.ship.components.get(MovementStateComponent)!.velocity = new Vector(200, 50);
        server.author(30, -10);
        deliver(owner, server);
        expect(owner.velocity()).toEqual(new Vector(230, 40));
    });

    it('ignores expired backlog using the estimated server clock', async () => {
        const server = await fixture('server');
        const owner = await fixture('player');
        server.time.time = 1100;
        server.author(30, 10);
        // A late full-state snapshot can have a fresh envelope timestamp.
        server.time.time += EXTERNAL_IMPULSE_LIFETIME_MS;
        owner.time.time = server.time.time + 50_000;
        owner.world.resources.get(ServerClockOffsetResource)!.offset = 50_000;
        deliver(owner, server);
        expect(owner.velocity()).toEqual(new Vector(120, 0));
    });

    it('does not replay retained full-state backlog after reconnect or re-entry', async () => {
        const server = await fixture('server');
        const owner = await fixture('player');
        server.time.time = owner.time.time = 1100;
        server.author(30, 10);
        deliver(owner, server);
        owner.communicator.connected.next(false);
        owner.communicator.connected.next(true);
        deliver(owner, server);
        expect(owner.velocity()).toEqual(new Vector(150, 10));
        owner.world.entities.delete('ship');
        owner.world.step();
        owner.world.entities.set('ship', owner.ship);
        deliver(owner, server);
        expect(owner.velocity()).toEqual(new Vector(150, 10));
        server.time.time = owner.time.time = 1200;
        server.author(5, 5);
        deliver(owner, server);
        expect(owner.velocity()).toEqual(new Vector(155, 15));
    });

    it('does not apply old-owner impulses on an ownership handoff', async () => {
        const server = await fixture('server');
        const owner = await fixture('player', 'someone-else');
        server.time.time = owner.time.time = 1100;
        server.author(30, 10);
        deliver(owner, server);
        owner.ship.components.set(MultiplayerData, { owner: 'player' });
        deliver(owner, server);
        expect(owner.velocity()).toEqual(new Vector(120, 0));
    });

    it('baselines a newly received full state, then applies only subsequent queue deltas', async () => {
        const server = await fixture('server');
        const owner = await fixture('player');
        owner.world.entities.delete('ship');
        owner.world.step();
        server.time.time = owner.time.time = 1100;
        server.author(30, 10);
        deliverFullState(owner, server);
        const movement = () => owner.world.entities.get('ship')!
            .components.get(MovementStateComponent)!;
        expect(movement().velocity).toEqual(new Vector(150, 10));
        deliverFullState(owner, server);
        expect(movement().velocity).toEqual(new Vector(150, 10));
        server.time.time = owner.time.time = 1200;
        server.author(5, 5);
        server.author(2, -2);
        deliver(owner, server, 'server', true);
        expect(movement().velocity).toEqual(new Vector(157, 13));
    });

    it('keeps the sequence after expiry and pruning instead of reusing old tokens', async () => {
        const server = await fixture('server');
        const owner = await fixture('player');
        server.time.time = owner.time.time = 1100;
        server.author(30, 10);
        deliver(owner, server);
        const oldState = JSON.parse(JSON.stringify(server.ship.components.get(ExternalImpulseComponent)));
        server.time.time = owner.time.time = 4000;
        server.author(5, 5);
        expect(server.ship.components.get(ExternalImpulseComponent)!.impulses.length).toBe(1);
        deliver(owner, server, 'server', true);
        expect(owner.velocity()).toEqual(new Vector(155, 15));
        server.ship.components.set(ExternalImpulseComponent, oldState);
        deliver(owner, server);
        expect(owner.velocity()).toEqual(new Vector(155, 15));
    });

    it('defers a fresh impulse ahead of the estimated server clock without consuming it', async () => {
        const server = await fixture('server');
        const owner = await fixture('player');
        server.time.time = 1200;
        server.author(30, 10);
        // Install the decoded component directly to isolate clock smoothing
        // from the transport's timestamp sample update.
        owner.ship.components.set(ExternalImpulseComponent,
            JSON.parse(JSON.stringify(server.ship.components.get(ExternalImpulseComponent))));
        owner.time.time = 1199;
        owner.world.step();
        expect(owner.velocity()).toEqual(new Vector(120, 0));
        owner.time.time = 1200;
        owner.world.step();
        expect(owner.velocity()).toEqual(new Vector(150, 10));
        owner.world.step();
        expect(owner.velocity()).toEqual(new Vector(150, 10));
    });

    const lockouts: Array<[string, (entity: Entity) => void, (entity: Entity) => void]> = [
        ['player death', entity => entity.components.set(PlayerDeathComponent, {
            wreckPosition: [10, 20], visualFallbackAt: 1250,
        }), entity => entity.components.delete(PlayerDeathComponent)],
        ['destruction', entity => entity.components.set(DestructionStartedComponent, true),
            entity => entity.components.delete(DestructionStartedComponent)],
        ...(['braking', 'spooling', 'departing', 'arriving'] as JumpState['phase'][])
            .map(phase => [
                `jump ${phase}`,
                (entity: Entity) => entity.components.set(JumpStateComponent, {
                    from: 'a', to: 'b', phase, phaseStartedAt: 1200,
                    transitionAt: 1300, requiresAdjacency: true,
                    arrivalSoundPending: false,
                }),
                (entity: Entity) => entity.components.delete(JumpStateComponent),
            ] as [string, (entity: Entity) => void, (entity: Entity) => void]),
    ];
    for (const [name, lock, unlock] of lockouts) {
        it(`baselines during ${name} and rejects late impulses after a same-entity reset`, async () => {
            const server = await fixture('server');
            const owner = await fixture('player');
            server.time.time = owner.time.time = 1100;
            server.author(30, 10);
            lock(owner.ship);
            deliver(owner, server);
            expect(owner.velocity()).toEqual(new Vector(120, 0));
            // Another pre-reset collision is still in transit when flight resumes.
            server.time.time = 1200;
            server.author(40, 20);
            unlock(owner.ship);
            owner.ship.components.get(MovementStateComponent)!.velocity = new Vector(0, 0);
            owner.time.time = 1300;
            owner.world.step();
            server.time.time = owner.time.time = 1400;
            deliver(owner, server);
            expect(owner.velocity()).toEqual(new Vector(0, 0));
            server.time.time = owner.time.time = 1500;
            server.author(5, -5);
            deliver(owner, server);
            deliver(owner, server);
            expect(owner.velocity()).toEqual(new Vector(5, -5));
        });
    }

    const boundaries: Array<[string, (world: World, entity: Entity) => void]> = [
        ['ship component', (_world, entity) => entity.components.set(ShipComponent, { id: 'replacement' })],
        ['player ship', (_world, entity) => { entity.components.get(PlayerStateComponent)!.shipId = 'replacement'; }],
        ['player system', (_world, entity) => { entity.components.get(PlayerStateComponent)!.currentSystem = 'destination'; }],
        ['world system', world => world.resources.set(SystemIdResource, 'destination')],
        ['death stamp', (_world, entity) => { entity.components.get(PlayerStateComponent)!.diedAt = 1250; }],
    ];
    for (const [name, change] of boundaries) {
        it(`detects a changed ${name} even if death/jump lockout was not observed`, async () => {
            const server = await fixture('server');
            const owner = await fixture('player');
            owner.ship.components.set(PlayerStateComponent, createInitialPlayerState());
            owner.ship.components.set(ShipComponent, { id: 'original' });
            owner.world.resources.set(SystemIdResource, 'origin');
            owner.world.step();
            server.time.time = 1200;
            server.author(30, 10);
            change(owner.world, owner.ship);
            owner.time.time = 1300;
            owner.ship.components.get(MovementStateComponent)!.velocity = new Vector(0, 0);
            owner.world.step();
            server.time.time = owner.time.time = 1400;
            deliver(owner, server);
            expect(owner.velocity()).toEqual(new Vector(0, 0));
            server.time.time = owner.time.time = 1500;
            server.author(5, 5);
            deliver(owner, server);
            expect(owner.velocity()).toEqual(new Vector(5, 5));
        });
    }

    it('reads the current clock on reconnect after a tick-local time draft is revoked', async () => {
        const owner = await fixture('player');
        // Rebind a communicator while TimeResource is a tick-local draft.
        const timeDraft = createDraft({ ...owner.time });
        owner.world.resources.set(TimeResource, timeDraft);
        await owner.world.removePlugin(ExternalImpulsePlugin);
        await owner.world.addPlugin(ExternalImpulsePlugin);
        owner.world.step();
        const replacement = { ...finishDraft(timeDraft), time: 1500 };
        owner.world.resources.set(TimeResource, replacement);
        const errors: unknown[] = [];
        const previousHandler = config.onUnhandledError;
        config.onUnhandledError = error => errors.push(error);
        try {
            owner.communicator.connected.next(false);
            owner.communicator.connected.next(true);
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(errors).toEqual([]);
            owner.world.step();
        } finally {
            config.onUnhandledError = previousHandler;
        }
    });

    it('rejects client-authored impulse state on the server', async () => {
        const server = await fixture('server');
        const owner = await fixture('player');
        owner.author(900, 900);
        deliver(server, owner, 'player');
        expect(server.ship.components.has(ExternalImpulseComponent)).toBeFalse();
        expect(server.velocity()).toEqual(new Vector(120, 0));
    });
});
