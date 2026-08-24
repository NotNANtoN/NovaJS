import { MissionData, MissionOfferLocation } from 'novadatainterface/MissionData';
import { PlanetData } from 'novadatainterface/PlanetData';
import { SystemData } from 'novadatainterface/SystemData';
import { Entity } from 'nova_ecs/entity';
import * as PIXI from 'pixi.js';
import { Observable } from 'rxjs';
import { GameData } from '../client/gamedata/GameData';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import {
    acceptMission,
    abortMission,
    formatMissionText,
    MissionDestinationOptions,
    refuseMission,
} from '../nova_plugin/mission_plugin';
import {
    getOfferableMissions,
    MissionPlanetSelector,
    resolveMissionCompletionDestination,
    resolveStellarSelector,
} from '../nova_plugin/mission_availability';
import {
    ActiveMission,
    formatGameDate,
    PlayerStateComponent,
} from '../nova_plugin/player_state';
import { Button } from './button';
import { Menu } from './menu';
import { MenuControls } from './menu_controls';

const MISSION_FONT = {
    title: {
        fontFamily: 'Geneva', fontSize: 16, fill: 0xffffff, align: 'center',
    } as const,
    flavor: {
        fontFamily: 'Geneva', fontSize: 10, fill: 0xffffff,
        align: 'left', wordWrap: true, wordWrapWidth: 420,
    } as const,
    list: {
        fontFamily: 'Geneva', fontSize: 10, fill: 0xffffff,
        align: 'left', wordWrap: true, wordWrapWidth: 205,
    } as const,
    detail: {
        fontFamily: 'Geneva', fontSize: 10, fill: 0xffffff,
        align: 'left', wordWrap: true, wordWrapWidth: 215,
    } as const,
    status: {
        fontFamily: 'Geneva', fontSize: 10, fill: 0xffff00,
        align: 'left', wordWrap: true, wordWrapWidth: 420,
    } as const,
};

export interface MissionBoardWorld {
    systems: readonly SystemData[];
    planets: readonly MissionPlanetSelector[];
    planetNames: ReadonlyMap<string, string>;
    systemNames: ReadonlyMap<string, string>;
}

const worldCache = new WeakMap<GameData, Promise<MissionBoardWorld>>();
const catalogCache = new WeakMap<GameData, Promise<Map<string, MissionData>>>();

async function loadMissionWorld(gameData: GameData): Promise<MissionBoardWorld> {
    const cached = worldCache.get(gameData);
    if (cached) {
        return cached;
    }

    const promise = (async () => {
        const ids = await gameData.ids;
        const systems = (await Promise.all((ids.System ?? []).map(async id => {
            try {
                return await gameData.data.System.get(id);
            } catch {
                return undefined;
            }
        }))).filter((system): system is SystemData => system !== undefined);

        const planetIds = [...new Set(systems.flatMap(system => system.planets))];
        const planetsWithData = await Promise.all(planetIds.map(async id => {
            try {
                const planet = await gameData.data.Planet.get(id);
                return [planet, id] as const;
            } catch {
                return undefined;
            }
        }));
        const planets: MissionPlanetSelector[] = planetsWithData
            .filter((entry): entry is readonly [PlanetData, string] =>
                entry !== undefined)
            .map(([planet, id]) => ({
                id,
                // PlanetData does not expose habitation yet. The missions
                // currently represented by the client use landing planets.
                inhabited: true,
            }));
        const planetNames = new Map(
            planetsWithData
                .filter((entry): entry is readonly [PlanetData, string] =>
                    entry !== undefined)
                .map(([planet, id]) => [id, planet.name]),
        );
        const systemNames = new Map(systems.map(system => [system.id, system.name]));
        return { systems, planets, planetNames, systemNames };
    })();
    worldCache.set(gameData, promise);
    return promise;
}

async function loadMissionCatalog(
    gameData: GameData,
): Promise<Map<string, MissionData>> {
    const cached = catalogCache.get(gameData);
    if (cached) {
        return cached;
    }

    const promise = (async () => {
        const ids = await gameData.ids;
        const entries = await Promise.all((ids.Mission ?? []).map(async id => {
            try {
                return [id, await gameData.data.Mission.get(id)] as const;
            } catch {
                return undefined;
            }
        }));
        return new Map(entries.filter(
            (entry): entry is readonly [string, MissionData] =>
                entry !== undefined,
        ));
    })();
    catalogCache.set(gameData, promise);
    return promise;
}

function firstBriefLine(mission: MissionData): string {
    const text = mission.quickBrief || mission.briefText || mission.offerText;
    return text.split(/\r?\n/, 1)[0] || 'Mission briefing unavailable.';
}

