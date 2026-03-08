import { Animation } from "novadatainterface/animation";
import { ExplosionData } from "novadatainterface/explosion_data";
import { Component } from "nova_ecs/component";
import { Plugin } from "nova_ecs/plugin";
import { Provide } from "nova_ecs/provide";
import { ProjectileDataComponent } from "./projectile_data.js";

export const AnimationComponent = new Component<Animation>('AnimationComponent');

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

        world.addSystem(ProjectileAnimationProvider);
        world.addSystem(ExplosionAnimationProvider);
    }
}
