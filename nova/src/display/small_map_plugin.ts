import { Entities, GetEntity, UUID } from "nova_ecs/arg_types";
import { Optional } from "nova_ecs/optional";
import { Plugin } from "nova_ecs/plugin";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { Query } from "nova_ecs/query";
import { Resource } from "nova_ecs/resource";
import { System } from "nova_ecs/system";
import * as PIXI from "pixi.js";
import { EcsControlEvent } from "../nova_plugin/controls_plugin";
import { HiredEscortComponent } from "../nova_plugin/escort_plugin";
import { JumpRouteComponent } from "../nova_plugin/jump_plugin";
import { PlanetDataComponent } from "../nova_plugin/planet_plugin";
import { PlayerShipSelector } from "../nova_plugin/player_ship_plugin";
import { PlayerStateComponent } from "../nova_plugin/player_state";
import { ShipDataComponent } from "../nova_plugin/ship_plugin";
import { TargetComponent } from "../nova_plugin/target_component";
import { createGraphicHandle, ManagedGraphic } from "./managed_graphic";
import { ScreenSize } from "./screen_size_plugin";
import { Stage } from "./stage_resource";

const MAP_SIZE = 240;
const HALF_SIZE = MAP_SIZE / 2;
const MAP_SYSTEM_RADIUS = 10_000;
const MAP_SCALE = (HALF_SIZE - 20) / MAP_SYSTEM_RADIUS;

export class SmallMap {
    readonly container = new PIXI.Container();
    readonly managed: ManagedGraphic = createGraphicHandle(this.container);
    private readonly bgGraphics = new PIXI.Graphics();
    private readonly gridGraphics = new PIXI.Graphics();
    private readonly blipsGraphics = new PIXI.Graphics();
    private readonly labelContainer = new PIXI.Container();
    private readonly titleText: PIXI.Text;
    private labelsPool: PIXI.Text[] = [];

    constructor() {
        this.container.zIndex = 900;
        this.container.visible = false;

        this.titleText = new PIXI.Text({
            text: "SYSTEM TACTICAL GRID (H)",
            style: {
                fontFamily: "Geneva, Monaco, Chicago, Arial, sans-serif",
                fontSize: 9,
                fontWeight: "bold",
                fill: 0x58c0ff,
                align: "center",
            },
        });
        this.titleText.anchor.set(0.5, 0);
        this.titleText.position.set(HALF_SIZE, 8);

        this.container.addChild(this.bgGraphics);
        this.container.addChild(this.gridGraphics);
        this.container.addChild(this.blipsGraphics);
        this.container.addChild(this.labelContainer);
        this.container.addChild(this.titleText);

        this.drawBackground();
    }

    get visible(): boolean {
        return this.container.visible;
    }

    set visible(v: boolean) {
        this.container.visible = v;
    }

    toggle(): void {
        this.visible = !this.visible;
    }

    attachTo(parent: PIXI.Container): void {
        if (!this.managed.disposed && this.container.parent !== parent) {
            parent.addChild(this.container);
        }
    }

    dispose(): void {
        this.managed.dispose();
    }

    private drawBackground(): void {
        this.bgGraphics.clear();
        // Outer dark window panel
        this.bgGraphics
            .roundRect(0, 0, MAP_SIZE, MAP_SIZE, 8)
            .fill({ color: 0x050c18, alpha: 0.85 })
            .stroke({ width: 1.5, color: 0x225588, alpha: 0.9 });

        // Header bar
        this.bgGraphics
            .roundRect(2, 2, MAP_SIZE - 4, 22, 6)
            .fill({ color: 0x0e243d, alpha: 0.9 });

        // Radar grid
        this.gridGraphics.clear();
        const center = HALF_SIZE;
        const cy = HALF_SIZE + 10;
        const r1 = (HALF_SIZE - 25) * 0.35;
        const r2 = (HALF_SIZE - 25) * 0.7;
        const r3 = HALF_SIZE - 25;

        // Concentric distance rings
        this.gridGraphics.circle(center, cy, r1).stroke({ width: 1, color: 0x163e66, alpha: 0.5 });
        this.gridGraphics.circle(center, cy, r2).stroke({ width: 1, color: 0x163e66, alpha: 0.5 });
        this.gridGraphics.circle(center, cy, r3).stroke({ width: 1, color: 0x20558a, alpha: 0.65 });

        // Crosshairs
        this.gridGraphics.moveTo(center - r3, cy).lineTo(center + r3, cy).stroke({ width: 1, color: 0x163e66, alpha: 0.4 });
        this.gridGraphics.moveTo(center, cy - r3).lineTo(center, cy + r3).stroke({ width: 1, color: 0x163e66, alpha: 0.4 });
    }

