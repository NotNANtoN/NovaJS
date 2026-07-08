import * as t from 'io-ts';
import { Animation } from "novadatainterface/animation";
import { ExplosionData } from "novadatainterface/explosion_data";
import { Component } from "nova_ecs/component";
import { Plugin } from "nova_ecs/plugin";
import { passthroughType, SerializerResource } from "nova_ecs/plugins/serializer_plugin";
import { Provide } from "nova_ecs/provide";
import { ProjectileDataComponent } from "./projectile_data.js";

export const AnimationComponent = new Component<Animation>('AnimationComponent');

/**
 * Rendering mode for sprites whose frame sequence is a pre-rendered
 * animation (a 3D tumble, a spinning weapon graphic) rather than view
 * rotations. The display advances the frames at `frameRate` on logical
 * (sim) time and applies NO screen-space rotation and NO angle->frame
 * mapping from the entity's sim rotation — composing the sim angle
 * with such a sequence reads as nonsense (see TumbleDrawSystem).
 *
 * Consumers:
 * - Asteroids and their debris (röid SpinRate; 100 = 30 fps).
 * - Future: "always spin" projectiles — wëap Flags 0x0001 "Spin the
 *   weapon's graphic continuously", frame interval in the BeamWidth
 *   field, in 30ths of a second (frameRate = 30 / BeamWidth).
 * - Future: ships with sequenced base frames — shän Flags 0x0008
 *   "Extra frames in base image are shown in sequence", frame interval
 *   in AnimDelay, in 30ths of a second (frameRate = 30 / AnimDelay).
 *   (shän 0x0001 banking and 0x0002 folding are different mechanisms.)
 */
export const TumbleAnimation = t.type({
    /**
     * Sprite frames per second, advanced on logical time. Negative
     * plays the sequence backwards.
     */
    frameRate: t.number,
    /**
     * Initial phase in animation cycles [0, 1); staggers entities that
     * would otherwise tumble in unison.
     */
    phase: t.number,
});
export type TumbleAnimation = t.TypeOf<typeof TumbleAnimation>;
export const TumbleAnimationComponent =
    new Component<TumbleAnimation>('TumbleAnimation');

const animationFactory = (a: { animation: Animation }) => a.animation;

const ProjectileAnimationProvider = Provide({
    name: "ProjectileAnimationProvider",
    provided: AnimationComponent,
    update: [ProjectileDataComponent],
    args: [ProjectileDataComponent],
    factory: animationFactory,
});

export const ExplosionDataComponent
    = new Component<ExplosionData>('ExplosionData');

const ExplosionAnimationProvider = Provide({
    name: "ExplosionAnimationProvider",
    provided: AnimationComponent,
    update: [ExplosionDataComponent],
    args: [ExplosionDataComponent],
    factory: animationFactory,
});

export const AnimationPlugin: Plugin = {
    name: 'AnimationPlugin',
    build(world) {
        world.addComponent(AnimationComponent);
        world.addComponent(ExplosionDataComponent);
        world.addComponent(TumbleAnimationComponent);
        world.resources.get(SerializerResource)?.addComponent(
            AnimationComponent, passthroughType<Animation>('AnimationComponentType'));
        world.resources.get(SerializerResource)?.addComponent(
            ExplosionDataComponent, passthroughType<ExplosionData>('ExplosionDataComponentType'));
        world.resources.get(SerializerResource)?.addComponent(
            TumbleAnimationComponent, TumbleAnimation);

        world.addSystem(ProjectileAnimationProvider);
        world.addSystem(ExplosionAnimationProvider);
    }
}
