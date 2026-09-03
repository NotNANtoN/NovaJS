import 'jasmine';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { MovementState } from 'nova_ecs/plugins/movement_plugin';
import { CLOAK_TRANSITION_MS, CLOAKED_ALPHA } from '../nova_plugin/cloaking_plugin';
import { CloakVisualSystem } from './cloak_effect_plugin';

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

function mockGraphic() {
    return {
        managed: { disposed: false },
        container: {
            alpha: 1,
            rotation: 0,
        },
        sprites: new Map(),
    };
}

function mockWakeGraphics() {
    const calls: { method: string; args: unknown[] }[] = [];
    const chainable = {
        circle(...args: unknown[]) {
            calls.push({ method: 'circle', args });
            return chainable;
        },
        ellipse(...args: unknown[]) {
            calls.push({ method: 'ellipse', args });
            return chainable;
        },
        stroke(...args: unknown[]) {
            calls.push({ method: 'stroke', args });
            return chainable;
        },
        clear() {
            calls.push({ method: 'clear', args: [] });
            return chainable;
        },
    };
    return {
        root: chainable,
        calls,
    };
}

describe('CloakVisualSystem', () => {
    it('sets player ship alpha to a stealth ghost pulse when fully cloaked', () => {
        const movement = movementAt(100, 200);
        const graphic = mockGraphic();
        const cloakState = {
            cloaked: true,
            transitionStartedAt: 1000,
            alpha: CLOAKED_ALPHA,
        };

        // Fully cloaked at t = 2000 (> 1000 + 600)
        CloakVisualSystem.step(
            movement,
            graphic as never,
            cloakState,
            {} as never, // playerShip present
            { time: 2000 } as never,
            undefined,
        );

        expect(graphic.container.alpha).toBeGreaterThanOrEqual(0.15);
        expect(graphic.container.alpha).toBeLessThanOrEqual(0.26);
    });

    it('sets remote/npc ship alpha to 0 when fully cloaked', () => {
        const movement = movementAt(100, 200);
        const graphic = mockGraphic();
        const cloakState = {
            cloaked: true,
            transitionStartedAt: 1000,
            alpha: CLOAKED_ALPHA,
        };

        // Remote ship fully cloaked at t = 2000
        CloakVisualSystem.step(
            movement,
            graphic as never,
            cloakState,
            undefined, // not playerShip
            { time: 2000 } as never,
            undefined,
        );

        expect(graphic.container.alpha).toBe(0);
    });

    it('draws ripple wake graphics during cloak transition', () => {
        const movement = movementAt(300, 400);
        const graphic = mockGraphic();
        const cloakState = {
            cloaked: true,
            transitionStartedAt: 1000,
            alpha: 0.5,
        };
        const wakeHandle = mockWakeGraphics();

        // Midway through transition at t = 1300
        CloakVisualSystem.step(
            movement,
            graphic as never,
            cloakState,
            undefined as never,
            { time: 1300 } as never,
            wakeHandle as never,
        );

        const circleCalls = wakeHandle.calls.filter(c => c.method === 'circle');
        expect(circleCalls.length).toBeGreaterThanOrEqual(2);
        expect(circleCalls[0]!.args[0]).toBe(300);
        expect(circleCalls[0]!.args[1]).toBe(400);
    });

    it('restores alpha to 1.0 when decloaked and transition completes', () => {
        const movement = movementAt(100, 200);
        const graphic = mockGraphic();
        graphic.container.alpha = 0.2;
        const cloakState = {
            cloaked: false,
            transitionStartedAt: 1000,
            alpha: 1.0,
        };

        CloakVisualSystem.step(
            movement,
            graphic as never,
            cloakState,
            undefined as never,
            { time: 2000 } as never,
            undefined,
        );

        expect(graphic.container.alpha).toBe(1.0);
    });
});
