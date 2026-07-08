import { SystemData } from "novadatainterface/system_data";
import * as PIXI from 'pixi.js';
import { Observable } from "rxjs";
import { DisplayAssetDataInterface } from "../client/gamedata/display_asset_data.js";
import { SimulationGameDataInterface } from "../client/gamedata/simulation_game_data.js";
import { ControlEvent } from "../nova_plugin/controls_plugin.js";
import { Button } from "./button.js";
import { Menu } from "./menu.js";
import { MenuControls } from "./menu_controls.js";


const GREY = 0x666666;
const BLUE = 0x0000BB;
const SYSTEM_TEXT = new PIXI.TextStyle({
    fontFamily: 'Geneva',
    fontSize: 10,
    align: 'left',
    fill: 0xffffff,
});

// The scale at which system positions are laid out. Zoom is applied on top of
// this as a transform on the map container, so systems are only drawn once.
const BASE_SCALE = 2;
// How far the view can be zoomed relative to BASE_SCALE.
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.15;
// How far the arrow keys pan per press, in screen pixels.
const KEY_PAN_STEP = 40;

function drawSystem(system: SystemData, graphics: PIXI.Graphics) {
    // Use blue if the system has a planet. Otherwise, grey.
    // TODO: Check if the planet is inhabited.
    const inhabited = system.planets.length > 0;
    const outColor = inhabited ? BLUE : GREY;
    const inColor = inhabited ? 0x000044 : 0x000000;
    graphics.lineStyle(1, outColor);
    graphics.beginFill(outColor)
    graphics.drawCircle(0, 0, 2.7 * BASE_SCALE);
    graphics.beginFill(inColor);
    graphics.drawCircle(0, 0, 1.8 * BASE_SCALE);
    graphics.endFill();
}

class SystemGraph {
    readonly container = new PIXI.Container();
    // Links and the highlighted route live on separate graphics so that
    // selecting a route only redraws the route, not the whole galaxy.
    private readonly linkGraphics: PIXI.Graphics;
    private readonly routeGraphics: PIXI.Graphics;
    private readonly links: [SystemData, SystemData][];
    private readonly systems: Map<string, SystemData>;
    // Zoom is a transform applied on top of BASE_SCALE. Panning and zooming
    // never redraw the systems; they only move/scale mapContainer.
    private zoom = 1;
    private dragData?: {
        pointerId: number,
        // Pointer position (screen space) at the previous move event.
        last: PIXI.Point,
    }
    // Whether the most recent pointer gesture moved the map, so a system's tap
    // handler can tell a click apart from the end of a pan.
    private draggedSinceDown = false;
    private wrappedRoute: string[] = [];
    private routes: Map<string, string[]>;
    private systemCircles: Map<string, [PIXI.Container, PIXI.Graphics]>;
    private mapContainer: PIXI.Container;
    private maskedContainer: PIXI.Container;
    // Bounding box of all systems in laid-out (BASE_SCALE) coordinates.
    private worldBounds: { minX: number, minY: number, maxX: number, maxY: number };

    constructor(systems: SystemData[], private currentSystem: string,
        private size = { x: 456, y: 419 }) {
        this.systems = new Map(systems.map(s => [s.id, s]));
        this.routes = this.computeShortestPaths();

        this.linkGraphics = new PIXI.Graphics();
        this.routeGraphics = new PIXI.Graphics();

        this.mapContainer = new PIXI.Container();
        this.mapContainer.addChild(this.linkGraphics);
        this.mapContainer.addChild(this.routeGraphics);

        this.maskedContainer = new PIXI.Container();
        const mask = new PIXI.Graphics();
        mask.beginFill(0xff0000);
        mask.drawRect(0, 0, size.x, size.y);
        mask.endFill();
        this.maskedContainer.mask = mask;
        this.container.addChild(mask);

        this.maskedContainer.addChild(this.mapContainer);
        this.container.addChild(this.maskedContainer);

        // Capture pointer and wheel events over the whole map area (including
        // the gaps between systems) so panning and zooming work anywhere.
        this.container.eventMode = 'static';
        this.container.hitArea = new PIXI.Rectangle(0, 0, size.x, size.y);
        const onDragStart = this.onDragStart.bind(this);
        const onDragMove = this.onDragMove.bind(this);
        const onDragEnd = this.onDragEnd.bind(this);
        this.container
            .on('pointerdown', onDragStart)
            .on('pointerup', onDragEnd)
            .on('pointerupoutside', onDragEnd)
            .on('pointermove', onDragMove)
            .on('wheel', this.onWheel.bind(this));

        this.links = [...this.getUniqueLinks()];

        this.systemCircles = new Map(systems.map(s => {
            const graphics = new PIXI.Graphics();
            drawSystem(s, graphics);
            const container = new PIXI.Container();
            const circleContainer = new PIXI.Container();
            container.addChild(circleContainer);
            circleContainer.eventMode = 'static';
            circleContainer.cursor = 'pointer';
            circleContainer.on('pointertap', () => {
                // Ignore taps that were actually the end of a drag.
                if (!this.draggedSinceDown) {
                    this.onClickSystem(s.id);
                }
            });
            circleContainer.addChild(graphics);

            const nameText = new PIXI.Text(s.name, SYSTEM_TEXT);
            nameText.position.x = 10;
            nameText.anchor.y = 0.5;
            container.addChild(nameText);

            container.position.set(...this.scalePos(s.position));
            this.mapContainer.addChild(container);
            return [s.id, [container, graphics]]
        }));

        this.worldBounds = this.computeWorldBounds();

        this.drawLinks();
        this.drawRoute();
        this.applyZoom();
    }

