import { NebulaData } from "novadatainterface/NebulaData";
import { PlanetData } from "novadatainterface/PlanetData";
import { SystemData } from "novadatainterface/SystemData";
import { GovtData } from "novadatainterface/GovtData";
import * as PIXI from 'pixi.js';
import { Observable } from "rxjs";
import { GameData } from "../client/gamedata/GameData";
import { ControlEvent } from "../nova_plugin/controls_plugin";
import { resourceId } from "../common/resource_id";
import { Button } from "./button";
import { Menu } from "./menu";
import { MenuControls } from "./menu_controls";
import { formatGameDate } from "../nova_plugin/player_state";
import { shortestRoutes } from "./route_planning";
import {
    MAP_WELL,
    mapWellOrigin,
    STARMAP_LAYOUT,
} from "./starmap_layout";
import { createGraphicHandle, ManagedGraphic } from "../display/managed_graphic";
import {
    consumeInitialCenter,
    MissionMarkerType,
    StarmapPlayerState,
    StarmapViewState,
    systemMarkerStyle,
} from "./starmap_state";
import type { ActiveMission } from "../nova_plugin/player_state";
import {
    starmapPanelData,
    starmapPanelText,
} from './starmap_content';
import {
    clampMapScale,
    MAP_SCALE_DEFAULT,
    mapScaleForWheel,
    zoomedMapPosition,
} from './starmap_zoom';
import {
    computeTerritoryField,
    TerritoryField,
    TerritoryPoint,
} from "./territory_field";

export { shortestRoute, shortestRoutes } from "./route_planning";


const GREY = 0x666666;
/** Keeps the political overlay readable without hiding links or markers. */
const TERRITORY_ALPHA = 0.55;
const BLUE = 0x0000BB;
const SYSTEM_TEXT = new PIXI.TextStyle({
    fontFamily: 'Geneva',
    fontSize: 10,
    align: 'left',
    fill: 0xffffff,
});
const STARMAP_HEADING = new PIXI.TextStyle({
    fontFamily: 'Geneva',
    fontSize: 12,
    align: 'left',
    fill: 0xffffff,
});
const STARMAP_BODY = new PIXI.TextStyle({
    fontFamily: 'Geneva',
    fontSize: 10,
    align: 'left',
    fill: 0xffffff,
    wordWrap: true,
});
const STARMAP_BOTTOM = new PIXI.TextStyle({
    fontFamily: 'Geneva',
    fontSize: 10,
    align: 'left',
    fill: 0xffffff,
    wordWrap: true,
});
const STARMAP_DATE = new PIXI.TextStyle({
    fontFamily: 'Geneva',
    fontSize: 10,
    align: 'right',
    fill: 0xffffff,
});

function addMaskedText(
    owner: PIXI.Container,
    region: { x: number; y: number; width: number; height: number },
    style: PIXI.TextStyle,
): PIXI.Text {
    const text = new PIXI.Text('', style);
    text.position.set(region.x, region.y);
    text.style.wordWrapWidth = region.width;
    const mask = new PIXI.Graphics();
    mask.rect(region.x, region.y, region.width, region.height).fill(0xffffff);
    text.mask = mask;
    owner.addChild(mask, text);
    return text;
}

