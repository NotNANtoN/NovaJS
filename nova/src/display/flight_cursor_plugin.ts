import * as PIXI from 'pixi.js';
import { Emit, Entities, RunQuery, UUID } from 'nova_ecs/arg_types';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { Query } from 'nova_ecs/query';
import { Resource } from 'nova_ecs/resource';
import { SingletonComponent } from 'nova_ecs/world';
import { System } from 'nova_ecs/system';
import { CloakStateComponent } from '../nova_plugin/cloaking_plugin';
import { GovernmentRelationResource, relation } from '../nova_plugin/govt_relations';
import { DisabledComponent } from '../nova_plugin/death_plugin';
import { GovtComponent } from '../nova_plugin/npc_components';
import {
    PlanetComponent,
    PlanetDataComponent,
    PlanetTargetComponent,
} from '../nova_plugin/planet_plugin';
import { PlayerShipSelector } from '../nova_plugin/player_ship_plugin';
import { ShipComponent } from '../nova_plugin/ship_plugin';
import {
    CLICK_TARGET_SHIP_SOUND_ID, SELECT_STELLAR_SOUND_ID, SoundEvent,
} from '../nova_plugin/sound_event';
import { TargetComponent } from '../nova_plugin/target_component';
import { Space } from './space_resource';
import { Stage } from './stage_resource';
import { StarmapResource } from './starmap_plugin';

export const CURSOR_COLOR_DEFAULT = 0xff2828;   // Authentic EV Nova target red
export const CURSOR_COLOR_PLANET = 0x00c8ff;    // Stellar cyan
export const CURSOR_COLOR_HOSTILE = 0xff1818;   // Vivid hostile red
export const CURSOR_COLOR_NEUTRAL = 0xffea00;   // Amber / yellow
export const CURSOR_COLOR_FRIENDLY = 0x28ff28;  // Friendly green
export const CURSOR_COLOR_DISABLED = 0x888888;  // Disabled gray

export class FlightCursor {
    readonly container: PIXI.Container;
    private readonly reticleGraphics: PIXI.Graphics;
    private readonly centerDot: PIXI.Graphics;
    private currentColor = CURSOR_COLOR_DEFAULT;
    private currentSpread = 1.0;

    constructor() {
        this.container = new PIXI.Container();
        this.container.label = 'FlightCursor';
        this.container.zIndex = 100000;
        this.container.eventMode = 'none';

        this.reticleGraphics = new PIXI.Graphics();
        this.centerDot = new PIXI.Graphics();

        this.container.addChild(this.reticleGraphics);
        this.container.addChild(this.centerDot);

        this.drawReticle(CURSOR_COLOR_DEFAULT, 1.0);
    }

    drawReticle(color: number, spread: number) {
        this.currentColor = color;
        this.currentSpread = spread;
        this.reticleGraphics.clear();
        this.centerDot.clear();

        // Fine center aiming dot with soft glow
        this.centerDot.circle(0, 0, 1.5).fill({ color, alpha: 0.95 });

        // Inner circular reticle with round antialiased stroke
        this.reticleGraphics.circle(0, 0, 8).stroke({ width: 1.2, color, alpha: 0.85, cap: 'round', join: 'round' });

        // 4 radial crosshair ticks with center gap and round caps
        this.reticleGraphics.moveTo(0, -10).lineTo(0, -15).stroke({ width: 1.5, color, alpha: 0.9, cap: 'round', join: 'round' });
        this.reticleGraphics.moveTo(0, 10).lineTo(0, 15).stroke({ width: 1.5, color, alpha: 0.9, cap: 'round', join: 'round' });
        this.reticleGraphics.moveTo(-10, 0).lineTo(-15, 0).stroke({ width: 1.5, color, alpha: 0.9, cap: 'round', join: 'round' });
        this.reticleGraphics.moveTo(10, 0).lineTo(15, 0).stroke({ width: 1.5, color, alpha: 0.9, cap: 'round', join: 'round' });

        // 4 outer corner targeting brackets
        const b = 17 * spread;
        const arm = 5;
        // Top-left
        this.reticleGraphics.moveTo(-b, -b + arm).lineTo(-b, -b).lineTo(-b + arm, -b).stroke({ width: 1.5, color, alpha: 0.85, cap: 'round', join: 'round' });
        // Top-right
        this.reticleGraphics.moveTo(b - arm, -b).lineTo(b, -b).lineTo(b, -b + arm).stroke({ width: 1.5, color, alpha: 0.85, cap: 'round', join: 'round' });
        // Bottom-left
        this.reticleGraphics.moveTo(-b, b - arm).lineTo(-b, b).lineTo(-b + arm, b).stroke({ width: 1.5, color, alpha: 0.85, cap: 'round', join: 'round' });
        // Bottom-right
        this.reticleGraphics.moveTo(b - arm, b).lineTo(b, b).lineTo(b, b - arm).stroke({ width: 1.5, color, alpha: 0.85, cap: 'round', join: 'round' });
    }

