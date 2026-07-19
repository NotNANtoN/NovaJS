import { Entity } from 'nova_ecs/entity';
import * as PIXI from 'pixi.js';
import { firstValueFrom, Observable, Subject } from 'rxjs';
import { DisplayAssetDataInterface } from '../client/gamedata/display_asset_data.js';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { ControlEvent } from '../nova_plugin/controls_plugin.js';
import {
    acceptOffer,
    LOCATION_BAR,
    MissionOffer,
    refuseOffer,
} from '../nova_plugin/mission_logic.js';
import { expandMissionText } from '../nova_plugin/mission_text.js';
import { Button } from './button.js';
import { GambleDialog } from './gamble.js';
import { HireEscortDialog } from './hire_escort.js';
import { Menu } from './menu.js';
import { offerSubstitutions, rollOffers } from './mission_offers.js';
import { MissionSession } from './mission_session.js';
import { MissionUniverse } from './mission_universe.js';
import { NewsDialog } from './news_dialog.js';
import { PendingEscortsComponent } from './pending_escorts.js';

// Laid out to fit the 263x185 Bar dialog (PICT 8503): text pane at
// x 5..252, y 3..118; the metal button area below fits a 2x2 grid.
const DESC_X = -122;
const DESC_Y = -85;
const DESC_WIDTH = 238;
const BUTTON_COL = [-120, 8];
const BUTTON_ROW = [30, 60];
const BUTTON_WIDTH = 80;

const DESC_FONT: Partial<PIXI.ITextStyle> = {
    fontFamily: 'Geneva', fontSize: 10, fill: 0xffffff,
    align: 'left', wordWrap: true, wordWrapWidth: DESC_WIDTH,
};

const FALLBACK_DESC = 'The bar is quiet tonight. A tired bartender '
    + 'polishes glasses and keeps one eye on the door.';

/**
 * The spaceport bar (spöb flag 0x40), following the original's flow:
 * entering the bar shows the news window, then any bar mission offers
 * (availLoc 1) approach the player one at a time as popup dialogs,
 * and then the bar itself — its dësc 10000-range description and the
 * Hire Escort / Gamble / Holovid / Leave buttons.
 *
 * All money movement (gambling, hire fees, mission Sxxx/payment
 * effects) happens in one MissionSession working copy, committed when
 * the player leaves the bar — the outfitter pattern.
 *
 * The Holovid (the original plays a QuickTime short) is not
 * implemented; its button is greyed out (documented gap).
 */
export class Bar extends Menu<Entity> {
    private session?: MissionSession;
    private hired: string[] = [];
    private description = new PIXI.Text('', DESC_FONT);
    private news: NewsDialog;
    private gamble: GambleDialog;
    private hireEscort: HireEscortDialog;
    private offerPopup: OfferPopup;
    private buttons: {
        hireEscort: Button, gamble: Button, holovid: Button, leave: Button,
    };

    constructor(displayAssets: DisplayAssetDataInterface,
        simulationData: SimulationGameDataInterface,
        controlEvents: Observable<ControlEvent>,
        private universe: MissionUniverse,
        private planetId: string) {
        super(displayAssets, simulationData, 'nova:8503', controlEvents);
        this.container.name = 'Bar';

        this.buttons = {
            hireEscort: new Button(displayAssets, 'Hire Escort',
                BUTTON_WIDTH, { x: BUTTON_COL[0], y: BUTTON_ROW[0] }),
            gamble: new Button(displayAssets, 'Gamble',
                BUTTON_WIDTH, { x: BUTTON_COL[1], y: BUTTON_ROW[0] }),
            holovid: new Button(displayAssets, 'Holovid',
                BUTTON_WIDTH, { x: BUTTON_COL[0], y: BUTTON_ROW[1] }),
            leave: new Button(displayAssets, 'Leave',
                BUTTON_WIDTH, { x: BUTTON_COL[1], y: BUTTON_ROW[1] }),
        };
        this.buttons.hireEscort.click.subscribe(
            () => void this.showHireEscort());
        this.buttons.gamble.click.subscribe(() => void this.showGamble());
        // The Holovid is unimplemented (see class doc).
        this.buttons.holovid.state = 'grey';
        this.buttons.leave.click.subscribe(this.done.bind(this));
        this.addButtons(this.buttons);

        this.description.position.set(DESC_X, DESC_Y);
        this.container.addChild(this.description);

        this.news = new NewsDialog(displayAssets, simulationData,
            controlEvents, universe, planetId);
        this.gamble = new GambleDialog(displayAssets, controlEvents);
        this.hireEscort = new HireEscortDialog(displayAssets,
            simulationData, controlEvents, planetId);
        this.offerPopup = new OfferPopup(displayAssets);
        this.container.addChild(this.hireEscort.container,
            this.gamble.container, this.news.container,
            this.offerPopup.container);

        this.controls.controls = {
            depart: this.done.bind(this),
        };
    }

    override async show(input: Entity): Promise<Entity> {
        try {
            this.session = await MissionSession.create(input,
                this.simulationData, this.universe, this.planetId);
        } catch (e) {
            console.warn('Bar failed to load:', e);
            return input;
        }
        this.hired = [];
        try {
            const planet = await this.simulationData.data.Planet
                .get(this.planetId);
            this.description.text = planet.barDesc || FALLBACK_DESC;
        } catch {
            this.description.text = FALLBACK_DESC;
        }

        const result = super.show(input);
        // The original's bar entry sequence: news first, then any bar
        // mission offers approach the player, then the bar itself.
        this.controls.unbind();
        try {
            await this.news.show(input);
            await this.presentBarOffers();
        } catch (e) {
            console.warn('Bar entry sequence failed:', e);
        }
        this.controls.bind();
        return result;
    }