function sameId(a: string, b: string) {
    return a === b || a.replace(/^.*:/, '') === b.replace(/^.*:/, '');
}

function planetName(
    id: string | '*' | undefined,
    world: MissionBoardWorld,
): string {
    if (!id || id === '*') {
        return 'any destination';
    }
    for (const [planetId, name] of world.planetNames) {
        if (sameId(planetId, id)) {
            return name;
        }
    }
    return id;
}

function systemNameForPlanet(
    id: string | '*' | undefined,
    world: MissionBoardWorld,
): string | undefined {
    if (!id || id === '*') {
        return undefined;
    }
    const system = world.systems.find(system =>
        system.planets.some(planetId => sameId(planetId, id)));
    return system ? world.systemNames.get(system.id) : undefined;
}

function missionValues(
    mission: MissionData,
    planetId: string,
    world: MissionBoardWorld,
    stateDate: number,
) {
    const destination = resolveMissionCompletionDestination(
        mission,
        planetId,
        { planets: world.planets, random: () => 0 },
    );
    const travelDestination = resolveStellarSelectorForText(
        mission.travelStel, planetId, world);
    const returnDestination = resolveStellarSelectorForText(
        mission.returnStel, planetId, world);
    const destinationLabel = planetName(travelDestination ?? destination, world);
    const returnLabel = planetName(returnDestination ?? destination, world);
    const destinationSystem = systemNameForPlanet(
        travelDestination ?? destination, world);
    const returnSystem = systemNameForPlanet(
        returnDestination ?? destination, world);
    return {
        destination: destinationLabel,
        destinationSystem,
        returnDestination: returnLabel,
        returnSystem,
        cargo: mission.cargo ?? undefined,
        quantity: mission.cargoQty >= 0 ? mission.cargoQty : undefined,
        deadline: mission.timeLimit > 0
            ? formatGameDate(stateDate + mission.timeLimit)
            : undefined,
        pay: mission.payVal > 0 ? mission.payVal : undefined,
    };
}

function resolveStellarSelectorForText(
    selector: number,
    planetId: string,
    world: MissionBoardWorld,
) {
    return resolveStellarSelector(selector, {
        initialPlanetId: planetId,
        planets: world.planets,
        random: () => 0,
    });
}

export class MissionInfo extends Menu<Entity> {
    private readonly title = new PIXI.Text('Active Missions', MISSION_FONT.title);
    private readonly list = new PIXI.Text('', MISSION_FONT.list);
    private readonly detail = new PIXI.Text('', MISSION_FONT.detail);
    private readonly status = new PIXI.Text('', MISSION_FONT.status);
    private readonly abortButton: Button;
    private entries: Array<{
        entry: ActiveMission;
        mission: MissionData;
    }> = [];
    private selectionIndex = -1;

    constructor(
        gameData: GameData,
        controlEvents: Observable<ControlEvent>,
    ) {
        super(gameData, 'nova:8500', controlEvents);
        this.abortButton = new Button(gameData, 'Abort', 65, { x: -60, y: 190 });
        const done = new Button(gameData, 'Done', 65, { x: 60, y: 190 });
        this.addButtons({ abort: this.abortButton, done });
        this.abortButton.click.subscribe(() => this.abortSelected());
        done.click.subscribe(this.done.bind(this));

        this.title.anchor.x = 0.5;
        this.title.position.set(0, -205);
        this.list.position.set(-290, -170);
        this.detail.position.set(-40, -170);
        this.status.position.set(-290, 155);
        this.container.addChild(
            this.title, this.list, this.detail, this.status);
        this.controls = new MenuControls(controlEvents, {
            up: () => this.moveSelection(-1),
            down: () => this.moveSelection(1),
            buy: () => this.abortSelected(),
            missions: this.done.bind(this),
            depart: this.done.bind(this),
        });
    }

    override async show(input: Entity): Promise<Entity> {
        await this.buildPromise;
        this.setInput(input);
        await this.refresh();
        return super.show(input);
    }

    private async refresh() {
        const state = this.input.components.get(PlayerStateComponent);
        this.entries = [];
        if (state) {
            const missions = await Promise.all(state.activeMissions
                .filter(entry => entry.state === 'active' || entry.state === 'failed')
                .map(async entry => {
                    try {
                        const mission = await this.gameData.data.Mission.get(entry.missionId);
                        return {
                            entry,
                            mission,
                        };
                    } catch {
                        return undefined;
                    }
                }));
            this.entries = missions.filter((entry): entry is {
                entry: ActiveMission;
                mission: MissionData;
            } => entry !== undefined);
        }
        this.selectionIndex = this.entries.length > 0 ? 0 : -1;
        this.render();
    }