export function getMissionDestinationMarkers(
    activeMissions: readonly ActiveMission[] | undefined,
    systems: readonly SystemData[],
): Map<string, MissionMarkerType> {
    const markers = new Map<string, MissionMarkerType>();
    if (!activeMissions || activeMissions.length === 0) {
        return markers;
    }

    const planetToSystem = new Map<string, string>();
    for (const sys of systems) {
        for (const planetId of sys.planets ?? []) {
            planetToSystem.set(planetId, sys.id);
            const barePlanetId = planetId.replace(/^.*:/, '');
            planetToSystem.set(barePlanetId, sys.id);
        }
    }

    const systemIds = new Set(systems.map(s => s.id));
    const bareSystemIds = new Map(systems.map(s => [s.id.replace(/^.*:/, ''), s.id]));

    const resolveSystem = (targetId: string | undefined): string | undefined => {
        if (!targetId || targetId === '*') {
            return undefined;
        }
        if (systemIds.has(targetId)) {
            return targetId;
        }
        if (planetToSystem.has(targetId)) {
            return planetToSystem.get(targetId);
        }
        const bare = targetId.replace(/^.*:/, '');
        if (bareSystemIds.has(bare)) {
            return bareSystemIds.get(bare);
        }
        if (planetToSystem.has(bare)) {
            return planetToSystem.get(bare);
        }
        return undefined;
    };

    for (const mission of activeMissions) {
        if (mission.state !== 'active') {
            continue;
        }
        let targetSystem: string | undefined;
        if (!mission.travelVisited && mission.travelDestination) {
            targetSystem = resolveSystem(mission.travelDestination);
        } else if (mission.travelVisited && mission.returnDestination) {
            targetSystem = resolveSystem(mission.returnDestination);
        } else if (mission.shipSystem) {
            targetSystem = resolveSystem(mission.shipSystem);
        } else if (mission.destination) {
            targetSystem = resolveSystem(mission.destination);
        }

        if (!targetSystem) {
            continue;
        }

        const isPassenger = mission.cargo?.type === 1001
            || mission.missionData?.cargoType === 1001
            || String(mission.missionData?.cargo).toLowerCase().includes('passenger');
        const isCargo = !isPassenger && (
            Boolean(mission.cargo)
            || (mission.missionData?.cargoType !== undefined && mission.missionData?.cargoType >= 0)
        );
        const markerType: MissionMarkerType = isPassenger
            ? 'passenger'
            : (isCargo ? 'cargo' : 'storyline');

        const existing = markers.get(targetSystem);
        if (!existing
            || markerType === 'storyline'
            || (markerType === 'cargo' && existing === 'passenger')) {
            markers.set(targetSystem, markerType);
        }
    }

    return markers;
}

export interface StarmapPlayerMarker {
    name: string;
    systemId: string;
    kind?: 'coords' | 'sos' | 'normal';
}

function drawSystem(
    system: SystemData,
    graphics: PIXI.Graphics,
    scale: number,
    currentSystem: string,
    missionMarker?: MissionMarkerType,
    playerMarkers?: readonly StarmapPlayerMarker[],
) {
    // Use blue if the system has a planet. Otherwise, grey.
    // TODO: Check if the planet is inhabited.
    const inhabited = system.planets.length > 0;
    const outColor = inhabited ? BLUE : GREY;
    const inColor = inhabited ? 0x000044 : 0x000000;
    const marker = systemMarkerStyle(system.id, currentSystem);
    if (marker.current) {
        graphics.circle(0, 0, 4.5 * scale).stroke({
            width: marker.ringWidth ?? 2,
            color: marker.ringColor ?? 0xffffff,
        });
    }
    graphics.circle(0, 0, 2.7 * scale).fill(outColor).stroke({ width: 1, color: outColor });
    graphics.circle(0, 0, 1.8 * scale).fill(inColor);

    if (playerMarkers && playerMarkers.length > 0) {
        const hasSos = playerMarkers.some(p => p.kind === 'sos');
        const markerColor = hasSos ? 0xff4400 : 0x28ffaa;
        // Draw player chevron / beacon symbol on top right of the system circle
        graphics.moveTo(5 * scale, -5 * scale);
        graphics.lineTo(8.5 * scale, -8.5 * scale);
        graphics.lineTo(8.5 * scale, -2.5 * scale);
        graphics.closePath();
        graphics.fill(markerColor).stroke({ width: 1, color: 0x000000 });
    }

    if (missionMarker) {
        const markerColor = missionMarker === 'passenger'
            ? 0x00d4ff   // Cyan / Sky Blue for passengers
            : (missionMarker === 'cargo'
                ? 0xffaa00 // Amber Orange for cargo / delivery
                : 0xff2222); // Vivid Red for storyline / special
        if (missionMarker === 'passenger') {
            // Diamond for passenger
            graphics.moveTo(0, -9.5 * scale);
            graphics.lineTo(3.5 * scale, -6.5 * scale);
            graphics.lineTo(0, -3.5 * scale);
            graphics.lineTo(-3.5 * scale, -6.5 * scale);
            graphics.closePath();
        } else if (missionMarker === 'cargo') {
            // Downward pointing triangle for cargo delivery
            graphics.moveTo(0, -3.8 * scale);
            graphics.lineTo(-4 * scale, -9.2 * scale);
            graphics.lineTo(4 * scale, -9.2 * scale);
            graphics.closePath();
        } else {
            // Sharp chevron / inverted triangle for main storyline
            graphics.moveTo(0, -3.2 * scale);
            graphics.lineTo(-4.5 * scale, -9.8 * scale);
            graphics.lineTo(0, -7.5 * scale);
            graphics.lineTo(4.5 * scale, -9.8 * scale);
            graphics.closePath();
        }
        graphics.fill(markerColor).stroke({ width: 1, color: 0x000000 });
    }
}

