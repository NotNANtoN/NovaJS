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
    MissionOffer,
} from '../nova_plugin/mission_logic.js';
import { expandMissionText, missionDisplayName } from '../nova_plugin/mission_text.js';
import { ActiveMission } from '../nova_plugin/player_state_plugin.js';
import { Button } from './button.js';
import { Menu } from './menu.js';
import { activeAsOffer, offerSubstitutions, rollOffers } from './mission_offers.js';
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

// Laid out to fit the 510x201 Mission BBS dialog (PICT 8505):
// header strip x 8..410, y 4..18; list pane x 6..219, y 26..173;
// right upper strip y 30..58 and description pane below it; metal
// button row along the bottom. Center-anchored coordinates.
const HEADER_Y = -95;
const LIST_X = -245;
const LIST_TOP = -72;
const LIST_ROWS = 11;
const ROW_HEIGHT = 13;
const LIST_WIDTH = 208;
const DESC_X = -24;
const DESC_TOP = -36;
const DESC_WIDTH = 240;
const DESC_HEIGHT = 108;
const INFO_Y = -66;
const BUTTON_Y = 75;

type Row =
    | { kind: 'offer', offer: MissionOffer }
    | { kind: 'active', active: ActiveMission }
    | { kind: 'header', label: string };


/**
 * The mission BBS (and its bar-flavored sibling): the original's
 * list/detail dialog on the 510x201 PICT 8505 frame. The left pane
 * lists the day's offers (availability evaluated against the player's
 * REAL control bits) with active missions below them; the right pane
 * shows the expanded offer text. Accept uses the mïsn's custom button
 * label when present, and runs through the real NCB machinery. There
 * is no Refuse here — a listing the player doesn't want is simply not
 * accepted. Active missions can be aborted when the mission allows.
 *
 * The AvailRandom roll happens when the board opens (see
 * mission_offers.ts — player-local UI randomness).
 */
export class MissionBoard extends Menu<Entity> {
    private session?: MissionSession;
    private offers: MissionOffer[] = [];
    private rows: Row[] = [];
    private selectedIndex = 0;
    private rowTexts: PIXI.Text[] = [];
    private listContainer = new PIXI.Container();
    private highlight = new PIXI.Graphics();
    private buttons: {
        accept: Button, abort: Button, done: Button,
    };

