import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Angle } from 'nova_ecs/datatypes/angle';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { ShipComponent } from './ship_plugin';
import { TargetComponent } from './target_component';
import { ChooseTargetSystem } from './target_plugin';
import 'jasmine';
import { Entity } from 'nova_ecs/entity';
import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { World } from 'nova_ecs/world';
import { ControlStateEvent } from './control_state_event';
import {
    CLOAKED_ALPHA,
    CLOAK_TRANSITION_MS,
    CloakDeviceComponent,
    CloakStateComponent,
    CloakingPlugin,
    computeCloakAlpha,
    DecloakOnFireSystem,
    PlayerCloakControlSystem,
} from './cloaking_plugin';
import { PlayerShipSelector } from './player_ship_plugin';
import { PlayerStateComponent } from './player_state';
import { createInitialPlayerState } from './player_state';
import { SoundEvent } from './sound_event';
import { WeaponsStateComponent } from './weapons_state';

describe('CloakingPlugin', () => {
    it('computes smooth transition alpha for cloaking and uncloaking', () => {
        // Fading in to cloak (1.0 -> CLOAKED_ALPHA)
        expect(computeCloakAlpha(true, 1000, 1000)).toBe(1.0);
        expect(computeCloakAlpha(true, 1000, 1000 + CLOAK_TRANSITION_MS / 2))
            .toBeCloseTo(1.0 - 0.5 * (1.0 - CLOAKED_ALPHA), 4);
        expect(computeCloakAlpha(true, 1000, 1000 + CLOAK_TRANSITION_MS))
            .toBeCloseTo(CLOAKED_ALPHA, 4);

        // Uncloaking (CLOAKED_ALPHA -> 1.0)
        expect(computeCloakAlpha(false, 2000, 2000)).toBe(CLOAKED_ALPHA);
        expect(computeCloakAlpha(false, 2000, 2000 + CLOAK_TRANSITION_MS))
            .toBeCloseTo(1.0, 4);
    });

    it('toggles cloaked state and emits authentic sounds on control event', async () => {
        const world = new World('cloak-test');
        const time = { time: 1000, delta_ms: 16, delta_s: 0.016, frame: 1 };
        world.resources.set(TimeResource, time);
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(CloakingPlugin);

        const sounds: string[] = [];
        world.events.get(SoundEvent).subscribe(s => sounds.push(s.id));

        const ship = new Entity('player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(CloakDeviceComponent, { canCloak: true });
        world.entities.set('player', ship);

        // 1. Press cloak -> Cloak On (nova:381)
        world.emitNow(ControlStateEvent, new Map([['cloak', 'start']]), ['player']);
        expect(ship.components.get(CloakStateComponent)?.cloaked).toBeTrue();
        expect(sounds).toEqual(['nova:381']);

        // 2. Press cloak again -> Cloak Off (nova:380)
        time.time = 2000;
        world.emitNow(ControlStateEvent, new Map([['cloak', 'start']]), ['player']);
        expect(ship.components.get(CloakStateComponent)?.cloaked).toBeFalse();
        expect(sounds).toEqual(['nova:381', 'nova:380']);
    });

    it('drops cloak immediately when weapons fire', async () => {
        const world = new World('decloak-test');
        const time = { time: 3000, delta_ms: 16, delta_s: 0.016, frame: 10 };
        world.resources.set(TimeResource, time);
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(CloakingPlugin);

        const sounds: string[] = [];
        world.events.get(SoundEvent).subscribe(s => sounds.push(s.id));

        const ship = new Entity('player')
            .addComponent(CloakDeviceComponent, { canCloak: true })
            .addComponent(CloakStateComponent, { cloaked: true, transitionStartedAt: 1000, alpha: CLOAKED_ALPHA })
            .addComponent(WeaponsStateComponent, new Map([['blaster', { count: 1, firing: false }]]));
        world.entities.set('player', ship);

        world.step();
        expect(ship.components.get(CloakStateComponent)?.cloaked).toBeTrue();

        // Fire weapon -> decloaks immediately with snd 380
        ship.components.get(WeaponsStateComponent)!.get('blaster')!.firing = true;
        world.step();

        expect(ship.components.get(CloakStateComponent)?.cloaked).toBeFalse();
        expect(sounds).toContain('nova:380');
    });

    it('prevents targeting of cloaked ships', async () => {
        const world = new World('cloak-target-test');
        world.addSystem(ChooseTargetSystem);

        const player = new Entity('player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(TargetComponent, { target: undefined })
            .addComponent(MovementStateComponent, {
                position: new Position(0, 0),
                velocity: new Vector(0, 0),
                rotation: new Angle(0),
                turning: 0,
                turnBack: false,
                accelerating: 0,
            });

        const enemy = new Entity('enemy')
            .addComponent(ShipComponent, { id: 'ship-1' })
            .addComponent(MovementStateComponent, {
                position: new Position(100, 0),
                velocity: new Vector(0, 0),
                rotation: new Angle(0),
                turning: 0,
                turnBack: false,
                accelerating: 0,
            })
            .addComponent(CloakStateComponent, { cloaked: true, transitionStartedAt: 0, alpha: 0.12 });

        world.entities.set('player', player);
        world.entities.set('enemy', enemy);

        world.emitNow(ControlStateEvent, new Map([['nearestTarget', 'start']]), ['player']);
        expect(player.components.get(TargetComponent)?.target).toBeUndefined();
    });

    it('continuously drains fuel and collapses cloak when energy is depleted', async () => {
        const world = new World('cloak-drain-test');
        const time = { time: 1000, delta_ms: 1000, delta_s: 1.0, frame: 1 };
        world.resources.set(TimeResource, time);
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(CloakingPlugin);

        const sounds: string[] = [];
        world.events.get(SoundEvent).subscribe(s => sounds.push(s.id));

        const playerState = createInitialPlayerState();
        playerState.fuel = 3; // 3 units of fuel left

        const ship = new Entity('player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(CloakDeviceComponent, { canCloak: true })
            .addComponent(CloakStateComponent, { cloaked: true, transitionStartedAt: 1000, alpha: CLOAKED_ALPHA })
            .addComponent(PlayerStateComponent, playerState);
        world.entities.set('player', ship);

        // Step 1: 1 second elapsed -> drains 2 units of fuel -> 1 unit remaining
        world.step();
        expect(playerState.fuel).toBe(1);
        expect(ship.components.get(CloakStateComponent)?.cloaked).toBeTrue();

        // Step 2: another second elapsed -> fuel drops to 0 -> cloak collapses
        time.time = 2000;
        world.step();
        expect(playerState.fuel).toBe(0);
        expect(ship.components.get(CloakStateComponent)?.cloaked).toBeFalse();
        expect(sounds).toContain('nova:380');
    });

});
