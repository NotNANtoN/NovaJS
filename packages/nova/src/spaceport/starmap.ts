import { SystemData } from "novadatainterface/system_data";
import * as PIXI from 'pixi.js';
import { Observable } from "rxjs";
import { DisplayAssetDataInterface } from "../client/gamedata/display_asset_data.js";
import { SimulationGameDataInterface } from "../client/gamedata/simulation_game_data.js";
import { ControlEvent } from "../nova_plugin/controls_plugin.js";
import { evaluateNCBTest } from "../nova_plugin/ncb.js";
import { Button } from "./button.js";
import { Menu } from "./menu.js";
import { MenuControls } from "./menu_controls.js";


const GREY = 0x666666;
const BLUE = 0x0000BB;
// Hypergate network links, drawn in a distinct cyan so the instant-travel
// hypergate routes read apart from the grey normal-jump hyperspace links.
const HYPERGATE_LINK_COLOR = 0x00cccc;
const LABEL_FONT_NAME = 'StarmapSystemLabel';
const LABEL_FONT_SIZE = 10;

// The scale at which system positions are laid out. Zoom is applied on top of
// this as a transform on the map container, so systems are only drawn once.
const BASE_SCALE = 2;
// How far the view can be zoomed relative to BASE_SCALE.
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.15;
// How far the arrow keys pan per press, in screen pixels.
const KEY_PAN_STEP = 40;
// Radius of a system's outer circle in laid-out coordinates.
const SYSTEM_RADIUS = 2.7 * BASE_SCALE;
// How close (in screen pixels) a click must be to a system to select it.
const CLICK_RADIUS = 12;

// Rendering every system name as its own PIXI.Text gives each label a
// distinct texture, which overwhelms the renderer's texture batching (the map
// dropped to ~4 FPS with 631 labels). A shared bitmap font lets all labels
// batch into a single draw call, and generating the glyph atlas once up front
// avoids the multi-hundred-ms rasterization hitch (which stalled the main
// thread long enough to desync the simulation) the first time the map
// rendered.
function installLabelFont(systems: SystemData[]) {
    const chars = new Set<string>([' ']);
    for (const system of systems) {
        for (const char of system.name) {
            chars.add(char);
        }
    }
    if (PIXI.BitmapFont.available[LABEL_FONT_NAME]) {
        PIXI.BitmapFont.uninstall(LABEL_FONT_NAME);
    }
    PIXI.BitmapFont.from(LABEL_FONT_NAME, {
        fontFamily: 'Geneva',
        fontSize: LABEL_FONT_SIZE,
        fill: 0xffffff,
    }, {
        chars: [...chars],
        // Rasterize at double size so labels stay reasonably crisp when the
        // map is zoomed in.
        resolution: 2,
    });
}

/**
 * Whether a system exists for the player according to its visibility NCB
 * test. Nova swaps between alternate copies of a system (stacked at the same
 * map position) by giving each a different visibility expression, e.g. the
 * four Sols at (0,0). The map currently evaluates against an empty control
 * bit set, which matches a brand-new pilot: the starter chär (nova:128) sets
 * no bits. Once per-player NCB state exists (with mission support), this
 * should use the player's actual bits instead.
 */
function systemVisible(system: SystemData): boolean {
    try {
        return evaluateNCBTest(system.visibility ?? '', {
            getBit: () => false,
        });
    } catch (e) {
        // Show systems with malformed visibility expressions rather than
        // hiding parts of the map.
        console.warn(`Bad visibility NCB test for ${system.id}: ${e}`);
        return true;
    }
}

/**
 * Computes the system-to-system hypergate links to overlay on the map from a
 * spöb -> system index and a per-gate destination lookup. Pure (no PIXI, no
 * async) so it is unit-testable. `gateDestinations` maps a hypergate spöb
 * global id to the spöb global ids it links to; non-hypergate spöbs are absent.
 */
export function computeHypergateSystemLinks(
    systemOfSpob: Map<string, string>,
    gateDestinations: Map<string, string[]>): [string, string][] {
    const links: [string, string][] = [];
    for (const [spob, destinations] of gateDestinations) {
        const fromSystem = systemOfSpob.get(spob);
        if (!fromSystem) {
            continue;
        }
        for (const dest of destinations) {
            const toSystem = systemOfSpob.get(dest);
            if (toSystem) {
                links.push([fromSystem, toSystem]);
            }
        }
    }
    return links;
}

