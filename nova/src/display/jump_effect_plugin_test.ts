import 'jasmine';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { MovementState } from 'nova_ecs/plugins/movement_plugin';
import {
    JumpState,
    JUMP_ARRIVAL_MS,
    JUMP_STREAK_MS,
    SYSTEM_DEPARTURE_RADIUS,
} from '../nova_plugin/jump_plugin';
import { JumpEffectSystem } from './jump_effect_plugin';

function movementAt(x: number, y: number): MovementState {
    return {
        position: new Position(x, y),
        velocity: new Vector(0, 0),
        rotation: new Angle(0),
        turning: 0,
        turnBack: false,
        accelerating: 0,
    };
}

function graphic() {
    const container = {
        alpha: 1,
        rotation: 0,
        scale: {
            x: 1,
            y: 1,
            set(x: number, y = x) {
                this.x = x;
                this.y = y;
            },
        },
    };
    return {
        managed: { disposed: false },
        container,
        sprites: new Map(),
    };
}

function jump(
    phase: JumpState['phase'],
    transitionAt: number,
): JumpState {
    return {
        from: 'source',
        to: 'destination',
        phase,
        phaseStartedAt: 0,
        transitionAt,
        requiresAdjacency: false,
        arrivalSoundPending: false,
    };
}

describe('other-ship jump effects', () => {
    it('emits spool and departure sounds once per phase', () => {
        const sounds: string[] = [];
        const emit = (_event: unknown, data: unknown) => {
            const sound = data as { id?: string };
            if (sound.id) {
                sounds.push(sound.id);
            }
        };
        const shipMovement = movementAt(100, 0);
        const playerMovement = movementAt(0, 0);
        const shipGraphic = graphic();
        const seen = new Map<string, JumpState['phase']>();
        const players = [[undefined, playerMovement]];

        JumpEffectSystem.step(
            { id: 'ship' } as never,
            shipMovement,
            shipGraphic as never,
            jump('spooling', JUMP_STREAK_MS) as never,
            undefined,
            { time: 0 } as never,
            'ship',
            emit as never,
            players as never,
            seen,
        );
        JumpEffectSystem.step(
            { id: 'ship' } as never,
            shipMovement,
            shipGraphic as never,
            jump('spooling', JUMP_STREAK_MS) as never,
            undefined,
            { time: 10 } as never,
            'ship',
            emit as never,
            players as never,
            seen,
        );
        JumpEffectSystem.step(
            { id: 'ship' } as never,
            shipMovement,
            shipGraphic as never,
            jump('departing', JUMP_STREAK_MS) as never,
            undefined,
            { time: 10 } as never,
            'ship',
            emit as never,
            players as never,
            seen,
        );

        expect(sounds).toEqual(['nova:128', 'nova:130']);
    });

    it('stretches and fades departure and mirrors it on arrival', () => {
        const shipMovement = movementAt(100, 0);
        const shipGraphic = graphic();
        const seen = new Map<string, JumpState['phase']>();
        const step = (state: JumpState, time: number) =>
            JumpEffectSystem.step(
                { id: 'ship' } as never,
                shipMovement,
                shipGraphic as never,
                state as never,
                undefined,
                { time } as never,
                'ship',
                (() => undefined) as never,
                [] as never,
                seen,
            );

        step(jump('departing', JUMP_STREAK_MS), 0);
        expect(shipGraphic.container.scale.y).toBe(1);
        step(jump('departing', JUMP_STREAK_MS), JUMP_STREAK_MS * 5);
        expect(shipGraphic.container.scale.y).toBe(4);
        expect(shipGraphic.container.alpha).toBeGreaterThan(0);
        shipMovement.position = new Position(
            SYSTEM_DEPARTURE_RADIUS - 1, 0);
        step(jump('departing', JUMP_STREAK_MS), JUMP_STREAK_MS * 5);
        expect(shipGraphic.container.alpha).toBeLessThan(0.01);

        step(jump('arriving', JUMP_ARRIVAL_MS), 0);
        expect(shipGraphic.container.scale.y).toBe(4);
        expect(shipGraphic.container.alpha).toBe(0);
        step(jump('arriving', JUMP_ARRIVAL_MS), JUMP_ARRIVAL_MS);
        expect(shipGraphic.container.scale.y).toBe(1);
        expect(shipGraphic.container.alpha).toBe(1);

        shipGraphic.container.scale.set(4, 4);
        shipGraphic.container.alpha = 0;
        JumpEffectSystem.step(
            { id: 'ship' } as never,
            shipMovement,
            shipGraphic as never,
            undefined,
            undefined,
            { time: 0 } as never,
            'ship',
            (() => undefined) as never,
            [] as never,
            seen,
        );
        expect(shipGraphic.container.scale.y).toBe(1);
        expect(shipGraphic.container.alpha).toBe(1);
    });
});
