import { Entity } from 'nova_ecs/entity';
import * as PIXI from 'pixi.js';
import { firstValueFrom, Observable, Subject } from 'rxjs';
import { DisplayAssetDataInterface } from '../client/gamedata/display_asset_data.js';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { dayNumber, formatDate } from '../nova_plugin/calendar.js';
import { ControlEvent } from '../nova_plugin/controls_plugin.js';
import { abortMission } from '../nova_plugin/mission_logic.js';
import { expandMissionText, missionDisplayName } from '../nova_plugin/mission_text.js';
import { makeDescTextContext, playerGender } from '../nova_plugin/desc_text.js';
import { PlayerIdentitySubs, playerIdentitySubs } from './player_identity.js';
import { ControlBitsComponent } from '../nova_plugin/ncb_plugin.js';
import { ShipComponent } from '../nova_plugin/ship_plugin.js';
import { ActiveMission, GameDateComponent, MissionsComponent } from '../nova_plugin/player_state_plugin.js';
import { Button } from './button.js';
import { MenuControls } from './menu_controls.js';
import { activeAsOffer, offerSubstitutions } from './mission_offers.js';
import { MissionSession } from './mission_session.js';
import { MissionUniverse } from './mission_universe.js';

/**
 * Docked context that makes the Abort button functional: aborting runs
 * through a MissionSession over the held entity (the standard spaceport
 * working-copy/commit pattern), which is only sound while docked. In
 * flight the button stays greyed — an in-flight abort would need an
 * input-record path of its own.
 */
export interface MissionInfoAbortContext {
    gameData: SimulationGameDataInterface;
    planetId: string;
}

// The Mission Info dialog on the 471x155 PICT 8517 frame: a left list of
// the player's active missions, a right pane with the current date and
// the selected mission's briefing text, and Abort / Done along the
// bottom. Center-anchored coordinates, measured against the
// missions/missions_info.png reference (1920x1080).
const WIDTH = 471;
const HEIGHT = 155;
const ORIGIN_X = -WIDTH / 2;
const ORIGIN_Y = -HEIGHT / 2;

const HEADER_X = ORIGIN_X + 10;
const HEADER_Y = ORIGIN_Y + 7;
const LIST_X = ORIGIN_X + 8;
const LIST_TOP = ORIGIN_Y + 24;
const LIST_WIDTH = 206;
const ROW_HEIGHT = 13;
const LIST_ROWS = 8;
const DATE_X = ORIGIN_X + WIDTH - 12;
const DATE_Y = HEADER_Y;
const DESC_X = ORIGIN_X + 232;
const DESC_TOP = ORIGIN_Y + 24;
const DESC_WIDTH = 222;
const DESC_HEIGHT = 96;
const BUTTON_Y = ORIGIN_Y + HEIGHT - 22;

const HEADER_FONT: Partial<PIXI.ITextStyle> = {
    fontFamily: 'Geneva', fontSize: 10, fill: 0xbbbbbb, align: 'left',
    wordWrap: false,
};
const DATE_FONT: Partial<PIXI.ITextStyle> = {
    ...HEADER_FONT, align: 'right',
};
const LIST_FONT: Partial<PIXI.ITextStyle> = {
    fontFamily: 'Geneva', fontSize: 10, fill: 0xffffff, align: 'left',
    wordWrap: false,
};
const DESC_FONT: Partial<PIXI.ITextStyle> = {
    fontFamily: 'Geneva', fontSize: 10, fill: 0xffffff, align: 'left',
    wordWrap: true, wordWrapWidth: DESC_WIDTH,
};

const NO_MISSIONS = 'You have no active missions.';

/**
 * The Mission Info dialog ('i'): lists the player's active missions and
 * shows the selected one's briefing text and the current date, on the
 * 8517 frame. Opens in flight and while docked, as a modal overlay on
 * the same focus stack as the starmap / player-info dialogs. Read-only:
 * the Abort button is functional while DOCKED (an abort context routes
 * it through a MissionSession over the held entity) and greyed in
 * flight, where an abort would bypass the deterministic mission
 * machinery.
 */
