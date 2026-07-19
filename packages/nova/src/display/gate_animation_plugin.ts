import { RunQuery, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Plugin } from 'nova_ecs/plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { Provide } from 'nova_ecs/provide';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { PlanetDataComponent, PlanetTargetComponent } from '../nova_plugin/planet_plugin.js';
import { PlayerShipSelector } from '../nova_plugin/player_ship_plugin.js';
import { AnimationGraphicComponent, ObjectDrawSystem } from './animation_graphic_plugin.js';

/**
 * Hypergate open/close animation (display-only, player-local).
 *
 * The stock hypergate sprite (rlëD 2001, shared by every animated stock gate)
 * has 42 frames. Per the EVN Bible's animated-hypergate rule (CustPicID 0 or
 * out of range — all stock gates — means "use the first half of the frames
 * for opening/closing and the second half for working"), frames 0-20 are the
 * opening/closing sequence and frames 21-41 the working loop.
 *
 * The gate opens when this player targets it for landing (the land key's
 * target selection) or is near it (which also covers "the destination gate is
 * open as you emerge from it" — arrivals appear within the proximity radius).
 * It plays the closing sequence when neither holds. Purely cosmetic and
 * driven by the display world's wall clock, so it never touches simulation
 * state.
 */

/** How long each animation frame shows. The spöb AnimDelay of every stock
 * gate is 0 (unset; the Bible's unit is 30ths of a second), so the rate is
 * tuned to feel: ~80ms/frame plays the 21-frame stock opening in ~1.7s. */
export const GATE_FRAME_MS = 80;
/** Distance within which a gate stands open for the approaching/emerging
 * player, in pixels. Covers the 300px emergence point with enough margin
 * that a slow ship flying straight out still sees the full ~1.7s opening
 * play before it leaves the radius and the gate closes behind it. */
export const GATE_OPEN_PROXIMITY = 600;

interface GateAnimationState {
    stage: 'closed' | 'opening' | 'working' | 'closing';
    frame: number;
    /** Display-clock time (ms) the frame last advanced. */
    lastAdvance: number;
}

export const GateAnimationComponent =
    new Component<GateAnimationState>('GateAnimation');

const GateAnimationProvider = Provide({
    name: 'GateAnimationProvider',
    provided: GateAnimationComponent,
    args: [PlanetDataComponent] as const,
    factory: () => ({ stage: 'closed' as const, frame: 0, lastAdvance: 0 }),
});

const PlayerQuery = new Query([PlanetTargetComponent, MovementStateComponent,
    PlayerShipSelector] as const);

export const GateAnimationSystem = new System({
    name: 'GateAnimationSystem',
    args: [GateAnimationComponent, PlanetDataComponent,
        AnimationGraphicComponent, MovementStateComponent, UUID, TimeResource,
        RunQuery] as const,
    step(state, planetData, graphic, movement, uuid, time, runQuery) {
        if (planetData.gate?.kind !== 'hypergate') {
            return;
        }
        // The frame count comes from the loaded sprite sheet (all frames load
        // regardless of the declared 'normal' range). A single-frame gate
        // (e.g. plug-in gates with static sprites) has nothing to animate.
        const sprites = [...graphic.sprites.values()];
        const frames = Math.min(...sprites.map(s => s.frames));
        if (!Number.isFinite(frames) || frames < 2) {
            return;
        }
        const openingFrames = Math.floor(frames / 2);

        // Open for the player who targets the gate for landing or is close
        // to it (approach and emergence).
        let wantOpen = false;
        for (const [target, playerMovement] of runQuery(PlayerQuery)) {
            if (target.target === uuid) {
                wantOpen = true;
                break;
            }
            const distance = playerMovement.position
                .subtract(movement.position).length;
            if (distance < GATE_OPEN_PROXIMITY) {
                wantOpen = true;
                break;
            }
        }

        const advance = time.time - state.lastAdvance >= GATE_FRAME_MS;
        switch (state.stage) {
            case 'closed':
                state.frame = 0;
                if (wantOpen) {
                    state.stage = 'opening';
                    state.lastAdvance = time.time;
                }
                break;
            case 'opening':
                if (!wantOpen) {
                    state.stage = 'closing';
                } else if (advance) {
                    state.lastAdvance = time.time;
                    if (state.frame + 1 >= openingFrames) {
                        state.stage = 'working';
                        state.frame = openingFrames;
                    } else {
                        state.frame++;
                    }
                }
                break;
            case 'working':
                if (!wantOpen) {
                    state.stage = 'closing';
                    state.frame = Math.max(0, openingFrames - 1);
                    state.lastAdvance = time.time;
                } else if (advance) {
                    state.lastAdvance = time.time;
                    // Loop the working frames [openingFrames, frames).
                    state.frame = state.frame + 1 >= frames
                        ? openingFrames : state.frame + 1;
                }
                break;
            case 'closing':
                if (wantOpen) {
                    state.stage = 'opening';
                } else if (advance) {
                    state.lastAdvance = time.time;
                    if (state.frame <= 0) {
                        state.stage = 'closed';
                        state.frame = 0;
                    } else {
                        state.frame--;
                    }
                }
                break;
        }

        // Override the frame ObjectDrawSystem's rotation pass picked (planets
        // have a 1-frame 'normal' set, which pins frame 0 every tick).
        for (const sprite of sprites) {
            sprite.frame = Math.min(frames - 1, state.frame);
        }
    },
    after: [ObjectDrawSystem],
});

export const GateAnimationPlugin: Plugin = {
    name: 'GateAnimationPlugin',
    build(world) {
        world.addComponent(GateAnimationComponent);
        world.addSystem(GateAnimationProvider);
        world.addSystem(GateAnimationSystem);
    },
    remove(world) {
        world.removeSystem(GateAnimationSystem);
        world.removeSystem(GateAnimationProvider);
    }
}