function normalizeKnownSystems(
    exploredSystems: readonly string[] | undefined,
    currentSystem: string,
): Set<string> | undefined {
    if (!exploredSystems || exploredSystems.length === 0) {
        return;
    }
    const known = new Set(exploredSystems);
    known.add(currentSystem);
    return known;
}

function sameSystemSet(
    first: Set<string> | undefined,
    second: Set<string> | undefined,
): boolean {
    if (first?.size !== second?.size) {
        return false;
    }
    if (!first || !second) {
        return true;
    }
    return [...first].every(system => second.has(system));
}

/**
 * Retail stores three pre-scaled copies of each nebula's artwork. Pick the
 * one closest to the map's current scale so the background is not visibly
 * resampled.
 */
export function nebulaImageForScale(
    images: NebulaData['images'], scale: number,
): string | null {
    if (scale > 0.75) {
        return images.zoom100 ?? images.zoom50 ?? images.zoom25;
    }
    if (scale > 0.375) {
        return images.zoom50 ?? images.zoom100 ?? images.zoom25;
    }
    return images.zoom25 ?? images.zoom50 ?? images.zoom100;
}

class SystemGraph {
    readonly container = new PIXI.Container();
    private readonly nebulaContainer = new PIXI.Container();
    private readonly nebulaSprites: [NebulaData, PIXI.Sprite][] = [];
    private readonly territoryContainer = new PIXI.Container();
    private territorySprite?: PIXI.Sprite;
    private territoryField?: TerritoryField;
    private territoryPoints: TerritoryPoint[] = [];
    private readonly graphics: PIXI.Graphics;
    private readonly links: [SystemData, SystemData][];
    private readonly systems: Map<string, SystemData>;
    private scale = MAP_SCALE_DEFAULT;
    private wheelBound = false;
    private dragData?: {
        offset: PIXI.Point,
    }
    private wrappedRoute: string[] = [];
    private routes: Map<string, string[]>;
    private knownSystems?: Set<string>;
    private systemCircles: Map<string, [PIXI.Container, PIXI.Graphics]>;
    private mapContainer: PIXI.Container;
    private maskedContainer: PIXI.Container;
    private missionMarkers = new Map<string, MissionMarkerType>();