    /** Centers the current system in the viewport at the current zoom. */
    center() {
        const system = this.systems.get(this.currentSystem);
        if (system) {
            const pos = this.scalePos(system.position);
            this.mapContainer.position.set(
                this.size.x / 2 - pos[0] * this.zoom,
                this.size.y / 2 - pos[1] * this.zoom,
            );
            this.clampPosition();
        }
    }

    set route(route: string[]) {
        this.wrappedRoute = route;
        this.drawRoute();
    }

    get route() {
        return this.wrappedRoute;
    }

    /** Pans the map by a screen-space delta (used by the arrow keys). */
    pan(dx: number, dy: number) {
        this.mapContainer.position.x += dx;
        this.mapContainer.position.y += dy;
        this.clampPosition();
    }

    /**
     * Zooms by `factor`, keeping the point at (centerX, centerY) in the
     * viewport fixed. If no center is given, zooms around the viewport center.
     */
    zoomBy(factor: number, centerX = this.size.x / 2, centerY = this.size.y / 2) {
        const oldZoom = this.zoom;
        const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldZoom * factor));
        if (newZoom === oldZoom) {
            return;
        }
        // Keep the world point under (centerX, centerY) stationary on screen.
        const pos = this.mapContainer.position;
        const worldX = (centerX - pos.x) / oldZoom;
        const worldY = (centerY - pos.y) / oldZoom;
        this.zoom = newZoom;
        pos.set(centerX - worldX * newZoom, centerY - worldY * newZoom);
        this.applyZoom();
    }

    private applyZoom() {
        this.mapContainer.scale.set(this.zoom);
        this.clampPosition();
    }

    /**
     * Keeps the map from being panned entirely out of view. The galaxy is
     * allowed to move until only a margin of it remains inside the viewport.
     */
    private clampPosition() {
        const b = this.worldBounds;
        const margin = 40;
        const pos = this.mapContainer.position;
        // Screen-space extent of the galaxy at the current zoom.
        const left = b.minX * this.zoom;
        const right = b.maxX * this.zoom;
        const top = b.minY * this.zoom;
        const bottom = b.maxY * this.zoom;

        // Clamp so at least `margin` px of the galaxy stays on each edge.
        const minPosX = margin - right;
        const maxPosX = this.size.x - margin - left;
        const minPosY = margin - bottom;
        const maxPosY = this.size.y - margin - top;
        pos.x = Math.min(maxPosX, Math.max(minPosX, pos.x));
        pos.y = Math.min(maxPosY, Math.max(minPosY, pos.y));
    }

    private onDragStart(event: PIXI.FederatedPointerEvent) {
        this.draggedSinceDown = false;
        this.dragData = {
            pointerId: event.pointerId,
            last: event.global.clone(),
        };
    }

    private onDragMove(event: PIXI.FederatedPointerEvent) {
        if (!this.dragData || event.pointerId !== this.dragData.pointerId) {
            return;
        }
        const dx = event.global.x - this.dragData.last.x;
        const dy = event.global.y - this.dragData.last.y;
        if (dx !== 0 || dy !== 0) {
            this.draggedSinceDown = true;
        }
        this.dragData.last.copyFrom(event.global);
        this.pan(dx, dy);
    }

    private onDragEnd(event: PIXI.FederatedPointerEvent) {
        if (this.dragData && event.pointerId !== this.dragData.pointerId) {
            return;
        }
        this.dragData = undefined;
        // `draggedSinceDown` is intentionally left set until the next
        // pointerdown so the system tap handler (which fires right after
        // pointerup) can tell a click apart from a drag.
    }

    private onWheel(event: PIXI.FederatedWheelEvent) {
        const local = event.getLocalPosition(this.container);
        const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        this.zoomBy(factor, local.x, local.y);
    }

    private onClickSystem(system: string) {
        this.route = this.routes.get(system) ?? [];
    }

    private getUniqueLinks() {
        const linksMap = new Map<string, [SystemData, SystemData]>();
        for (const [source, sourceSystem] of this.systems) {
            for (const dest of sourceSystem.links) {
                const linkEntry = [source, dest].sort().join('<->');
                if (this.systems.has(dest)) {
                    linksMap.set(linkEntry, [sourceSystem, this.systems.get(dest)!]);
                }
            }
        }
        return linksMap.values();
    }

    private computeWorldBounds() {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const system of this.systems.values()) {
            const [x, y] = this.scalePos(system.position);
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
        if (!Number.isFinite(minX)) {
            minX = minY = maxX = maxY = 0;
        }
        return { minX, minY, maxX, maxY };
    }

    private scalePos(pos: [number, number]): [number, number] {
        return pos.map(p => p * BASE_SCALE) as [number, number];
    }

    private drawLinks() {
        this.linkGraphics.clear();
        for (const [source, dest] of this.links) {
            this.drawLink(this.linkGraphics, source, dest);
        }
    }

    private drawRoute() {
        this.routeGraphics.clear();
        let prev = this.systems.get(this.currentSystem);
        for (const system of this.route.map(id => this.systems.get(id))) {
            if (system) {
                if (prev) {
                    this.drawLink(this.routeGraphics, prev, system, 0x00ff00, 3);
                }
                prev = system;
            }
        }
    }

    private drawLink(graphics: PIXI.Graphics, a: SystemData, b: SystemData,
        color = GREY, thickness = 1) {
        graphics.lineStyle(thickness, color);
        graphics.moveTo(...this.scalePos(a.position));
        graphics.lineTo(...this.scalePos(b.position));
    }

    private computeShortestPaths() {
        // Dijkstra's
        let frontier = new Set<string>([this.currentSystem]);
        const paths = new Map<string, string[]>([[this.currentSystem, []]]);

        while (true) {
            const newFrontier = new Set<string>();
            for (const id of frontier) {
                const system = this.systems.get(id);
                if (!system) {
                    continue;
                }

                const path = paths.get(id);
                if (!path) {
                    throw new Error(`Path to ${id} should exist`);
                }

                for (const link of system.links) {
                    if (paths.has(link)) {
                        continue;
                    }
                    newFrontier.add(link);
                    paths.set(link, [...path, link]);
                }
            }
            if (newFrontier.size === 0) {
                break;
            }
            frontier = newFrontier;
        }
        return paths;
    }
}

