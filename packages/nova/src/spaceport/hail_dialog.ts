import * as PIXI from 'pixi.js';
import { firstValueFrom, Observable, Subject } from 'rxjs';
import { DisplayAssetDataInterface } from '../client/gamedata/display_asset_data.js';
import { ControlEvent } from '../nova_plugin/controls_plugin.js';
import { Button } from './button.js';
import {
    buttonRowY, commButtonSlots, COMM_ESCORT, COMM_HAGGLE, COMM_LINE_HEIGHT,
    COMM_PLANET, COMM_SHIP, CommFrameLayout, fitImage, frameOrigin,
} from './hail_layout.js';
import { MenuControls } from './menu_controls.js';

/**
 * ============================================================================
 * The communications (hail) dialog — client-side rendering
 * ============================================================================
 *
 * A modal overlay opened by the 'hail' key while in flight, on the same
 * MenuControls focus stack as the starmap / mission-info dialogs. It renders
 * one of the comms backgrounds (PICT 8511 ships, 8512 planets, 8513 escorts,
 * 8514 haggle/beg-for-mercy) with the target's image and greeting/response
 * text, plus context-appropriate buttons.
 *
 * This class is presentation only: what to show and which buttons to offer is
 * decided by hail_dialog_plugin (from the pure logic in nova_plugin/hail.ts),
 * and every button that has a SIMULATION effect calls back into the plugin,
 * which routes it through the deterministic input path (bridge.hail /
 * escort-command control events). The dialog never mutates the sim directly.
 *
 * The ESCORT comm dialog (PICT 8513) manages a hired escort — it does NOT
 * issue fleet commands (Attack / Defend / Formation / ...); commanding escorts
 * is the keyboard escort-controls' job. Per the reference screenshots
 * (hail/hail_escort.png and the upgrading/captured/sell variants) the button
 * column is, top to bottom: Upgrade Escort, Sell Escort, Release, Close
 * Channel. All three management actions depend on state NovaJS does not model
 * yet — a shipyard upgrade-transfer, an escort resale value, and per-escort
 * release (a future per-escort-control feature Matthew will spec separately) —
 * so they render as GREYED seams; only Close Channel is live. See the plugin
 * for the documented seams.
 */

/** Comms-dialog background PICT ids (see novajs-spaceport-ui memory map). */
export const HAIL_PICT_SHIP = 'nova:8511';
export const HAIL_PICT_PLANET = 'nova:8512';
export const HAIL_PICT_ESCORT = 'nova:8513';
export const HAIL_PICT_HAGGLE = 'nova:8514';

/** Interface beeps (snd resources) for the comm dialog: open, close, and a
 * generic button press. Local client UI sounds — routed through the display
 * audio path via the playSound callback, never the simulation. */
export const HAIL_SND_OPEN = 'nova:154';
export const HAIL_SND_CLOSE = 'nova:152';
export const HAIL_SND_BUTTON = 'nova:151';

/** What the plugin tells the dialog to display. Pure data, no world refs. */
export interface HailContext {
    /** Which comms background / layout to use. */
    variant: 'ship' | 'planet' | 'escort';
    /** Header line: govt comm name, person name, or planet name. */
    heading: string;
    /** A fully-qualified PICT global id for the target image (e.g. a ship's
     * 'nova:3001' pict, a pers hailPict which the parser already emits as
     * 'nova:4001', or a planet pict), or null for no image. Already prefixed —
     * the caller must NOT add another 'nova:'. */
    image: string | null;
    /** Body: greeting, hostile line, or planet/escort status text. */
    body: string;
    /** Request-assistance offer (fuel/repair), when eligible. */
    assist?: { free: boolean };
    /** Bribe / beg-for-mercy offer against a hostile ship, when eligible. */
    bribe?: { amount: number, canAfford: boolean };
    /** Escort-management dialog (escort variant only): show the Upgrade
     * Escort / Sell Escort / Release seam buttons above Close Channel. */
    escort?: boolean;
}

/** Callbacks the dialog fires. `requestAssistance`/`bribe` route to the
 * deterministic input path; `playSound` plays a local client UI beep through
 * the display audio path (no simulation involvement). */
