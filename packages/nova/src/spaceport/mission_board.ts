import { Entity } from 'nova_ecs/entity';
import * as PIXI from 'pixi.js';
import { Observable } from 'rxjs';
import { DisplayAssetDataInterface } from '../client/gamedata/display_asset_data.js';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { ControlEvent } from '../nova_plugin/controls_plugin.js';
import { dateFromDayNumber, formatDate } from '../nova_plugin/calendar.js';
import {
    abortMission,
    acceptOffer,
    cargoName,
    makeMissionOffer,
    MissionOffer,
    missionMatchesLocation,
    refuseOffer,
} from '../nova_plugin/mission_logic.js';
import { expandMissionText, missionDisplayName } from '../nova_plugin/mission_text.js';
import { ActiveMission } from '../nova_plugin/player_state_plugin.js';
import { Button } from './button.js';
import { Menu } from './menu.js';
import { MissionSession } from './mission_session.js';
import { MissionUniverse } from './mission_universe.js';
import { FONT } from './outfitter.js';

const LIST_FONT: Partial<PIXI.ITextStyle> = {
    fontFamily: 'Geneva', fontSize: 10, fill: 0xffffff,
    align: 'left', wordWrap: false,
};
const LIST_FONT_DIM: Partial<PIXI.ITextStyle> =
    { ...LIST_FONT, fill: 0x888888 };
const LIST_FONT_HEADER: Partial<PIXI.ITextStyle> =
    { ...LIST_FONT, fill: 0xffff88 };

// Laid out to fit the 510x201 Mission BBS dialog (PICT 8505).
const LIST_ROWS = 10;
const ROW_HEIGHT = 13;
const LIST_X = -245;
const CONTENT_TOP = -76;
const DESC_X = 0;
const DESC_WIDTH = 240;
const CONTENT_HEIGHT = 140;
const BUTTON_Y = 78;

type Row =
    | { kind: 'offer', offer: MissionOffer }
    | { kind: 'active', active: ActiveMission }
    | { kind: 'header', label: string };


/**
 * The mission computer / bar: lists the missions available to this
 * player at this stellar (availability is evaluated against the
 * player's REAL control bits), shows the expanded offer text, and
 * accepts or refuses them through the real NCB machinery. Active
 * missions are listed below the offers and can be aborted when the
 * mission allows it.
 *
 * The AvailRandom percentage roll happens when the board opens. It is
 * player-local UI randomness (like the outfitter's R(a b) rolls), so
 * plain Math.random is fine here — only the resulting accepted-
 * mission state ever reaches the simulation.
 */
export class MissionBoard extends Menu<Entity> {
    private session?: MissionSession;
    private offers: MissionOffer[] = [];
    private rows: Row[] = [];
    private selectedIndex = 0;
    private rowTexts: PIXI.Text[] = [];
    private listContainer = new PIXI.Container();

    private text = {
        title: new PIXI.Text('', {
            fontFamily: 'Geneva', fontSize: 12, fill: 0xffffff,
        }),
        status: new PIXI.Text('', { ...FONT.normal, wordWrap: false }),
        description: new PIXI.Text('', {
            ...FONT.normal, wordWrapWidth: DESC_WIDTH,
        }),
        dateCredits: new PIXI.Text('', FONT.normal),
    };

    constructor(displayAssets: DisplayAssetDataInterface,
        simulationData: SimulationGameDataInterface,
        controlEvents: Observable<ControlEvent>,
        private universe: MissionUniverse,
        private planetId: string,
        /** LOCATION_MISSION_COMPUTER or LOCATION_BAR. */
        private location: number,
        background: string,
        title: string) {
        super(displayAssets, simulationData, background, controlEvents);
        this.container.name = `MissionBoard-${title}`;

        const buttons = {
            accept: new Button(displayAssets, 'Accept', 60, { x: -180, y: BUTTON_Y }),
            refuse: new Button(displayAssets, 'Refuse', 60, { x: -95, y: BUTTON_Y }),
            abort: new Button(displayAssets, 'Abort', 60, { x: -10, y: BUTTON_Y }),
            done: new Button(displayAssets, 'Done', 60, { x: 180, y: BUTTON_Y }),
        };
        buttons.accept.click.subscribe(this.accept.bind(this));
        buttons.refuse.click.subscribe(this.refuse.bind(this));
        buttons.abort.click.subscribe(this.abort.bind(this));
        buttons.done.click.subscribe(this.done.bind(this));
        this.addButtons(buttons);

        this.text.title.text = title;
        this.text.title.position.set(LIST_X, -95);
        this.text.dateCredits.position.set(DESC_X + 40, -93);
        this.listContainer.position.set(LIST_X, CONTENT_TOP);
        this.text.description.position.set(DESC_X, CONTENT_TOP);
        this.text.status.position.set(LIST_X, BUTTON_Y - 14);
        this.container.addChild(this.text.title, this.text.dateCredits,
            this.listContainer, this.text.description, this.text.status);

        // Clip the list and the description to their dialog panes.
        const listMask = new PIXI.Graphics()
            .beginFill(0xffffff)
            .drawRect(LIST_X, CONTENT_TOP, DESC_X - LIST_X - 10,
                CONTENT_HEIGHT)
            .endFill();
        this.container.addChild(listMask);
        this.listContainer.mask = listMask;
        const descMask = new PIXI.Graphics()
            .beginFill(0xffffff)
            .drawRect(DESC_X, CONTENT_TOP, DESC_WIDTH + 10, CONTENT_HEIGHT)
            .endFill();
        this.container.addChild(descMask);
        this.text.description.mask = descMask;

        this.controls.controls = {
            up: () => this.moveSelection(-1),
            down: () => this.moveSelection(1),
            buy: this.accept.bind(this),
            sell: this.refuse.bind(this),
            depart: this.done.bind(this),
        };
    }

