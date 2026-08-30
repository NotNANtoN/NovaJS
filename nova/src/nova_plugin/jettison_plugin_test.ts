import 'jasmine';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { World } from 'nova_ecs/world';
import {
    JettisonPlugin,
    JettisonRequestComponent,
    PlayerJettisonInputSystem,
    ServerJettisonSystem,
} from './jettison_plugin';
import { ControlStateEvent } from './control_state_event';
import { EntityBudgetResource, EntityBudget } from './entity_budget';
import { PlatformResource } from './platform_plugin';
import { PlayerShipSelector } from './player_ship_plugin';
import { createInitialPlayerState, PlayerStateComponent } from './player_state';
import { OreComponent } from './asteroid_plugin';

describe('Jettison plugin', () => {
    it('sets a jettison request when player presses jettison with cargo in holds', () => {
        const world = new World('jettison-input-test');
        world.resources.set(PlatformResource, 'browser');
        world.addSystem(PlayerJettisonInputSystem);

        const playerState = createInitialPlayerState();
        playerState.holds = [{ commodity: 'Metal', tons: 5, isMissionCargo: false }];

        const player = new Entity('player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(PlayerStateComponent, playerState);

        world.entities.set('player', player);

        world.emitNow(ControlStateEvent, new Map([['jettison', 'start']]));
        expect(player.components.get(JettisonRequestComponent)?.sequence).toBe(1);
    });

    it('spawns an ore canister in space and releases 1 ton of player cargo on server', () => {
        const world = new World('jettison-server-test');
        world.resources.set(PlatformResource, 'node');
        world.resources.set(EntityBudgetResource, new EntityBudget('classic'));
        world.addSystem(ServerJettisonSystem);

        const playerState = createInitialPlayerState();
        playerState.holds = [{ commodity: 'Food', tons: 3, isMissionCargo: false }];

        const player = new Entity('player')
            .addComponent(PlayerStateComponent, playerState)
            .addComponent(MultiplayerData, { owner: 'player' })
            .addComponent(MovementStateComponent, {
                accelerating: 0,
                position: new Position(100, 200),
                rotation: new Angle(0),
                turnBack: false,
                turning: 0,
                velocity: new Vector(0, 0),
            })
            .addComponent(JettisonRequestComponent, { sequence: 1 });

        world.entities.set('player', player);
        world.step();

        expect(playerState.holds[0].tons).toBe(2);
        expect(player.components.has(JettisonRequestComponent)).toBeFalse();

        // Check spawned ore canister entity in world
        const oreEntities = [...world.entities.values()].filter(e => e.components.has(OreComponent));
        expect(oreEntities.length).toBe(1);
        expect(oreEntities[0].components.get(OreComponent)?.commodity).toBe('Food');
        expect(oreEntities[0].components.get(OreComponent)?.tons).toBe(1);
    });
});
