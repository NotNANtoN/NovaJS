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
import { NpcTrafficComponent } from './npc_traffic_plugin';
import { MiningShipComponent } from './miner_ai';
import { PlanetComponent } from './planet_plugin';
import { ShieldComponent } from './health_plugin';
import { Stat } from './stat';
import { TargetComponent } from './target_component';
import { ShipDataComponent } from './ship_plugin';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { NpcInteractionPlugin, AmbientChatterStateResource } from './npc_interaction_plugin';

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
            .addComponent(GovtComponent, { id: 128 })
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
            .addComponent(GovtComponent, { id: 128 })
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

    it('emits contextual trader radio chatter referencing real destination planets', () => {
        const planet = new Entity('Earth')
            .addComponent(PlanetComponent, { id: 'nova:128', name: 'Earth' });

        const trader = new Entity('Starling Freighter')
            .addComponent(ShipDataComponent, { ...getDefaultShipData(), name: 'Starling Freighter' })
            .addComponent(NpcTrafficComponent, { phase: 'travelling', destination: 'earth-uuid', readyAt: 0 })
            .addComponent(MovementStateComponent, {
                position: new Position(500, 0),
                velocity: new Vector(100, 0),
                rotation: new Angle(0),
                accelerating: 1,
                turning: 0,
                turnBack: false,
            });

        world.entities.set('earth-uuid', planet);
        world.entities.set('trader-uuid', trader);

        const chatterState = world.resources.get(AmbientChatterStateResource)!;
        chatterState.nextChatterAt = 0; // Trigger immediately

        world.step();

        const chatter = receivedMessages.find(m => m.kind === 'chatter');
        expect(chatter).toBeDefined();
        expect(chatter?.fromName).toBe('Starling Freighter');
        expect(chatter?.text).toContain('Earth');
    });

    it('emits dynamic SOS distress signals naming the attacking vessel when shields drop', () => {
        const attacker = new Entity('Pirate Marauder')
            .addComponent(ShipDataComponent, { ...getDefaultShipData(), name: 'Pirate Marauder' })
            .addComponent(MovementStateComponent, {
                position: new Position(100, 100),
                velocity: new Vector(0, 0),
                rotation: new Angle(0),
                accelerating: 0,
                turning: 0,
                turnBack: false,
            });

        const victim = new Entity('Solar Wind (Freighter)')
            .addComponent(ShipDataComponent, { ...getDefaultShipData(), name: 'Solar Wind (Freighter)' })
            .addComponent(NpcTrafficComponent, { phase: 'travelling', readyAt: 0 })
            .addComponent(TargetComponent, { target: 'attacker-uuid' })
            .addComponent(ShieldComponent, new Stat({ current: 20, max: 100, recharge: 1 })) // 20% shield
            .addComponent(MovementStateComponent, {
                position: new Position(120, 100),
                velocity: new Vector(0, 0),
                rotation: new Angle(0),
                accelerating: 0,
                turning: 0,
                turnBack: false,
            });

        world.entities.set('attacker-uuid', attacker);
        world.entities.set('victim-uuid', victim);

        world.step();

        const sos = receivedMessages.find(m => m.kind === 'sos');
        expect(sos).toBeDefined();
        expect(sos?.fromName).toBe('Solar Wind (Freighter)');
        expect(sos?.text).toContain('Pirate Marauder');
        expect(sos?.text).toContain('20%');
    });
});