    private moveSelection(delta: number) {
        if (this.entries.length === 0) {
            return;
        }
        this.selectionIndex = Math.max(
            0,
            Math.min(this.entries.length - 1, this.selectionIndex + delta),
        );
        this.render();
    }

    private render() {
        if (this.entries.length === 0 || this.selectionIndex < 0) {
            this.list.text = 'No active missions.';
            this.detail.text = '';
            this.abortButton.state = 'grey';
            return;
        }
        this.list.text = this.entries.map(({ entry, mission }, index) =>
            `${index === this.selectionIndex ? '▶ ' : '  '}${mission.name}`
            + ` [${entry.state}]`).join('\n');
        const selected = this.entries[this.selectionIndex];
        if (!selected) {
            return;
        }
        this.abortButton.state = selected.mission.canAbort
            && selected.entry.state === 'active' ? 'normal' : 'grey';
        const destination = planetName(selected.entry.destination, {
            systems: [], planets: [], planetNames: new Map(), systemNames: new Map(),
        });
        this.detail.text = formatMissionText(
            selected.mission.quickBrief || selected.mission.briefText
            || 'Mission briefing unavailable.',
            {
                destination,
                returnDestination: destination,
                cargo: selected.mission.cargo ?? undefined,
                quantity: selected.entry.cargo?.quantity,
                pay: selected.mission.payVal > 0
                    ? selected.mission.payVal : undefined,
            },
        );
        this.status.text = selected.entry.state === 'failed'
            ? 'This mission has failed. Land anywhere to dismiss the report.'
            : selected.mission.canAbort
                ? 'Select Abort to cancel this mission.'
                : 'This mission cannot be aborted.';
    }

    private abortSelected() {
        const selected = this.entries[this.selectionIndex];
        const state = this.input.components.get(PlayerStateComponent);
        if (!selected || !state
            || !selected.mission.canAbort
            || selected.entry.state !== 'active') {
            return;
        }
        if (abortMission(state, selected.entry, selected.mission)) {
            this.status.text = 'Mission aborted.';
            void this.refresh();
        }
    }
}

/**
 * Shared BBS/bar implementation. The two public subclasses only select the
 * Bible AvailLoc and their flavor copy.
 */
export abstract class MissionBoard extends Menu<Entity> {
    private readonly title: PIXI.Text;
    private readonly flavor: PIXI.Text;
    private readonly list: PIXI.Text;
    private readonly detail: PIXI.Text;
    private readonly status: PIXI.Text;
    private offers: MissionData[] = [];
    private world?: MissionBoardWorld;
    private selectionIndex = -1;
    private readonly planetId: string;
    private readonly offerLocation: MissionOfferLocation;
    private readonly onInfo?: () => void | Promise<void>;

    constructor(
        gameData: GameData,
        planetId: string,
        controlEvents: Observable<ControlEvent>,
        offerLocation: MissionOfferLocation,
        flavorText: string,
        onInfo?: () => void | Promise<void>,
    ) {
        super(gameData, 'nova:8500', controlEvents);
        this.planetId = planetId;
        this.offerLocation = offerLocation;
        this.onInfo = onInfo;

        this.title = new PIXI.Text(
            offerLocation === MissionOfferLocation.Bar
                ? 'The Bar' : 'Mission Computer',
            MISSION_FONT.title,
        );
        this.flavor = new PIXI.Text(flavorText, MISSION_FONT.flavor);
        this.list = new PIXI.Text('', MISSION_FONT.list);
        this.detail = new PIXI.Text('', MISSION_FONT.detail);
        this.status = new PIXI.Text('', MISSION_FONT.status);
        this.title.anchor.x = 0.5;
        this.title.position.set(0, -210);
        this.flavor.position.set(-210, -190);
        this.list.position.set(-290, -125);
        this.detail.position.set(-40, -125);
        this.status.position.set(-290, 150);

        const accept = new Button(gameData, 'Accept', 70, { x: -120, y: 190 });
        const refuse = new Button(gameData, 'Refuse', 70, { x: -40, y: 190 });
        const info = new Button(gameData, 'Missions', 80, { x: 55, y: 190 });
        const done = new Button(gameData, 'Done', 60, { x: 150, y: 190 });
        this.addButtons({ accept, refuse, info, done });
        accept.click.subscribe(() => this.acceptSelected());
        refuse.click.subscribe(() => this.refuseSelected());
        info.click.subscribe(() => this.onInfo?.());
        done.click.subscribe(this.done.bind(this));

        this.container.addChild(
            this.title, this.flavor, this.list, this.detail, this.status);
        this.controls = new MenuControls(controlEvents, {
            up: () => this.moveSelection(-1),
            down: () => this.moveSelection(1),
            buy: () => this.acceptSelected(),
            missions: () => this.onInfo?.(),
            depart: this.done.bind(this),
        });
    }

