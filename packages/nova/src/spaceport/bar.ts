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
import { MenuControls } from './menu_controls.js';
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
 * The spaceport bar (spöb flag 0x40): on entry any bar mission offers
 * (availLoc 1) approach the player one at a time as popup dialogs,
 * and then the bar itself — its dësc 10000-range description and the
 * Hire Escort / Gamble / Holovid / Leave buttons. The news does NOT
 * open automatically; the Holovid button (or the 'n' key) shows it.
 *
 * All money movement (gambling, hire fees, mission Sxxx/payment
 * effects) happens in one MissionSession working copy, committed when
 * the player leaves the bar — the outfitter pattern.
 *
 * The Holovid's QuickTime short ("Race N.mov") is unplayable in the
 * browser (documented gap), so its button shows the news feed the
 * original played alongside it.
 */
export class Bar extends Menu<Entity> {
    private session?: MissionSession;
    private hired: string[] = [];
    private description = new PIXI.Text('', DESC_FONT);
    private news: NewsDialog;
    private gamble: GambleDialog;
    private hireEscort: HireEscortDialog;
    private offerPopup: OfferPopup;
    /** Holds keyboard focus while the pointer-only offer popups show. */
    private popupBlocker: MenuControls;
    private buttons: {
        hireEscort: Button, gamble: Button, holovid: Button, leave: Button,
    };
    /** Holds the "Bar + pict" frame (8504) + the bar dësc's picture,
     * shown behind the text/buttons only when the stellar's bar has a
     * graphic (a plug-in feature; the stock scenario has none). */
    private barPictLayer = new PIXI.Container();

    constructor(displayAssets: DisplayAssetDataInterface,
        simulationData: SimulationGameDataInterface,
        controlEvents: Observable<ControlEvent>,
        private universe: MissionUniverse,
        private planetId: string) {
        super(displayAssets, simulationData, 'nova:8503', controlEvents);
        this.container.name = 'Bar';

        // Behind the buttons/description (added below), above the 8503
        // background: the opaque 8504 frame covers it when populated.
        this.container.addChild(this.barPictLayer);

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
        // The Holovid's movie is unplayable in the browser; the button
        // opens the news feed instead (see class doc).
        this.buttons.holovid.click.subscribe(() => void this.showNews());
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
        this.popupBlocker = new MenuControls(controlEvents);
        this.container.addChild(this.hireEscort.container,
            this.gamble.container, this.news.container,
            this.offerPopup.container);

        this.controls.controls = {
            hire: () => void this.showHireEscort(),
            news: () => void this.showNews(),
            gamble: () => void this.showGamble(),
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
            this.setBarPict(planet.barPict);
        } catch {
            this.description.text = FALLBACK_DESC;
            this.setBarPict(null);
        }

        const result = super.show(input);
        // Bar mission offers approach the player on entry, then the
        // bar itself. (The news no longer auto-opens; the Holovid
        // button or the 'n' key shows it.) The blocker keeps the bar's
        // own keys — and the global map key — quiet while the
        // pointer-driven offer popups are up.
        this.controls.unbind();
        this.popupBlocker.bind();
        try {
            await this.presentBarOffers();
        } catch (e) {
            console.warn('Bar entry sequence failed:', e);
        }
        this.popupBlocker.unbind();
        this.controls.bind();
        return result;
    }

    /**
     * Swaps the bar to the "Bar + pict" frame (PICT 8504) with the bar
     * dësc's picture in its upper area when the stellar defines one,
     * otherwise leaves the plain 8503 bar. The stock scenario has no bar
     * graphics, so this only lights up for plug-in content.
     */
    private setBarPict(pictId: string | null) {
        this.barPictLayer.removeChildren();
        if (!pictId) {
            this.barPictLayer.visible = false;
            return;
        }
        this.barPictLayer.visible = true;
        // The 8504 frame (266x306) is taller than the plain bar and
        // opaque, so it covers the 8503 background when centered.
        const frame = this.displayAssets.spriteFromPict('nova:8504');
        frame.anchor.set(0.5);
        this.barPictLayer.addChild(frame);
        // The picture sits in the frame's upper area, above the
        // description text.
        const image = this.displayAssets.spriteFromPict(pictId);
        image.anchor.set(0.5);
        image.position.set(0, -100);
        const fit = () => {
            if (!image.texture.valid) {
                return;
            }
            const scale = Math.min(1, 250 / image.texture.width,
                104 / image.texture.height);
            image.scale.set(scale);
        };
        fit();
        image.texture.baseTexture.once('loaded', fit);
        this.barPictLayer.addChild(image);
    }

