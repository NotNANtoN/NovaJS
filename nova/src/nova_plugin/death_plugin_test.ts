import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import { ArmorComponent, ShieldComponent } from './health_plugin';
import {
    createInitialPlayerState,
    PlayerStateComponent,
} from './player_state';
import {
    DeathEvent,
    DeathPlugin,
    PlayerDeathComponent,
} from './death_plugin';
import { PlayerShipSelector } from './player_ship_plugin';
import { Position } from 'nova_ecs/datatypes/position';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Stat } from './stat';

describe('player death', () => {
    it('holds the wreck, then respawns at the last landed position', async () => {
        const time = {
            time: 1_000,
            delta_ms: 0,
            delta_s: 0,
            frame: 0,
        };
        const state = createInitialPlayerState();
        state.lastLandedSystem = 'nova:130';
        state.lastLandedPosition = [321, -123];

        const world = new World('player-death-test');
        world.resources.set(TimeResource, time);
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(DeathPlugin);

        const player = new Entity('player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(PlayerStateComponent, state)
            .addComponent(MovementStateComponent, {
                accelerating: 0,
                position: new Position(42, 24),
                rotation: new Angle(0),
                turnBack: false,
                turning: 0,
                velocity: new Vector(4, 5),
            })
            .addComponent(ShieldComponent, new Stat({
                current: 0, recharge: 0, max: 100,
            }))
            .addComponent(ArmorComponent, new Stat({
                current: 0, recharge: 0, max: 200,
            }));
        world.entities.set('player', player);

        world.emitNow(DeathEvent, time, ['player']);
        world.step();

        const death = player.components.get(PlayerDeathComponent);
        expect(death?.wreckPosition).toEqual([42, 24]);
        expect(player.components.get(MovementStateComponent)!.velocity)
            .toEqual(new Vector(0, 0));

        time.time = 2_000;
        world.step();
        expect(player.components.get(MovementStateComponent)!.position)
            .toEqual(new Position(42, 24));

        time.time = death!.respawnAt;
        world.step();

        expect(player.components.has(PlayerDeathComponent)).toBe(false);
        expect(player.components.get(MovementStateComponent)!.position)
            .toEqual(new Position(321, -123));
        expect(player.components.get(ShieldComponent)!.current).toBe(100);
        expect(player.components.get(ArmorComponent)!.current).toBe(200);
    });
});
