import { Resource } from "nova_ecs/resource";
import * as PIXI from "pixi.js";

export const Space = new Resource<PIXI.Container>('SpaceContainer');

/**
 * The camera's focus in world coordinates (the player ship's position),
 * updated each frame by CenterShipSystem. Entities are drawn at the toroidal
 * copy of their position nearest this focus so objects stay visible across
 * the loop-boundary seam. Display-only; never reflects into the simulation.
 */
export const CameraFocus = new Resource<{ x: number, y: number }>('CameraFocus');
