import { MissionData, MissionOfferLocation } from 'novadatainterface/MissionData';
import { PlanetData } from 'novadatainterface/PlanetData';
import { SystemData } from 'novadatainterface/SystemData';
import { GovtData } from 'novadatainterface/GovtData';
import { STANDARD_COMMODITIES } from 'novadatainterface/CommodityData';
import { Entity } from 'nova_ecs/entity';
import * as PIXI from 'pixi.js';
import { Observable } from 'rxjs';
import { GameData } from '../client/gamedata/GameData';
import { resourceId } from '../common/resource_id';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import {
    acceptMission,
    abortMission,
    MissionDestinationOptions,
    PendingMissionJumpComponent,
    PendingMissionSoundComponent,
    resolveMissionDestinations,
    ResolvedMissionDestinations,
    refuseMission,
} from '../nova_plugin/mission_plugin';
import {
    formatVisibleMissionText,
    missionInfoDisplayText,
    missionOfferDisplayText,
} from '../nova_plugin/mission_text';
import { NcbRuntime } from '../nova_plugin/ncb_runtime';
import { ShipDataComponent } from '../nova_plugin/ship_plugin';
import {
    getOfferableMissions,
    MissionPlanetSelector,
} from '../nova_plugin/mission_availability';
import {
    ActiveMission,
    formatGameDate,
    getFreeSpace,
    PlayerState,
    PlayerStateComponent,
    setCargoCapacity,
} from '../nova_plugin/player_state';
import { OutfitsStateComponent } from '../nova_plugin/outfit_plugin';
import {
    generateProceduralMissions,
    ProceduralMissionOffer,
    seededRandom,
} from '../nova_plugin/procedural_missions';
import { Button } from './button';
import { Menu } from './menu';
import { MenuControls } from './menu_controls';
import {
    barOfferView,
    BAR_LAYOUT,
    fitLinesToHeight,
    MISSION_BBS_LAYOUT,
    MISSION_INFO_LAYOUT,
    MissionPanelLayout,
    preferRetailOffers,
    selectionPage,
} from './mission_bbs_layout';

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
    unavailableList: {
        fontFamily: 'Geneva', fontSize: 10, fill: 0x777777,
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
    governments: readonly GovtData[];
    planetNames: ReadonlyMap<string, string>;
    systemNames: ReadonlyMap<string, string>;
}

interface MissionOffer {
    mission: MissionData;
    resolved: ResolvedMissionDestinations;
    available: boolean;
}

function panelPosition(
    layout: MissionPanelLayout,
    region: { x: number; y: number },
) {
    return {
        x: region.x - layout.width / 2,
        y: region.y - layout.height / 2,
    };
}

function addViewportMask(
    owner: PIXI.Container,
    target: PIXI.Container,
    layout: MissionPanelLayout,
    region: { x: number; y: number; width: number; height: number },
) {
    const mask = new PIXI.Graphics();
    const position = panelPosition(layout, region);
    mask.beginFill(0xffffff);
    mask.drawRect(position.x, position.y, region.width, region.height);
    mask.endFill();
    target.mask = mask;
    owner.addChild(mask, target);
}