    override async show(input: Entity): Promise<Entity> {
        try {
            this.session = await MissionSession.create(input,
                this.simulationData, this.universe, this.planetId);
        } catch (e) {
            // Data failed to load; don't wedge the spaceport.
            console.warn('Mission board failed to load:', e);
            return input;
        }
        this.computeOffers();
        this.buildRows();
        this.selectedIndex = this.rows.findIndex(
            row => row.kind !== 'header');
        this.text.status.text = '';
        this.refreshHeader();
        this.refreshList();
        this.refreshDescription();
        return super.show(input);
    }

    /** Rolls availability once per opening and freezes the offers. */
    private computeOffers() {
        const ctx = this.session!.machinery.offerContext();
        this.offers = [];
        for (const mission of this.universe.missions) {
            if (!missionMatchesLocation(mission, this.location, ctx)) {
                continue;
            }
            // The AvailRandom roll (per board opening; see class doc).
            if (mission.availRandom < 100
                && Math.random() * 100 >= mission.availRandom) {
                continue;
            }
            const offer = makeMissionOffer(mission, ctx);
            if (offer) {
                this.offers.push(offer);
            }
        }
        this.offers.sort((a, b) => b.data.dispWeight - a.data.dispWeight);
    }

    /** Rebuilds the row list from the frozen offers + active missions. */
    private buildRows() {
        const session = this.session!;
        // An offer may have become active (accepted) meanwhile.
        this.offers = this.offers.filter(
            offer => !session.state.missions.has(offer.data.id));
        this.rows = this.offers.map(
            offer => ({ kind: 'offer', offer } as Row));
        const active = [...session.state.missions.values()];
        if (active.length > 0) {
            this.rows.push({ kind: 'header', label: '--- Active missions ---' });
            for (const mission of active) {
                this.rows.push({ kind: 'active', active: mission });
            }
        }
        if (this.rows.length === 0) {
            this.rows.push({ kind: 'header', label: '(no missions available)' });
        }
    }

    private refreshHeader() {
        const session = this.session!;
        const date = formatDate(dateFromDayNumber(session.currentDay));
        const credits = session.state.credits.credits.toLocaleString();
        this.text.dateCredits.text = `${date}    ${credits} cr`;
    }

    private refreshList() {
        for (const text of this.rowTexts) {
            this.listContainer.removeChild(text);
            text.destroy();
        }
        this.rowTexts = [];

        // A simple window keeps the selection visible.
        const start = Math.max(0, Math.min(
            this.selectedIndex - (LIST_ROWS - 2),
            this.rows.length - LIST_ROWS));
        const visible = this.rows.slice(start, start + LIST_ROWS);
        visible.forEach((row, i) => {
            const index = start + i;
            const selected = index === this.selectedIndex;
            let label: string;
            let style: Partial<PIXI.ITextStyle> = LIST_FONT;
            if (row.kind === 'offer') {
                // Mission names use the same <DST>-style wildcards as
                // the descriptions.
                label = expandMissionText(missionDisplayName(row.offer.data.name),
                    this.offerSubstitutions(row.offer));
                if (!row.offer.acceptable) {
                    style = LIST_FONT_DIM;
                }
            } else if (row.kind === 'active') {
                const mission = this.universe.getMission(row.active.id);
                label = mission
                    ? expandMissionText(missionDisplayName(mission.name),
                        this.offerSubstitutions({
                            data: mission,
                            travelPlanet: row.active.travelPlanet,
                            returnPlanet: row.active.returnPlanet,
                            cargoType: row.active.cargoType,
                            cargoQty: row.active.cargoQty,
                            acceptable: true,
                        }, row.active))
                    : row.active.id;
            } else {
                label = row.label;
                style = LIST_FONT_HEADER;
            }
            const text = new PIXI.Text(
                `${selected ? '> ' : '  '}${label}`, style);
            text.position.set(0, i * ROW_HEIGHT);
            if (row.kind !== 'header') {
                text.interactive = true;
                text.cursor = 'pointer';
                text.on('pointerdown', () => {
                    this.selectedIndex = index;
                    this.refreshList();
                    this.refreshDescription();
                });
            }
            this.listContainer.addChild(text);
            this.rowTexts.push(text);
        });
    }

    private selectedRow(): Row | undefined {
        return this.rows[this.selectedIndex];
    }