export interface HailCallbacks {
    /**
     * Asks the hailed ship for aid, and returns WHAT IT SAID — an acceptance
     * ("All right, I'll help you."), a busy refusal ("I'm busy.") or a
     * pointless-request refusal ("You're not in any trouble."), all real lines
     * from the stock comm table. The simulation effect, if any, has already
     * been dispatched by the time this returns.
     *
     * The answer comes back from the one call rather than from a separate
     * "may I?" probe on purpose: probe-then-send would evaluate the ship's
     * state twice, and could dispatch a request the probe had just cleared.
     */
    requestAssistance(): string;
    bribe(): void;
    playSound(id: string): void;
}

/**
 * The comm dialogs' identity-block colours, sampled from the original-hardware
 * captures (1920x1080, frames blitted 1:1 — these are the game's own pixels):
 * on hail/hail_hostile.png the lower well's "Class:" / "Status:" labels are
 * 0x808080 grey, "Fed Destroyer" and "(Federation)" are white, and "Hostile"
 * is 0xdd0806 red. hail/hail.png and hail/hail_escort.png agree (a bare label
 * line such as "Hired Escort:" is grey, the name under it white).
 */
export const COMM_LABEL_COLOR = 0x808080;
export const COMM_VALUE_COLOR = 0xffffff;
export const COMM_HOSTILE_COLOR = 0xdd0806;

/** A stretch of identity text drawn in one colour. */
export interface CommTextRun {
    text: string;
    color: number;
}

/**
 * Splits an identity block (hail_dialog_plugin's shipIdentityBlock) into the
 * coloured runs the original draws, one array of runs per line:
 *
 *   "Class: Fed Destroyer" -> grey "Class: " + white "Fed Destroyer"
 *   "Status: Hostile"      -> grey "Status: " + RED "Hostile"
 *   "(Federation)"         -> white, whole
 *   "Hired Escort:"        -> grey, whole (a label with nothing after it)
 *
 * Pure and total, and it never alters the text: concatenating the runs back
 * together reproduces the block exactly. Only the Status line is red, and
 * "Hostile" is the only status the block ever carries.
 */
export function identityRuns(block: string): CommTextRun[][] {
    return block.split('\n').map(line => {
        const colon = line.indexOf(':');
        if (colon < 0) {
            return [{ text: line, color: COMM_VALUE_COLOR }];
        }
        // Keep the separating space with the LABEL, so the value run starts
        // at the first inked pixel of the value.
        const valueStart = /\S/.exec(line.slice(colon + 1));
        if (!valueStart) {
            // A bare label ("Hired Escort:", "Fighter:") — all dim.
            return [{ text: line, color: COMM_LABEL_COLOR }];
        }
        const split = colon + 1 + valueStart.index;
        const label = line.slice(0, split);
        return [
            { text: label, color: COMM_LABEL_COLOR },
            {
                text: line.slice(split),
                color: label.trimEnd() === 'Status:'
                    ? COMM_HOSTILE_COLOR : COMM_VALUE_COLOR,
            },
        ];
    });
}

/**
 * The comm dialogs' body font. Geneva 9.4px with an explicit 15px leading:
 * the same bitmap face and size the mission popups use (popup_layout's
 * POPUP_FONT), set to the looser line pitch these frames show — see
 * COMM_LINE_HEIGHT. NOT bold and not two different sizes: the references'
 * response and identity text are the same face, and the only variation is
 * colour (dim grey labels, white values).
 */
const HEADING_FONT: Partial<PIXI.ITextStyle> = {
    fontFamily: 'Geneva', fontSize: 9.4, fill: 0xffffff, align: 'left',
    wordWrap: false, lineHeight: COMM_LINE_HEIGHT,
};
const BODY_FONT: Partial<PIXI.ITextStyle> = {
    fontFamily: 'Geneva', fontSize: 9.4, fill: 0xffffff, align: 'left',
    wordWrap: true, wordWrapWidth: 240, lineHeight: COMM_LINE_HEIGHT,
};

/**
 * A Button's container.x is not quite its sprite's left edge: the left cap
 * (13px wide) is anchored to END at container.x + 13.2 (button.ts's
 * LEFT_POS), so the sprite's left edge lands at container.x + 0.2.
 * hail_layout quotes the measured SPRITE left edge, so placing one takes
 * that fifth of a pixel back off.
 */
const BUTTON_CAP_INSET = 0.2;

/** The frame layout for a context/phase (see hail_layout.ts). */
export function frameFor(phase: 'main' | 'haggle',
    variant: 'ship' | 'planet' | 'escort'): CommFrameLayout {
    if (phase === 'haggle') {
        return COMM_HAGGLE;
    }
    switch (variant) {
        case 'planet': return COMM_PLANET;
        case 'escort': return COMM_ESCORT;
        default: return COMM_SHIP;
    }
}