function drawSystem(system: SystemData, graphics: PIXI.Graphics,
    x: number, y: number) {
    // Use blue if the system has a planet. Otherwise, grey.
    // TODO: Check if the planet is inhabited.
    const inhabited = system.planets.length > 0;
    const outColor = inhabited ? BLUE : GREY;
    const inColor = inhabited ? 0x000044 : 0x000000;
    graphics.lineStyle(1, outColor);
    graphics.beginFill(outColor)
    graphics.drawCircle(x, y, SYSTEM_RADIUS);
    graphics.beginFill(inColor);
    graphics.drawCircle(x, y, 1.8 * BASE_SCALE);
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
    // Whether the most recent pointer gesture moved the map, so the tap
    // handler can tell a click apart from the end of a pan.
    private draggedSinceDown = false;
    private wrappedRoute: string[] = [];
    private routes: Map<string, string[]>;
    // One representative system per map position, used for drawing circles and
    // labels and for resolving clicks. Nova swaps between multiple copies of a
    // system (at the same coordinates) with NCBs, so several systems can be
    // stacked on one spot; only one of them should respond to the map.
    private clickTargets: { system: SystemData, x: number, y: number }[];
    private mapContainer: PIXI.Container;
    private maskedContainer: PIXI.Container;
    // Bounding box of all systems in laid-out (BASE_SCALE) coordinates.
    private worldBounds: { minX: number, minY: number, maxX: number, maxY: number };

    // Hypergate links between systems (each a pair of system global ids).
    // Drawn in a distinct style from the normal grey hyperspace links.
    private readonly gateLinks: [SystemData, SystemData][];

    constructor(systems: SystemData[], private currentSystem: string,
        gateLinks: [string, string][] = [],
        private size = { x: 456, y: 419 }) {
        // NCB-hidden systems don't exist for the player: they aren't drawn,
        // clicked, linked, or routed through. The current system is always
        // kept so the map stays usable even if the player is somewhere the
        // visibility data says shouldn't exist.
        const visibleSystems = systems.filter(
            s => s.id === currentSystem || systemVisible(s));
        this.systems = new Map(visibleSystems.map(s => [s.id, s]));
        this.routes = this.computeShortestPaths();
        this.clickTargets = this.pickRepresentativeSystems(visibleSystems);

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

        // Capture pointer and wheel events over the whole map area. Clicks on
        // systems are resolved manually in onTap by finding the nearest system
        // to the pointer: with one interactive object instead of hundreds, the
        // event system stays fast, and a label drawn over a neighboring system
        // (e.g. Murasaki's label over Fomalhaut) can't swallow that system's
        // clicks like per-circle hit-testing allowed.
        this.container.eventMode = 'static';
        this.container.hitArea = new PIXI.Rectangle(0, 0, size.x, size.y);
        this.container.cursor = 'pointer';
        const onDragStart = this.onDragStart.bind(this);
        const onDragMove = this.onDragMove.bind(this);
        const onDragEnd = this.onDragEnd.bind(this);
        this.container
            .on('pointerdown', onDragStart)
            .on('pointerup', onDragEnd)
            .on('pointerupoutside', onDragEnd)
            .on('pointermove', onDragMove)
            .on('pointertap', this.onTap.bind(this))
            .on('wheel', this.onWheel.bind(this));

        this.links = [...this.getUniqueLinks()];
        // Resolve hypergate link ids to the visible systems they connect.
        // Links touching an NCB-hidden system (not in this.systems) are
        // dropped, like normal jump links.
        this.gateLinks = [];
        const seenGateLink = new Set<string>();
        for (const [a, b] of gateLinks) {
            const sa = this.systems.get(a);
            const sb = this.systems.get(b);
            if (!sa || !sb || a === b) {
                continue;
            }
            const key = [a, b].sort().join('<->');
            if (seenGateLink.has(key)) {
                continue;
            }
            seenGateLink.add(key);
            this.gateLinks.push([sa, sb]);
        }

        // All circles are baked into a single Graphics and all labels share
        // one bitmap font texture, so drawing the whole galaxy takes a couple
        // of draw calls instead of ~1300 display objects with distinct
        // textures. Pan and zoom are transforms on mapContainer, so nothing
        // here is ever redrawn per frame.
        installLabelFont(this.clickTargets.map(t => t.system));
        const circleGraphics = new PIXI.Graphics();
        const labelContainer = new PIXI.Container();
        for (const { system, x, y } of this.clickTargets) {
            drawSystem(system, circleGraphics, x, y);
            const label = new PIXI.BitmapText(system.name, {
                fontName: LABEL_FONT_NAME,
                fontSize: LABEL_FONT_SIZE,
            });
            label.position.set(x + 10, y);
            label.anchor.set(0, 0.5);
            labelContainer.addChild(label);
        }
        this.mapContainer.addChild(circleGraphics);
        this.mapContainer.addChild(labelContainer);

        this.worldBounds = this.computeWorldBounds();

        this.drawLinks();
        this.drawRoute();
        this.applyZoom();
    }

    /**
     * Groups systems by map position and picks the one the map should show
     * and select for each spot. NCB visibility filtering usually collapses a
     * stack of swapped duplicates to a single system already; this handles
     * spots where several systems remain (e.g. plugin systems with blank
     * visibility stacked on stock ones) by preferring a system reachable from
     * the current system, breaking ties by data order.
     */
    private pickRepresentativeSystems(systems: SystemData[]) {
        const byPosition = new Map<string, SystemData>();
        for (const system of systems) {
            const key = `${system.position[0]},${system.position[1]}`;
            const existing = byPosition.get(key);
            if (!existing) {
                byPosition.set(key, system);
                continue;
            }
            // Keep the existing pick unless this one is reachable and the
            // existing one isn't.
            if (!this.routes.has(existing.id) && this.routes.has(system.id)) {
                byPosition.set(key, system);
            }
        }
        return [...byPosition.values()].map(system => {
            const [x, y] = this.scalePos(system.position);
            return { system, x, y };
        });
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

    private onTap(event: PIXI.FederatedPointerEvent) {
        // Ignore taps that were actually the end of a drag.
        if (this.draggedSinceDown) {
            return;
        }
        const local = event.getLocalPosition(this.container);
        const system = this.systemAt(local.x, local.y);
        if (system) {
            this.onClickSystem(system.id);
        }
    }

    /**
     * Finds the system nearest to a point in viewport coordinates, or
     * undefined if none is within clicking distance.
     */
    private systemAt(viewX: number, viewY: number): SystemData | undefined {
        const pos = this.mapContainer.position;
        const worldX = (viewX - pos.x) / this.zoom;
        const worldY = (viewY - pos.y) / this.zoom;
        // Accept clicks within CLICK_RADIUS on screen, but never make the
        // target smaller than the drawn circle.
        const radius = Math.max(SYSTEM_RADIUS, CLICK_RADIUS / this.zoom);
        let best: SystemData | undefined;
        let bestDistSq = radius * radius;
        for (const { system, x, y } of this.clickTargets) {
            const dx = x - worldX;
            const dy = y - worldY;
            const distSq = dx * dx + dy * dy;
            if (distSq <= bestDistSq) {
                best = system;
                bestDistSq = distSq;
            }
        }
        return best;
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
        // Hypergate network links, over the normal links in a distinct color
        // so the instant-travel routes are legible as their own layer.
        for (const [source, dest] of this.gateLinks) {
            this.drawLink(this.linkGraphics, source, dest,
                HYPERGATE_LINK_COLOR, 1);
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
        const gateLinks = await this.computeHypergateLinks(systems);
        this.systemGraph = new SystemGraph(systems, this.systemId, gateLinks);
        this.systemGraph.container.position.set(-290, -248);
        this.container.addChild(this.systemGraph.container);
    }

    /**
     * Builds the system-to-system hypergate links to overlay on the map. A
     * hypergate spöb connects to other hypergate spöbs (its HyperLink
     * destinations); each such connection becomes a link between the systems
     * containing the two gates. Wormholes are deliberately left off the map:
     * they are meant to be mysterious, and the Bible documents no map display
     * for them.
     */
    private async computeHypergateLinks(systems: SystemData[]):
        Promise<[string, string][]> {
        // spöb global id -> system global id that contains it.
        const systemOfSpob = new Map<string, string>();
        for (const system of systems) {
            for (const spob of system.planets) {
                if (!systemOfSpob.has(spob)) {
                    systemOfSpob.set(spob, system.id);
                }
            }
        }
        const gateDestinations = new Map<string, string[]>();
        await Promise.all([...systemOfSpob.keys()].map(async spob => {
            let planet;
            try {
                planet = await this.simulationData.data.Planet.get(spob);
            } catch {
                return;
            }
            if (planet.gate?.kind === 'hypergate') {
                gateDestinations.set(spob, planet.gate.destinations);
            }
        }));
        return computeHypergateSystemLinks(systemOfSpob, gateDestinations);
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