    private async showNews() {
        if (!this.input) {
            return;
        }
        this.controls.unbind();
        await this.news.show(this.input);
        this.controls.bind();
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
                offerSubstitutions(this.universe, session.currentDay, offer);
            const text = expandMissionText(offer.data.offerText,
                substitutions);
            if (!text) {
                continue;
            }
            const choice = await this.offerPopup.show(text, {
                accept: offer.data.acceptButton || 'Accept',
                refuse: offer.data.flags.cantRefuse ? null
                    : (offer.data.refuseButton || 'Refuse'),
            }, { pict: offer.data.offerPict, style: 'offer' });
            if (choice === 'accept') {
                // The offer's acceptable flag was frozen when offers were
                // rolled; a prior accept this visit may have filled the
                // hold or the cap, so re-check and report cleanly.
                const result = acceptOffer(session.machinery, offer,
                    session.outfits);
                if (!result.accepted) {
                    await this.offerPopup.show(result.reason, { accept: 'OK' });
                    continue;
                }
                const brief = expandMissionText(offer.data.briefText,
                    substitutions);
                if (brief) {
                    // The briefing (post-accept) text uses the generic
                    // briefing frame, with its own dësc picture when set.
                    await this.offerPopup.show(brief, { accept: 'OK' },
                        { pict: offer.data.briefPict, style: 'briefing' });
                }
            } else {
                refuseOffer(session.machinery, offer, session.outfits);
                const refuseText = expandMissionText(
                    offer.data.refuseText, substitutions);
                if (refuseText) {
                    await this.offerPopup.show(refuseText,
                        { accept: 'OK' },
                        { pict: offer.data.refusePict, style: 'briefing' });
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

// The mission-text popup frames. Two are three-part compositions whose
// middle strip tiles vertically to fit the text (top 9px, bottom 40px):
//   'offer'    — PICTs 8521/8522/8523, the mission-offer popup.
//   'briefing' — PICTs 8524/8525/8526, generic briefing / result text.
// The third is the fixed-size "desc + pict" frame (PICT 8527, 649x244),
// used when the mission text carries an accompanying picture (the dësc's
// Graphic field): text on the left, the picture on the right.
const POPUP_WIDTH = 441;
const POPUP_TEXT_MARGIN = 24;
const POPUP_TEXT_WIDTH = POPUP_WIDTH - 2 * POPUP_TEXT_MARGIN;

type PopupStyle = 'offer' | 'briefing';
const POPUP_FRAMES: Record<PopupStyle, [string, string, string]> = {
    offer: ['nova:8521', 'nova:8522', 'nova:8523'],
    briefing: ['nova:8524', 'nova:8525', 'nova:8526'],
};

// The desc + pict frame (PICT 8527): the picture sits in the right pane,
// the text wraps in the left pane.
const PICT_FRAME = 'nova:8527';
const PICT_FRAME_WIDTH = 649;
const PICT_FRAME_HEIGHT = 244;
const PICT_TEXT_MARGIN = 16;
const PICT_TEXT_WIDTH = 372;
// The picture pane is the right ~230px of the frame.
const PICT_PANE_CENTER_X = PICT_FRAME_WIDTH / 2 - 122;
const PICT_PANE_MAX = 210;

const POPUP_FONT: Partial<PIXI.ITextStyle> = {
    fontFamily: 'Geneva', fontSize: 10, fill: 0xffffff,
    align: 'left', wordWrap: true, wordWrapWidth: POPUP_TEXT_WIDTH,
};
const PICT_TEXT_FONT: Partial<PIXI.ITextStyle> = {
    ...POPUP_FONT, wordWrapWidth: PICT_TEXT_WIDTH,
};

/** Optional rendering choices for a mission-text popup. */
interface PopupOptions {
    /** Global PICT id shown beside the text (the dësc Graphic). When set,
     * the popup uses the desc+pict frame (8527) instead of a tiled one. */
    pict?: string | null;
    /** Which tiled frame to use when there is no picture. */
    style?: PopupStyle;
}

/**
 * A modal mission-text dialog: expanded mission text with Accept / Refuse
 * buttons (using the mïsn's custom button labels when present). Renders
 * on the mission-offer frame (8521-8523), the generic briefing frame
 * (8524-8526), or — when the text carries a picture — the desc+pict
 * frame (8527) with the image beside the text. Pointer-driven; the owner
 * keeps its own controls unbound while a popup is up.
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
    }, options: PopupOptions = {}): Promise<'accept' | 'refuse'> {
        this.container.removeChildren();

        if (options.pict) {
            this.buildWithPict(text, buttons, options.pict);
        } else {
            this.buildTiled(text, buttons, options.style ?? 'offer');
        }

        this.container.visible = true;
        const result = await firstValueFrom(this.choice);
        this.container.visible = false;
        this.container.removeChildren();
        return result;
    }

    /** The Accept (and optional Refuse) buttons at a given y. */
    private addButtons(buttons: { accept: string, refuse?: string | null },
        buttonY: number) {
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
    }

    /** Three-part frame (offer 8521-3 or briefing 8524-6), middle tiled
     * to the text height. */
    private buildTiled(text: string, buttons: {
        accept: string, refuse?: string | null,
    }, style: PopupStyle) {
        const [topId, middleId, bottomId] = POPUP_FRAMES[style];
        const textSprite = new PIXI.Text(text, POPUP_FONT);
        const textHeight = Math.min(
            Math.max(textSprite.height, 40), 480);

        const top = this.displayAssets.spriteFromPict(topId);
        const middle = new PIXI.TilingSprite(
            this.displayAssets.textureFromPict(middleId),
            POPUP_WIDTH, textHeight + 2 * POPUP_TEXT_MARGIN);
        const bottom = this.displayAssets.spriteFromPict(bottomId);
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
        // Clip overlong text to the frame (it stays readable — EVN
        // texts rarely exceed this height).
        const textMask = new PIXI.Graphics().beginFill(0xffffff)
            .drawRect(-POPUP_WIDTH / 2, originY + 9, POPUP_WIDTH,
                middle.height)
            .endFill();
        this.container.addChild(textMask);
        textSprite.mask = textMask;

        this.addButtons(buttons, originY + totalHeight - 32);
    }

    /** The fixed-size desc+pict frame (8527): text left, picture right. */
    private buildWithPict(text: string, buttons: {
        accept: string, refuse?: string | null,
    }, pict: string) {
        const totalHeight = PICT_FRAME_HEIGHT + 40;
        const originY = -totalHeight / 2;
        const originX = -PICT_FRAME_WIDTH / 2;

        const frame = this.displayAssets.spriteFromPict(PICT_FRAME);
        frame.position.set(originX, originY);
        frame.interactive = true;
        this.container.addChild(frame);

        const textSprite = new PIXI.Text(text, PICT_TEXT_FONT);
        textSprite.position.set(originX + PICT_TEXT_MARGIN,
            originY + PICT_TEXT_MARGIN);
        this.container.addChild(textSprite);
        const textMask = new PIXI.Graphics().beginFill(0xffffff)
            .drawRect(originX + PICT_TEXT_MARGIN, originY + 8,
                PICT_TEXT_WIDTH, PICT_FRAME_HEIGHT - 16)
            .endFill();
        this.container.addChild(textMask);
        textSprite.mask = textMask;

        // The picture, scaled to fit the right pane.
        const image = this.displayAssets.spriteFromPict(pict);
        image.anchor.set(0.5);
        image.position.set(PICT_PANE_CENTER_X, originY + PICT_FRAME_HEIGHT / 2);
        const fit = () => {
            if (!image.texture.valid) {
                return;
            }
            const scale = Math.min(1,
                PICT_PANE_MAX / image.texture.width,
                PICT_PANE_MAX / image.texture.height);
            image.scale.set(scale);
        };
        fit();
        image.texture.baseTexture.once('loaded', fit);
        this.container.addChild(image);

        this.addButtons(buttons, originY + totalHeight - 32);
    }
}