function preparedMission(
    mission: MissionData,
    seed: string,
): MissionData {
    const random = seededRandom(`${seed}:${mission.id}`);
    let cargo = mission.cargo;
    let cargoType = mission.cargoType;
    if (cargoType === 1000) {
        cargoType = Math.floor(random() * STANDARD_COMMODITIES.length);
        cargo = STANDARD_COMMODITIES[cargoType]!;
    }
    let cargoQty = mission.cargoQty;
    if (cargoQty <= -2) {
        const nominal = Math.abs(cargoQty);
        cargoQty = Math.max(1, Math.round(nominal * (0.5 + random())));
    }
    return {
        ...mission,
        cargoType,
        cargoQty,
        cargo: cargo?.replace(/^\*/, '') ?? null,
    };
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
                inhabited: planet.inhabited,
                government: planet.government,
                systemId: systems.find(system => system.planets.some(
                    planetId => sameId(planetId, id)))?.id,
            }));
        const govtGettable = gameData.data.Govt;
        const governments = govtGettable
            ? (await Promise.all((ids.Govt ?? []).map(async id => {
                try {
                    return await govtGettable.get(id);
                } catch {
                    return undefined;
                }
            }))).filter((govt): govt is GovtData => govt !== undefined)
            : [];
        const planetNames = new Map(
            planetsWithData
                .filter((entry): entry is readonly [PlanetData, string] =>
                    entry !== undefined)
                .map(([planet, id]) => [id, planet.name]),
        );
        const systemNames = new Map(systems.map(system => [system.id, system.name]));
        return { systems, planets, governments, planetNames, systemNames };
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
    resolved?: ResolvedMissionDestinations,
    state?: Pick<
        PlayerState,
        'pilotName' | 'shipName' | 'shipId' | 'gender' |
        'missionBits' | 'activeRanks'
    >,
) {
    const travelDestination = resolved?.travelDestination
        ?? (mission.travelStel === -1 ? '*' : undefined);
    const returnDestination = resolved?.returnDestination
        ?? (mission.returnStel === -1 ? '*' : undefined);
    const destinationLabel = planetName(travelDestination, world);
    const returnLabel = planetName(returnDestination, world);
    const destinationSystem = systemNameForPlanet(
        travelDestination, world);
    const returnSystem = systemNameForPlanet(
        returnDestination, world);
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
        pilotName: state?.pilotName,
        shipName: state?.shipName,
        shipType: state?.shipId,
        gender: state?.gender,
        missionBits: state?.missionBits,
        activeRanks: state?.activeRanks,
    };
}

export class MissionInfo extends Menu<Entity> {
    private readonly title = new PIXI.Text('Active Missions', MISSION_FONT.title);
    private readonly list = new PIXI.Text('', MISSION_FONT.list);
    private readonly detail = new PIXI.Text('', MISSION_FONT.detail);
    private readonly status = new PIXI.Text('', MISSION_FONT.status);
    private missionWorld?: MissionBoardWorld;
    private readonly abortButton: Button;
    private entries: Array<{
        entry: ActiveMission;
        mission: MissionData;
    }> = [];
    private selectionIndex = -1;
    private firstVisible = 0;
    private readonly ncbRuntime: NcbRuntime;