    constructor(
        systems: SystemData[],
        private currentSystem: string,
        exploredSystems?: readonly string[],
        private readonly onSystemSelected: (systemId: string) => void = () => {},
        private readonly isVisible: () => boolean = () => true,
        private size = MAP_WELL.size) {
        this.systems = new Map(systems.map(s => [s.id, s]));
        this.knownSystems = normalizeKnownSystems(
            exploredSystems, this.currentSystem);
        this.routes = this.computeShortestPaths();

        this.graphics = new PIXI.Graphics();

        this.container.interactive = true;
        this.container.hitArea = new PIXI.Rectangle(
            0, 0, size.x, size.y);
        const onDragStart = this.onDragStart.bind(this);
        const onDragMove = this.onDragMove.bind(this);
        const onDragEnd = this.onDragEnd.bind(this);
        this.container.on('mousedown', onDragStart)
            .on('touchstart', onDragStart)
            .on('mouseup', onDragEnd)
            .on('mouseupoutside', onDragEnd)
            .on('touchend', onDragEnd)
            .on('touchendoutside', onDragEnd)
            .on('mousemove', onDragMove)
            .on('touchmove', onDragMove);

        this.mapContainer = new PIXI.Container();
        // Nebulae are background artwork, so they go under the territory
        // shading, the links, the route and the system markers.
        this.mapContainer.addChild(this.nebulaContainer);
        // Government territory is background shading, so it goes under the
        // links, the route and the system markers.
        this.mapContainer.addChild(this.territoryContainer);
        this.mapContainer.addChild(this.graphics);

        this.maskedContainer = new PIXI.Container();
        const mask = new PIXI.Graphics();
        mask.lineStyle(1);
        mask.beginFill(0xff0000);
        mask.drawRect(0, 0, size.x, size.y);
        this.maskedContainer.mask = mask;
        this.container.addChild(mask);

        this.maskedContainer.addChild(this.mapContainer);
        this.container.addChild(this.maskedContainer);

        this.links = [...this.getUniqueLinks()];

        this.systemCircles = new Map(systems.map(s => {
            const graphics = new PIXI.Graphics();
            drawSystem(s, graphics, this.scale, this.currentSystem);
            const container = new PIXI.Container();
            const circleContainer = new PIXI.Container();
            container.addChild(circleContainer);
            circleContainer.interactive = true;
            circleContainer.on('click', () => {
                this.onClickSystem(s.id);
            });
            circleContainer.addChild(graphics);

            const nameText = new PIXI.Text(s.name, SYSTEM_TEXT);
            nameText.position.x = 10;
            nameText.anchor.y = 0.5;
            container.addChild(nameText);

            this.mapContainer.addChild(container);
            return [s.id, [container, graphics]]
        }));

        this.draw();
    }

    center() {
        const system = this.systems.get(this.currentSystem);
        if (system) {
            const pos = this.scalePos(system.position);
            this.mapContainer.position.set(
                this.size.x / 2 - pos[0],
                this.size.y / 2 - pos[1]
            );
            this.updateTransform();
        }
    }

    set route(route: string[]) {
        this.wrappedRoute = route;
        this.draw();
    }

    setKnownSystems(exploredSystems?: readonly string[], redraw = true) {
        const knownSystems = normalizeKnownSystems(
            exploredSystems, this.currentSystem);
        if (sameSystemSet(this.knownSystems, knownSystems)) {
            return;
        }
        this.knownSystems = knownSystems;
        this.routes = this.computeShortestPaths();
        if (this.territoryPoints.length > 0) {
            this.rebuildTerritory();
        }
        if (redraw) {
            this.draw();
        }
    }

    private playerMarkers = new Map<string, StarmapPlayerMarker[]>();

    setPlayerMarkers(markers: readonly StarmapPlayerMarker[] | undefined, redraw = true) {
        const bySystem = new Map<string, StarmapPlayerMarker[]>();
        for (const m of markers ?? []) {
            let list = bySystem.get(m.systemId);
            if (!list) {
                list = [];
                bySystem.set(m.systemId, list);
            }
            list.push(m);
        }
        this.playerMarkers = bySystem;
        if (redraw) {
            this.draw();
        }
    }

    setMissionMarkers(activeMissions?: readonly ActiveMission[], redraw = true) {
        this.missionMarkers = getMissionDestinationMarkers(
            activeMissions, [...this.systems.values()]);
        if (redraw) {
            this.draw();
        }
    }

    get route() {
        return this.wrappedRoute;
    }

    draw(scale = this.scale) {
        this.mapContainer.cacheAsBitmap = false;
        this.scale = clampMapScale(scale);
        this.graphics.clear();
        this.placeNebulae();
        this.placeTerritory();
        this.drawLinks();
        this.drawRoute();
        this.placeSystems();
        this.mapContainer.cacheAsBitmap = true;
    }