export class MissionInfoDialog {
    container = new PIXI.Container();
    private controls: MenuControls;
    private closed = new Subject<void>();
    private header = new PIXI.Text('', HEADER_FONT);
    private date = new PIXI.Text('', DATE_FONT);
    private listContainer = new PIXI.Container();
    private highlight = new PIXI.Graphics();
    private description = new PIXI.Text('', DESC_FONT);
    private abort: Button;
    private rowTexts: PIXI.Text[] = [];
    private missions: [string, ActiveMission][] = [];
    private selectedIndex = 0;
    private currentDay = 0;
    private entity?: Entity;
    private abortContext?: MissionInfoAbortContext;
    /** <PN>/<PSN>-style identity values, loaded per show(). */
    private identity: PlayerIdentitySubs = {};
    private aborting = false;

    constructor(private displayAssets: DisplayAssetDataInterface,
        private universe: MissionUniverse,
        controlEvents: Observable<ControlEvent>) {
        this.container.name = 'MissionInfo';
        this.container.visible = false;

        // A modal shield behind the frame, so clicks can't reach the
        // screen underneath while the dialog is up.
        const shield = new PIXI.Graphics()
            .beginFill(0x000000, 0.001)
            .drawRect(-4000, -4000, 8000, 8000)
            .endFill();
        shield.interactive = true;
        this.container.addChild(shield);

        const background = this.displayAssets.spriteFromPict('nova:8517');
        background.anchor.set(0.5);
        background.interactive = true;
        this.container.addChild(background);

        this.header.text = 'Currently active missions:';
        this.header.position.set(HEADER_X, HEADER_Y);
        this.date.anchor.set(1, 0);
        this.date.position.set(DATE_X, DATE_Y);
        this.listContainer.position.set(LIST_X, LIST_TOP);
        this.description.position.set(DESC_X, DESC_TOP);
        this.container.addChild(this.highlight, this.header, this.date,
            this.listContainer, this.description);

        // Clip the list and description to their panes.
        const listMask = new PIXI.Graphics().beginFill(0xffffff)
            .drawRect(LIST_X, LIST_TOP, LIST_WIDTH, LIST_ROWS * ROW_HEIGHT)
            .endFill();
        this.container.addChild(listMask);
        this.listContainer.mask = listMask;
        const descMask = new PIXI.Graphics().beginFill(0xffffff)
            .drawRect(DESC_X, DESC_TOP, DESC_WIDTH + 6, DESC_HEIGHT)
            .endFill();
        this.container.addChild(descMask);
        this.description.mask = descMask;

        // Functional while docked (see class doc); greyed in flight or
        // when the selected mission can't be aborted.
        this.abort = new Button(displayAssets, 'Abort', 80,
            { x: ORIGIN_X + 60, y: BUTTON_Y });
        this.abort.state = 'grey';
        this.abort.click.subscribe(() => void this.doAbort());
        const done = new Button(displayAssets, 'Done', 80,
            { x: ORIGIN_X + 285, y: BUTTON_Y });
        done.click.subscribe(() => this.closed.next());
        this.container.addChild(this.abort.container, done.container);

        this.controls = new MenuControls(controlEvents, {
            up: () => this.moveSelection(-1),
            down: () => this.moveSelection(1),
            // 'i' toggles the dialog closed again; 'd'/Escape backs out.
            missions: () => this.closed.next(),
            depart: () => this.closed.next(),
        });
    }

    /**
     * Shows the dialog for a ship entity; resolves when dismissed.
     * Passing an abort context (docked only) enables the Abort button.
     */
    async show(entity: Entity,
        abortContext?: MissionInfoAbortContext): Promise<void> {
        this.entity = entity;
        this.abortContext = abortContext;
        this.identity = await playerIdentitySubs(this.universe,
            entity.components.get(ShipComponent)?.id);
        try {
            await this.universe.load();
        } catch (e) {
            console.warn('Mission info failed to load universe:', e);
        }
        const missions = entity.components.get(MissionsComponent);
        // Hide invisible missions (mïsn Flags "invisible": never listed).
        this.missions = missions
            ? [...missions].filter(([id]) =>
                !this.universe.getMission(id)?.flags.invisible)
            : [];
        const date = entity.components.get(GameDateComponent);
        this.currentDay = date ? dayNumber(date) : 0;
        this.date.text = date ? formatDate(date) : '';
        this.selectedIndex = 0;

        this.refreshList();
        this.refreshDescription();

        this.container.visible = true;
        this.controls.bind();
        await firstValueFrom(this.closed);
        this.controls.unbind();
        this.container.visible = false;
    }