    update(hoverColor: number, isHovering: boolean, idleTimeMs: number) {
        if (!this.container || (this.container as any).destroyed) {
            return;
        }
        // Continuous smooth rotation
        this.reticleGraphics.rotation += 0.015;

        // Disappearing animation when mouse is not moving
        const IDLE_DELAY_MS = 1500;
        const FADE_DURATION_MS = 800;

        let targetSpread = isHovering ? 0.85 : 1.0;

        if (idleTimeMs > IDLE_DELAY_MS) {
            const fade = Math.min(1, (idleTimeMs - IDLE_DELAY_MS) / FADE_DURATION_MS);
            // Smooth ease out
            const alpha = Math.max(0, 1 - fade);
            this.container.alpha = alpha;
            // Brackets subtly dissolve outwards as it disappears
            targetSpread = (isHovering ? 0.85 : 1.0) + fade * 0.4;
        } else {
            // Quickly and smoothly fade in when moving
            this.container.alpha = Math.min(1, this.container.alpha + 0.25);
        }

        if (Math.abs(this.currentSpread - targetSpread) > 0.01 || this.currentColor !== hoverColor) {
            const nextSpread = this.currentSpread + (targetSpread - this.currentSpread) * 0.25;
            this.drawReticle(hoverColor, nextSpread);
        }
    }
}

export const FlightCursorResource = new Resource<FlightCursor>('FlightCursorResource');

interface PointerState {
    x: number;
    y: number;
    inWindow: boolean;
    pendingClick: boolean;
    clickX: number;
    clickY: number;
    lastMoveTime: number;
}

const pointerState: PointerState = {
    x: -9999,
    y: -9999,
    inWindow: false,
    pendingClick: false,
    clickX: 0,
    clickY: 0,
    lastMoveTime: Date.now(),
};

let listenersBound = false;

function bindPointerListeners() {
    if (listenersBound || typeof window === 'undefined') return;
    listenersBound = true;

    window.addEventListener('pointermove', e => {
        pointerState.x = e.clientX;
        pointerState.y = e.clientY;
        pointerState.inWindow = true;
        pointerState.lastMoveTime = Date.now();
    });

    window.addEventListener('pointerdown', e => {
        if (e.button === 0) {
            pointerState.pendingClick = true;
            pointerState.clickX = e.clientX;
            pointerState.clickY = e.clientY;
            pointerState.lastMoveTime = Date.now();
        }
    });

    window.addEventListener('pointerleave', () => {
        pointerState.inWindow = false;
    });
}

const ShipsQuery = new Query([
    UUID,
    MovementStateComponent,
    ShipComponent,
    Optional(DisabledComponent),
    Optional(GovtComponent),
    Optional(TargetComponent),
    Optional(CloakStateComponent),
] as const);

const PlanetsQuery = new Query([
    UUID,
    MovementStateComponent,
    PlanetComponent,
    Optional(PlanetDataComponent),
] as const);

const PlayerShipTargetQuery = new Query([
    UUID,
    PlayerShipSelector,
    TargetComponent,
    PlanetTargetComponent,
    MovementStateComponent,
    Optional(GovtComponent),
] as const);

