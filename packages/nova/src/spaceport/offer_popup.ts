import * as PIXI from 'pixi.js';
import { firstValueFrom, Subject } from 'rxjs';
import { DisplayAssetDataInterface } from '../client/gamedata/display_asset_data.js';
import {
    acceptOffer,
    MissionOffer,
    refuseOffer,
} from '../nova_plugin/mission_logic.js';
import { expandMissionText } from '../nova_plugin/mission_text.js';
import { makeDescTextContext, playerGender } from '../nova_plugin/desc_text.js';
import { Button } from './button.js';
import { offerSubstitutions } from './mission_offers.js';
import { playerIdentitySubs } from './player_identity.js';
import { MissionSession } from './mission_session.js';
import { MissionUniverse } from './mission_universe.js';

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
// A long offer's text scrolls within this window; the original paginates
// the same-size frame with up/down arrows (see the kont-probe reference
// spaceport/kiniké_kont_probe_mission_offer_in_spaceport{,_cont}.png).
const POPUP_MAX_VISIBLE = 320;
// A page's worth of scroll leaves a couple of lines of overlap, matching
// the original's page-down behaviour (the _cont reference repeats the
// last visible paragraph at the top of the next page).
const POPUP_PAGE_OVERLAP = 20;

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
export interface PopupOptions {
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
 * frame (8527) with the image beside the text. Long text paginates in
 * place with up/down arrows (the kont-probe reference). Pointer-driven;
 * the owner keeps its own controls unbound while a popup is up.
 */
export class OfferPopup {
    container = new PIXI.Container();
    private choice = new Subject<'accept' | 'refuse'>();
    /** Scroll machinery for the current (tiled) popup, when it paginates. */
    private scroll?: {
        text: PIXI.Text,
        top: number,
        maxOffset: number,
        offset: number,
        up: Button,
        down: Button,
    };

    constructor(private displayAssets: DisplayAssetDataInterface) {
        this.container.name = 'OfferPopup';
        this.container.visible = false;
    }

