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
