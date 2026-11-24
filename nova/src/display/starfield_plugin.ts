import { Vector } from "nova_ecs/datatypes/vector";
import { Plugin } from "nova_ecs/plugin";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { Resource } from "nova_ecs/resource";
import { System } from "nova_ecs/system";
import { SingletonComponent } from "nova_ecs/world";
import * as PIXI from "pixi.js";
import { alea } from 'seedrandom';
import { GameDataResource } from "../nova_plugin/game_data_resource";
import { PlayerShipSelector } from "../nova_plugin/player_ship_plugin";
import { ResizeEvent } from "./screen_size_plugin";
import { Stage } from "./stage_resource";
import { texturesFromFrames } from "./textures_from_frames";
import { createGraphicHandle, ManagedGraphic } from './managed_graphic';

const STAR_ID = "nova:700";

interface StarfieldArgs {
    textures: PIXI.Texture[];
    density: number;
    positionFactorRange: [number, number];
    seed?: string;
}

interface PositionedStar {
    x: number;
    y: number;
}

/**
 * Toroidal GPU-batched starfield.
 *
 * Instead of allocating thousands of sprites across the full system boundary
 * and querying an RBush every frame, we allocate only the on-screen star count
 * and wrap each star toroidally in screen space using flat typed arrays.
 * When all star textures share a single atlas source (the standard spritesheet
 * case), stars render in a single PIXI.ParticleContainer draw call.
 */
class Starfield {
    private readonly textures: PIXI.Texture[];
    private readonly density: number;
    private readonly positionFactorRange: [number, number];
    private readonly seed: string;
    private readonly fudge: number;
    private readonly useParticleContainer: boolean;

    readonly container = new PIXI.Container();
    readonly managed: ManagedGraphic = createGraphicHandle(this.container);
    private layer?: PIXI.ParticleContainer | PIXI.Container;

    private screen = { width: 100, height: 100 };
    private baseX = new Float32Array(0);
    private baseY = new Float32Array(0);
    private parallax = new Float32Array(0);
    private items: PositionedStar[] = [];
    private lastShipX = 0;
    private lastShipY = 0;

    constructor({ textures, density, positionFactorRange, seed }: StarfieldArgs) {
        this.textures = textures;
        this.density = density;
        this.positionFactorRange = positionFactorRange;
        this.seed = seed ?? 'stars';
        this.container.label = 'Starfield';

        this.fudge = textures.length > 0
            ? Math.max(...textures.map(t => Math.max(t.width, t.height))) + 1
            : 4;

        const firstSource = textures[0]?.source;
        this.useParticleContainer = Boolean(
            firstSource
            && typeof PIXI.ParticleContainer === 'function'
            && typeof PIXI.Particle === 'function'
            && textures.every(t => t.source === firstSource)
        );
    }

    private rebuildStars() {
        if (this.layer) {
            this.container.removeChild(this.layer);
            this.layer.destroy({ children: !this.useParticleContainer });
            this.layer = undefined;
        }
        this.items = [];

        const spanX = Math.max(1, this.screen.width);
        const spanY = Math.max(1, this.screen.height);
        // Match the original visible density: with factor in [0, 0.5],
        // E[1 / (1 - factor)^2] = 2.0 relative to raw density * viewport area.
        const [minF, maxF] = this.positionFactorRange;
        const expectedDensityScale = minF < 1 && maxF < 1
            ? 1 / ((1 - minF) * (1 - maxF))
            : 1;
        const count = this.textures.length > 0
            ? Math.max(1, Math.min(600, Math.round(
                this.density * expectedDensityScale * spanX * spanY)))
            : 0;

        this.baseX = new Float32Array(count);
        this.baseY = new Float32Array(count);
        this.parallax = new Float32Array(count);

        const rng = alea(this.seed);
        if (this.useParticleContainer && count > 0) {
            const pc = new PIXI.ParticleContainer({
                texture: this.textures[0],
                dynamicProperties: {
                    position: true,
                    scale: false,
                    rotation: false,
                    color: false,
                },
            });
            pc.label = 'StarfieldParticles';
            for (let i = 0; i < count; i++) {
                const texture = this.textures[Math.floor(rng() * this.textures.length)];
                const factor = minF + rng() * (maxF - minF);
                this.baseX[i] = rng() * spanX;
                this.baseY[i] = rng() * spanY;
                this.parallax[i] = 1 - factor;
                const particle = new PIXI.Particle({ texture });
                pc.addParticle(particle);
                this.items.push(particle);
            }
            this.layer = pc;
            this.container.addChild(pc);
        } else if (count > 0) {
            const group = new PIXI.Container();
            group.label = 'StarfieldSprites';
            for (let i = 0; i < count; i++) {
                const texture = this.textures[Math.floor(rng() * this.textures.length)];
                const factor = minF + rng() * (maxF - minF);
                this.baseX[i] = rng() * spanX;
                this.baseY[i] = rng() * spanY;
                this.parallax[i] = 1 - factor;
                const sprite = new PIXI.Sprite(texture);
                group.addChild(sprite);
                this.items.push(sprite);
            }
            this.layer = group;
            this.container.addChild(group);
        }

        this.updatePositions(this.lastShipX, this.lastShipY);
    }

