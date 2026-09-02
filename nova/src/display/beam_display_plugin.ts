import { Plugin } from 'nova_ecs/plugin';
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { SingletonComponent } from "nova_ecs/world";
import * as PIXI from "pixi.js";
import {
    BeamClippingSystem,
    BeamDataComponent,
    BeamStateComponent,
    BeamSystem,
} from "../nova_plugin/beam_plugin";
import { Optional } from "nova_ecs/optional";
import { Space } from "./space_resource";
import { attachGraphic, ManagedGraphic } from './managed_graphic';


const BeamGraphicsResource = new Resource<ManagedGraphic>('BeamGraphics');

const ClearBeams = new System({
    name: 'ClearBeams',
    args: [BeamGraphicsResource, SingletonComponent] as const,
    step(beamHandle) {
        (beamHandle.root as PIXI.Graphics).clear();
    }
});

const BeamDisplaySystem = new System({
    name: 'BeamDisplay',
    args: [BeamDataComponent, Optional(BeamStateComponent), MovementStateComponent,
        BeamGraphicsResource, /*UUID*/] as const,
    step(beamData, beamState, movement, beamHandle, /*uuid*/) {
        const beamGraphics = beamHandle.root as PIXI.Graphics;
        const { width, beamColor, coronaColor, coronaFalloff, length, lightningAmplitude, lightningDensity }
            = beamData.beamAnimation;
        const effectiveLength = Math.max(0, Math.min(
            length, beamState?.length ?? length));
        const destination = movement.rotation.getUnitVector()
            .scale(effectiveLength).add(movement.position);
        //const rng = seedrandom.alea(uuid);  //for if not randomized every frame
        const rng = Math.random;
        const lightningAmplitudeScale = 2;
        if (lightningDensity > 0) {
            beamGraphics.moveTo(movement.position.x, movement.position.y);
            const direction = destination.subtract(movement.position);
            for (let i = 1; i <= lightningDensity; i++) {
                const center = movement.position.add(direction.scale(i / (lightningDensity + 2)));
                const offset = {
                    x: (rng() * 2 - 1) * lightningAmplitude * lightningAmplitudeScale,
                    y: (rng() * 2 - 1) * lightningAmplitude * lightningAmplitudeScale
                };
                const point = center.add(offset);
                beamGraphics.lineTo(point.x, point.y);
            }
            beamGraphics.lineTo(destination.x, destination.y);
            beamGraphics.stroke({ width, color: beamColor });
        } else {
            const coronaScale = 2 * 16;
            const coronaWidth = coronaScale / coronaFalloff;
            const coronaSteps = coronaWidth / 2;
            if (coronaFalloff >= 2) {
                for (let i = 0; i < coronaSteps; i++) {
                    beamGraphics.moveTo(movement.position.x, movement.position.y);
                    beamGraphics.lineTo(destination.x, destination.y);
                    beamGraphics.stroke({
                        width: width + 2 + i * coronaWidth / coronaSteps,
                        color: coronaColor,
                        alpha: 1 / coronaSteps,
                    });
                }
            } else {
                beamGraphics.moveTo(movement.position.x, movement.position.y);
                beamGraphics.lineTo(destination.x, destination.y);
                beamGraphics.stroke({ width: width + 2, color: coronaColor });
            }
            beamGraphics.moveTo(movement.position.x, movement.position.y);
            beamGraphics.lineTo(destination.x, destination.y);
            beamGraphics.stroke({ width, color: beamColor });
        }
    },
    after: [ClearBeams, BeamSystem, BeamClippingSystem],
    before: []
});


export const BeamDisplayPlugin: Plugin = {
    name: 'BeamDisplayPlugin',
    build(world) {
        const space = world.resources.get(Space);
        if (!space) {
            throw new Error('Expected space resource');
        }
        const beamGraphics = new PIXI.Graphics();
        beamGraphics.name = 'BeamGraphics';
        world.resources.set(BeamGraphicsResource, attachGraphic(space, beamGraphics));
        world.addSystem(ClearBeams);
        world.addSystem(BeamDisplaySystem);
    },
    remove(world) {
        const space = world.resources.get(Space);
        world.resources.get(BeamGraphicsResource)?.dispose();
        world.removeSystem(BeamDisplaySystem);
        world.removeSystem(ClearBeams);
        world.resources.delete(BeamGraphicsResource);
    }
}