    bindWheel() {
        if (this.wheelBound) {
            return;
        }
        this.container.on('wheel', this.onWheel, this);
        this.wheelBound = true;
    }

    unbindWheel() {
        if (!this.wheelBound) {
            return;
        }
        this.container.off('wheel', this.onWheel, this);
        this.wheelBound = false;
    }

    private onDragStart(event: PIXI.FederatedPointerEvent) {
        const dragPos = this.container.toLocal(event.global);
        const offset = new PIXI.Point(
            this.mapContainer.position.x - dragPos.x,
            this.mapContainer.position.y - dragPos.y,
        );
        this.dragData = {
            offset,
        }
    }

    private onDragMove(event: PIXI.FederatedPointerEvent) {
        if (this.dragData) {
            const dragPos = this.container.toLocal(event.global);
            this.mapContainer.position.set(
                dragPos.x + this.dragData.offset.x,
                dragPos.y + this.dragData.offset.y,
            );
        }
    }

    private updateTransform() {
        // Since the map is cached as a bitmap, this updates the positions
        // of the system circles so they can be clicked again.
        this.mapContainer.updateLocalTransform();
    }

    private onDragEnd() {
        this.dragData = undefined;
        this.updateTransform();
    }

    private onWheel(event: PIXI.FederatedWheelEvent) {
        if (!this.isVisible()) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        (event.nativeEvent as Event)?.preventDefault?.();
        const nextScale = mapScaleForWheel(this.scale, event.deltaY);
        if (nextScale === this.scale) {
            return;
        }
        const pointer = this.container.toLocal(event.global);
        const nextPosition = zoomedMapPosition(
            this.mapContainer.position,
            pointer,
            this.scale,
            nextScale,
        );
        this.draw(nextScale);
        this.mapContainer.position.set(nextPosition.x, nextPosition.y);
        this.updateTransform();
    }

    private onClickSystem(system: string) {
        if (this.knownSystems && !this.knownSystems.has(system)) {
            return;
        }
        this.route = this.routes.get(system) ?? [];
        this.onSystemSelected(system);
    }

    isKnown(systemId: string): boolean {
        return !this.knownSystems || this.knownSystems.has(systemId);
    }

