import { GameDate } from "novadatainterface/player_start_data";
import { SystemData } from "novadatainterface/system_data";
import * as PIXI from 'pixi.js';
import { Observable, Subject } from "rxjs";
import { DisplayAssetDataInterface } from "../client/gamedata/display_asset_data.js";
import { SimulationGameDataInterface } from "../client/gamedata/simulation_game_data.js";
import { ControlEvent } from "../nova_plugin/controls_plugin.js";
import { MissionMapMark, STANDARD_CARGO_NAMES } from "../nova_plugin/mission_logic.js";
import { evaluateNCBTest } from "../nova_plugin/ncb.js";
import { legalStatusName } from "../nova_plugin/reputation.js";
import { LegalRecordsState } from "../nova_plugin/reputation_plugin.js";
import { Button } from "./button.js";
import { FindDialog } from "./find_dialog.js";
import { Menu } from "./menu.js";
import { MenuControls } from "./menu_controls.js";
import { MissionUniverse } from "./mission_universe.js";
import {
    Adjacency, adjacentSystems, buildAdjacency, cycleSingle, effectiveRoute,
    expandRoute, formatMapDate, hazardDescription, reconcileRouteState,
    RouteState,
} from "./route.js";


const GREY = 0x666666;
const BLUE = 0x0000BB;
// Hypergate network links, drawn in a distinct cyan so the instant-travel
// hypergate routes read apart from the grey normal-jump hyperspace links.
const HYPERGATE_LINK_COLOR = 0x00cccc;
// Route colors (map/notes.txt): the multi-jump route is the STRONGER green
// line; the single-jump route is the WEAKER one.
const ROUTE_MULTI_COLOR = 0x00ff00;
const ROUTE_MULTI_WIDTH = 3;
const ROUTE_SINGLE_COLOR = 0x00b400;
const ROUTE_SINGLE_WIDTH = 1;
// Active-mission markers: ORANGE arrows on destination (travel/return)
// systems (mission_bbs/notes.txt), yellow for a mission's special-ship
// system (the Bible's additional arrow), and GREEN for the destinations of
// the mission being viewed in the Mission BBS. Orange and green marks may
// share a system, so they sit on opposite sides of it.
const MISSION_DEST_COLOR = 0xff8000;
const MISSION_SHIPSYST_COLOR = 0xffcc00;
const MISSION_VIEWED_COLOR = 0x00dd00;
const SELECT_COLOR = 0x00ff00;
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
 * test, evaluated against the player's control bits. Nova swaps between
 * alternate copies of a system (stacked at the same map position) by
 * giving each a different visibility expression, e.g. the four Sols
 * at (0,0).
 */