    private getLabel(index: number): PIXI.Text {
        if (index < this.labelsPool.length) {
            return this.labelsPool[index];
        }
        const label = new PIXI.Text({
            text: "",
            style: {
                fontFamily: "Geneva, Monaco, Arial, sans-serif",
                fontSize: 8,
                fill: 0xa0c8e0,
                align: "center",
            },
        });
        label.anchor.set(0.5, 0);
        this.labelContainer.addChild(label);
        this.labelsPool.push(label);
        return label;
    }

    renderTacticalState(
        playerPos: { x: number; y: number },
        playerRotation: number,
        targetUuid: string | undefined,
        jumpRoute: string[] | undefined,
        ships: Array<{ uuid: string; pos: { x: number; y: number }; isPlayer: boolean; isEscort: boolean; isHostile: boolean }>,
        planets: Array<{ uuid: string; name: string; pos: { x: number; y: number } }>,
    ): void {
        this.blipsGraphics.clear();
        const cx = HALF_SIZE;
        const cy = HALF_SIZE + 10;
        let labelIdx = 0;

        // Draw planets and spobs
        for (const planet of planets) {
            const px = cx + planet.pos.x * MAP_SCALE;
            const py = cy + planet.pos.y * MAP_SCALE;
            if (px < 10 || px > MAP_SIZE - 10 || py < 30 || py > MAP_SIZE - 10) continue;

            const isTarget = planet.uuid === targetUuid;
            // Planet dot
            this.blipsGraphics.circle(px, py, isTarget ? 4 : 3).fill(0x38b0ff);
            if (isTarget) {
                this.blipsGraphics.circle(px, py, 6).stroke({ width: 1, color: 0xffea00 });
            }

            const label = this.getLabel(labelIdx++);
            label.text = planet.name;
            label.position.set(px, py + 4);
            label.visible = true;
        }

        // Hide unused labels
        for (let i = labelIdx; i < this.labelsPool.length; i++) {
            this.labelsPool[i].visible = false;
        }

        // Draw ships
        for (const ship of ships) {
            const sx = cx + ship.pos.x * MAP_SCALE;
            const sy = cy + ship.pos.y * MAP_SCALE;
            if (sx < 6 || sx > MAP_SIZE - 6 || sy < 26 || sy > MAP_SIZE - 6) continue;

            const isTarget = ship.uuid === targetUuid;
            let color = 0x90a4ae;
            let size = 2;

            if (ship.isHostile) {
                color = 0xff3333;
                size = 3;
            } else if (ship.isEscort) {
                color = 0x38ff75;
                size = 2.5;
            } else if (ship.isPlayer) {
                color = 0x00f0ff;
                size = 3;
            }

            this.blipsGraphics.circle(sx, sy, size).fill(color);
            if (isTarget) {
                this.blipsGraphics.rect(sx - 5, sy - 5, 10, 10).stroke({ width: 1, color: 0xffea00 });
            }
        }

        // Draw Player flagship marker
        const pScreenX = cx + playerPos.x * MAP_SCALE;
        const pScreenY = cy + playerPos.y * MAP_SCALE;
        // Directional arrow/chevron pointing along playerRotation
        const forwardX = Math.sin(playerRotation);
        const forwardY = -Math.cos(playerRotation);
        const rightX = Math.cos(playerRotation);
        const rightY = Math.sin(playerRotation);

        const tipX = pScreenX + forwardX * 6;
        const tipY = pScreenY + forwardY * 6;
        const leftX = pScreenX - forwardX * 4 - rightX * 3.5;
        const leftY = pScreenY - forwardY * 4 - rightY * 3.5;
        const rightTailX = pScreenX - forwardX * 4 + rightX * 3.5;
        const rightTailY = pScreenY - forwardY * 4 + rightY * 3.5;

        this.blipsGraphics.poly([tipX, tipY, leftX, leftY, pScreenX, pScreenY, rightTailX, rightTailY]).fill(0xffffff);

        // Draw hyperspace jump vector if destination planned
        if (jumpRoute && jumpRoute.length > 0) {
            this.blipsGraphics.moveTo(pScreenX, pScreenY).lineTo(pScreenX + forwardX * 22, pScreenY + forwardY * 22)
                .stroke({ width: 1.5, color: 0x00e5ff, alpha: 0.8 });
        }
    }
}