/**
 * Which offer the 'r' key ("recharge", the original's request-assistance
 * key) activates in the hail dialog: the assist button slot's occupant —
 * Request Assistance when eligible, or Beg for Mercy against a hostile
 * ship (the slot's replacement). Nothing on the haggle page (where the
 * offer buttons are Pay/Leave) or when neither offer exists.
 */
export function assistSlotAction(phase: 'main' | 'haggle',
    context?: { assist?: unknown, bribe?: unknown }):
    'assist' | 'beg' | undefined {
    if (phase !== 'main' || !context) {
        return undefined;
    }
    if (context.assist) {
        return 'assist';
    }
    if (context.bribe) {
        return 'beg';
    }
    return undefined;
}

export class HailDialog {
    container = new PIXI.Container();
    private content = new PIXI.Container();
    private controls: MenuControls;
    private closed = new Subject<void>();
    private phase: 'main' | 'haggle' = 'main';
    private context?: HailContext;
    /** The context the channel opened with, so Greetings can restore it. */
    private opening?: HailContext;

    constructor(private displayAssets: DisplayAssetDataInterface,
        private controlEvents: Observable<ControlEvent>,
        private callbacks: HailCallbacks) {
        this.container.name = 'HailDialog';
        this.container.visible = false;

        // Modal shield: swallow clicks aimed past the dialog.
        const shield = new PIXI.Graphics()
            .beginFill(0x000000, 0.001)
            .drawRect(-4000, -4000, 8000, 8000)
            .endFill();
        shield.interactive = true;
        this.container.addChild(shield);
        this.container.addChild(this.content);

        this.controls = new MenuControls(controlEvents, {
            // 'y' toggles the dialog closed again; 'd'/Escape backs out.
            hail: () => this.closed.next(),
            depart: () => this.close(),
            // 'r': the assist slot — Request Assistance, or Beg for
            // Mercy when hostile (the slot's replacement).
            recharge: () => this.pressAssistSlot(),
        });
    }

    /** Shows the dialog for a computed context; resolves when dismissed. */
    async show(context: HailContext): Promise<void> {
        this.context = context;
        this.opening = context;
        this.phase = 'main';
        await this.render();
        this.container.visible = true;
        this.callbacks.playSound(HAIL_SND_OPEN);
        this.controls.bind();
        await firstValueFrom(this.closed);
        this.callbacks.playSound(HAIL_SND_CLOSE);
        this.controls.unbind();
        this.container.visible = false;
    }

    /**
     * The Greetings press (the top button in every ship/planet reference):
     * hails again. NovaJS's greeting line is a deterministic function of the
     * target (hail_dialog_plugin's greetingText, seeded by its uuid), so the
     * answer is the SAME line every time — pressing it restores the greeting
     * the channel opened with, which is what it is good for after a refusal
     * has replaced the response text.
     */
    private pressGreetings() {
        this.beep();
        if (this.context && this.opening
            && this.context.body !== this.opening.body) {
            this.context = { ...this.context, body: this.opening.body };
            void this.render();
        }
    }

    /** The Beg for Mercy press: into the haggle page. */
    private pressBeg() {
        this.beep();
        this.phase = 'haggle';
        void this.render();
    }

    /**
     * The Request Assistance press. WHATEVER the ship answers — an acceptance
     * ("All right, I'll help you."), a busy refusal ("I'm busy.") or "you
     * don't need help" — the channel stays OPEN showing the line, so the
     * player actually hears the reply and closes the channel themselves. The
     * offer button goes away with the answer, so one request cannot be
     * hammered at a ship that has already replied. (Accepting used to slam the
     * dialog shut the moment the request was dispatched.)
     */
    private pressAssist() {
        const context = this.context;
        if (!context?.assist) {
            return;
        }
        this.beep();
        const answer = this.callbacks.requestAssistance();
        this.context = { ...context, body: answer, assist: undefined };
        void this.render();
    }

    /**
     * The 'r' key ("recharge", the original's request-assistance key):
     * presses whatever occupies the assist button slot on the main page —
     * see {@link assistSlotAction}.
     */
    private pressAssistSlot() {
        switch (assistSlotAction(this.phase, this.context)) {
            case 'assist':
                this.pressAssist();
                break;
            case 'beg':
                this.pressBeg();
                break;
        }
    }

