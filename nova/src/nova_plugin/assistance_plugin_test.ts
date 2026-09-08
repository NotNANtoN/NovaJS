import 'jasmine';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';
import {
    MovementPhysicsComponent,
    MovementPlugin,
    MovementStateComponent,
    MovementType,
} from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { World } from 'nova_ecs/world';
import {
    AssistanceOrderComponent,
    AssistanceOutcomeComponent,
    AssistancePlugin,
    AssistanceRequestComponent,
} from './assistance_plugin';
import { DisabledComponent } from './death_plugin';
import { JumpStateComponent } from './jump_plugin';
import { GovtComponent } from './npc_components';
import { DestructionStartedComponent } from './destruction_state';
import { assistanceGenerosity } from './comms';
import {
    GovernmentRelationResource,
} from './govt_relations';
import { NpcAIComponent } from './npc_plugin';
import {
    createInitialPlayerState,
    PlayerStateComponent,
} from './player_state';
import { PlatformResource } from './platform_plugin';
import { ShipDataComponent } from './ship_plugin';
import { TargetComponent } from './target_component';

const PLAYER_UUID = 'player';

function movementAt(x: number, y: number) {
    return {
        accelerating: 0,
        position: new Position(x, y),
        rotation: new Angle(Math.PI / 2),
        turnBack: false,
        turning: 0,
        velocity: new Vector(0, 0),
    };
}

async function makeWorld() {
    const world = new World('assistance-test');
    world.resources.set(TimeResource, {
        time: 0,
        delta_ms: 1_000 / 60,
        delta_s: 1 / 60,
        frame: 0,
    });
    world.resources.set(PlatformResource, 'node');
    world.resources.set(
        GovernmentRelationResource,
        { getCached: () => undefined } as never,
    );
    await world.addPlugin(DeltaPlugin);
    await world.addPlugin(MovementPlugin);
    await world.addPlugin(AssistancePlugin);
    return world;
}

function playerAt(fuel: number) {
    const state = createInitialPlayerState();
    state.currentSystem = 'assistance-test';
    state.fuel = fuel;
    return new Entity('player')
        .addComponent(PlayerStateComponent, state)
        .addComponent(ShipDataComponent, {
            ...getDefaultShipData(),
            fuelCapacity: 300,
        } as never)
        .addComponent(MovementStateComponent, movementAt(0, 0))
        .addComponent(MultiplayerData, { owner: 'client' });
}

function helperAt(uuid: string, x: number, target?: string) {
    return new Entity('helper')
        .addComponent(NpcAIComponent, undefined)
        .addComponent(MultiplayerData, { owner: 'server' })
        .addComponent(TargetComponent, { target })
        .addComponent(MovementStateComponent, movementAt(x, 0))
        .addComponent(MovementPhysicsComponent, {
            acceleration: 100,
            maxVelocity: 160,
            movementType: MovementType.INERTIAL,
            turnRate: 3,
        });
}

function freeHelperUuid(): string {
    for (let index = 0; index < 100; index++) {
        const uuid = `helper-${index}`;
        if (assistanceGenerosity(PLAYER_UUID, uuid) < 0.25) {
            return uuid;
        }
    }
    throw new Error('Could not find a generous test helper');
}

function paidHelperUuids(): string[] {
    return Array.from({ length: 100 }, (_, index) => `paid-${index}`)
        .filter(uuid => {
            const generosity = assistanceGenerosity(PLAYER_UUID, uuid);
            return generosity >= 0.25 && generosity < 0.75;
        });
}

function submitRequest(
    player: Entity,
    helper: string,
    sequence = 1,
    action: 'request' | 'accept' = 'request',
) {
    player.components.set(AssistanceRequestComponent, {
        helper,
        sequence,
        action,
    });
}