    private text = {
        title: new PIXI.Text('', {
            fontFamily: 'Geneva', fontSize: 12, fill: 0xffffff,
        }),
        dateCredits: new PIXI.Text('', { ...LIST_FONT, align: 'right' }),
        info: new PIXI.Text('', LIST_FONT),
        description: new PIXI.Text('', {
            ...FONT.normal, wordWrapWidth: DESC_WIDTH,
        }),
        status: new PIXI.Text('', { ...FONT.normal, wordWrap: false }),
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

        // No Refuse on the BBS: an uninteresting listing is simply not
        // accepted. (Bar mission POPUPS keep their accept/refuse
        // choice — that's a different surface; see bar.ts.)
        this.buttons = {
            accept: new Button(displayAssets, 'Accept', 74, { x: -245, y: BUTTON_Y }),
            abort: new Button(displayAssets, 'Abort', 60, { x: -140, y: BUTTON_Y }),
            done: new Button(displayAssets, 'Done', 60, { x: 180, y: BUTTON_Y }),
        };
        this.buttons.accept.click.subscribe(this.accept.bind(this));
        this.buttons.abort.click.subscribe(this.abort.bind(this));
        this.buttons.done.click.subscribe(this.done.bind(this));
        this.addButtons(this.buttons);

        this.text.title.text = title;
        this.text.title.position.set(LIST_X, HEADER_Y);
        this.text.dateCredits.anchor.x = 1;
        this.text.dateCredits.position.set(155, HEADER_Y + 2);
        this.text.info.position.set(DESC_X, INFO_Y);
        this.listContainer.position.set(LIST_X, LIST_TOP);
        this.text.description.position.set(DESC_X, DESC_TOP);
        this.text.status.position.set(LIST_X, BUTTON_Y - 16);
        this.container.addChild(this.highlight, this.text.title,
            this.text.dateCredits, this.text.info, this.listContainer,
            this.text.description, this.text.status);

        // Clip the list and the description to their dialog panes.
        const listMask = new PIXI.Graphics()
            .beginFill(0xffffff)
            .drawRect(LIST_X, LIST_TOP, LIST_WIDTH,
                LIST_ROWS * ROW_HEIGHT + 4)
            .endFill();
        this.container.addChild(listMask);
        this.listContainer.mask = listMask;
        const descMask = new PIXI.Graphics()
            .beginFill(0xffffff)
            .drawRect(DESC_X, DESC_TOP, DESC_WIDTH + 10, DESC_HEIGHT)
            .endFill();
        this.container.addChild(descMask);
        this.text.description.mask = descMask;

        this.controls.controls = {
            up: () => this.moveSelection(-1),
            down: () => this.moveSelection(1),
            accept: this.accept.bind(this),
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
        this.offers = rollOffers(this.session, this.universe,
            this.location);
        this.buildRows();
        this.selectedIndex = this.rows.findIndex(
            row => row.kind !== 'header');
        this.text.status.text = '';
        this.refreshHeader();
        this.refreshList();
        this.refreshDescription();
        return super.show(input);
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
        this.highlight.clear();

        // A simple window keeps the selection visible.
        const start = Math.max(0, Math.min(
            this.selectedIndex - (LIST_ROWS - 2),
            this.rows.length - LIST_ROWS));
        const visible = this.rows.slice(start, start + LIST_ROWS);
        visible.forEach((row, i) => {
            const index = start + i;
            let label: string;
            let style: Partial<PIXI.ITextStyle> = LIST_FONT;
            if (row.kind === 'offer') {
                // Mission names use the same <DST>-style wildcards as
                // the descriptions.
                label = expandMissionText(missionDisplayName(row.offer.data.name),
                    this.substitutionsFor(row.offer));
                if (!row.offer.acceptable) {
                    style = LIST_FONT_DIM;
                }
            } else if (row.kind === 'active') {
                const offer = activeAsOffer(this.universe, row.active);
                label = offer
                    ? expandMissionText(missionDisplayName(offer.data.name),
                        this.substitutionsFor(offer, row.active))
                    : row.active.id;
            } else {
                label = row.label;
                style = LIST_FONT_HEADER;
            }
            if (index === this.selectedIndex && row.kind !== 'header') {
                // The original's full-width selection bar.
                this.highlight.beginFill(0x8b0000)
                    .drawRect(LIST_X, LIST_TOP + i * ROW_HEIGHT,
                        LIST_WIDTH, ROW_HEIGHT)
                    .endFill();
            }
            const text = new PIXI.Text(label, style);
            text.position.set(4, i * ROW_HEIGHT);
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

    private substitutionsFor(offer: MissionOffer,
        active?: ActiveMission) {
        return offerSubstitutions(this.universe, this.session!, offer,
            active);
    }

    /** The right pane: expanded text, info line, and button labels. */
    private refreshDescription() {
        const row = this.selectedRow();
        this.buttons.accept.setLabel('Accept');
        this.text.info.text = '';
        if (!row || row.kind === 'header') {
            this.text.description.text = '';
            this.buttons.accept.state = 'grey';
            this.buttons.abort.state = 'grey';
            return;
        }
        if (row.kind === 'offer') {
            const { offer } = row;
            const subs = this.substitutionsFor(offer);
            const text = expandMissionText(offer.data.offerText, subs);
            const extra = offer.acceptable ? '' : `\n\n[${offer.reason}]`;
            this.text.description.text = text + extra;
            this.text.info.text = [
                subs.payment !== undefined
                    ? `Pay: ${subs.payment.toLocaleString()} cr` : '',
                subs.deadline !== undefined
                    ? `Deadline: ${subs.deadline}` : '',
            ].filter(Boolean).join('    ');
            // The mïsn's custom accept label, where present.
            if (offer.data.acceptButton) {
                this.buttons.accept.setLabel(offer.data.acceptButton);
            }
            this.buttons.accept.state =
                offer.acceptable ? 'normal' : 'grey';
            this.buttons.abort.state = 'grey';
        } else {
            const offer = activeAsOffer(this.universe, row.active);
            if (!offer) {
                this.text.description.text = row.active.id;
                return;
            }
            const mission = offer.data;
            const brief = mission.quickBrief || mission.briefText
                || mission.offerText;
            this.text.description.text = expandMissionText(brief,
                this.substitutionsFor(offer, row.active))
                + (mission.canAbort ? '' : '\n\n[This mission cannot be aborted.]');
            this.buttons.accept.state = 'grey';
            this.buttons.abort.state = mission.canAbort ? 'normal' : 'grey';
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
        const subs = this.substitutionsFor(row.offer);
        const brief = expandMissionText(row.offer.data.briefText, subs);
        // Mission names carry the same <DST>-style wildcards as the
        // descriptions; expand them in the status line too.
        this.text.status.text = `Accepted: ${expandMissionText(
            missionDisplayName(row.offer.data.name), subs)}.`;
        this.buildRows();
        this.selectedIndex = Math.min(this.selectedIndex,
            this.rows.length - 1);
        this.refreshHeader();
        this.refreshList();
        this.refreshDescription();
        if (brief) {
            this.text.description.text = brief;
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