    private close() {
        this.closed.next();
    }

    /** Local UI beep for a button press (not the closing "Close Channel",
     * whose close beep already covers it). */
    private beep() {
        this.callbacks.playSound(HAIL_SND_BUTTON);
    }

    /** Rebuilds the scene graph for the current phase/context. */
    private async render() {
        this.content.removeChildren().forEach(child => child.destroy());
        const context = this.context;
        if (!context) {
            return;
        }
        const frame = frameFor(this.phase, context.variant);
        // Load the background so it is ready before anything is laid out on
        // it. Its size comes from hail_layout (measured off the art), not
        // from the sprite, so a slow/missing texture cannot shift the layout.
        const background = await this.displayAssets
            .spriteFromPictAsync(frame.pict);
        // Positioned by its top-left at the WHOLE-PIXEL origin the original
        // blits to (frameOrigin), not centred with anchor 0.5: an odd-width
        // frame centred that way lands on a half pixel, which blurs the art
        // and drags every glyph laid on it a pixel left.
        const { x: originX, y: originY } =
            frameOrigin(frame.width, frame.height);
        background.anchor.set(0);
        background.position.set(originX, originY);
        background.interactive = true;
        this.content.addChild(background);

        if (this.phase === 'haggle') {
            this.renderHaggle(frame, originX, originY);
        } else {
            await this.renderMain(context, frame, originX, originY);
        }
    }

    /** Places a Button by its frame-local sprite box (hail_layout's
     * coordinates are the SPRITE's left edge; a Button draws its left cap
     * ending at container.x + BUTTON_CAP_INSET). */
    private placeButton(label: string, frame: CommFrameLayout,
        originX: number, originY: number, row: number): Button {
        return new Button(this.displayAssets, label, frame.buttonWidth, {
            x: originX + frame.buttonX - BUTTON_CAP_INSET,
            y: originY + buttonRowY(frame, row),
        });
    }

    private async renderMain(context: HailContext, frame: CommFrameLayout,
        originX: number, originY: number) {
        // Layout comes from hail_layout.ts, measured off each frame's own
        // PICT art and its reference capture. The comm dialog is:
        //   - the hailed party's RESPONSE in the upper black well,
        //   - WHO they are in the lower well,
        //   - a button column under them,
        //   - their picture in the framed pane on the right.
        // (Both texts used to be stacked in the upper area with the lower
        // well left empty.)

        // Target picture on the RIGHT, fitted to the frame's image pane.
        if (context.image && frame.imagePane) {
            try {
                const image = await this.displayAssets
                    .spriteFromPictAsync(context.image);
                image.anchor.set(0.5);
                const fit = fitImage(frame.imagePane, image.width,
                    image.height);
                image.scale.set(fit.scale);
                image.position.set(originX + fit.x, originY + fit.y);
                this.content.addChild(image);
            } catch {
                // Missing pict: skip the image, keep the text.
            }
        }

        // Upper well: what they said.
        const response = new PIXI.Text(context.body, {
            ...BODY_FONT,
            wordWrapWidth: frame.responseWell.width
                - (frame.responseText.x - frame.responseWell.x) - 4,
        });
        response.position.set(originX + frame.responseText.x,
            originY + frame.responseText.y);
        this.content.addChild(response);

        // Lower well: who they are, in the reference's colours — dim labels,
        // white values, and a RED status (identityRuns). Each line is laid
        // out as a row of runs, the pen advancing by each run's own width, so
        // the block still starts at the measured infoText origin and keeps
        // the frames' 15px leading.
        if (frame.infoWell) {
            const wrapWidth = frame.infoWell.width
                - (frame.infoText.x - frame.infoWell.x) - 4;
            let y = originY + frame.infoText.y;
            for (const runs of identityRuns(context.heading)) {
                let x = originX + frame.infoText.x;
                // A single-run line can still WRAP inside the well (a long
                // pers name); a label+value line is short by construction and
                // is laid out inline, as the references show it.
                const wordWrap = runs.length === 1;
                let height = COMM_LINE_HEIGHT;
                for (const run of runs) {
                    const text = new PIXI.Text(run.text, {
                        ...HEADING_FONT, fill: run.color,
                        wordWrap, wordWrapWidth: wrapWidth,
                    });
                    text.position.set(x, y);
                    this.content.addChild(text);
                    x += text.width;
                    height = Math.max(height, text.height);
                }
                y += height;
            }
        }

        if (context.escort) {
            this.renderEscortButtons(frame, originX, originY);
            return;
        }
        this.renderCommButtons(context, frame, originX, originY);
    }

