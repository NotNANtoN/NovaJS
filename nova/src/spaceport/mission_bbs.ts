import { MissionData, MissionOfferLocation } from 'novadatainterface/MissionData';
import { PlanetData } from 'novadatainterface/PlanetData';
import { SystemData } from 'novadatainterface/SystemData';
import { GovtData } from 'novadatainterface/GovtData';
import { Entity } from 'nova_ecs/entity';
import * as PIXI from 'pixi.js';
import { Observable } from 'rxjs';
import { resourceId } from '../common/resource_id';
import { GameData } from '../client/gamedata/GameData';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import {
    acceptMission,
    abortMission,
    formatMissionText,
    MissionDestinationOptions,
    PendingMissionJumpComponent,
    PendingMissionSoundComponent,
    resolveMissionDestinations,
    ResolvedMissionDestinations,
    refuseMission,
} from '../nova_plugin/mission_plugin';
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
} from '../nova_plugin/procedural_missions';
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
    private readonly ncbRuntime: NcbRuntime;

    constructor(
        gameData: GameData,
        controlEvents: Observable<ControlEvent>,
    ) {
        super(gameData, 'nova:8500', controlEvents);
        this.ncbRuntime = new NcbRuntime(gameData);
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
            } => entry !== undefined && entry.mission !== undefined);
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
        const world = this.missionWorld;
        this.list.text = this.entries.map(({ entry, mission }, index) => {
            const destinationId = entry.travelDestination
                ?? entry.destination;
            const destination = world
                ? planetName(destinationId, world) : destinationId ?? 'any destination';
            const deadline = world && entry.acceptedDate !== undefined
                && mission.timeLimit > 0
                ? formatGameDate(entry.acceptedDate + mission.timeLimit)
                : undefined;
            return `${index === this.selectionIndex ? '▶ ' : '  '}${mission.name}`
                + ` [${entry.state}]\n   ${destination}`
                + (deadline ? ` — due ${deadline}` : '');
        }).join('\n');
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
        const state = this.input.components.get(PlayerStateComponent);
        this.detail.text = formatMissionText(
            selected.mission.quickBrief || selected.mission.briefText
            || 'Mission briefing unavailable.',
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
export abstract class MissionBoard extends Menu<Entity> {
    private readonly title: PIXI.Text;
    private readonly flavor: PIXI.Text;
    private readonly list: PIXI.Text;
    private readonly unavailableList: PIXI.Text;
    private readonly detail: PIXI.Text;
    private readonly status: PIXI.Text;
    private readonly briefingGraphic = new PIXI.Container();
    private offers: MissionOffer[] = [];
    private world?: MissionBoardWorld;
    private selectionIndex = -1;
    private readonly planetId: string;
    private readonly offerLocation: MissionOfferLocation;
    private readonly onInfo?: () => void | Promise<void>;
    private readonly ncbRuntime: NcbRuntime;
    private readonly acceptButton: Button;
    private showing?: Promise<Entity>;
    private refreshGeneration = 0;

    constructor(
        gameData: GameData,
        planetId: string,
        controlEvents: Observable<ControlEvent>,
        offerLocation: MissionOfferLocation,
        flavorText: string,
        onInfo?: () => void | Promise<void>,
    ) {
        super(gameData, 'nova:8500', controlEvents);
        this.ncbRuntime = new NcbRuntime(gameData);
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
        this.unavailableList = new PIXI.Text(
            '', MISSION_FONT.unavailableList);
        this.detail = new PIXI.Text('', MISSION_FONT.detail);
        this.status = new PIXI.Text('', MISSION_FONT.status);
        this.title.anchor.x = 0.5;
        this.title.position.set(0, -210);
        this.flavor.position.set(-210, -190);
        this.list.position.set(-290, -125);
        this.detail.position.set(-40, -125);
        this.status.position.set(-290, 150);

        const accept = new Button(gameData, 'Accept', 70, { x: -120, y: 190 });
        this.acceptButton = accept;
        const refuse = new Button(gameData, 'Refuse', 70, { x: -40, y: 190 });
        const info = new Button(gameData, 'Missions', 80, { x: 55, y: 190 });
        const done = new Button(gameData, 'Done', 60, { x: 150, y: 190 });
        this.addButtons({ accept, refuse, info, done });
        accept.click.subscribe(() => this.acceptSelected());
        refuse.click.subscribe(() => this.refuseSelected());
        info.click.subscribe(() => this.onInfo?.());
        done.click.subscribe(this.done.bind(this));

        this.container.addChild(
            this.title, this.flavor, this.list, this.unavailableList,
            this.detail, this.status, this.briefingGraphic);
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
        await this.refreshOffers();
        return super.show(input);
    }

    private async refreshOffers(statusOverride?: string) {
        const generation = ++this.refreshGeneration;
        const state = this.input.components.get(PlayerStateComponent);
        if (!state) {
            this.offers = [];
            this.render();
            return;
        }
        await this.syncCargoCapacity(state);
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
        const resourceOffers = offerable
            .map(mission => ({
                mission,
                resolved: resolveMissionDestinations(state, mission, {
                    initialPlanetId: this.planetId,
                    planets: world.planets,
                    systems: world.systems,
                    governments: world.governments,
                    initialSystemId: state.currentSystem,
                    currentSystemId: state.currentSystem,
                }),
                available: true,
            }))
            .filter((offer): offer is MissionOffer =>
                offer.resolved !== undefined);
        const proceduralOffers: MissionOffer[] = this.offerLocation
            === MissionOfferLocation.MissionComputer
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
        // Computer, before data-driven mïsn resources.
        this.offers = [...proceduralOffers, ...resourceOffers];
        this.selectionIndex = this.offers.length > 0 ? 0 : -1;
        this.render();
        if (statusOverride) {
            this.status.text = statusOverride;
        }
    }

    private async syncCargoCapacity(
        state: PlayerState,
    ): Promise<void> {
        const shipData = this.input.components.get(ShipDataComponent);
        if (shipData) {
            setCargoCapacity(state, shipData.cargoCapacity);
            return;
        }
        try {
            const ship = await this.gameData.data.Ship.get(state.shipId);
            setCargoCapacity(state, ship.cargoCapacity);
        } catch {
            // The persisted fallback capacity remains usable for old data
            // providers which do not expose ship cargo fields.
        }
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

    private render() {
        this.briefingGraphic.removeChildren();
        if (this.offers.length === 0 || this.selectionIndex < 0) {
            this.list.text = 'No missions are available here.';
            this.unavailableList.text = '';
            this.detail.text = '';
            this.acceptButton.state = 'grey';
            return;
        }
        const world = this.world;
        if (!world) {
            return;
        }
        const offerText = (offer: MissionOffer, index: number) =>
            `${index === this.selectionIndex ? '▶ ' : '  '}`
            + `${offer.available ? '' : '[NO ROOM] '}${offer.mission.name}`
            + `\n   ${firstBriefLine(offer.mission)}`;
        // Keep unavailable entries in the same line slots as the normal list,
        // but render them in a separate grey layer so they are visibly
        // disabled rather than merely carrying a status label.
        this.list.text = this.offers.map((offer, index) =>
            offer.available ? offerText(offer, index) : '\n').join('\n');
        this.unavailableList.text = this.offers.map((offer, index) =>
            offer.available ? '\n' : offerText(offer, index)).join('\n');
        const offer = this.offers[this.selectionIndex];
        if (!offer) {
            return;
        }
        const boardingUnsupported = offer.mission.shipGoal === 2
            || offer.mission.shipGoal === 5;
        this.acceptButton.state = offer.available && !boardingUnsupported
            ? 'normal' : 'grey';
        const state = this.input.components.get(PlayerStateComponent);
        const values = missionValues(
            offer.mission, this.planetId, world, state?.gameDate ?? 0,
            offer.resolved, state);
        this.detail.text = formatMissionText(
            offer.mission.briefText || offer.mission.quickBrief
            || offer.mission.offerText
            || 'Mission briefing unavailable.',
            values,
        );
        const briefGraphic = offer.mission.briefGraphic;
        if (briefGraphic !== undefined && briefGraphic > 0) {
            const graphic = this.gameData.spriteFromPict(
                resourceId(briefGraphic));
            graphic.position.set(205, -100);
            graphic.scale.set(0.45);
            this.briefingGraphic.addChild(graphic);
        }
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
        void this.refreshOffers(`Mission accepted: ${offer.mission.name}`);
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
        this.status.text = formatMissionText(
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