    async show(text: string, buttons: {
        accept: string,
        refuse?: string | null,
    }, options: PopupOptions = {}): Promise<'accept' | 'refuse'> {
        this.container.removeChildren();
        this.scroll = undefined;

        if (options.pict) {
            this.buildWithPict(text, buttons, options.pict);
        } else {
            this.buildTiled(text, buttons, options.style ?? 'offer');
        }

        this.container.visible = true;
        const result = await firstValueFrom(this.choice);
        this.container.visible = false;
        this.container.removeChildren();
        this.scroll = undefined;
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

    /**
     * The up/down page arrows for a paginated popup, sitting at the right
     * of the button row (the original's scroll chevrons). Greyed at each
     * end of the scroll range.
     */
    private addScrollButtons(text: PIXI.Text, top: number,
        maxOffset: number, buttonY: number) {
        const up = new Button(this.displayAssets, '▲', 18,
            { x: 150, y: buttonY });
        const down = new Button(this.displayAssets, '▼', 18,
            { x: 185, y: buttonY });
        this.scroll = { text, top, maxOffset, offset: 0, up, down };
        up.click.subscribe(() => this.scrollBy(-1));
        down.click.subscribe(() => this.scrollBy(1));
        this.container.addChild(up.container, down.container);
        this.refreshScrollButtons();
    }

    private scrollBy(direction: number) {
        if (!this.scroll) {
            return;
        }
        const page = POPUP_MAX_VISIBLE - POPUP_PAGE_OVERLAP;
        this.scroll.offset = Math.max(0, Math.min(this.scroll.maxOffset,
            this.scroll.offset + direction * page));
        this.scroll.text.position.y = this.scroll.top - this.scroll.offset;
        this.refreshScrollButtons();
    }

    private refreshScrollButtons() {
        if (!this.scroll) {
            return;
        }
        this.scroll.up.state = this.scroll.offset > 0 ? 'normal' : 'grey';
        this.scroll.down.state =
            this.scroll.offset < this.scroll.maxOffset ? 'normal' : 'grey';
    }

    /** Three-part frame (offer 8521-3 or briefing 8524-6), middle tiled
     * to the visible text height; overlong text scrolls with the arrows. */
    private buildTiled(text: string, buttons: {
        accept: string, refuse?: string | null,
    }, style: PopupStyle) {
        const [topId, middleId, bottomId] = POPUP_FRAMES[style];
        const textSprite = new PIXI.Text(text, POPUP_FONT);
        const fullHeight = Math.max(textSprite.height, 40);
        const visibleHeight = Math.min(fullHeight, POPUP_MAX_VISIBLE);
        const paginated = fullHeight > visibleHeight + 1;

        const top = this.displayAssets.spriteFromPict(topId);
        const middle = new PIXI.TilingSprite(
            this.displayAssets.textureFromPict(middleId),
            POPUP_WIDTH, visibleHeight + 2 * POPUP_TEXT_MARGIN);
        const bottom = this.displayAssets.spriteFromPict(bottomId);
        const totalHeight = 9 + middle.height + 40;
        const originY = -totalHeight / 2;
        top.position.set(-POPUP_WIDTH / 2, originY);
        middle.position.set(-POPUP_WIDTH / 2, originY + 9);
        bottom.position.set(-POPUP_WIDTH / 2, originY + 9 + middle.height);
        top.interactive = middle.interactive = bottom.interactive = true;
        this.container.addChild(top, middle, bottom);

        const textTop = originY + 9 + POPUP_TEXT_MARGIN / 2;
        textSprite.position.set(-POPUP_WIDTH / 2 + POPUP_TEXT_MARGIN, textTop);
        this.container.addChild(textSprite);
        // Clip the text to the visible window (the scroll arrows page
        // through the rest).
        const textMask = new PIXI.Graphics().beginFill(0xffffff)
            .drawRect(-POPUP_WIDTH / 2, originY + 9, POPUP_WIDTH,
                middle.height)
            .endFill();
        this.container.addChild(textMask);
        textSprite.mask = textMask;

        const buttonY = originY + totalHeight - 32;
        this.addButtons(buttons, buttonY);
        if (paginated) {
            this.addScrollButtons(textSprite, textTop,
                fullHeight - visibleHeight, buttonY);
        }
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

/**
 * Presents a pre-rolled list of mission offers one popup at a time (the
 * shared bar / main-spaceport offer flow). Each offer shows its expanded
 * offer text with the mïsn's custom accept/refuse labels; Accept runs
 * through the real NCB machinery (and shows the briefing text), Refuse
 * runs OnRefuse (and shows any refuse text). A cantRefuse offer shows only
 * the accept button. Mutations land in the session's working copy; the
 * caller commits.
 */
export async function presentOffers(popup: OfferPopup,
    session: MissionSession, universe: MissionUniverse,
    offers: MissionOffer[]): Promise<void> {
    const identity = await playerIdentitySubs(universe, session.shipId);
    for (const offer of offers) {
        // A prior accept this visit may have made the mission active.
        if (session.state.missions.has(offer.data.id)) {
            continue;
        }
        const substitutions = {
            ...offerSubstitutions(universe, session.currentDay, offer),
            ...identity,
        };
        const ctx = makeDescTextContext(session.state.bits,
            playerGender());
        const text = expandMissionText(offer.data.offerText, substitutions, ctx);
        if (!text) {
            continue;
        }
        const choice = await popup.show(text, {
            accept: offer.data.acceptButton || 'Accept',
            refuse: offer.data.flags.cantRefuse ? null
                : (offer.data.refuseButton || 'Refuse'),
        }, { pict: offer.data.offerPict, style: 'offer' });
        if (choice === 'accept') {
            // The offer's acceptable flag was frozen when offers were
            // rolled; a prior accept this visit may have filled the hold
            // or the cap, so re-check and report cleanly.
            const result = acceptOffer(session.machinery, offer,
                session.outfits);
            if (!result.accepted) {
                await popup.show(result.reason, { accept: 'OK' });
                continue;
            }
            const brief = expandMissionText(offer.data.briefText,
                substitutions, ctx);
            if (brief) {
                // The briefing (post-accept) text uses the generic
                // briefing frame, with its own dësc picture when set.
                await popup.show(brief, { accept: 'OK' },
                    { pict: offer.data.briefPict, style: 'briefing' });
            }
        } else {
            refuseOffer(session.machinery, offer, session.outfits);
            const refuseText = expandMissionText(
                offer.data.refuseText, substitutions, ctx);
            if (refuseText) {
                await popup.show(refuseText, { accept: 'OK' },
                    { pict: offer.data.refusePict, style: 'briefing' });
            }
        }
    }
}