    /** Bar mission offers (availLoc 1), one popup at a time. */
    private async presentBarOffers() {
        const session = this.session!;
        const offers = rollOffers(session, this.universe, LOCATION_BAR)
            .filter(offer => offer.acceptable);
        for (const offer of offers) {
            if (session.state.missions.has(offer.data.id)) {
                continue;
            }
            const substitutions =
                offerSubstitutions(this.universe, session, offer);
            const text = expandMissionText(offer.data.offerText,
                substitutions);
            if (!text) {
                continue;
            }
            const choice = await this.offerPopup.show(text, {
                accept: offer.data.acceptButton || 'Accept',
                refuse: offer.data.flags.cantRefuse ? null
                    : (offer.data.refuseButton || 'Refuse'),
            });
            if (choice === 'accept') {
                acceptOffer(session.machinery, offer, session.outfits);
                const brief = expandMissionText(offer.data.briefText,
                    substitutions);
                if (brief) {
                    await this.offerPopup.show(brief, { accept: 'OK' });
                }
            } else {
                refuseOffer(session.machinery, offer, session.outfits);
                const refuseText = expandMissionText(
                    offer.data.refuseText, substitutions);
                if (refuseText) {
                    await this.offerPopup.show(refuseText,
                        { accept: 'OK' });
                }
            }
        }
    }

    private async showGamble() {
        if (!this.session) {
            return;
        }
        this.controls.unbind();
        await this.gamble.show(this.session.state.credits);
        this.controls.bind();
    }

    private async showHireEscort() {
        if (!this.session) {
            return;
        }
        this.controls.unbind();
        await this.hireEscort.show(this.session.state.credits, this.hired);
        this.controls.bind();
    }

    protected override done() {
        this.session?.commit();
        if (this.hired.length > 0) {
            const pending =
                this.input.components.get(PendingEscortsComponent) ?? [];
            this.input.components.set(PendingEscortsComponent,
                [...pending, ...this.hired]);
            this.hired = [];
        }
        super.done();
    }
}

// The mission-offer popup frame (PICTs 8521/8522/8523): a fixed-width
// dialog whose middle tiles vertically to fit the offer text.
const POPUP_WIDTH = 441;
const POPUP_TEXT_MARGIN = 24;
const POPUP_TEXT_WIDTH = POPUP_WIDTH - 2 * POPUP_TEXT_MARGIN;

const POPUP_FONT: Partial<PIXI.ITextStyle> = {
    fontFamily: 'Geneva', fontSize: 10, fill: 0xffffff,
    align: 'left', wordWrap: true, wordWrapWidth: POPUP_TEXT_WIDTH,
};

/**
 * A modal offer dialog: expanded mission text with Accept / Refuse
 * buttons (using the mïsn's custom button labels when present).
 * Pointer-driven; the owner keeps its own controls unbound while a
 * popup is up.
 */
class OfferPopup {
    container = new PIXI.Container();
    private choice = new Subject<'accept' | 'refuse'>();

    constructor(private displayAssets: DisplayAssetDataInterface) {
        this.container.name = 'OfferPopup';
        this.container.visible = false;
    }

    async show(text: string, buttons: {
        accept: string,
        refuse?: string | null,
    }): Promise<'accept' | 'refuse'> {
        this.container.removeChildren();

        const textSprite = new PIXI.Text(text, POPUP_FONT);
        const textHeight = Math.min(
            Math.max(textSprite.height, 40), 300);

        const top = this.displayAssets.spriteFromPict('nova:8521');
        const middle = new PIXI.TilingSprite(
            this.displayAssets.textureFromPict('nova:8522'),
            POPUP_WIDTH, textHeight + 2 * POPUP_TEXT_MARGIN);
        const bottom = this.displayAssets.spriteFromPict('nova:8523');
        const totalHeight = 9 + middle.height + 40;
        const originY = -totalHeight / 2;
        top.position.set(-POPUP_WIDTH / 2, originY);
        middle.position.set(-POPUP_WIDTH / 2, originY + 9);
        bottom.position.set(-POPUP_WIDTH / 2, originY + 9 + middle.height);
        top.interactive = middle.interactive = bottom.interactive = true;
        this.container.addChild(top, middle, bottom);

        textSprite.position.set(-POPUP_WIDTH / 2 + POPUP_TEXT_MARGIN,
            originY + 9 + POPUP_TEXT_MARGIN / 2);
        this.container.addChild(textSprite);

        const buttonY = originY + totalHeight - 32;
        const accept = new Button(this.displayAssets, buttons.accept,
            70, { x: buttons.refuse ? 30 : 75, y: buttonY });
        accept.click.subscribe(() => this.choice.next('accept'));
        this.container.addChild(accept.container);
        if (buttons.refuse) {
            const refuse = new Button(this.displayAssets, buttons.refuse,
                70, { x: -125, y: buttonY });
            refuse.click.subscribe(() => this.choice.next('refuse'));
            this.container.addChild(refuse.container);
        }

        this.container.visible = true;
        const result = await firstValueFrom(this.choice);
        this.container.visible = false;
        this.container.removeChildren();
        return result;
    }
}