    private descContext() {
        const bits = this.entity
            ?.components.get(ControlBitsComponent) ?? new Set<number>();
        return makeDescTextContext(bits, playerGender());
    }

    private missionName(id: string, active: ActiveMission): string {
        const offer = activeAsOffer(this.universe, active);
        if (!offer) {
            return id;
        }
        return expandMissionText(missionDisplayName(offer.data.name),
            {
                ...offerSubstitutions(this.universe, this.currentDay, offer,
                    active),
                ...this.identity,
            }, this.descContext());
    }

    private refreshList() {
        for (const text of this.rowTexts) {
            this.listContainer.removeChild(text);
            text.destroy();
        }
        this.rowTexts = [];
        this.highlight.clear();

        if (this.missions.length === 0) {
            const empty = new PIXI.Text('None.', LIST_FONT);
            empty.position.set(4, 0);
            this.listContainer.addChild(empty);
            this.rowTexts.push(empty);
            return;
        }

        // A simple window keeps the selection visible.
        const start = Math.max(0, Math.min(
            this.selectedIndex - (LIST_ROWS - 1),
            this.missions.length - LIST_ROWS));
        const visible = this.missions.slice(start, start + LIST_ROWS);
        visible.forEach(([id, active], i) => {
            const index = start + i;
            if (index === this.selectedIndex) {
                this.highlight.beginFill(0x8b0000)
                    .drawRect(LIST_X, LIST_TOP + i * ROW_HEIGHT,
                        LIST_WIDTH, ROW_HEIGHT)
                    .endFill();
            }
            const text = new PIXI.Text(this.missionName(id, active),
                LIST_FONT);
            text.position.set(4, i * ROW_HEIGHT);
            text.interactive = true;
            text.cursor = 'pointer';
            text.on('pointerdown', () => {
                this.selectedIndex = index;
                this.refreshList();
                this.refreshDescription();
            });
            this.listContainer.addChild(text);
            this.rowTexts.push(text);
        });
    }

    private refreshDescription() {
        this.refreshAbortState();
        const entry = this.missions[this.selectedIndex];
        if (!entry) {
            this.description.text = this.missions.length === 0
                ? NO_MISSIONS : '';
            return;
        }
        const [, active] = entry;
        const offer = activeAsOffer(this.universe, active);
        if (!offer) {
            this.description.text = active.id;
            return;
        }
        const mission = offer.data;
        const brief = mission.quickBrief || mission.briefText
            || mission.offerText;
        this.description.text = expandMissionText(brief,
            {
                ...offerSubstitutions(this.universe, this.currentDay, offer,
                    active),
                ...this.identity,
            }, this.descContext());
    }

    private refreshAbortState() {
        const entry = this.missions[this.selectedIndex];
        const canAbort = !!this.abortContext && !!entry
            && (this.universe.getMission(entry[0])?.canAbort ?? true);
        this.abort.state = canAbort ? 'normal' : 'grey';
    }

    /**
     * Aborts the selected mission (docked only): runs OnAbort, drops
     * mission cargo and removes the mission via a MissionSession over
     * the held entity, then re-reads the entity's mission list.
     */
    private async doAbort() {
        const entry = this.missions[this.selectedIndex];
        if (!entry || !this.entity || !this.abortContext || this.aborting) {
            return;
        }
        const [id] = entry;
        if (!(this.universe.getMission(id)?.canAbort ?? true)) {
            this.refreshAbortState();
            return;
        }
        this.aborting = true;
        try {
            const session = await MissionSession.create(this.entity,
                this.abortContext.gameData, this.universe,
                this.abortContext.planetId);
            abortMission(session.machinery, id, session.outfits);
            session.commit();
        } finally {
            this.aborting = false;
        }
        const missions = this.entity.components.get(MissionsComponent);
        this.missions = missions
            ? [...missions].filter(([mid]) =>
                !this.universe.getMission(mid)?.flags.invisible)
            : [];
        this.selectedIndex = Math.min(this.selectedIndex,
            Math.max(0, this.missions.length - 1));
        this.refreshList();
        this.refreshDescription();
    }

    private moveSelection(delta: number) {
        if (this.missions.length === 0) {
            return;
        }
        this.selectedIndex = Math.max(0,
            Math.min(this.missions.length - 1, this.selectedIndex + delta));
        this.refreshList();
        this.refreshDescription();
    }
}
