import { BaseResource } from "./nova_resource_base.js";
import { NovaResources, NovaResourceType } from "./resource_holder_base.js";
import { Resource } from "resource_fork";
import { Reader } from "./reader.js";

/**
 * A spïn (sprite info) resource.
 *
 * Field layout follows ResForge's spïn template (12 bytes, matching Nova's
 * own data exactly), documented in the EVN Bible p. 13. A spïn tells Nova
 * which sprite set to load for a simple graphical object (explosions, cargo,
 * asteroids, stellars, weapon sprites, ...) and how the sprites are arranged
 * in a grid.
 */
class SpinResource extends BaseResource {
    /** rlëD/rle8 (or PICT) resource id of the sprite images. */
    spriteID: number;
    /** PICT resource id of the sprite masks (ignored for rlëD sprites). */
    maskID: number;
    /** [xSize, ySize]: pixel size of each sprite frame. */
    spriteSize: Array<number>;
    /** [xTiles, yTiles]: grid dimensions of the sprite sheet. */
    spriteTiles: Array<number>;
    imageType: NovaResourceType;
    /** Heuristic description of what the sprite is used for, by reserved id. */
    usedFor: string;
    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const r = new Reader(this.data);

        this.spriteID = r.int16();
        this.maskID = r.int16();
        this.spriteSize = [r.int16(), r.int16()];
        this.spriteTiles = [r.int16(), r.int16()];
        this.imageType = NovaResourceType.rlëD; // for now until picts can be used properly

        // What the resource is used for, by reserved sprite id (EVN Bible p. 13).
        this.usedFor = "Unknown";
        if (this.spriteID >= 400 && this.spriteID <= 463) {
            this.usedFor = "Explosion";
        }
        if (this.spriteID == 500) {
            this.usedFor = "Cargo box";
        }
        if (this.spriteID >= 501 && this.spriteID <= 504) {
            this.usedFor = "Mineral";
        }
        if (this.spriteID >= 600 && this.spriteID <= 605) {
            this.usedFor = "Main menu button";
        }
        if (this.spriteID == 606) {
            this.usedFor = "Main screen logo";
        }
        if (this.spriteID == 607) {
            this.usedFor = "Main screen rollover image";
        }
        if (this.spriteID >= 608 && this.spriteID <= 610) {
            this.usedFor = "Main screen sliding button";
        }
        if (this.spriteID == 650) {
            this.usedFor = "Target cursor";
        }
        if (this.spriteID == 700) {
            this.usedFor = "Starfield";
        }
        if (this.spriteID >= 800 && this.spriteID <= 815) {
            this.usedFor = "Asteriod";
        }
        if (this.spriteID >= 1000 && this.spriteID <= 1255) {
            this.usedFor = "Stellar object";
        }
        if (this.spriteID >= 3000 && this.spriteID <= 3255) {
            this.usedFor = "Weapon";
        }

    }
}


export { SpinResource }