function systemVisible(system: SystemData,
    bits: ReadonlySet<number>): boolean {
    try {
        return evaluateNCBTest(system.visibility ?? '', {
            getBit: bit => bits.has(bit),
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

export interface SystemGraphOptions {
    /**
     * Hypergate lanes to overlay (pairs of system global ids). The REGULAR
     * starmap does not show hypergate lanes (matching the original game);
     * only the hypergate transit map (GateMap) passes these.
     */
    gateLinks?: [string, string][];
    /**
     * Destination-picker mode: clicking is restricted to these systems, and a
     * click selects (highlights) the system instead of plotting a route. Used
     * by the hypergate map to pick one of the gate's linked neighbors.
     */
    selectable?: Set<string>;
    size?: { x: number, y: number };
    /**
     * The player's control bits for NCB visibility filtering: systems whose
     * visibility expression fails against these bits aren't drawn, clicked,
     * linked, or routed through. Defaults to no bits (a new pilot).
     */
    playerBits?: ReadonlySet<number>;
    /**
     * Systems to mark for the player's active missions (mission_logic
     * missionMapMarks): orange destination arrows plus optional yellow
     * special-ship-system arrows. Purely decorative — an additive overlay
     * that never affects clicking, linking, or routing. Marks on systems the
     * player hasn't explored still render (mission_bbs/notes.txt).
     */
    missionMarks?: MissionMapMark[];
    /**
     * Destination systems of the mission currently being viewed in the
     * Mission BBS, marked with GREEN arrows. May share systems with
     * missionMarks (both arrows show).
     */
    viewedMarks?: MissionMapMark[];
    /**
     * The government border color for a system (Show Borders), or null for
     * no blob. Injected so the graph itself stays free of async data loads.
     */
    govtColorOf?: (system: SystemData) => number | null;
}

export class SystemGraph {
    readonly container = new PIXI.Container();
    /** Emits the plainly-clicked system (route mode), for the properties
     * panel. */
    readonly infoSelection = new Subject<string>();
    /** Emits whenever the pinned/single route state changes (route mode). */
    readonly routeChanged = new Subject<void>();

    // Links and the highlighted route live on separate graphics so that
    // selecting a route only redraws the route, not the whole galaxy.
    private readonly linkGraphics: PIXI.Graphics;
    private readonly routeGraphics: PIXI.Graphics;
    private readonly borderGraphics: PIXI.Graphics;
    private readonly links: [SystemData, SystemData][];
    private readonly systems: Map<string, SystemData>;
    /** Adjacency over the visible systems, for route planning. */
    private readonly adj: Adjacency;
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
    // Route mode state (see route.ts): pinned multi-jump waypoints, the
    // single-jump destination, and the system whose properties are shown.
    private pinned: string[] = [];
    private single?: string;
    private infoSelected?: string;
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
    // Destination-picker mode (see SystemGraphOptions.selectable).
    private readonly selectable?: Set<string>;
    // Active-mission destination / ship-syst markers (decorative overlay).
    private readonly missionMarks: MissionMapMark[];
    private readonly viewedMarks: MissionMapMark[];
    /** The picked system in destination-picker mode, if any. */
    selectedSystem?: string;
    private size: { x: number, y: number };

    constructor(systems: SystemData[], private currentSystem: string,
        options: SystemGraphOptions = {}) {
        const gateLinks = options.gateLinks ?? [];
        const playerBits = options.playerBits ?? new Set<number>();
        this.selectable = options.selectable;
        this.missionMarks = options.missionMarks ?? [];
        this.viewedMarks = options.viewedMarks ?? [];
        const size = this.size = options.size ?? { x: 456, y: 419 };
        // NCB-hidden systems don't exist for the player: they aren't drawn,
        // clicked, linked, or routed through. The current system is always
        // kept so the map stays usable even if the player is somewhere the
        // visibility data says shouldn't exist.
        const visibleSystems = systems.filter(
            s => s.id === currentSystem || systemVisible(s, playerBits));
        this.systems = new Map(visibleSystems.map(s => [s.id, s]));
        this.adj = buildAdjacency(visibleSystems);
        this.routes = this.computeShortestPaths();
        this.clickTargets = this.pickRepresentativeSystems(visibleSystems);

        this.linkGraphics = new PIXI.Graphics();
        this.routeGraphics = new PIXI.Graphics();
        this.borderGraphics = new PIXI.Graphics();
        this.borderGraphics.visible = false;

        this.mapContainer = new PIXI.Container();
        // Borders sit under everything; the route overlays the links.
        this.mapContainer.addChild(this.borderGraphics);
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
        this.drawMissionMarks();

        this.worldBounds = this.computeWorldBounds();

        if (options.govtColorOf) {
            this.drawBorders(options.govtColorOf);
        }
        this.drawLinks();
        if (this.selectable) {
            this.drawSelection();
        } else {
            this.drawRoute();
        }
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
        this.centerOn(this.currentSystem);
    }

    /** Centers any system in the viewport at the current zoom. */
    centerOn(systemId: string) {
        const system = this.systems.get(systemId);
        if (system) {
            const pos = this.scalePos(system.position);
            this.mapContainer.position.set(
                this.size.x / 2 - pos[0] * this.zoom,
                this.size.y / 2 - pos[1] * this.zoom,
            );
            this.clampPosition();
        }
    }

    // --- Route mode (the regular starmap) ---

    /** Loads route state (pinned waypoints + single-jump destination). */
    setRouteState(state: RouteState) {
        this.pinned = [...state.pinned];
        this.single = state.single;
        this.drawRoute();
    }

    getRouteState(): RouteState {
        return { pinned: [...this.pinned], single: this.single };
    }

    /** The route hyperspace jumps follow (multi-jump takes precedence). */
    getEffectiveRoute(): string[] {
        return effectiveRoute(this.adj, this.currentSystem,
            this.getRouteState());
    }

    get adjacency(): Adjacency {
        return this.adj;
    }

    get hasRoute(): boolean {
        return this.pinned.length > 0 || this.single !== undefined;
    }

    /** The system whose properties the panel shows. */
    get infoSystem(): string | undefined {
        return this.infoSelected;
    }

    clearRoute() {
        this.pinned = [];
        this.single = undefined;
        this.routeChanged.next();
        this.drawRoute();
    }

    /** Tab: cycles the single-jump route through the current system's
     * neighbours (through an "off" slot to clear it). */
    cycleSingleRoute(direction = 1) {
        if (this.selectable) {
            return;
        }
        const neighbours = adjacentSystems(this.adj, this.currentSystem);
        this.single = cycleSingle(neighbours, this.single, direction);
        if (this.single !== undefined) {
            this.selectForInfo(this.single);
        }
        this.routeChanged.next();
        this.drawRoute();
    }

    /**
     * Selects (and centers on) a system by name for the Find button.
     * Exact match first, then a unique prefix match. Returns the id, or
     * undefined if no match.
     */
    findByName(name: string): string | undefined {
        const wanted = name.trim().toLowerCase();
        if (!wanted) {
            return undefined;
        }
        let prefixMatch: SystemData | undefined;
        let prefixMatches = 0;
        for (const { system } of this.clickTargets) {
            const candidate = system.name.toLowerCase();
            if (candidate === wanted) {
                this.selectForInfo(system.id);
                this.centerOn(system.id);
                return system.id;
            }
            if (candidate.startsWith(wanted)) {
                prefixMatch = system;
                prefixMatches++;
            }
        }
        if (prefixMatch && prefixMatches === 1) {
            this.selectForInfo(prefixMatch.id);
            this.centerOn(prefixMatch.id);
            return prefixMatch.id;
        }
        return undefined;
    }

    /** Shows or hides the government border overlay. */
    setBordersShown(shown: boolean) {
        this.borderGraphics.visible = shown;
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
            this.onClickSystem(system.id, event.shiftKey);
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

    private selectForInfo(system: string) {
        this.infoSelected = system;
        this.infoSelection.next(system);
        this.drawRoute();
    }

    private onClickSystem(system: string, shiftKey: boolean) {
        if (this.selectable) {
            // Destination-picker mode: only the offered systems respond, and
            // clicking one selects it (clicking again deselects).
            if (!this.selectable.has(system)) {
                return;
            }
            this.selectedSystem =
                this.selectedSystem === system ? undefined : system;
            this.drawSelection();
            return;
        }
        if (shiftKey) {
            // Shift-click appends the system to the multi-jump route as a
            // pinned waypoint (or unpins it). Gaps between pins auto-fill
            // with the shortest path when the route is expanded — the only
            // auto-routing there is (map/notes.txt).
            if (system !== this.currentSystem) {
                this.pinned = this.pinned.includes(system)
                    ? this.pinned.filter(p => p !== system)
                    : [...this.pinned, system];
                this.routeChanged.next();
            }
        } else if (adjacentSystems(this.adj, this.currentSystem)
            .includes(system)) {
            // A plain click on an adjacent system sets (or toggles off) the
            // single-jump route. Clicking anything else only inspects it.
            this.single = this.single === system ? undefined : system;
            this.routeChanged.next();
        }
        this.selectForInfo(system);
    }

    /**
     * Draws the destination-picker overlay on the route layer: a ring around
     * each offered system, and a filled highlight on the picked one.
     */
    private drawSelection() {
        this.routeGraphics.clear();
        if (!this.selectable) {
            return;
        }
        for (const id of this.selectable) {
            const system = this.systems.get(id);
            if (!system) {
                continue;
            }
            const [x, y] = this.scalePos(system.position);
            const picked = id === this.selectedSystem;
            this.routeGraphics.lineStyle(picked ? 2 : 1,
                picked ? 0x00ff00 : HYPERGATE_LINK_COLOR);
            this.routeGraphics.drawCircle(x, y, SYSTEM_RADIUS + 3);
        }
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

    /**
     * Draws the government border overlay (Show Borders): a soft blob of the
     * owning government's color around each governed system, like the
     * original's territory shading (map/govt_borders.png). Baked once into
     * its own layer and simply hidden until toggled on.
     */
    private drawBorders(govtColorOf: (system: SystemData) => number | null) {
        // Two concentric translucent circles per system approximate the
        // original's soft-edged blobs; neighbors overlap into contiguous
        // territory. Colors are dimmed toward the original's deep muted
        // shading (govt_borders.png) — full-strength gövt colors (including
        // white ones) wash out the map.
        const dim = (color: number) =>
            (((color >> 16 & 0xff) * 0.55) & 0xff) << 16
            | (((color >> 8 & 0xff) * 0.55) & 0xff) << 8
            | ((color & 0xff) * 0.55) & 0xff;
        for (const { system, x, y } of this.clickTargets) {
            const color = govtColorOf(system);
            if (color === null) {
                continue;
            }
            this.borderGraphics.lineStyle(0);
            this.borderGraphics.beginFill(dim(color), 0.30);
            this.borderGraphics.drawCircle(x, y, 34 * BASE_SCALE);
            this.borderGraphics.endFill();
            this.borderGraphics.beginFill(dim(color), 0.32);
            this.borderGraphics.drawCircle(x, y, 20 * BASE_SCALE);
            this.borderGraphics.endFill();
        }
    }

    /**
     * Draws the active-mission markers: small arrows beside their systems
     * (destinations orange, ship-syst yellow, BBS-viewed green). Additive
     * and decorative: baked into the map container like the circles, so it
     * pans/zooms with them and never intercepts clicks. Marks whose system
     * is NCB-hidden (not on this map) are skipped; marks on unexplored
     * systems still render.
     */
    private drawMissionMarks() {
        if (this.missionMarks.length === 0 && this.viewedMarks.length === 0) {
            return;
        }
        const graphics = new PIXI.Graphics();
        for (const mark of this.missionMarks) {
            const color = mark.kind === 'shipSyst'
                ? MISSION_SHIPSYST_COLOR : MISSION_DEST_COLOR;
            // Active-mission arrows sit below-left, pointing up at the
            // system (map_showing_mission_location.png).
            this.drawMarkArrow(graphics, mark.systemId, color, 1);
        }
        for (const mark of this.viewedMarks) {
            // Viewed-mission arrows sit above-left pointing down, so both
            // can share a system (mission_bbs/notes.txt).
            this.drawMarkArrow(graphics, mark.systemId,
                MISSION_VIEWED_COLOR, -1);
        }
        this.mapContainer.addChild(graphics);
    }

    /** Draws one diagonal mark arrow beside a system. `side` +1 = below-left
     * pointing up-right at it; -1 = above-left pointing down-right. */
    private drawMarkArrow(graphics: PIXI.Graphics, systemId: string,
        color: number, side: number) {
        const system = this.systems.get(systemId);
        if (!system) {
            return;
        }
        const [x, y] = this.scalePos(system.position);
        // Arrow tip just outside the system circle, on the lower-left (or
        // upper-left) diagonal; tail extends away from the system.
        const tipX = x - SYSTEM_RADIUS - 1;
        const tipY = y + side * (SYSTEM_RADIUS + 1);
        const dir = { x: -1, y: side }; // Away from the system.
        const len = 5 * BASE_SCALE;
        const tailX = tipX + dir.x * len;
        const tailY = tipY + dir.y * len;
        // Shaft.
        graphics.lineStyle(1.5, color, 1);
        graphics.moveTo(tailX, tailY);
        graphics.lineTo(tipX, tipY);
        // Head: a small filled triangle at the tip.
        const head = 2.2 * BASE_SCALE;
        graphics.lineStyle(0);
        graphics.beginFill(color, 1);
        graphics.drawPolygon([
            tipX + dir.x * 0.2, tipY + dir.y * 0.2,
            tipX + dir.x * head, tipY + dir.y * head - side * head * 0.7,
            tipX + dir.x * head + head * 0.7, tipY + dir.y * head,
        ]);
        graphics.endFill();
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

    /**
     * Draws the route overlay: the WEAK single-jump line, the STRONG
     * multi-jump line over it, pinned-waypoint boxes, the current system's
     * ring, and the properties-selection brackets.
     */
    private drawRoute() {
        if (this.selectable) {
            return;
        }
        const g = this.routeGraphics;
        g.clear();

        // Single-jump route: the weaker green line.
        if (this.single !== undefined) {
            const from = this.systems.get(this.currentSystem);
            const to = this.systems.get(this.single);
            if (from && to) {
                this.drawLink(g, from, to,
                    ROUTE_SINGLE_COLOR, ROUTE_SINGLE_WIDTH);
            }
        }

        // Multi-jump route: the stronger green line, over the single one.
        const multi = expandRoute(this.adj, this.currentSystem, this.pinned);
        let prev = this.systems.get(this.currentSystem);
        for (const system of multi.map(id => this.systems.get(id))) {
            if (system) {
                if (prev) {
                    this.drawLink(g, prev, system,
                        ROUTE_MULTI_COLOR, ROUTE_MULTI_WIDTH);
                }
                prev = system;
            }
        }

        // Pinned waypoints: a small green box marks each explicitly
        // selected system (they always stay in the route).
        for (const id of this.pinned) {
            const system = this.systems.get(id);
            if (!system) {
                continue;
            }
            const [x, y] = this.scalePos(system.position);
            const r = SYSTEM_RADIUS + 2;
            g.lineStyle(1, ROUTE_MULTI_COLOR);
            g.drawRect(x - r, y - r, 2 * r, 2 * r);
        }

        // The current system: a dashed green ring (the original's marker).
        const current = this.systems.get(this.currentSystem);
        if (current) {
            const [x, y] = this.scalePos(current.position);
            const r = SYSTEM_RADIUS + 2.5;
            g.lineStyle(1.2, SELECT_COLOR);
            const segments = 8;
            for (let i = 0; i < segments; i++) {
                const a0 = (i * 2 * Math.PI) / segments;
                const a1 = a0 + Math.PI / segments;
                g.moveTo(x + r * Math.cos(a0), y + r * Math.sin(a0));
                g.arc(x, y, r, a0, a1);
            }
        }

        // The inspected system: green corner brackets around it.
        if (this.infoSelected !== undefined
            && this.infoSelected !== this.currentSystem) {
            const system = this.systems.get(this.infoSelected);
            if (system) {
                const [x, y] = this.scalePos(system.position);
                const r = SYSTEM_RADIUS + 3;
                const arm = 3;
                g.lineStyle(1, SELECT_COLOR);
                for (const [sx, sy] of
                    [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
                    g.moveTo(x + sx * r - sx * arm, y + sy * r);
                    g.lineTo(x + sx * r, y + sy * r);
                    g.lineTo(x + sx * r, y + sy * r - sy * arm);
                }
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

/**
 * Client-side persistence for the map's route state, owned by the plugin so
 * pinned waypoints and the single-jump pick survive world rebuilds (system
 * transits). Never simulation state: only the effective route (a plain
 * string[] of adjacent hops) reaches the sim, through the same
 * SetJumpRouteEvent -> setPlayerJumpRoute input-record path a plain route
 * always used.
 */
export interface RouteStateStore {
    state: RouteState;
}

/** Extra per-open context for the starmap (see OpenStarmapResource). */
export interface OpenStarmapOptions {
    /**
     * Destination marks of the mission being viewed in the Mission BBS,
     * shown in green while this map is open.
     */
    viewedMarks?: MissionMapMark[];
    /**
     * Overrides the plugin's active-mission marks (orange) for this open.
     * Landed screens must pass these: the docked entity — and with it the
     * Missions component — is out of the display world, so the plugin's own
     * lookup comes up empty while a menu has the ship.
     */
    missionMarks?: MissionMapMark[];
    /**
     * The player's calendar date for the gray readout, when the caller has
     * it handy (landed screens; the entity is out of the display world
     * while docked, so the plugin can't always read it itself).
     */
    date?: GameDate;
}

// Right-column/properties fonts. The label blue-gray matches the original's
// field captions; values are white.
const PROP_LABEL_FONT: Partial<PIXI.ITextStyle> = {
    fontFamily: 'Geneva', fontSize: 10, fill: 0x8f9fc0,
    align: 'left', wordWrap: false,
};
const PROP_VALUE_FONT: Partial<PIXI.ITextStyle> = {
    fontFamily: 'Geneva', fontSize: 10, fill: 0xffffff,
    align: 'left', wordWrap: false,
};
const DATE_FONT: Partial<PIXI.ITextStyle> = {
    fontFamily: 'Geneva', fontSize: 10, fill: 0x888888,
    align: 'right', wordWrap: false,
};

// Layout (container-centered like every menu): the nova:8509 dialog frame
// holds the 456x419 map pane at (-290,-248); the properties column sits to
// its right and the Ports/Hazards readouts plus the button row below it,
// matching map_open_over_spaceport.png.
const MAP_POS = { x: -290, y: -248 };
const PROP_X = 178;
const PROP_TOP = -240;
const PROP_LINE = 13;
const PORTS_Y = 182;
const HAZARDS_Y = 202;
const DATE_RIGHT_X = 288;
// Measured against map_single_jump_route.png at 1920x1080: the reference
// row's red button core spans y=773..783 (center 778); at BUTTON_Y=220 ours
// sat at center 771 with the dialog frame edges exactly aligned, so the row
// moves 7px down.
const BUTTON_Y = 227;

export class Starmap extends Menu<string[] /* route list of systems */> {
    private systemGraph?: SystemGraph;
    private allSystems?: SystemData[];
    private graphBitsKey?: string;
    private universe: MissionUniverse;
    private findDialog: FindDialog;
    private buttons: {
        borders: Button, clear: Button, find: Button,
        zoomOut: Button, zoomIn: Button, done: Button,
    };
    private bordersShown = false;
    /** Set by the plugin for the current open (BBS-viewed mission marks,
     * a landed caller's date). */
    openOptions: OpenStarmapOptions = {};

    // The properties readouts.
    private propContainer = new PIXI.Container();
    private portsLabel = new PIXI.Text('Ports:', PROP_LABEL_FONT);
    private portsValue = new PIXI.Text('', PROP_VALUE_FONT);
    private hazardsLabel = new PIXI.Text('Navigation Hazards:',
        PROP_LABEL_FONT);
    private hazardsValue = new PIXI.Text('', PROP_VALUE_FONT);
    private dateText = new PIXI.Text('', DATE_FONT);

    constructor(displayAssets: DisplayAssetDataInterface,
        simulationData: SimulationGameDataInterface,
        private systemId: string, controlEvents: Observable<ControlEvent>,
        /** The player's control bits, for NCB system visibility. */
        private getPlayerBits: () => ReadonlySet<number> = () => new Set(),
        /**
         * The player's active-mission map markers (mission_logic
         * missionMapMarks), refreshed each time the map opens. Optional:
         * omit for a marker-free map.
         */
        private getMissionMarks: () => MissionMapMark[] = () => [],
        /** Persistent route state (see RouteStateStore). */
        private routeStore: RouteStateStore = { state: { pinned: [] } },
        /** Whether the player has explored (entered) a system; unexplored
         * systems' properties read "<Unknown>". */
        private isSystemExplored: (systemId: string) => boolean = () => true,
        /** The player's calendar date (in flight). Landed callers pass it
         * through OpenStarmapOptions instead. */
        private getDate: () => GameDate | undefined = () => undefined,
        /** The player's legal records, for the Legal Status line. */
        private getLegalRecords: () => LegalRecordsState | undefined =
            () => undefined) {
        super(displayAssets, simulationData, "nova:8509", controlEvents);
        this.container.name = "StarMap";
        this.universe = MissionUniverse.shared(simulationData);
        this.buttons = {
            borders: new Button(displayAssets, "Show Borders", 100,
                { x: -287, y: BUTTON_Y }),
            clear: new Button(displayAssets, "Clear Route", 88,
                { x: -142, y: BUTTON_Y }),
            find: new Button(displayAssets, "Find", 66,
                { x: -10, y: BUTTON_Y }),
            zoomOut: new Button(displayAssets, "-", 10,
                { x: 110, y: BUTTON_Y }),
            zoomIn: new Button(displayAssets, "+", 10,
                { x: 141, y: BUTTON_Y }),
            done: new Button(displayAssets, "Done", 64,
                { x: 188, y: BUTTON_Y }),
        };
        this.addButtons(this.buttons);

        this.buttons.done.click.subscribe(this.done.bind(this));
        this.buttons.borders.click.subscribe(() => this.toggleBorders());
        this.buttons.clear.click.subscribe(() => {
            this.systemGraph?.clearRoute();
        });
        this.buttons.find.click.subscribe(() => void this.openFind());
        this.buttons.zoomOut.click.subscribe(
            () => this.systemGraph?.zoomBy(1 / ZOOM_STEP ** 2));
        this.buttons.zoomIn.click.subscribe(
            () => this.systemGraph?.zoomBy(ZOOM_STEP ** 2));

        this.findDialog = new FindDialog(controlEvents);

        this.controls = new MenuControls(controlEvents, {
            depart: this.done.bind(this),
            map: this.done.bind(this),
            // Tab cycles through possible single-jump routes.
            nextTarget: () => this.systemGraph?.cycleSingleRoute(1),
            // Space re-centers the view on the current system.
            firePrimary: () => this.systemGraph?.center(),
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
        this.allSystems = await Promise.all(
            systemIds.map(s => this.simulationData.data.System.get(s)));
        // Planet/govt/system indices for the properties panel and borders.
        await this.universe.load();
        this.rebuildGraph(this.getPlayerBits());

        this.propContainer.position.set(0, 0);
        this.container.addChild(this.propContainer);
        this.portsLabel.position.set(MAP_POS.x, PORTS_Y);
        this.portsValue.position.set(MAP_POS.x + 42, PORTS_Y);
        this.hazardsLabel.position.set(MAP_POS.x, HAZARDS_Y);
        this.hazardsValue.position.set(MAP_POS.x + 118, HAZARDS_Y);
        this.dateText.anchor.x = 1;
        this.dateText.position.set(DATE_RIGHT_X, HAZARDS_Y);
        this.container.addChild(this.portsLabel, this.portsValue,
            this.hazardsLabel, this.hazardsValue, this.dateText);
        this.container.addChild(this.findDialog.container);
    }

    /** (Re)filters the map against the given control bits. */
    private rebuildGraph(bits: ReadonlySet<number>) {
        if (!this.allSystems) {
            return;
        }
        // The active-mission markers can change independently of the bits
        // (accepting/completing a mission), and the BBS-viewed marks change
        // per open, so they're part of the key.
        const missionMarks =
            this.openOptions.missionMarks ?? this.getMissionMarks();
        const viewedMarks = this.openOptions.viewedMarks ?? [];
        const marksKey = [
            ...missionMarks.map(m => `${m.systemId}:${m.kind}`).sort(),
            '#viewed',
            ...viewedMarks.map(m => m.systemId).sort(),
        ].join('|');
        const key = [...bits].sort((a, b) => a - b).join(',') + '#' + marksKey;
        if (this.systemGraph && key === this.graphBitsKey) {
            return;
        }
        if (this.systemGraph) {
            this.container.removeChild(this.systemGraph.container);
        }
        this.graphBitsKey = key;
        // The regular starmap does NOT show hypergate lanes — the original
        // game only reveals the network on the hypergate transit map
        // (GateMap), which is where the lanes are drawn (via
        // SystemGraphOptions.gateLinks).
        this.systemGraph = new SystemGraph(this.allSystems, this.systemId, {
            playerBits: bits,
            missionMarks,
            viewedMarks,
            govtColorOf: system => this.govtColorOf(system),
        });
        this.systemGraph.container.position.set(MAP_POS.x, MAP_POS.y);
        // Keep the graph under the buttons/readouts (they were added to the
        // container first), matching the dialog frame's layering.
        this.container.addChildAt(this.systemGraph.container, 1);
        this.systemGraph.setBordersShown(this.bordersShown);
        this.systemGraph.infoSelection.subscribe(
            id => this.showProperties(id));
        this.systemGraph.routeChanged.subscribe(
            () => this.refreshClearButton());
    }

    /** The Show Borders blob color for a system: its govt's color. */
    private govtColorOf(system: SystemData): number | null {
        if (!system.govt) {
            return null;
        }
        const govt = this.universe.getGovt(system.govt);
        if (!govt) {
            return null;
        }
        // A govt with color 0 (black, the field's default) still owns
        // territory; give it the original's deep blue so its space shows.
        const color = govt.color & 0xffffff;
        return color === 0 ? 0x000090 : color;
    }

    private toggleBorders() {
        this.bordersShown = !this.bordersShown;
        this.systemGraph?.setBordersShown(this.bordersShown);
        this.buttons.borders.setLabel(
            this.bordersShown ? 'Hide Borders' : 'Show Borders');
    }

    private refreshClearButton() {
        this.buttons.clear.state =
            this.systemGraph?.hasRoute ? 'normal' : 'grey';
    }

    private async openFind() {
        if (!this.systemGraph) {
            return;
        }
        const name = await this.findDialog.show();
        if (name) {
            this.systemGraph.findByName(name);
        }
    }

    /**
     * Fills the properties panel for a system: the right-hand column
     * (Current/Destination System, Government, Legal Status, Goods Traded,
     * Services) and the Ports / Navigation Hazards readouts. Everything but
     * the title reads "<Unknown>" until the player has explored the system.
     */
    private showProperties(systemId: string) {
        this.propContainer.removeChildren();
        let y = PROP_TOP;
        const addLine = (label: string, values: string[]) => {
            const labelText = new PIXI.Text(label, PROP_LABEL_FONT);
            labelText.position.set(PROP_X, y);
            this.propContainer.addChild(labelText);
            y += PROP_LINE;
            for (const value of values) {
                const valueText = new PIXI.Text(value, PROP_VALUE_FONT);
                valueText.position.set(PROP_X + 6, y);
                this.propContainer.addChild(valueText);
                y += PROP_LINE;
            }
            y += 5;
        };

        const isCurrent = systemId === this.systemId;
        const title = isCurrent ? 'Current System:' : 'Destination System:';
        const system = this.allSystems?.find(s => s.id === systemId);
        const explored = this.isSystemExplored(systemId);
        if (!system || !explored) {
            addLine(title, [explored && system ? system.name : '<Unknown>']);
            this.portsValue.text = '<Unknown>';
            this.hazardsValue.text = '<Unknown>';
            return;
        }

        addLine(title, [system.name]);

        const govt = system.govt
            ? this.universe.getGovt(system.govt) : undefined;
        addLine('Government:', [govt?.name ?? 'Independent']);

        if (govt && system.govt) {
            const record = this.getLegalRecords()?.get(system.govt) ?? 0;
            addLine('Legal Status:',
                [legalStatusName(record, govt.crimeTol)]);
        }

        // Ports: the landable stellars. Goods/services aggregate over them.
        const planets = system.planets
            .map(id => this.universe.getPlanet(id))
            .filter(<T>(p: T): p is NonNullable<T> => p != null);
        const ports = planets.filter(p => p.flags.canLand);

        const goods = new Set<number>();
        let trading = false, outfitting = false, shipyard = false;
        for (const port of ports) {
            port.tradeTiers.forEach((tier, i) => {
                if (tier !== null) {
                    goods.add(i);
                }
            });
            trading ||= port.flags.hasCommodityExchange;
            outfitting ||= port.flags.hasOutfitter;
            shipyard ||= port.flags.hasShipyard;
        }
        addLine('Goods Traded:', goods.size > 0
            ? [...goods].sort((a, b) => a - b)
                .map(i => STANDARD_CARGO_NAMES[i] ?? `Cargo ${i}`)
            : ['None']);
        const services = [
            ...(trading ? ['Trading'] : []),
            ...(outfitting ? ['Outfitting'] : []),
            ...(shipyard ? ['Shipyard'] : []),
        ];
        addLine('Services:', services.length > 0 ? services : ['None']);

        this.portsValue.text = ports.length > 0
            ? ports.map(p => p.name).join(', ') : 'None';
        this.hazardsValue.text =
            hazardDescription(system.asteroids, system.interference);
    }

    override async show(route: string[]) {
        await this.buildPromise
        // The player's bits may have changed (missions, outfits) since
        // the graph was built; refilter NCB-gated systems.
        this.rebuildGraph(this.getPlayerBits());
        if (!this.systemGraph) {
            throw new Error('Expected system graph to be built')
        }
        // Bring the persisted pins/single up to date with where the player
        // is now, adopting the sim's route if the client state was lost.
        this.routeStore.state = reconcileRouteState(this.routeStore.state,
            this.systemId, this.systemGraph.adjacency, route);
        this.systemGraph.setRouteState(this.routeStore.state);
        this.systemGraph.center();
        this.refreshClearButton();
        this.showProperties(this.systemId);
        const date = this.openOptions.date ?? this.getDate();
        this.dateText.text = date ? formatMapDate(date) : '';
        try {
            return await super.show(route);
        } finally {
            // Viewed-mission marks only last for the open that set them.
            this.openOptions = {};
        }
    }

    override done() {
        if (this.systemGraph) {
            this.routeStore.state = this.systemGraph.getRouteState();
            this.input = this.systemGraph.getEffectiveRoute();
        }
        super.done();
    }
}
