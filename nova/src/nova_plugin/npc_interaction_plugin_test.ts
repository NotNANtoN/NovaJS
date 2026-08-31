import 'jasmine';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Angle } from 'nova_ecs/datatypes/angle';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { TimePlugin, TimeResource } from 'nova_ecs/plugins/time_plugin';
import { ChatMessageEvent, ChatMessageEntry } from 'nova_ecs/plugins/multiplayer_plugin';
import { PlayerShipSelector } from './player_ship_plugin';
import { PlayerStateComponent, createInitialPlayerState } from './player_state';
import { GovtComponent } from './npc_plugin';
import { NpcCombatRoleComponent } from './npc_components';
import { NpcInteractionPlugin, SecurityScanResource } from './npc_interaction_plugin';

describe('NpcInteractionPlugin', () => {
    let world: World;
    let receivedMessages: ChatMessageEntry[];

    beforeEach(async () => {
        world = new World('npc-interaction-test');
        receivedMessages = [];
        await world.addPlugin(TimePlugin);
        await world.addPlugin(NpcInteractionPlugin);
        world.events.get(ChatMessageEvent)?.subscribe(msg => {
            receivedMessages.push(msg);
        });
    });

    it('scans a player vessel within security range and emits a security notification', () => {
        const player = new Entity('Player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(PlayerStateComponent, createInitialPlayerState())
            .addComponent(MovementStateComponent, {
                position: new Position(0, 0),
                velocity: new Vector(0, 0),
                rotation: new Angle(0),
                accelerating: 0,
                turning: 0,
                turnBack: false,
            });

        const patrol = new Entity('Fed Patrol')
            .addComponent(GovtComponent, { id: 'nova:128' })
            .addComponent(NpcCombatRoleComponent, 'military')
            .addComponent(MovementStateComponent, {
                position: new Position(100, 0), // Within 480px scan distance
                velocity: new Vector(0, 0),
                rotation: new Angle(0),
                accelerating: 0,
                turning: 0,
                turnBack: false,
            });

        world.entities.set('player', player);
        world.entities.set('patrol', patrol);

        world.step();

        expect(receivedMessages.length).toBe(1);
        expect(receivedMessages[0].kind).toBe('security');
        expect(receivedMessages[0].fromName).toBe('Fed Patrol');
        expect(receivedMessages[0].text.length).toBeGreaterThan(10);
    });

    it('does not re-scan within the cooldown window', () => {
        const player = new Entity('Player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(PlayerStateComponent, createInitialPlayerState())
            .addComponent(MovementStateComponent, {
                position: new Position(0, 0),
                velocity: new Vector(0, 0),
                rotation: new Angle(0),
                accelerating: 0,
                turning: 0,
                turnBack: false,
            });

        const patrol = new Entity('Fed Patrol')
            .addComponent(GovtComponent, { id: 'nova:128' })
            .addComponent(NpcCombatRoleComponent, 'military')
            .addComponent(MovementStateComponent, {
                position: new Position(100, 0),
                velocity: new Vector(0, 0),
                rotation: new Angle(0),
                accelerating: 0,
                turning: 0,
                turnBack: false,
            });

        world.entities.set('player', player);
        world.entities.set('patrol', patrol);

        world.step();
        expect(receivedMessages.length).toBe(1);

        // Step again immediately: should not emit a second scan
        world.step();
        expect(receivedMessages.length).toBe(1);
    });
});