    private moveSelection(delta: number) {
        if (this.rows.length === 0) {
            return;
        }
        let index = this.selectedIndex;
        do {
            index = Math.max(0, Math.min(this.rows.length - 1, index + delta));
        } while (this.rows[index]?.kind === 'header'
            && index > 0 && index < this.rows.length - 1);
        if (this.rows[index]?.kind !== 'header') {
            this.selectedIndex = index;
        }
        this.refreshList();
        this.refreshDescription();
    }

    private offerSubstitutions(offer: MissionOffer,
        active?: ActiveMission) {
        const session = this.session!;
        const travel = active?.travelPlanet ?? offer.travelPlanet;
        const ret = active?.returnPlanet ?? offer.returnPlanet;
        const deadlineDay = active?.deadlineDay
            ?? (offer.data.timeLimit > 0
                ? session.currentDay + offer.data.timeLimit : null);
        return {
            destinationStellar: this.universe.planetName(travel ?? ret),
            destinationSystem: this.universe.systemNameOfPlanet(travel ?? ret),
            returnStellar: this.universe.planetName(ret),
            returnSystem: this.universe.systemNameOfPlanet(ret),
            cargoType: offer.cargoType >= 0
                ? cargoName(offer.cargoType) : undefined,
            cargoQty: offer.cargoQty > 0 ? offer.cargoQty : undefined,
            deadline: deadlineDay !== null
                ? formatDate(dateFromDayNumber(deadlineDay)) : undefined,
            payment: offer.data.payVal > 0 ? offer.data.payVal : undefined,
        };
    }

    private refreshDescription() {
        const row = this.selectedRow();
        if (!row || row.kind === 'header') {
            this.text.description.text = '';
            return;
        }
        if (row.kind === 'offer') {
            const { offer } = row;
            const text = expandMissionText(offer.data.offerText,
                this.offerSubstitutions(offer));
            const extra = offer.acceptable ? '' : `\n\n[${offer.reason}]`;
            this.text.description.text = text + extra;
        } else {
            const mission = this.universe.getMission(row.active.id);
            if (!mission) {
                this.text.description.text = row.active.id;
                return;
            }
            const pseudoOffer: MissionOffer = {
                data: mission,
                travelPlanet: row.active.travelPlanet,
                returnPlanet: row.active.returnPlanet,
                cargoType: row.active.cargoType,
                cargoQty: row.active.cargoQty,
                acceptable: true,
            };
            const brief = mission.quickBrief || mission.briefText
                || mission.offerText;
            this.text.description.text = expandMissionText(brief,
                this.offerSubstitutions(pseudoOffer, row.active))
                + (mission.canAbort ? '' : '\n\n[This mission cannot be aborted.]');
        }
    }

    private accept() {
        const row = this.selectedRow();
        if (!row || row.kind !== 'offer' || !this.session) {
            return;
        }
        if (!row.offer.acceptable) {
            this.text.status.text = row.offer.reason ?? 'Cannot accept.';
            return;
        }
        acceptOffer(this.session.machinery, row.offer, this.session.outfits);
        const brief = expandMissionText(row.offer.data.briefText,
            this.offerSubstitutions(row.offer));
        this.text.status.text =
            `Accepted: ${missionDisplayName(row.offer.data.name)}.`;
        this.buildRows();
        this.selectedIndex = Math.min(this.selectedIndex,
            this.rows.length - 1);
        this.refreshHeader();
        this.refreshList();
        if (brief) {
            this.text.description.text = brief;
        } else {
            this.refreshDescription();
        }
    }

    private refuse() {
        const row = this.selectedRow();
        if (!row || row.kind !== 'offer' || !this.session) {
            return;
        }
        if (row.offer.data.flags.cantRefuse) {
            this.text.status.text = 'This offer cannot be refused.';
            return;
        }
        refuseOffer(this.session.machinery, row.offer, this.session.outfits);
        const refuseText = expandMissionText(row.offer.data.refuseText,
            this.offerSubstitutions(row.offer));
        this.rows = this.rows.filter(r => r !== row);
        if (this.rows.length === 0) {
            this.rows.push({ kind: 'header', label: '(no missions available)' });
        }
        this.selectedIndex = Math.min(this.selectedIndex,
            this.rows.length - 1);
        this.text.status.text = `Refused: ${missionDisplayName(row.offer.data.name)}.`;
        this.refreshList();
        if (refuseText) {
            this.text.description.text = refuseText;
        } else {
            this.refreshDescription();
        }
    }

    private abort() {
        const row = this.selectedRow();
        if (!row || row.kind !== 'active' || !this.session) {
            return;
        }
        const mission = this.universe.getMission(row.active.id);
        if (mission && !mission.canAbort) {
            this.text.status.text = 'This mission cannot be aborted.';
            return;
        }
        abortMission(this.session.machinery, row.active.id,
            this.session.outfits);
        this.text.status.text = `Aborted: ${mission ? missionDisplayName(mission.name) : row.active.id}.`;
        this.buildRows();
        this.selectedIndex = Math.min(this.selectedIndex,
            this.rows.length - 1);
        this.refreshHeader();
        this.refreshList();
        this.refreshDescription();
    }

    protected override done() {
        this.session?.commit();
        super.done();
    }
}