    getSystem(systemId: string): SystemData | undefined {
        return this.systems.get(systemId);
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

    /**
     * Colours in the space controlled by each government. Only systems the
     * pilot has visited contribute, so the overlay cannot reveal unexplored
     * space.
     */
    setTerritory(points: readonly TerritoryPoint[]) {
        this.territoryPoints = [...points];
        this.rebuildTerritory();
    }

    private rebuildTerritory() {
        this.territoryField = computeTerritoryField(this.territoryPoints);
        if (this.territorySprite) {
            this.territoryContainer.removeChild(this.territorySprite);
            this.territorySprite.destroy({ texture: true });
            this.territorySprite = undefined;
        }
        const field = this.territoryField;
        if (field) {
            const source = new PIXI.BufferImageSource({
                resource: new Uint8Array(field.pixels),
                width: field.width,
                height: field.height,
            });
            // Linear filtering is what turns the coarse field into the
            // smooth gradient between neighbouring governments.
            source.style.scaleMode = 'linear';
            const texture = new PIXI.Texture({ source });
            const sprite = new PIXI.Sprite(texture);
            sprite.alpha = TERRITORY_ALPHA;
            this.territorySprite = sprite;
            this.territoryContainer.addChild(sprite);
        }
        // The map is cached as a bitmap, so it has to be redrawn once the
        // asynchronously loaded colours arrive.
        this.draw();
    }

    private placeTerritory() {
        const field = this.territoryField;
        const sprite = this.territorySprite;
        if (!field || !sprite) {
            return;
        }
        const [x, y] = this.scalePos([field.origin.x, field.origin.y]);
        sprite.position.set(x, y);
        sprite.width = field.size.x * this.scale;
        sprite.height = field.size.y * this.scale;
    }

    private placeSystems() {
        for (const [id, [container, graphics]] of this.systemCircles) {
            const system = this.systems.get(id);
            if (!system) {
                container.visible = false;
                console.warn(`missing system ${id}`);
                continue;
            }
            container.visible = true;
            const pos = this.scalePos(system.position);
            graphics.clear();
            drawSystem(system, graphics, this.scale, this.currentSystem, this.missionMarkers.get(id), this.playerMarkers.get(id));
            container.position.set(...pos);
        }
    }

    addNebula(nebula: NebulaData, sprite: PIXI.Sprite) {
        this.nebulaSprites.push([nebula, sprite]);
        this.nebulaContainer.addChild(sprite);
        this.placeNebulae();
        // The map is cached as a bitmap, so it must be redrawn once the
        // asynchronously loaded artwork arrives.
        this.draw();
    }

    private placeNebulae() {
        for (const [nebula, sprite] of this.nebulaSprites) {
            const [x, y] = this.scalePos(
                [nebula.position.x, nebula.position.y]);
            sprite.position.set(x, y);
            sprite.width = nebula.size.x * this.scale;
            sprite.height = nebula.size.y * this.scale;
        }
    }

    private scalePos(pos: [number, number]): [number, number] {
        return pos.map(p => p * this.scale) as [number, number];
    }

    private drawLinks() {
        for (const [source, dest] of this.links) {
            this.drawLink(source, dest);
        }
    }

    private drawRoute() {
        let prev = this.systems.get(this.currentSystem);
        for (const system of this.route.map(id => this.systems.get(id))) {
            if (system) {
                if (prev) {
                    this.drawLink(prev, system, 0x00ff00, 3);
                }
                prev = system;
            }
        }
    }

    private drawLink(a: SystemData, b: SystemData,
        color = GREY, thickness = 1) {
        const posA = this.scalePos(a.position);
        const posB = this.scalePos(b.position);
        this.graphics.moveTo(posA[0], posA[1]);
        this.graphics.lineTo(posB[0], posB[1]);
        this.graphics.stroke({ width: thickness, color });
    }

    private computeShortestPaths() {
        return shortestRoutes(
            [...this.systems.values()],
            this.currentSystem,
        );
    }
}

export class Starmap extends Menu<string[] /* route list of systems */> {
    private systemGraph?: SystemGraph;
    private readonly viewState: StarmapViewState = { centeredOnce: false };
    private readonly planetDataCache =
        new Map<string, Promise<readonly PlanetData[]>>();
    private readonly governmentDataCache =
        new Map<string, Promise<GovtData | undefined>>();
    private selectedSystemId?: string;
    private playerState?: StarmapPlayerState;
    private panelRequest = 0;
    private readonly panelHeading: PIXI.Text;
    private readonly panelBody: PIXI.Text;
    private readonly panelBottom: PIXI.Text;
    private readonly panelDate: PIXI.Text;
    readonly managed: ManagedGraphic = createGraphicHandle(this.container);

    constructor(gameData: GameData, private systemId: string,
        controlEvents: Observable<ControlEvent>,
        private exploredSystems?: readonly string[]) {
        super(gameData, "nova:8509", controlEvents);
        this.container.name = "StarMap";
        this.panelHeading = addMaskedText(
            this.container,
            STARMAP_LAYOUT.rightHeading,
            STARMAP_HEADING,
        );
        this.panelBody = addMaskedText(
            this.container,
            STARMAP_LAYOUT.rightBody,
            STARMAP_BODY,
        );
        this.panelBottom = addMaskedText(
            this.container,
            STARMAP_LAYOUT.bottomFacts,
            STARMAP_BOTTOM,
        );
        this.panelDate = addMaskedText(
            this.container,
            STARMAP_LAYOUT.date,
            STARMAP_DATE,
        );
        //this.container.alpha = 0.5;
        const buttons = {
            done: new Button(gameData, "Done", 120, { x: 150, y: 220 }),
        };
        this.addButtons(buttons);

        buttons.done.click.subscribe(this.done.bind(this));

        this.controls = new MenuControls(controlEvents, {
            // TODO: Bind tab to cycle destinations
            depart: this.done.bind(this),
            map: this.done.bind(this),
        });

    }
    override async build() {
        await super.build();
        const systemIds = (await this.gameData.ids).System;
        const systems = await Promise.all(
            systemIds.map(s => this.gameData.data.System.get(s)));
        this.systemGraph = new SystemGraph(
            systems,
            this.systemId,
            this.exploredSystems,
            this.selectSystem.bind(this),
            () => this.container.visible,
        );
        const well = mapWellOrigin();
        this.systemGraph.container.position.set(well.x, well.y);
        this.container.addChild(this.systemGraph.container);
        // Nebula artwork is large and purely decorative, so it is loaded
        // after the map itself is usable.
        void this.loadNebulae();
        // The overlay needs a government lookup per claimed system, so it is
        // filled in after the map itself is usable.
        void this.loadTerritory(systems);
    }