    private updatePositions(sx: number, sy: number) {
        const spanX = this.screen.width;
        const spanY = this.screen.height;
        const halfW = spanX * 0.5;
        const halfH = spanY * 0.5;
        const baseX = this.baseX;
        const baseY = this.baseY;
        const parallax = this.parallax;
        const items = this.items;
        const count = items.length;

        for (let i = 0; i < count; i++) {
            const p = parallax[i];
            let x = (baseX[i] - sx * p) % spanX;
            if (x < 0) x += spanX;
            let y = (baseY[i] - sy * p) % spanY;
            if (y < 0) y += spanY;
            const item = items[i];
            item.x = x - halfW;
            item.y = y - halfH;
        }
    }

    draw(shipPos: Vector) {
        this.lastShipX = shipPos.x;
        this.lastShipY = shipPos.y;
        this.updatePositions(shipPos.x, shipPos.y);
    }

    resize(width: number, height: number) {
        this.screen.width = width + this.fudge * 2;
        this.screen.height = height + this.fudge * 2;
        this.container.position.x = this.screen.width / 2 - this.fudge;
        this.container.position.y = this.screen.height / 2 - this.fudge;
        this.rebuildStars();
    }
}

const StarfieldResource = new Resource<Starfield>('Starfield');

export function starfield({ density = 0.00002,
    positionFactorRange = [0, 0.5] as [number, number] } = {}): Plugin {

    const StarfieldSystem = new System({
        name: 'StarfieldSystem',
        args: [MovementStateComponent, StarfieldResource,
            PlayerShipSelector] as const,
        step(movementState, starfield) {
            starfield.draw(movementState.position);
        }
    });

    const StarfieldResize = new System({
        name: 'StarfieldResize',
        events: [ResizeEvent],
        args: [StarfieldResource, ResizeEvent, SingletonComponent] as const,
        step(starfield, { x, y }) {
            starfield.resize(x, y);
        }
    });

    return {
        name: 'Starfield',
        async build(world) {
            const gameData = world.resources.get(GameDataResource);
            if (!gameData) {
                throw new Error('Expected GameData resource to exist');
            }
            const stage = world.resources.get(Stage);
            if (!stage) {
                throw new Error('Expected Stage resource to exist');
            }

            const framesData = await gameData.data.SpriteSheetFrames.get(STAR_ID);
            const textures = await texturesFromFrames(framesData);
            const starfield = new Starfield({
                textures,
                density,
                positionFactorRange,
                seed: world.name,
            });

            starfield.resize(window.innerWidth, window.innerHeight);
            stage.addChildAt(starfield.container, 0);
            world.resources.set(StarfieldResource, starfield);
            world.addSystem(StarfieldResize);
            world.addSystem(StarfieldSystem);
        },
        remove(world) {
            world.removeSystem(StarfieldResize);
            world.removeSystem(StarfieldSystem);

            const starfield = world.resources.get(StarfieldResource);
            if (starfield) {
                starfield.managed.dispose();
            }
            world.resources.delete(StarfieldResource);
        }
    };
}