export const SmallMapResource = new Resource<SmallMap>("SmallMapResource");

const ShipsQuery = new Query([
    UUID,
    MovementStateComponent,
    ShipDataComponent,
    Optional(TargetComponent),
    Optional(PlayerStateComponent),
    Optional(HiredEscortComponent),
] as const);

const PlanetsQuery = new Query([
    UUID,
    MovementStateComponent,
    PlanetDataComponent,
] as const);

export const SmallMapControlSystem = new System({
    name: "SmallMapControlSystem",
    events: [EcsControlEvent],
    args: [EcsControlEvent, SmallMapResource] as const,
    step(events, smallMap) {
        for (const event of events) {
            if (event.action === "smallMap" && event.state === "start") {
                smallMap.toggle();
            }
        }
    },
});

export const DrawSmallMapSystem = new System({
    name: "DrawSmallMapSystem",
    args: [
        SmallMapResource,
        ScreenSize,
        MovementStateComponent,
        PlayerShipSelector,
        UUID,
        Optional(TargetComponent),
        Optional(JumpRouteComponent),
        ShipsQuery,
        PlanetsQuery,
    ] as const,
    step(smallMap, screenSize, playerMovement, _selector, playerUuid, playerTarget, jumpRoute, ships, planets) {
        if (!smallMap.visible) {
            return;
        }

        // Position in top-right HUD corner
        smallMap.container.position.set(
            screenSize.x / 2 - MAP_SIZE - 20,
            -screenSize.y / 2 + 20,
        );

        const shipEntries: Array<{ uuid: string; pos: { x: number; y: number }; isPlayer: boolean; isEscort: boolean; isHostile: boolean }> = [];
        for (const [uuid, movement, , target, playerState, escort] of ships) {
            if (uuid === playerUuid) continue;
            const isPlayer = Boolean(playerState);
            const isEscort = Boolean(escort && escort.ownerUuid === playerUuid);
            const isHostile = target?.target === playerUuid;
            shipEntries.push({
                uuid,
                pos: { x: movement.position.x, y: movement.position.y },
                isPlayer,
                isEscort,
                isHostile,
            });
        }

        const planetEntries: Array<{ uuid: string; name: string; pos: { x: number; y: number } }> = [];
        for (const [uuid, movement, planetData] of planets) {
            planetEntries.push({
                uuid,
                name: planetData.name,
                pos: { x: movement.position.x, y: movement.position.y },
            });
        }

        smallMap.renderTacticalState(
            playerMovement.position,
            playerMovement.rotation.angle,
            playerTarget?.target,
            jumpRoute?.route,
            shipEntries,
            planetEntries,
        );
    },
});

export const SmallMapPlugin: Plugin = {
    name: "SmallMapPlugin",
    build(world) {
        const stage = world.resources.get(Stage);
        if (!stage) {
            throw new Error("Expected Stage resource to exist");
        }

        const smallMap = new SmallMap();
        smallMap.attachTo(stage);
        world.resources.set(SmallMapResource, smallMap);

        world.addSystem(SmallMapControlSystem);
        world.addSystem(DrawSmallMapSystem);
    },
    remove(world) {
        world.removeSystem(SmallMapControlSystem);
        world.removeSystem(DrawSmallMapSystem);
        const smallMap = world.resources.get(SmallMapResource);
        if (smallMap) {
            smallMap.dispose();
        }
        world.resources.delete(SmallMapResource);
    },
};