    private async loadNebulae() {
        const nebulaData = this.gameData.data.Nebula;
        if (!nebulaData) {
            return;
        }
        const ids = (await this.gameData.ids).Nebula ?? [];
        await Promise.all(ids.map(async id => {
            try {
                const nebula = await nebulaData.get(id);
                // Keep one cached nebula asset while zooming; the sprite is
                // rescaled with the map instead of reloading on every wheel.
                const image = nebulaImageForScale(
                    nebula.images, MAP_SCALE_DEFAULT);
                if (!image || !this.systemGraph) {
                    return;
                }
                const sprite = await this.gameData.spriteFromPictAsync(image);
                if (!this.systemGraph || this.managed.disposed) {
                    return;
                }
                this.systemGraph.addNebula(nebula, sprite);
            } catch (e) {
                console.warn(`Could not load nebula ${id}`, e);
            }
        }));
    }

    /**
     * Territory colours come from each controlling government's `gövt` map
     * colour, which is the colour retail uses for that empire.
     */
    private async loadTerritory(systems: readonly SystemData[]) {
        const govtData = this.gameData.data.Govt;
        if (!govtData) {
            return;
        }
        const claimed = systems.filter(system =>
            system.government !== undefined && system.government >= 128);
        const colors = new Map<number, number | undefined>();
        const governments = [...new Set(claimed.map(
            system => system.government as number))];
        await Promise.all(governments.map(async government => {
            try {
                const govt = await govtData.get(resourceId(government));
                colors.set(government, govt.color);
            } catch (error) {
                console.warn(`Could not load government ${government}`, error);
                colors.set(government, undefined);
            }
        }));
        if (!this.systemGraph || this.managed.disposed) {
            return;
        }
        const points: TerritoryPoint[] = [];
        for (const system of claimed) {
            const color = colors.get(system.government as number);
            if (color === undefined) {
                continue;
            }
            points.push({
                x: system.position[0],
                y: system.position[1],
                color,
                systemId: system.id,
            });
        }
        this.systemGraph.setTerritory(points);
    }

    override async show(route: string[]) {
        await this.buildPromise
        if (!this.systemGraph) {
            throw new Error('Expected system graph to be built')
        }
        // A newly constructed system world centers once after the asynchronous
        // graph build. Reopening in that same world preserves the player's pan.
        if (consumeInitialCenter(this.viewState)) {
            this.systemGraph.center();
        }
        this.selectedSystemId ??= this.currentSystemId();
        void this.renderPanel(this.selectedSystemId);
        this.systemGraph.route = route;
        this.systemGraph.bindWheel();
        try {
            return await super.show(route);
        } finally {
            this.systemGraph.unbindWheel();
        }
    }

    private playerMarkersList: readonly StarmapPlayerMarker[] = [];

    setPlayerMarkers(markers?: readonly StarmapPlayerMarker[]) {
        this.playerMarkersList = markers ?? [];
        this.systemGraph?.setPlayerMarkers(markers);
        if (this.container.visible && this.selectedSystemId) {
            void this.renderPanel(this.selectedSystemId);
        }
    }