export class Starmap extends Menu<string[] /* route list of systems */> {
    private systemGraph?: SystemGraph;

    constructor(displayAssets: DisplayAssetDataInterface,
        simulationData: SimulationGameDataInterface,
        private systemId: string, controlEvents: Observable<ControlEvent>) {
        super(displayAssets, simulationData, "nova:8509", controlEvents);
        this.container.name = "StarMap";
        //this.container.alpha = 0.5;
        const buttons = {
            done: new Button(displayAssets, "Done", 120, { x: 150, y: 220 }),
        };
        this.addButtons(buttons);

        buttons.done.click.subscribe(this.done.bind(this));

        this.controls = new MenuControls(controlEvents, {
            // TODO: Bind tab to cycle destinations
            depart: this.done.bind(this),
            map: this.done.bind(this),
            // Arrow keys pan the map.
            up: () => this.systemGraph?.pan(0, KEY_PAN_STEP),
            down: () => this.systemGraph?.pan(0, -KEY_PAN_STEP),
            left: () => this.systemGraph?.pan(KEY_PAN_STEP, 0),
            right: () => this.systemGraph?.pan(-KEY_PAN_STEP, 0),
        });

    }
    override async build() {
        await super.build();
        const systemIds = (await this.simulationData.ids).System;
        const systems = await Promise.all(
            systemIds.map(s => this.simulationData.data.System.get(s)));
        this.systemGraph = new SystemGraph(systems, this.systemId);
        this.systemGraph.container.position.set(-290, -248);
        this.container.addChild(this.systemGraph.container);
    }

    override async show(route: string[]) {
        await this.buildPromise
        if (!this.systemGraph) {
            throw new Error('Expected system graph to be built')
        }
        this.systemGraph.center();
        this.systemGraph.route = route;
        return super.show(route);
    }

    override done() {
        if (this.systemGraph) {
            this.input = this.systemGraph.route;
        }
        super.done();
    }
}
