import 'jasmine';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { MovementState } from 'nova_ecs/plugins/movement_plugin';
import {
    JumpState,
    JUMP_ARRIVAL_MS,
    JUMP_DEPARTURE_SPEED_MULTIPLIER,
    SYSTEM_DEPARTURE_RADIUS,
} from '../nova_plugin/jump_plugin';
import {
    JumpEffectSystem,
    departureStretchFactor,
} from './jump_effect_plugin';

const MAX_VELOCITY = 40;
const PHYSICS = {maxVelocity: MAX_VELOCITY};

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
    it('emits charging and departure sounds once per phase', () => {
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
            PHYSICS as never,
            shipGraphic as never,
            jump('braking', 800) as never,
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
            PHYSICS as never,
            shipGraphic as never,
            jump('spooling', 1_200) as never,
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
            PHYSICS as never,
            shipGraphic as never,
            jump('departing', 180) as never,
            undefined,
            { time: 10 } as never,
            'ship',
            emit as never,
            players as never,
            seen,
        );

        expect(sounds).toEqual(['nova:128', 'nova:130']);
    });

    it('grows the departure streak with actual speed', () => {
        const shipMovement = movementAt(100, 0);
        const shipGraphic = graphic();
        const seen = new Map<string, JumpState['phase']>();
        const step = (state: JumpState, time: number) =>
            JumpEffectSystem.step(
                { id: 'ship' } as never,
                shipMovement,
                PHYSICS as never,
                shipGraphic as never,
                state as never,
                undefined,
                { time } as never,
                'ship',
                (() => undefined) as never,
                [] as never,
                seen,
            );

        step(jump('braking', 800), 0);
        expect(shipGraphic.container.scale.y).toBe(1);

        shipMovement.velocity = new Vector(0, -MAX_VELOCITY);
        step(jump('spooling', 1_200), 1_200);
        expect(shipGraphic.container.scale.y).toBeGreaterThan(1);
        expect(shipGraphic.container.scale.y).toBeLessThan(2);

        shipMovement.velocity = new Vector(
            0,
            -MAX_VELOCITY * JUMP_DEPARTURE_SPEED_MULTIPLIER,
        );
        step(jump('departing', 180), 0);
        expect(shipGraphic.container.scale.y).toBe(4);
        expect(shipGraphic.container.alpha).toBeGreaterThan(0);
        shipMovement.position = new Position(
            SYSTEM_DEPARTURE_RADIUS - 1, 0);
        step(jump('departing', 180), 180);
        expect(shipGraphic.container.alpha).toBeLessThan(0.01);

        shipMovement.position = new Position(100, 0);
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
            PHYSICS as never,
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

    it('reaches full departure stretch only at hyperspace speed', () => {
        const hyperspaceSpeed =
            MAX_VELOCITY * JUMP_DEPARTURE_SPEED_MULTIPLIER;

        expect(departureStretchFactor(0, MAX_VELOCITY)).toBe(0);
        expect(departureStretchFactor(MAX_VELOCITY, MAX_VELOCITY))
            .toBeCloseTo(1 / JUMP_DEPARTURE_SPEED_MULTIPLIER, 8);
        expect(departureStretchFactor(
            hyperspaceSpeed * 0.99,
            MAX_VELOCITY,
        )).toBeCloseTo(0.99, 8);
        expect(departureStretchFactor(
            hyperspaceSpeed,
            MAX_VELOCITY,
        )).toBe(1);
    });
});