    setPlayerState(playerState?: StarmapPlayerState) {
        this.playerState = playerState
            ? {
                ...playerState,
                legalRecords: playerState.legalRecords
                    ? { ...playerState.legalRecords } : undefined,
                activeMissions: playerState.activeMissions
                    ? [...playerState.activeMissions] : undefined,
            }
            : undefined;
        this.systemGraph?.setMissionMarkers(playerState?.activeMissions, false);
        if (this.container.visible && this.selectedSystemId) {
            void this.renderPanel(this.selectedSystemId);
        }
    }

    setExploredSystems(exploredSystems?: readonly string[]) {
        this.exploredSystems = exploredSystems;
        this.systemGraph?.setKnownSystems(exploredSystems);
        if (this.container.visible && this.selectedSystemId) {
            void this.renderPanel(this.selectedSystemId);
        }
    }

    attachTo(parent: PIXI.Container): void {
        if (!this.managed.disposed && this.container.parent !== parent) {
            parent.addChild(this.container);
        }
    }

    dispose(): void {
        this.systemGraph?.unbindWheel();
        this.managed.dispose();
    }

    override done() {
        if (this.systemGraph) {
            this.input = this.systemGraph.route;
        }
        super.done();
    }

    private currentSystemId(): string {
        return this.playerState?.currentSystem ?? this.systemId;
    }

    private selectSystem(systemId: string) {
        this.selectedSystemId = systemId;
        void this.renderPanel(systemId);
    }

    private setPanelLoading(
        system: SystemData | undefined,
        known: boolean,
    ) {
        const heading = system?.id === this.currentSystemId()
            ? 'Current System' : 'Selected System';
        this.panelHeading.text = `${heading}:`;
        this.panelBody.text = known ? system?.name ?? '' : '';
        this.panelBottom.text = '';
        this.panelDate.text = formatGameDate(
            this.playerState?.gameDate ?? 0);
    }

    private setPanelData(panel: ReturnType<typeof starmapPanelData>) {
        const text = starmapPanelText(panel);
        this.panelHeading.text = text.heading;
        this.panelBody.text = text.body;
        this.panelBottom.text = text.bottom;
        this.panelDate.text = text.date;
    }

    private async planetsFor(
        system: SystemData,
    ): Promise<readonly PlanetData[]> {
        const cached = this.planetDataCache.get(system.id);
        if (cached) {
            return cached;
        }
        const load = Promise.all(system.planets.map(async id => {
            try {
                return await this.gameData.data.Planet.get(id);
            } catch {
                return undefined;
            }
        })).then(planets => planets.filter(
            (planet): planet is PlanetData => planet !== undefined));
        this.planetDataCache.set(system.id, load);
        return load;
    }

    private async governmentFor(
        system: SystemData,
    ): Promise<GovtData | undefined> {
        if (system.government === undefined || system.government < 0) {
            return undefined;
        }
        const id = resourceId(system.government);
        const cached = this.governmentDataCache.get(id);
        if (cached) {
            return cached;
        }
        const load = (async () => {
            try {
                return await this.gameData.data.Govt?.get(id);
            } catch {
                return undefined;
            }
        })();
        this.governmentDataCache.set(id, load);
        return load;
    }

    private async renderPanel(systemId: string) {
        const request = ++this.panelRequest;
        const graph = this.systemGraph;
        if (!graph) {
            return;
        }
        const system = graph.getSystem(systemId);
        const known = !!system && graph.isKnown(systemId);
        this.setPanelLoading(system, known);
        if (!system || !known) {
            return;
        }
        const [planets, government] = await Promise.all([
            this.planetsFor(system),
            this.governmentFor(system),
        ]);
        if (request !== this.panelRequest
            || this.selectedSystemId !== systemId) {
            return;
        }
        const transmissions = this.playerMarkersList
            .filter(p => p.systemId === systemId)
            .map(p => `[${p.kind === 'sos' ? 'SOS' : 'PILOT'}] ${p.name}`);

        this.setPanelData(starmapPanelData({
            system,
            currentSystemId: this.currentSystemId(),
            known,
            planets,
            government,
            legalRecords: this.playerState?.legalRecords,
            gameDate: this.playerState?.gameDate ?? 0,
            transmissions,
        }));
    }
}