    /**
     * The ship / planet comm's button column. Every reference shows a FIXED
     * column with Greetings on top and Close Channel at the bottom; between
     * them is one OFFER SLOT — Request Assistance (request_assistance.png) or
     * Beg For Mercy (hail_hostile.png). NovaJS previously grew the column
     * from the bottom and never drew Greetings at all.
     */
    private renderCommButtons(context: HailContext, frame: CommFrameLayout,
        originX: number, originY: number) {
        const slots = commButtonSlots(context.variant, context);
        slots.forEach((slot, row) => {
            let label: string;
            let onPress: (() => void) | undefined;
            switch (slot) {
                case 'greetings':
                    label = 'Greetings';
                    onPress = () => this.pressGreetings();
                    break;
                case 'assist':
                    label = context.assist?.free
                        ? 'Request Aid (free)' : 'Request Assistance';
                    onPress = () => this.pressAssist();
                    break;
                case 'beg':
                    label = 'Beg For Mercy';
                    onPress = () => this.pressBeg();
                    break;
                case 'tribute':
                    // A seam: planet tribute isn't modeled. Greyed rather
                    // than omitted, so Close Channel stays on the
                    // reference's third row.
                    label = 'Demand Tribute';
                    onPress = undefined;
                    break;
                default:
                    label = 'Close Channel';
                    onPress = () => this.close();
                    break;
            }
            const button =
                this.placeButton(label, frame, originX, originY, row);
            if (onPress) {
                button.click.subscribe(onPress);
            } else {
                button.state = 'grey';
            }
            this.content.addChild(button.container);
        });
    }

    /**
     * The escort comm MANAGES a hired escort; it does not issue fleet
     * commands (that's the keyboard escort-controls' job). Per
     * hail/hail_escort.png the column reads, top to bottom: Upgrade Escort /
     * Sell Escort / Release / Close Channel. The first three depend on state
     * NovaJS does not model yet — shipyard upgrade transfer, escort resale
     * value, and per-escort release (a future per-escort-control feature) —
     * so they render GREYED with no handler (seams). The reference greys Sell
     * Escort for the same reason our three are greyed: nothing to sell.
     */
    private renderEscortButtons(frame: CommFrameLayout, originX: number,
        originY: number) {
        const seams = ['Upgrade Escort', 'Sell Escort', 'Release'];
        seams.forEach((label, row) => {
            const button =
                this.placeButton(label, frame, originX, originY, row);
            button.state = 'grey';
            this.content.addChild(button.container);
        });
        const close = this.placeButton('Close Channel', frame, originX,
            originY, seams.length);
        close.click.subscribe(() => this.close());
        this.content.addChild(close.container);
    }

    private renderHaggle(frame: CommFrameLayout, originX: number,
        originY: number) {
        const context = this.context;
        const bribe = context?.bribe;
        const demand = bribe
            ? `They demand ${bribe.amount.toLocaleString()} credits to let you `
            + `go.${bribe.canAfford ? '' : ' You cannot afford it.'}`
            : 'They refuse to negotiate.';
        const body = new PIXI.Text(demand, {
            ...BODY_FONT,
            wordWrapWidth: frame.responseWell.width
                - (frame.responseText.x - frame.responseWell.x) - 4,
        });
        body.position.set(originX + frame.responseText.x,
            originY + frame.responseText.y);
        this.content.addChild(body);

        // Two rows, as in beg_mercy.png (the original's are Lower Price /
        // Accept Price against a haggling pirate; ours pays or backs out).
        if (bribe && bribe.canAfford) {
            const pay = this.placeButton(
                `Pay ${bribe.amount.toLocaleString()} cr`, frame,
                originX, originY, 0);
            pay.click.subscribe(() => {
                this.beep();
                this.callbacks.bribe();
                this.close();
            });
            this.content.addChild(pay.container);
        }
        const cancel =
            this.placeButton('Never Mind', frame, originX, originY, 1);
        cancel.click.subscribe(() => {
            this.beep();
            this.phase = 'main';
            void this.render();
        });
        this.content.addChild(cancel.container);
    }
}
