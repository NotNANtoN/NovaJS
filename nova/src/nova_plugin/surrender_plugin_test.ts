import 'jasmine';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import { Position } from 'nova_ecs/datatypes/position';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Vector } from 'nova_ecs/datatypes/vector';
import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData, replicationPolicies } from 'nova_ecs/plugins/multiplayer_plugin';
import { BoardingInventoryComponent } from './boarding_plugin';
import { DisabledComponent } from './death_plugin';
import { DestructionStartedComponent } from './destruction_state';
import { NpcAIComponent } from './npc_plugin';
import { PlayerStateComponent, createInitialPlayerState } from './player_state';
import { PlatformResource } from './platform_plugin';
import { SurrenderPlugin, SurrenderRequestComponent, SurrenderOutcomeComponent } from './surrender_plugin';

function movement(x = 0) {
    return { position: new Position(x, 0), velocity: new Vector(0, 0), rotation: new Angle(0),
        accelerating: 0, turning: 0, turnBack: false };
}
async function setup() {
    const world = new World('surrender-test');
    world.resources.set(PlatformResource, 'node');
    await world.addPlugin(DeltaPlugin);
    await world.addPlugin(SurrenderPlugin);
    const player = new Entity().addComponent(PlayerStateComponent, createInitialPlayerState())
        .addComponent(MultiplayerData, { owner: 'client' })
        .addComponent(MovementStateComponent, movement());
    const target = new Entity().addComponent(NpcAIComponent, undefined)
        .addComponent(MultiplayerData, { owner: 'server' })
        .addComponent(DisabledComponent, true)
        .addComponent(MovementStateComponent, movement(100))
        .addComponent(BoardingInventoryComponent, { credits: 7000, holds: [], cargoCapacity: 0 });
    world.entities.set('player', player);
    world.entities.set('target', target);
    return { world, player, target };
}
function request(player: Entity, sequence: number, target = 'target') {
    player.components.set(SurrenderRequestComponent, { target, sequence });
}

describe('authoritative surrender', () => {
    it('pays once from the boarding purse, including repeated and competing demands', async () => {
        const { world, player, target } = await setup();
        const before = player.components.get(PlayerStateComponent)!.credits;
        request(player, 1);
        world.step();
        expect(player.components.get(PlayerStateComponent)!.credits).toBe(before + 5000);
        expect(target.components.get(BoardingInventoryComponent)!.credits).toBe(2000);
        world.step();
        request(player, 2);
        world.step();
        expect(player.components.get(SurrenderOutcomeComponent)!.reason).toBe('already-surrendered');
        const other = new Entity().addComponent(PlayerStateComponent, createInitialPlayerState())
            .addComponent(MultiplayerData, { owner: 'other-client' })
            .addComponent(MovementStateComponent, movement());
        world.entities.set('other', other);
        request(other, 1);
        world.step();
        expect(other.components.get(SurrenderOutcomeComponent)!.status).toBe('rejected');
        expect(player.components.get(PlayerStateComponent)!.credits).toBe(before + 5000);
        expect(target.components.get(BoardingInventoryComponent)!.credits).toBe(2000);
    });

    it('cannot replay a processed sequence against a different target', async () => {
        const { world, player } = await setup();
        request(player, 2, 'missing');
        world.step();
        request(player, 2);
        world.step();
        expect(player.components.get(SurrenderOutcomeComponent)!.target).toBe('missing');
        request(player, 3);
        world.step();
        expect(player.components.get(SurrenderOutcomeComponent)!.status).toBe('paid');
    });

    for (const invalid of ['active', 'distant', 'destroying', 'player-target', 'missing'] as const) {
        it(`rejects ${invalid} targets without credit mutation`, async () => {
            const { world, player, target } = await setup();
            const before = player.components.get(PlayerStateComponent)!.credits;
            if (invalid === 'active') target.components.delete(DisabledComponent);
            if (invalid === 'distant') target.components.set(MovementStateComponent, movement(10000));
            if (invalid === 'destroying') target.components.set(DestructionStartedComponent, true);
            if (invalid === 'player-target') target.components.set(MultiplayerData, { owner: 'other-client' });
            request(player, 1, invalid === 'missing' ? 'missing' : 'target');
            world.step();
            expect(player.components.get(SurrenderOutcomeComponent)!.status).toBe('rejected');
            expect(player.components.get(PlayerStateComponent)!.credits).toBe(before);
            expect(target.components.get(BoardingInventoryComponent)!.credits).toBe(7000);
        });
    }

    it('does not pay on browsers and ignores malformed sequences without poisoning retries', async () => {
        const { world, player, target } = await setup();
        world.resources.set(PlatformResource, 'browser');
        request(player, 1);
        world.step();
        expect(player.components.has(SurrenderOutcomeComponent)).toBeFalse();
        world.resources.set(PlatformResource, 'node');
        request(player, Number.MAX_SAFE_INTEGER + 1);
        world.step();
        request(player, 1);
        world.step();
        expect(player.components.get(SurrenderOutcomeComponent)!.status).toBe('paid');
        expect(target.components.get(BoardingInventoryComponent)!.credits).toBe(2000);
    });

    it('caps rewards at the available purse and rejects empty purses', async () => {
        const { world, player, target } = await setup();
        target.components.get(BoardingInventoryComponent)!.credits = 0;
        request(player, 1);
        world.step();
        expect(player.components.get(SurrenderOutcomeComponent)!.reason).toBe('no-credits');
        target.components.get(BoardingInventoryComponent)!.credits = 123;
        request(player, 2);
        world.step();
        expect(player.components.get(SurrenderOutcomeComponent)!.amount).toBe(123);
        expect(target.components.get(BoardingInventoryComponent)!.credits).toBe(0);
    });
});