    constructor(
        gameData: GameData,
        controlEvents: Observable<ControlEvent>,
    ) {
        super(gameData, MISSION_INFO_LAYOUT.background, controlEvents);
        this.ncbRuntime = new NcbRuntime(gameData);
        this.abortButton = new Button(gameData, 'Abort', 55, { x: -100, y: 50 });
        const done = new Button(gameData, 'Done', 50, { x: 30, y: 50 });
        this.addButtons({ abort: this.abortButton, done });
        this.abortButton.click.subscribe(() => this.abortSelected());
        done.click.subscribe(this.done.bind(this));

        this.title.anchor.x = 0.5;
        this.title.style.fontSize = 10;
        this.title.position.set(0, -74);
        this.list.position.set(-226.5, -53.5);
        this.detail.position.set(-21.5, -53.5);
        this.status.position.set(-21.5, 18);
        this.status.style.wordWrapWidth = 240;
        this.container.addChild(this.title);
        addViewportMask(
            this.container, this.list, MISSION_INFO_LAYOUT,
            MISSION_INFO_LAYOUT.list);
        addViewportMask(
            this.container, this.detail, MISSION_INFO_LAYOUT,
            MISSION_INFO_LAYOUT.detail!);
        addViewportMask(
            this.container, this.status, MISSION_INFO_LAYOUT,
            MISSION_INFO_LAYOUT.detail!);
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
        try {
            this.missionWorld = await loadMissionWorld(this.gameData);
        } catch {
            this.missionWorld = undefined;
        }
        if (state) {
            const missions = await Promise.all(state.activeMissions
                .filter(entry => entry.state === 'active' || entry.state === 'failed')
                .map(async entry => {
                    try {
                        const mission = entry.missionData
                            && typeof entry.missionData === 'object'
                            ? entry.missionData as MissionData
                            : await this.gameData.data.Mission.get(entry.missionId);
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
            } => entry !== undefined && entry.mission !== undefined
                && (entry.mission.flags & 0x0400) === 0);
        }
        this.selectionIndex = this.entries.length > 0 ? 0 : -1;
        this.firstVisible = 0;
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
        const world = this.missionWorld;
        const state = this.input.components.get(PlayerStateComponent);
        const rows = this.entries.map(({ entry, mission }, index) => {
            const destinationId = entry.travelDestination
                ?? entry.destination;
            const destination = world
                ? planetName(destinationId, world) : destinationId ?? 'any destination';
            const deadline = world && entry.acceptedDate !== undefined
                && mission.timeLimit > 0
                ? formatGameDate(entry.acceptedDate + mission.timeLimit)
                : undefined;
            const name = formatVisibleMissionText(mission.name, {
                destination,
                destinationSystem: systemNameForPlanet(destinationId, world ?? {
                    systems: [], planets: [], governments: [],
                    planetNames: new Map(), systemNames: new Map(),
                }),
                cargo: mission.cargo?.replace(/^\*/, '') ?? undefined,
                quantity: entry.cargo?.quantity,
                pilotName: state?.pilotName,
                shipName: state?.shipName,
                shipType: state?.shipId,
            });
            return `${index === this.selectionIndex ? '▶ ' : '  '}${name}`
                + ` [${entry.state}] — ${destination}`
                + (deadline ? `, due ${deadline}` : '');
        });
        const heights = rows.map(row => Math.max(
            14,
            PIXI.TextMetrics.measureText(row, this.list.style).height + 3));
        const page = selectionPage(
            heights, this.selectionIndex, this.firstVisible,
            MISSION_INFO_LAYOUT.list.height);
        this.firstVisible = page.start;
        this.list.text = rows.slice(page.start, page.end).join('\n');
        const selected = this.entries[this.selectionIndex];
        if (!selected) {
            return;
        }
        this.abortButton.state = selected.mission.canAbort
            && selected.entry.state === 'active' ? 'normal' : 'grey';
        const worldForMission = world ?? {
            systems: [], planets: [], governments: [],
            planetNames: new Map(), systemNames: new Map(),
        };
        const destination = planetName(
            selected.entry.travelDestination ?? selected.entry.destination,
            worldForMission);
        const returnDestination = planetName(
            selected.entry.returnDestination ?? selected.entry.destination,
            worldForMission);
        const destinationSystem = systemNameForPlanet(
            selected.entry.travelDestination ?? selected.entry.destination,
            worldForMission);
        const deadline = selected.entry.acceptedDate !== undefined
            && selected.mission.timeLimit > 0
            ? formatGameDate(
                selected.entry.acceptedDate + selected.mission.timeLimit)
            : undefined;
        this.detail.text = formatVisibleMissionText(
            missionInfoDisplayText(selected.mission),
            {
                destination,
                destinationSystem,
                returnDestination,
                deadline,
                cargo: selected.mission.cargo ?? undefined,
                quantity: selected.entry.cargo?.quantity,
                pay: selected.mission.payVal > 0
                    ? selected.mission.payVal : undefined,
                pilotName: state?.pilotName,
                shipName: state?.shipName,
                shipType: state?.shipId,
                gender: state?.gender,
                missionBits: state?.missionBits,
                activeRanks: state?.activeRanks,
            },
        );
        this.detail.text += `\n\nDestination: ${destination}`
            + (destinationSystem ? ` (${destinationSystem})` : '')
            + (deadline ? `\nDeadline: ${deadline}` : '\nNo deadline');
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
        const ncb = this.ncbRuntime.setContext(this.input, state);
        if (abortMission(state, selected.entry, selected.mission, undefined, ncb)) {
            if (ncb.outfits) {
                this.input.components.set(OutfitsStateComponent, ncb.outfits);
            }
            this.status.text = 'Mission aborted.';
            void this.refresh();
        }
    }
}

/**
 * Shared BBS/bar implementation. The two public subclasses only select the
 * Bible AvailLoc and their flavor copy.
 */
/** Height reserved for the status line under a text pane. */
const STATUS_HEIGHT = 16;

export abstract class MissionBoard extends Menu<Entity> {
    private readonly title: PIXI.Text;
    private readonly flavor: PIXI.Text;
    private readonly list: PIXI.Text;
    private readonly detail: PIXI.Text;
    private readonly status: PIXI.Text;
    private readonly briefingGraphic = new PIXI.Container();
    private readonly layout: MissionPanelLayout;
    private offers: MissionOffer[] = [];
    private world?: MissionBoardWorld;
    private selectionIndex = -1;
    private firstVisible = 0;
    private readonly planetId: string;
    private readonly offerLocation: MissionOfferLocation;
    private readonly onInfo?: () => void | Promise<void>;
    private readonly ncbRuntime: NcbRuntime;
    private readonly acceptButton: Button;
    private refuseButton?: Button;
    private showing?: Promise<Entity>;
    private refreshGeneration = 0;
    private sessionKey?: string;
    private shipTypeName?: string;
    private loading = false;

    constructor(
        gameData: GameData,
        planetId: string,
        controlEvents: Observable<ControlEvent>,
        offerLocation: MissionOfferLocation,
        flavorText: string,
        onInfo?: () => void | Promise<void>,
    ) {
        super(
            gameData,
            offerLocation === MissionOfferLocation.Bar
                ? BAR_LAYOUT.background : MISSION_BBS_LAYOUT.background,
            controlEvents,
        );
        this.ncbRuntime = new NcbRuntime(gameData);
        this.layout = offerLocation === MissionOfferLocation.Bar
            ? BAR_LAYOUT : MISSION_BBS_LAYOUT;
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
        this.title.style.fontSize = 10;
        this.title.position.set(
            0, this.layout.header.y - this.layout.height / 2);
        this.flavor.visible = false;
        const listPosition = panelPosition(this.layout, this.layout.list);
        this.list.position.set(listPosition.x, listPosition.y);
        this.list.style.wordWrapWidth = this.layout.list.width - 4;
        if (this.layout.detail) {
            const detailPosition = panelPosition(
                this.layout, this.layout.detail);
            this.detail.position.set(detailPosition.x, detailPosition.y);
            this.detail.style.wordWrapWidth = this.layout.detail.width - 4;
            this.status.position.set(
                detailPosition.x,
                detailPosition.y + this.layout.detail.height - 25);
            this.status.style.wordWrapWidth = this.layout.detail.width - 4;
        } else {
            // A single-pane board (the bar) has nowhere to put a detail
            // column, so the status line sits at the foot of the one pane.
            this.detail.visible = false;
            this.status.position.set(
                listPosition.x,
                listPosition.y + this.layout.list.height - STATUS_HEIGHT);
            this.status.style.wordWrapWidth = this.layout.list.width - 4;
        }

        const footerY = this.layout.footerY - this.layout.height / 2 + 5;
        const buttonStart = -this.layout.width / 2 + 8;
        const buttonGap = this.layout === BAR_LAYOUT ? 64 : 120;
        const accept = new Button(
            gameData, 'Accept', 35, { x: buttonStart, y: footerY });
        this.acceptButton = accept;
        const refuse = new Button(
            gameData, 'Refuse', 35, { x: buttonStart + buttonGap, y: footerY });
        this.refuseButton = refuse;
        const info = new Button(
            gameData, 'Info', 30, { x: buttonStart + buttonGap * 2, y: footerY });
        const done = new Button(
            gameData, 'Done', 30, {
                x: buttonStart + buttonGap * 3 - 5, y: footerY,
            });
        this.addButtons({ accept, refuse, info, done });
        accept.click.subscribe(() => this.acceptSelected());
        refuse.click.subscribe(() => this.refuseSelected());
        info.click.subscribe(() => this.onInfo?.());
        done.click.subscribe(this.done.bind(this));

        this.container.addChild(this.title, this.flavor, this.briefingGraphic);
        addViewportMask(
            this.container, this.list, this.layout, this.layout.list);
        if (this.layout.detail) {
            addViewportMask(
                this.container, this.detail, this.layout, this.layout.detail);
            addViewportMask(
                this.container, this.status, this.layout, this.layout.detail);
        } else {
            addViewportMask(
                this.container, this.status, this.layout, this.layout.list);
        }
        this.controls = new MenuControls(controlEvents, {
            up: () => this.moveSelection(-1),
            down: () => this.moveSelection(1),
            buy: () => this.acceptSelected(),
            missions: () => this.onInfo?.(),
            depart: this.done.bind(this),
        });
    }

    override async show(input: Entity): Promise<Entity> {
        if (this.showing) {
            // A previous show() is still pending. Its container may have been
            // hidden while another dialog was on top, so make this board
            // visible and interactive again instead of handing back a promise
            // nothing can close.
            this.container.visible = true;
            this.resumeControls();
            return this.showing;
        }
        const showing = this.showOnce(input);
        let guarded: Promise<Entity>;
        guarded = showing.finally(() => {
            if (this.showing === guarded) {
                this.showing = undefined;
            }
        });
        this.showing = guarded;
        return guarded;
    }

    private async showOnce(input: Entity): Promise<Entity> {
        await this.buildPromise;
        this.setInput(input);
        const state = input.components.get(PlayerStateComponent);
        const nextSessionKey = state
            ? `${this.planetId}:${state.currentSystem}:${state.gameDate}`
            : undefined;
        const needsRefresh = nextSessionKey !== this.sessionKey;
        if (needsRefresh) {
            this.loading = true;
            this.offers = [];
            this.selectionIndex = -1;
            this.firstVisible = 0;
            this.list.text = 'Loading mission postings…';
            this.detail.text = '';
            this.status.text = '';
            this.acceptButton.state = 'grey';
        } else if (this.loading) {
            this.list.text = 'Loading mission postings…';
            this.detail.text = '';
            this.status.text = '';
        } else {
            this.render();
        }
        const result = super.show(input);
        if (needsRefresh) {
            this.sessionKey = nextSessionKey;
            void this.refreshOffers().catch(error => {
                console.error('Unable to load mission postings', error);
                this.loading = false;
                this.offers = [];
                this.list.text = 'Mission postings are temporarily unavailable.';
                this.detail.text = '';
                this.status.text = '';
            });
        }
        return result;
    }

    private async refreshOffers(statusOverride?: string) {
        const generation = ++this.refreshGeneration;
        const state = this.input.components.get(PlayerStateComponent);
        if (!state) {
            this.offers = [];
            this.loading = false;
            this.render();
            return;
        }
        this.shipTypeName = await this.syncCargoCapacity(state);
        const [world, missions] = await Promise.all([
            loadMissionWorld(this.gameData),
            loadMissionCatalog(this.gameData),
        ]);
        if (generation !== this.refreshGeneration) {
            return;
        }
        this.world = world;
        const currentSystem = world.systems.find(system =>
            sameId(system.id, state.currentSystem)) ?? {
                id: state.currentSystem,
                links: [],
                planets: [],
            };
        const currentPlanet = world.planets.find(planet =>
            sameId(planet.id, this.planetId)) ?? { id: this.planetId };
        const offerable = getOfferableMissions({
            missionIds: [...missions.keys()],
            missions,
            playerState: state,
            currentPlanet,
            currentSystem,
            offerLocation: this.offerLocation,
            destinationPlanets: world.planets,
            destinationSystems: world.systems,
            governments: world.governments,
            outfits: this.input.components.get(OutfitsStateComponent),
        }).sort((a, b) => b.displayWeight - a.displayWeight);
        const offerSeed = this.sessionKey
            ?? `${state.currentSystem}:${this.planetId}:${state.gameDate}`;
        const resourceOffers = offerable
            .map(sourceMission => {
                const mission = preparedMission(sourceMission, offerSeed);
                return {
                mission,
                resolved: resolveMissionDestinations(state, mission, {
                    initialPlanetId: this.planetId,
                    planets: world.planets,
                    systems: world.systems,
                    governments: world.governments,
                    initialSystemId: state.currentSystem,
                    currentSystemId: state.currentSystem,
                    random: seededRandom(`${offerSeed}:${mission.id}:destination`),
                }),
                available: mission.cargoType < 0 || mission.cargoQty === -1
                    || mission.cargoQty <= getFreeSpace(state),
            };
            })
            .filter((offer): offer is MissionOffer =>
                offer.resolved !== undefined);
        const proceduralOffers: MissionOffer[] = this.offerLocation
            === MissionOfferLocation.MissionComputer
            && resourceOffers.length === 0
            ? generateProceduralMissions({
                currentSystemId: state.currentSystem,
                currentPlanetId: this.planetId,
                gameDate: state.gameDate,
                freeSpace: getFreeSpace(state),
                systems: world.systems,
                planets: world.planets.map(planet => ({
                    ...planet,
                    name: world.planetNames.get(planet.id),
                })),
            }).filter(offer => !state.activeMissions.some(active =>
                active.state === 'active'
                && active.missionId === offer.mission.id))
            .map((offer: ProceduralMissionOffer) => ({
                mission: offer.mission,
                resolved: {
                    travelDestination: offer.destinationPlanetId,
                    returnDestination: offer.destinationPlanetId,
                },
                available: offer.available,
            }))
            : [];
        // The generated board is shown first, like the original Mission
        // Computer only when no usable retail mïsn resources exist.
        this.offers = [...preferRetailOffers(resourceOffers, proceduralOffers)];
        this.selectionIndex = this.offers.length > 0 ? 0 : -1;
        this.firstVisible = 0;
        this.loading = false;
        this.render();
        if (statusOverride) {
            this.status.text = statusOverride;
        }
    }

    private async syncCargoCapacity(
        state: PlayerState,
    ): Promise<string | undefined> {
        const shipData = this.input.components.get(ShipDataComponent);
        if (shipData) {
            setCargoCapacity(state, shipData.cargoCapacity);
            return shipData.name;
        }
        try {
            const ship = await this.gameData.data.Ship.get(state.shipId);
            setCargoCapacity(state, ship.cargoCapacity);
            return ship.name;
        } catch {
            // The persisted fallback capacity remains usable for old data
            // providers which do not expose ship cargo fields.
            return undefined;
        }
    }

    /** Vertical room the status line needs at the foot of a pane. */
    private get listTextHeight(): number {
        return this.layout.detail
            ? this.layout.list.height
            : this.layout.list.height - STATUS_HEIGHT;
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

    private destinationOptions(
        state: Pick<PlayerState, 'currentSystem'>,
        resolved: ResolvedMissionDestinations,
    ): MissionDestinationOptions {
        return {
            initialPlanetId: this.planetId,
            planets: this.world?.planets,
            systems: this.world?.systems,
            governments: this.world?.governments,
            initialSystemId: state.currentSystem,
            currentSystemId: state.currentSystem,
            resolved,
        };
    }

    /** Trims text that would spill past the bottom of the list pane. */
    private fitToListPane(text: string): string {
        const heights = text.split('\n').map(line => PIXI.TextMetrics
            .measureText(line || ' ', this.list.style).height);
        return fitLinesToHeight(text, heights, this.listTextHeight);
    }

    private render() {
        for (const child of this.briefingGraphic.removeChildren()) {
            child.destroy();
        }
        if (this.offers.length === 0 || this.selectionIndex < 0) {
            this.list.text = 'No missions are available here.';
            this.detail.text = '';
            this.status.text = '';
            this.acceptButton.state = 'grey';
            // Info stays live because it opens the mission log, which is
            // useful with nothing on offer.
            if (this.refuseButton) {
                this.refuseButton.state = 'grey';
            }
            return;
        }
        if (this.refuseButton) {
            this.refuseButton.state = 'normal';
        }
        const world = this.world;
        if (!world) {
            return;
        }
        const state = this.input.components.get(PlayerStateComponent);
        const valuesFor = (offer: MissionOffer) => ({
            ...missionValues(
                offer.mission, this.planetId, world, state?.gameDate ?? 0,
                offer.resolved, state),
            shipType: this.shipTypeName ?? state?.shipId,
        });
        const rows = this.offers.map((candidate, index) => {
            const values = valuesFor(candidate);
            const name = formatVisibleMissionText(
                candidate.mission.name, values);
            const summary = formatVisibleMissionText(
                firstBriefLine(candidate.mission), values);
            const body = this.layout === BAR_LAYOUT
                ? `${name}: ${summary}` : name;
            return `${index === this.selectionIndex ? '▶ ' : '  '}${
                candidate.available ? '' : '[NO ROOM] '}${body}`;
        });
        const heights = rows.map(row => Math.max(
            14,
            PIXI.TextMetrics.measureText(row, this.list.style).height + 3));
        const offer = this.offers[this.selectionIndex];
        if (!offer) {
            return;
        }
        if (this.layout.detail) {
            const page = selectionPage(
                heights, this.selectionIndex, this.firstVisible,
                this.listTextHeight);
            this.firstVisible = page.start;
            this.list.text = rows.slice(page.start, page.end).join('\n');
        } else {
            this.firstVisible = this.selectionIndex;
            this.list.text = this.fitToListPane(barOfferView(
                {
                    name: formatVisibleMissionText(
                        offer.mission.name, valuesFor(offer)),
                    text: formatVisibleMissionText(
                        missionOfferDisplayText(offer.mission),
                        valuesFor(offer)),
                },
                this.selectionIndex,
                this.offers.length,
            ));
        }
        const boardingUnsupported = offer.mission.shipGoal === 2
            || offer.mission.shipGoal === 5;
        this.acceptButton.state = offer.available && !boardingUnsupported
            ? 'normal' : 'grey';
        const values = valuesFor(offer);
        this.detail.text = formatVisibleMissionText(
            missionOfferDisplayText(offer.mission),
            values,
        );
        this.status.text = boardingUnsupported
            ? 'Boarding missions are not supported yet.'
            : `Payment: ${offer.mission.payVal > 0
                ? `${offer.mission.payVal.toLocaleString()} cr` : 'none'}`
                + (offer.mission.cargo ? `  Cargo: ${offer.mission.cargo}` : '');
    }

    private acceptSelected() {
        const offer = this.offers[this.selectionIndex];
        const state = this.input.components.get(PlayerStateComponent);
        if (!offer || !state || !offer.available) {
            if (offer && !offer.available) {
                this.status.text = 'This mission needs more cargo space.';
            }
            return;
        }
        if (offer.mission.shipGoal === 2 || offer.mission.shipGoal === 5) {
            this.status.text = 'Boarding missions are not supported yet.';
            return;
        }
        const ncb = this.ncbRuntime.setContext(this.input, state);
        ncb.onStartMission = (missionId: number) => {
            const target = this.offers.find(candidate =>
                candidate.mission.id === resourceId(missionId)
                || candidate.mission.id.replace(/^.*:/, '') === String(missionId));
            if (!target || !target.available) {
                return;
            }
            acceptMission(state, target.mission, {
                ...this.destinationOptions(state, target.resolved),
                ncb: this.ncbRuntime.setContext(this.input, state),
            });
        };
        const accepted = acceptMission(
            state, offer.mission, {
                ...this.destinationOptions(state, offer.resolved),
                ncb,
            });
        if (!accepted) {
            this.status.text = offer.mission.shipGoal === 2
                || offer.mission.shipGoal === 5
                ? 'Boarding missions are not supported yet.'
                : 'This mission cannot be accepted.';
            return;
        }
        if (ncb.outfits) {
            this.input.components.set(OutfitsStateComponent, ncb.outfits);
        }
        this.offers = this.offers.filter(entry =>
            entry.mission.id !== offer.mission.id);
        this.selectionIndex = Math.min(
            this.selectionIndex, this.offers.length - 1);
        this.render();
        this.status.text = `Mission accepted: ${formatVisibleMissionText(
            offer.mission.name,
            missionValues(
                offer.mission, this.planetId, this.world!,
                state.gameDate, offer.resolved, state),
        )}`;
    }

    private refuseSelected() {
        const offer = this.offers[this.selectionIndex];
        const state = this.input.components.get(PlayerStateComponent);
        if (!offer || !state) {
            return;
        }
        const ncb = this.ncbRuntime.setContext(this.input, state);
        refuseMission(state, offer.mission, undefined, ncb);
        if (ncb.outfits) {
            this.input.components.set(OutfitsStateComponent, ncb.outfits);
        }
        this.offers = this.offers.filter(entry =>
            entry.mission.id !== offer.mission.id);
        this.selectionIndex = Math.min(
            this.selectionIndex, this.offers.length - 1);
        this.render();
        this.status.text = formatVisibleMissionText(
            offer.mission.refuseText || 'Mission refused.',
            missionValues(
                offer.mission, this.planetId, this.world!, state.gameDate,
                offer.resolved, state),
        );
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
