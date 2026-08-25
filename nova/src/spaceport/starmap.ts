import { SystemData } from "novadatainterface/SystemData";
import * as PIXI from 'pixi.js';
import { Observable } from "rxjs";
import { GameData } from "../client/gamedata/GameData";
import { ControlEvent } from "../nova_plugin/controls_plugin";
import { Button } from "./button";
import { Menu } from "./menu";
import { MenuControls } from "./menu_controls";
import { shortestRoutes } from "./route_planning";
import { createGraphicHandle, ManagedGraphic } from "../display/managed_graphic";

export { shortestRoute, shortestRoutes } from "./route_planning";


const GREY = 0x666666;
const BLUE = 0x0000BB;
const SYSTEM_TEXT = new PIXI.TextStyle({
    fontFamily: 'Geneva',
    fontSize: 10,
    align: 'left',
    fill: 0xffffff,
});

function drawSystem(system: SystemData, graphics: PIXI.Graphics, scale: number) {
    // Use blue if the system has a planet. Otherwise, grey.
    // TODO: Check if the planet is inhabited.
    const inhabited = system.planets.length > 0;
    const outColor = inhabited ? BLUE : GREY;
    const inColor = inhabited ? 0x000044 : 0x000000;
    graphics.lineStyle(1, outColor);
    graphics.beginFill(outColor)
    graphics.drawCircle(0, 0, 2.7 * scale);
    graphics.beginFill(inColor);
    graphics.drawCircle(0, 0, 1.8 * scale);
    graphics.endFill();
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

class SystemGraph {
    readonly container = new PIXI.Container();
    private readonly graphics: PIXI.Graphics;
    private readonly links: [SystemData, SystemData][];
    private readonly systems: Map<string, SystemData>;
    private scale = 2;
    private dragData?: {
        data: PIXI.FederatedPointerEvent,
        offset: PIXI.Point,
    }
    private wrappedRoute: string[] = [];
    private routes: Map<string, string[]>;
    private knownSystems?: Set<string>;
    private systemCircles: Map<string, [PIXI.Container, PIXI.Graphics]>;
    private mapContainer: PIXI.Container;
    private maskedContainer: PIXI.Container;

    constructor(systems: SystemData[], private currentSystem: string,
        exploredSystems?: readonly string[],
        private size = { x: 456, y: 419 }) {
        this.systems = new Map(systems.map(s => [s.id, s]));
        this.knownSystems = normalizeKnownSystems(
            exploredSystems, this.currentSystem);
        this.routes = this.computeShortestPaths();

        this.graphics = new PIXI.Graphics();

        this.container.interactive = true;
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
            drawSystem(s, graphics, this.scale);
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
        if (redraw) {
            this.draw();
        }
    }

    get route() {
        return this.wrappedRoute;
    }

    draw(scale = this.scale) {
        this.mapContainer.cacheAsBitmap = false;
        this.scale = scale;
        this.graphics.clear();
        this.drawLinks();
        this.drawRoute();
        this.placeSystems();
        this.mapContainer.cacheAsBitmap = true;
    }

    private onDragStart(event: PIXI.FederatedPointerEvent) {
        //const dragPos = event.data.getLocalPosition(this.container);

        const offset = new PIXI.Point(
            this.mapContainer.position.x - event.x,
            this.mapContainer.position.y - event.y,
        );
        this.dragData = {
            data: event,
            offset,
        }
    }

    private onDragMove() {
        if (this.dragData) {
            this.mapContainer.position.set(
                this.dragData.data.x + this.dragData.offset.x,
                this.dragData.data.y + this.dragData.offset.y,
            );
        }
    }

    private updateTransform() {
        // Since the map is cached as a bitmap, this updates the positions
        // of the system circles so they can be clicked again.
        this.mapContainer.containerUpdateTransform();
    }

    private onDragEnd() {
        this.dragData = undefined;
        this.updateTransform();
    }

    private onClickSystem(system: string) {
        if (this.knownSystems && !this.knownSystems.has(system)) {
            return;
        }
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

    private placeSystems() {
        for (const [id, [container, graphics]] of this.systemCircles) {
            const system = this.systems.get(id);
            if (!system) {
                container.visible = false;
                console.warn(`missing system ${id}`);
                continue;
            }
            container.visible = !this.knownSystems
                || this.knownSystems.has(id);
            const pos = this.scalePos(system.position);
            graphics.clear();
            drawSystem(system, graphics, this.scale);
            container.position.set(...pos);
        }
    }

    private scalePos(pos: [number, number]): [number, number] {
        return pos.map(p => p * this.scale) as [number, number];
    }

    private drawLinks() {
        for (const [source, dest] of this.links) {
            if (this.knownSystems
                && (!this.knownSystems.has(source.id)
                    || !this.knownSystems.has(dest.id))) {
                continue;
            }
            this.drawLink(source, dest)
        }
    }

    private drawRoute() {
        let prev = this.systems.get(this.currentSystem);
        for (const system of this.route.map(id => this.systems.get(id))) {
            if (system && (!this.knownSystems
                || (this.knownSystems.has(system.id)
                    && prev && this.knownSystems.has(prev.id)))) {
                if (prev) {
                    this.drawLink(prev, system, 0x00ff00, 3);
                }
                prev = system;
            }
        }
    }

    private drawLink(a: SystemData, b: SystemData,
        color = GREY, thickness = 1) {
        this.graphics.lineStyle(thickness, color);
        this.graphics.moveTo(...this.scalePos(a.position));
        this.graphics.lineTo(...this.scalePos(b.position));
    }

    private computeShortestPaths() {
        return shortestRoutes(
            [...this.systems.values()],
            this.currentSystem,
            this.knownSystems ? [...this.knownSystems] : undefined,
        );
    }
}

export class Starmap extends Menu<string[] /* route list of systems */> {
    private systemGraph?: SystemGraph;
    readonly managed: ManagedGraphic = createGraphicHandle(this.container);

    constructor(gameData: GameData, private systemId: string,
        controlEvents: Observable<ControlEvent>,
        private exploredSystems?: readonly string[]) {
        super(gameData, "nova:8509", controlEvents);
        this.container.name = "StarMap";
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
            systems, this.systemId, this.exploredSystems);
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

    setExploredSystems(exploredSystems?: readonly string[]) {
        this.exploredSystems = exploredSystems;
        this.systemGraph?.setKnownSystems(exploredSystems);
    }

    attachTo(parent: PIXI.Container): void {
        if (!this.managed.disposed && this.container.parent !== parent) {
            parent.addChild(this.container);
        }
    }

    dispose(): void {
        this.managed.dispose();
    }

    override done() {
        if (this.systemGraph) {
            this.input = this.systemGraph.route;
        }
        super.done();
    }
}