export const FlightCursorSystem = new System({
    name: 'FlightCursorSystem',
    args: [
        SingletonComponent,
        Stage,
        Space,
        FlightCursorResource,
        Entities,
        Emit,
        RunQuery,
        Optional(StarmapResource),
        Optional(GovernmentRelationResource),
    ] as const,
    step(
        _singleton,
        stage,
        space,
        cursor,
        entities,
        emit,
        runQuery,
        starmap,
        govts,
    ) {
        // Check if any fullscreen / modal UI is currently displayed
        const modalOpen = Boolean(
            starmap?.container.visible ||
            stage.getChildByLabel('Spaceport')?.visible ||
            stage.getChildByLabel('StarMap')?.visible ||
            stage.getChildByLabel('PlayerDeathOverlay')?.visible ||
            stage.getChildByLabel('RadialMenu')?.visible
        );

        // Check if cursor or its container has been destroyed or unmounted
        if (!cursor?.container || (cursor.container as any).destroyed || !cursor.container.position) {
            return;
        }

        if (modalOpen || !pointerState.inWindow) {
            cursor.container.visible = false;
            if (typeof document !== 'undefined' && document.body) {
                document.body.style.cursor = '';
            }
            pointerState.pendingClick = false;
            return;
        }

        // Active flight scene: hide OS cursor and show custom reticle
        cursor.container.visible = true;
        if (cursor.container.position) {
            cursor.container.position.set(pointerState.x, pointerState.y);
        }
        if (typeof document !== 'undefined' && document.body) {
            document.body.style.cursor = 'none';
        }

        if (!space || (space as any).destroyed || typeof space.toLocal !== 'function') {
            return;
        }

        // Convert pointer position to space world coordinates
        const worldPos = space.toLocal(new PIXI.Point(pointerState.x, pointerState.y));

        const playerShipMatches = runQuery(PlayerShipTargetQuery);
        const playerShip = playerShipMatches[0];
        const playerUuid = playerShip ? playerShip[0] : undefined;
        const playerTarget = playerShip ? playerShip[2] : undefined;
        const playerPlanetTarget = playerShip ? playerShip[3] : undefined;
        const playerGovt = playerShip ? playerShip[5] : undefined;

        // Hover detection
        let hoveredColor = CURSOR_COLOR_DEFAULT;
        let isHovering = false;

        // 1. Check ship under cursor
        const allShips = runQuery(ShipsQuery);
        let closestShip: (typeof allShips)[number] | undefined;
        let closestShipDistSq = Infinity;

        for (const shipRow of allShips) {
            const [shipUuid, shipMovement, , , , , cloak] = shipRow;
            if (shipUuid === playerUuid) continue;
            if (cloak?.cloaked && cloak.alpha < 0.5) continue;

            const dx = shipMovement.position.x - worldPos.x;
            const dy = shipMovement.position.y - worldPos.y;
            const distSq = dx * dx + dy * dy;
            const hitRadius = 36;
            if (distSq <= hitRadius * hitRadius && distSq < closestShipDistSq) {
                closestShip = shipRow;
                closestShipDistSq = distSq;
            }
        }

        // 2. Check planet under cursor
        const allPlanets = runQuery(PlanetsQuery);
        let closestPlanet: (typeof allPlanets)[number] | undefined;
        let closestPlanetDistSq = Infinity;

        for (const planetRow of allPlanets) {
            const [, planetMovement, , planetData] = planetRow;
            const dx = planetMovement.position.x - worldPos.x;
            const dy = planetMovement.position.y - worldPos.y;
            const distSq = dx * dx + dy * dy;
            const hitRadius = Math.max(45, ((planetData as any)?.size ?? 60) * 0.5);
            if (distSq <= hitRadius * hitRadius && distSq < closestPlanetDistSq) {
                closestPlanet = planetRow;
                closestPlanetDistSq = distSq;
            }
        }

        if (closestShip) {
            isHovering = true;
            const [, , , disabled, targetGovt, targetLock] = closestShip;
            if (disabled) {
                hoveredColor = CURSOR_COLOR_DISABLED;
            } else if (targetLock?.target === playerUuid) {
                hoveredColor = CURSOR_COLOR_HOSTILE;
            } else if (targetGovt && playerGovt && govts) {
                const targetGovtData = govts.getCached(targetGovt.id);
                const playerGovtData = govts.getCached(playerGovt.id);
                if (targetGovtData && playerGovtData) {
                    const rel = relation(playerGovtData, targetGovtData);
                    if (rel === 'enemy') hoveredColor = CURSOR_COLOR_HOSTILE;
                    else if (rel === 'ally') hoveredColor = CURSOR_COLOR_FRIENDLY;
                    else hoveredColor = CURSOR_COLOR_NEUTRAL;
                } else {
                    hoveredColor = CURSOR_COLOR_NEUTRAL;
                }
            } else {
                hoveredColor = CURSOR_COLOR_NEUTRAL;
            }
        } else if (closestPlanet) {
            isHovering = true;
            hoveredColor = CURSOR_COLOR_PLANET;
        }

        const idleElapsedMs = Date.now() - pointerState.lastMoveTime;
        cursor.update(hoveredColor, isHovering, idleElapsedMs);

        // Click-to-target handling
        if (pointerState.pendingClick) {
            pointerState.pendingClick = false;

            const clickWorldPos = space.toLocal(
                new PIXI.Point(pointerState.clickX, pointerState.clickY)
            );

            // 1. Re-evaluate ship under click coordinates
            let clickShip: (typeof allShips)[number] | undefined;
            let clickShipDistSq = Infinity;
            for (const shipRow of allShips) {
                const [shipUuid, shipMovement, , , , , cloak] = shipRow;
                if (shipUuid === playerUuid) continue;
                if (cloak?.cloaked && cloak.alpha < 0.5) continue;

                const dx = shipMovement.position.x - clickWorldPos.x;
                const dy = shipMovement.position.y - clickWorldPos.y;
                const distSq = dx * dx + dy * dy;
                const hitRadius = 38;
                if (distSq <= hitRadius * hitRadius && distSq < clickShipDistSq) {
                    clickShip = shipRow;
                    clickShipDistSq = distSq;
                }
            }

            if (clickShip && playerTarget) {
                playerTarget.target = clickShip[0];
                emit(SoundEvent, { id: CLICK_TARGET_SHIP_SOUND_ID });
                return;
            }

            // 2. If no ship was clicked, check planets
            let clickPlanet: (typeof allPlanets)[number] | undefined;
            let clickPlanetDistSq = Infinity;
            for (const planetRow of allPlanets) {
                const [, planetMovement, , planetData] = planetRow;
                const dx = planetMovement.position.x - clickWorldPos.x;
                const dy = planetMovement.position.y - clickWorldPos.y;
                const distSq = dx * dx + dy * dy;
                const hitRadius = Math.max(45, ((planetData as any)?.size ?? 60) * 0.5);
                if (distSq <= hitRadius * hitRadius && distSq < clickPlanetDistSq) {
                    clickPlanet = planetRow;
                    clickPlanetDistSq = distSq;
                }
            }

            if (clickPlanet && playerPlanetTarget) {
                // Click strictly targets the planet. Only pressing 'L' lands.
                const [planetUuid] = clickPlanet;
                playerPlanetTarget.target = planetUuid;
                emit(SoundEvent, { id: SELECT_STELLAR_SOUND_ID });
            }
        }
    },
});

export const FlightCursorPlugin: Plugin = {
    name: 'FlightCursorPlugin',
    build(world) {
        bindPointerListeners();
        const stage = world.resources.get(Stage);
        if (!stage) {
            throw new Error('Expected Stage resource to exist');
        }

        const cursor = new FlightCursor();
        stage.addChild(cursor.container);
        world.resources.set(FlightCursorResource, cursor);

        world.addSystem(FlightCursorSystem);
    },
    remove(world) {
        world.removeSystem(FlightCursorSystem);
        const cursor = world.resources.get(FlightCursorResource);
        if (cursor) {
            if (!(cursor.container as any).destroyed) {
                cursor.container.destroy({ children: true });
            }
        }
        world.resources.delete(FlightCursorResource);
        if (typeof document !== 'undefined' && document.body) {
            document.body.style.cursor = '';
        }
    },
};