    override async show(input: Entity): Promise<Entity> {
        await this.buildPromise;
        this.setInput(input);
        await this.refreshOffers();
        return super.show(input);
    }

    private async refreshOffers() {
        const state = this.input.components.get(PlayerStateComponent);
        if (!state) {
            this.offers = [];
            this.render();
            return;
        }
        const [world, missions] = await Promise.all([
            loadMissionWorld(this.gameData),
            loadMissionCatalog(this.gameData),
        ]);
        this.world = world;
        const currentSystem = world.systems.find(system =>
            sameId(system.id, state.currentSystem)) ?? {
                id: state.currentSystem,
                links: [],
                planets: [],
            };
        this.offers = getOfferableMissions({
            missionIds: [...missions.keys()],
            missions,
            playerState: state,
            currentPlanet: { id: this.planetId, inhabited: true },
            currentSystem,
            offerLocation: this.offerLocation,
            destinationPlanets: world.planets,
            destinationSystems: world.systems,
        }).sort((a, b) => b.displayWeight - a.displayWeight);
        this.selectionIndex = this.offers.length > 0 ? 0 : -1;
        this.render();
    }

    private moveSelection(delta: number) {
        if (this.offers.length === 0) {
            return;
        }
        this.selectionIndex = Math.max(
            0,
            Math.min(this.offers.length - 1, this.selectionIndex + delta),
        );
        this.render();
    }

    private destinationOptions(): MissionDestinationOptions {
        return {
            initialPlanetId: this.planetId,
            planets: this.world?.planets,
        };
    }

    private render() {
        if (this.offers.length === 0 || this.selectionIndex < 0) {
            this.list.text = 'No missions are available here.';
            this.detail.text = '';
            return;
        }
        const world = this.world;
        if (!world) {
            return;
        }
        this.list.text = this.offers.map((mission, index) =>
            `${index === this.selectionIndex ? '▶ ' : '  '}${mission.name}`
            + `\n   ${firstBriefLine(mission)}`).join('\n');
        const mission = this.offers[this.selectionIndex];
        if (!mission) {
            return;
        }
        const state = this.input.components.get(PlayerStateComponent);
        const values = missionValues(
            mission, this.planetId, world, state?.gameDate ?? 0);
        this.detail.text = formatMissionText(
            mission.briefText || mission.quickBrief || mission.offerText
            || 'Mission briefing unavailable.',
            values,
        );
        this.status.text = `Payment: ${mission.payVal > 0
            ? `${mission.payVal.toLocaleString()} cr` : 'none'}`
            + (mission.cargo ? `  Cargo: ${mission.cargo}` : '');
    }

    private acceptSelected() {
        const mission = this.offers[this.selectionIndex];
        const state = this.input.components.get(PlayerStateComponent);
        if (!mission || !state) {
            return;
        }
        const accepted = acceptMission(
            state, mission, this.destinationOptions());
        if (!accepted) {
            this.status.text = 'This mission cannot be accepted.';
            return;
        }
        this.status.text = `Mission accepted: ${mission.name}`;
        void this.refreshOffers();
    }

    private refuseSelected() {
        const mission = this.offers[this.selectionIndex];
        const state = this.input.components.get(PlayerStateComponent);
        if (!mission || !state) {
            return;
        }
        refuseMission(state, mission);
        this.status.text = formatMissionText(
            mission.refuseText || 'Mission refused.',
            missionValues(
                mission, this.planetId, this.world!, state.gameDate),
        );
        this.offers = this.offers.filter(entry => entry.id !== mission.id);
        this.selectionIndex = Math.min(
            this.selectionIndex, this.offers.length - 1);
        this.render();
    }
}

export class MissionBbs extends MissionBoard {
    constructor(
        gameData: GameData,
        planetId: string,
        controlEvents: Observable<ControlEvent>,
        onInfo?: () => void | Promise<void>,
    ) {
        super(
            gameData,
            planetId,
            controlEvents,
            MissionOfferLocation.MissionComputer,
            'The mission computer lists contracts currently posted by local employers.',
            onInfo,
        );
    }
}