describe('ship assistance', () => {
    for (const failure of [
        'timeout', 'helper-disabled', 'helper-left-system', 'player-left-system',
        'helper-destroyed', 'player-destroyed', 'player-jumped', 'helper-jumped',
        'invalid-helper',
    ] as const) {
        it(`refunds a paid rescue exactly once on ${failure}`, async () => {
            const world = await makeWorld();
            const player = playerAt(0);
            const [id, otherId] = paidHelperUuids();
            const helper = helperAt(id, 2_000);
            world.entities.set(PLAYER_UUID, player);
            world.entities.set(id, helper);
            world.entities.set(otherId, helperAt(otherId, 2_000));
            submitRequest(player, id, 1, 'accept');
            world.step();
            expect(player.components.get(PlayerStateComponent)!.credits).toBe(9500);
            // Even a request not yet observed by RequestSystem must not queue.
            submitRequest(player, otherId, 2, 'accept');
            switch (failure) {
                case 'timeout':
                    world.resources.get(TimeResource)!.time =
                        helper.components.get(AssistanceOrderComponent)!.expiresAt;
                    break;
                case 'helper-disabled': helper.components.set(DisabledComponent, true); break;
                case 'helper-destroyed': helper.components.set(DestructionStartedComponent, true); break;
                case 'player-destroyed': player.components.set(DestructionStartedComponent, true); break;
                case 'player-jumped': player.components.set(JumpStateComponent, {} as never); break;
                case 'helper-jumped': helper.components.set(JumpStateComponent, {} as never); break;
                case 'helper-left-system': world.entities.delete(id); break;
                case 'player-left-system': world.entities.delete(PLAYER_UUID); break;
                case 'invalid-helper': helper.components.delete(MovementPhysicsComponent); break;
            }
            if (failure.endsWith('left-system')) {
                // Removal must settle before the next frame / transfer snapshot.
                expect(player.components.get(PlayerStateComponent)!.credits).toBe(10000);
            }
            world.step();
            world.step();
            expect(player.components.get(AssistanceOutcomeComponent)).toEqual({
                helper: id, sequence: 1, phase: 'failed', reason: failure,
                refundedCredits: 500,
            });
            expect(player.components.get(PlayerStateComponent)!.credits).toBe(10000);
            expect(player.components.get(PlayerStateComponent)!.fuel).toBe(0);
            expect(helper.components.has(AssistanceOrderComponent)).toBeFalse();
            expect(world.entities.get(otherId)!.components.has(AssistanceOrderComponent)).toBeFalse();
        });
    }

    it('refunds before a jumping player is transferred and does not refund again on re-entry', async () => {
        const world = await makeWorld();
        const player = playerAt(0);
        const [id] = paidHelperUuids();
        const helper = helperAt(id, 2_000);
        world.entities.set(PLAYER_UUID, player);
        world.entities.set(id, helper);
        submitRequest(player, id, 1, 'accept');
        world.step();
        player.components.set(JumpStateComponent, {} as never);
        world.entities.delete(PLAYER_UUID);
        expect(player.components.get(PlayerStateComponent)!.credits).toBe(10000);
        expect(player.components.get(AssistanceOutcomeComponent)?.reason).toBe('player-jumped');
        player.components.delete(JumpStateComponent);
        world.entities.set(PLAYER_UUID, player);
        world.step();
        world.entities.delete(PLAYER_UUID);
        expect(player.components.get(PlayerStateComponent)!.credits).toBe(10000);
        expect(helper.components.has(AssistanceOrderComponent)).toBeFalse();
    });

    it('does not let malformed sequences reset a consumed player-wide watermark', async () => {
        const world = await makeWorld();
        const player = playerAt(0);
        const [id, otherId] = paidHelperUuids();
        const helper = helperAt(id, 2_000);
        helper.components.set(DisabledComponent, true);
        world.entities.set(PLAYER_UUID, player);
        world.entities.set(id, helper);
        world.entities.set(otherId, helperAt(otherId, 2_000));
        submitRequest(player, id, 5, 'accept');
        world.step();
        submitRequest(player, otherId, Number.MAX_SAFE_INTEGER + 1, 'accept');
        world.step();
        submitRequest(player, otherId, 4, 'accept');
        world.step();
        expect(player.components.get(PlayerStateComponent)!.credits).toBe(10000);
        submitRequest(player, otherId, 6, 'accept');
        world.step();
        expect(player.components.get(PlayerStateComponent)!.credits).toBe(9500);
    });

    it('removes its departure subscription when the plugin is removed', async () => {
        const world = await makeWorld();
        const player = playerAt(0);
        const [id] = paidHelperUuids();
        world.entities.set(PLAYER_UUID, player);
        world.entities.set(id, helperAt(id, 2_000));
        submitRequest(player, id, 1, 'accept');
        world.step();
        await world.removePlugin(AssistancePlugin);
        world.entities.delete(id);
        expect(player.components.get(PlayerStateComponent)!.credits).toBe(9500);
    });

    for (const reason of ['helper-disabled', 'government-unavailable'] as const) {
        it(`rejects ${reason} before payment and requires a fresh sequence to retry`, async () => {
            const world = await makeWorld();
            const player = playerAt(0);
            const [id, otherId] = paidHelperUuids();
            const helper = helperAt(id, 2_000);
            if (reason === 'helper-disabled') helper.components.set(DisabledComponent, true);
            else helper.components.set(GovtComponent, { id: 123 });
            world.entities.set(PLAYER_UUID, player);
            world.entities.set(id, helper);
            world.entities.set(otherId, helperAt(otherId, 2_000));
            submitRequest(player, id, 1, 'accept');
            world.step();
            expect(player.components.get(AssistanceOutcomeComponent)).toEqual({
                helper: id, sequence: 1, phase: 'failed', reason,
            });
            expect(player.components.get(PlayerStateComponent)!.credits).toBe(10000);
            expect(helper.components.has(AssistanceOrderComponent)).toBeFalse();
            submitRequest(player, otherId, 1, 'accept');
            world.step();
            expect(player.components.get(PlayerStateComponent)!.credits).toBe(10000);
            submitRequest(player, otherId, 2, 'accept');
            world.step();
            expect(player.components.get(PlayerStateComponent)!.credits).toBe(9500);
        });
    }
    for (const replacement of [
        'duplicate', 'new-sequence', 'other-helper', 'invalid-helper',
    ] as const) {
        it(`preserves a paid rescue on ${replacement} requests`, async () => {
            const world = await makeWorld();
            const player = playerAt(0);
            const [firstId, secondId] = paidHelperUuids();
            const first = helperAt(firstId, 2_000);
            const second = helperAt(secondId, 2_000);
            world.entities.set(PLAYER_UUID, player);
            world.entities.set(firstId, first);
            world.entities.set(secondId, second);
            const credits = player.components.get(PlayerStateComponent)!.credits;
            submitRequest(player, firstId, 1, 'accept');
            world.step();
            const expiresAt = first.components.get(AssistanceOrderComponent)!.expiresAt;

            submitRequest(player,
                replacement === 'invalid-helper' ? ''
                    : replacement === 'other-helper' ? secondId : firstId,
                replacement === 'duplicate' ? 1 : 2, 'accept');
            world.step();
            world.step();

            expect(player.components.get(PlayerStateComponent)!.credits).toBe(credits - 500);
            expect(player.components.get(AssistanceOutcomeComponent)).toEqual({
                helper: firstId, sequence: 1, phase: 'approaching',
            });
            expect(first.components.get(AssistanceOrderComponent)).toEqual({
                player: PLAYER_UUID, sequence: 1, expiresAt,
            });
            expect(second.components.has(AssistanceOrderComponent)).toBeFalse();

            first.components.set(MovementStateComponent, movementAt(0, 0));
            world.step();
            world.step();
            expect(player.components.get(AssistanceOutcomeComponent)).toEqual({
                helper: firstId, sequence: 1, phase: 'completed',
            });
            expect(player.components.get(PlayerStateComponent)!.fuel).toBe(100);
            expect(player.components.get(PlayerStateComponent)!.credits).toBe(credits - 500);
            expect(first.components.has(AssistanceOrderComponent)).toBeFalse();
            expect(second.components.has(AssistanceOrderComponent)).toBeFalse();

            // A genuinely new rescue remains possible after completion.
            player.components.get(PlayerStateComponent)!.fuel = 0;
            submitRequest(player, secondId, 3, 'accept');
            world.step();
            expect(player.components.get(AssistanceOutcomeComponent)).toEqual({
                helper: secondId, sequence: 3, phase: 'approaching',
            });
            expect(player.components.get(PlayerStateComponent)!.credits).toBe(credits - 1000);
        });
    }

    it('preserves timeout semantics and does not run an ignored request afterward', async () => {
        const world = await makeWorld();
        const player = playerAt(0);
        const [firstId, secondId] = paidHelperUuids();
        const first = helperAt(firstId, 2_000);
        const second = helperAt(secondId, 2_000);
        world.entities.set(PLAYER_UUID, player);
        world.entities.set(firstId, first);
        world.entities.set(secondId, second);
        submitRequest(player, firstId, 1, 'accept');
        world.step();
        submitRequest(player, secondId, 2, 'accept');
        world.resources.get(TimeResource)!.time =
            first.components.get(AssistanceOrderComponent)!.expiresAt;
        world.step();
        world.step();
        expect(player.components.get(AssistanceOutcomeComponent)).toEqual({
            helper: firstId, sequence: 1, phase: 'failed', reason: 'timeout',
                        refundedCredits: 500,
        });
        expect(player.components.get(PlayerStateComponent)!.credits).toBe(10000);
        expect(first.components.has(AssistanceOrderComponent)).toBeFalse();
        expect(second.components.has(AssistanceOrderComponent)).toBeFalse();
    });

    it('does not grant fuel while the helper is far away', async () => {
        const world = await makeWorld();
        const player = playerAt(0);
        const helperUuid = freeHelperUuid();
        const helper = helperAt(helperUuid, 2_000);
        world.entities.set(PLAYER_UUID, player);
        world.entities.set(helperUuid, helper);
        submitRequest(player, helperUuid);

        world.step();

        expect(player.components.get(PlayerStateComponent)!.fuel).toBe(0);
        expect(player.components.get(AssistanceOutcomeComponent))
            .toEqual({
                helper: helperUuid,
                sequence: 1,
                phase: 'approaching',
            });
        expect(helper.components.has(AssistanceOrderComponent)).toBeTrue();
    });

    it('approaches over successive steps and transfers fuel at readiness',
        async () => {
            const world = await makeWorld();
            const player = playerAt(0);
            const helperUuid = freeHelperUuid();
            const helper = helperAt(helperUuid, 1_500);
            world.entities.set(PLAYER_UUID, player);
            world.entities.set(helperUuid, helper);
            submitRequest(player, helperUuid);

            world.step();
            expect(player.components.get(PlayerStateComponent)!.fuel)
                .toBe(0);

            let steps = 0;
            while (player.components.get(AssistanceOutcomeComponent)?.phase
                === 'approaching' && steps < 2_400) {
                world.step();
                steps++;
            }

            expect(steps).toBeLessThan(2_400);
            expect(player.components.get(PlayerStateComponent)!.fuel)
                .toBe(100);
            expect(player.components.get(AssistanceOutcomeComponent))
                .toEqual({
                    helper: helperUuid,
                    sequence: 1,
                    phase: 'completed',
                });
            expect(helper.components.has(AssistanceOrderComponent)).toBeFalse();
            expect(helper.components.get(TargetComponent)!.target)
                .toBeUndefined();
        });

    it('rejects hostile and no-longer-stranded requests', async () => {
        const hostileWorld = await makeWorld();
        const hostilePlayer = playerAt(0);
        const hostileUuid = freeHelperUuid();
        const hostile = helperAt(hostileUuid, 100, PLAYER_UUID);
        hostileWorld.entities.set(PLAYER_UUID, hostilePlayer);
        hostileWorld.entities.set(hostileUuid, hostile);
        submitRequest(hostilePlayer, hostileUuid);

        hostileWorld.step();

        expect(hostilePlayer.components.get(PlayerStateComponent)!.fuel)
            .toBe(0);
        expect(hostilePlayer.components.get(AssistanceOutcomeComponent))
            .toEqual({
                helper: hostileUuid,
                sequence: 1,
                phase: 'failed',
                reason: 'hostile',
            });
        expect(hostile.components.has(AssistanceOrderComponent)).toBeFalse();

        const strandedWorld = await makeWorld();
        const safePlayer = playerAt(100);
        const safeUuid = freeHelperUuid();
        const safeHelper = helperAt(safeUuid, 100);
        strandedWorld.entities.set(PLAYER_UUID, safePlayer);
        strandedWorld.entities.set(safeUuid, safeHelper);
        submitRequest(safePlayer, safeUuid);

        strandedWorld.step();

        expect(safePlayer.components.get(AssistanceOutcomeComponent))
            .toEqual({
                helper: safeUuid,
                sequence: 1,
                phase: 'failed',
                reason: 'not-stranded',
            });
        expect(safeHelper.components.has(AssistanceOrderComponent))
            .toBeFalse();
    });

    it('fails and clears the order when it times out', async () => {
        const world = await makeWorld();
        const player = playerAt(0);
        const helperUuid = freeHelperUuid();
        const helper = helperAt(helperUuid, 2_000);
        world.entities.set(PLAYER_UUID, player);
        world.entities.set(helperUuid, helper);
        submitRequest(player, helperUuid);

        world.step();
        const order = helper.components.get(AssistanceOrderComponent)!;
        world.resources.get(TimeResource)!.time = order.expiresAt;
        world.step();

        expect(player.components.get(AssistanceOutcomeComponent)?.phase)
            .toBe('failed');
        expect(player.components.get(AssistanceOutcomeComponent)?.reason)
            .toBe('timeout');
        expect(helper.components.has(AssistanceOrderComponent)).toBeFalse();
    });

    it('fails and clears the order when the helper is destroyed',
        async () => {
            const world = await makeWorld();
            const player = playerAt(0);
            const helperUuid = freeHelperUuid();
            const helper = helperAt(helperUuid, 2_000);
            world.entities.set(PLAYER_UUID, player);
            world.entities.set(helperUuid, helper);
            submitRequest(player, helperUuid);

            world.step();
            helper.components.set(DestructionStartedComponent, true);
            world.step();

            expect(player.components.get(AssistanceOutcomeComponent))
                .toEqual({
                    helper: helperUuid,
                    sequence: 1,
                    phase: 'failed',
                    reason: 'helper-destroyed',
                });
            expect(helper.components.has(AssistanceOrderComponent)).toBeFalse();
            expect(helper.components.get(TargetComponent)!.target)
                .toBeUndefined();
        });
});
