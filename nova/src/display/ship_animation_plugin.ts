import { Plugin } from "nova_ecs/plugin";
import { Optional } from "nova_ecs/optional";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { System } from "nova_ecs/system";
import { GameDataResource } from "../nova_plugin/game_data_resource";
import { IonizationColorComponent, ShieldComponent } from "../nova_plugin/health_plugin";
import { IsIonizedComponent } from "../nova_plugin/ionization_plugin";
import { ShipComponent } from "../nova_plugin/ship_plugin";
import { WeaponsStateComponent } from "../nova_plugin/weapons_state";
import { AnimationGraphicComponent, ObjectDrawSystem } from "./animation_graphic_plugin";


const ENGINE_GLOW_HOLD_MS = 350;
const ENGINE_GLOW_FADE_MS = 250;
const engineGlow = new WeakMap<object, { lastThrustAt: number }>();

export const ShipAnimationSystem = new System({
    name: "ShipAnimationSystem",
    // ObjectDrawSystem writes a raw glow alpha each frame; this system owns
    // the ship engine glow and must have the final word.
    after: [ObjectDrawSystem],
    args: [
        ShipComponent,
        WeaponsStateComponent,
        GameDataResource,
        AnimationGraphicComponent,
        TimeResource,
        IsIonizedComponent,
        IonizationColorComponent,
        Optional(MovementStateComponent),
        Optional(ShieldComponent),
    ] as const,
    step(ship, weaponStates, gameData, animation, time, ionized, ionizationColor, movement, shieldStat) {
        // Shield flash animation on taking damage
        const shield = animation.sprites.get('shieldImage');
        if (shield) {
            shield.pixiSprite.blendMode = 'add';
            if (shieldStat) {
                const prev = (shieldStat as any)._prevAnimShield ?? shieldStat.current;
                (shieldStat as any)._prevAnimShield = shieldStat.current;
                if (shieldStat.current < prev && shieldStat.current > 0) {
                    (shieldStat as any)._flashUntil = time.time + 160;
                }
                const flashUntil = (shieldStat as any)._flashUntil ?? 0;
                if (time.time < flashUntil) {
                    shield.pixiSprite.visible = true;
                    shield.pixiSprite.alpha = Math.max(0, Math.min(1, (flashUntil - time.time) / 160));
                } else {
                    shield.pixiSprite.visible = false;
                }
            } else {
                shield.pixiSprite.visible = false;
            }
        }

        // Engine glow while accelerating. AI pilots feather the throttle
        // (short on/off pulses while matching a target), and remote ships only
        // report thrust at snapshot rate, so the glow is held briefly after the
        // last thrust and faded rather than strobing on and off.
        const glow = animation.sprites.get('glowImage');
        if (glow) {
            glow.pixiSprite.blendMode = 'add';
            const state = engineGlow.get(animation) ?? { lastThrustAt: -Infinity };
            engineGlow.set(animation, state);
            if (movement && movement.accelerating > 0) {
                state.lastThrustAt = time.time;
            }
            const sinceThrust = time.time - state.lastThrustAt;
            if (sinceThrust <= ENGINE_GLOW_HOLD_MS + ENGINE_GLOW_FADE_MS) {
                const fade = sinceThrust <= ENGINE_GLOW_HOLD_MS ? 1
                    : 1 - (sinceThrust - ENGINE_GLOW_HOLD_MS) / ENGINE_GLOW_FADE_MS;
                glow.pixiSprite.visible = true;
                // Subtle engine exhaust flicker
                glow.pixiSprite.alpha = fade
                    * (0.85 + Math.sin(time.time * 0.04) * 0.15);
            } else {
                glow.pixiSprite.visible = false;
            }
        }

        // Show the ship's weapon image iff a weapon is firing.
        const weaponImage = animation.sprites.get('weapImage');
        if (weaponImage) {
            weaponImage.pixiSprite.visible = false;
            for (const [id, weaponState] of weaponStates) {
                if (weaponState.firing && gameData.data.Weapon.getCached(id)?.useFiringAnimation) {
                    weaponImage.pixiSprite.visible = true;
                    break;
                }
            }
        }

        // Blink running lights every two seconds.
        const runningLights = animation.sprites.get('lightImage');
        if (runningLights) {
            runningLights.pixiSprite.visible = time.time % 2000 < 1000;
        }

        const sprite =animation.sprites.get('baseImage')?.pixiSprite;
        if (sprite) {
            if (ionized) {
                sprite.tint = (ionizationColor.color ?? 0x888888) & 0xffffff;
            } else {
                sprite.tint = 0xffffff;
            }
        }
    },
});

export const ShipAnimationPlugin: Plugin = {
    name: "ShipAnimationPlugin",
    build(world) {
        world.addSystem(ShipAnimationSystem);
    }
}
