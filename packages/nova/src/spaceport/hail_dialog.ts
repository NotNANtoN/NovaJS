import * as PIXI from 'pixi.js';
import { firstValueFrom, Observable, Subject } from 'rxjs';
import { DisplayAssetDataInterface } from '../client/gamedata/display_asset_data.js';
import { ControlEvent } from '../nova_plugin/controls_plugin.js';
import { Button } from './button.js';
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
     * Asks the hailed ship for aid. Returns the ship's REFUSAL line when it
     * turns the request down (it is in the middle of a fight — "I'm busy"),
     * in which case no simulation effect was dispatched and the dialog shows
     * the answer; undefined when the request went through.
     *
     * The answer comes back from the one call rather than from a separate
     * "may I?" probe on purpose: probe-then-send would evaluate the ship's
     * state twice, and could dispatch a request the probe had just cleared.
     */
    requestAssistance(): string | undefined;
    bribe(): void;
    playSound(id: string): void;
}

const HEADING_FONT: Partial<PIXI.ITextStyle> = {
    fontFamily: 'Geneva', fontSize: 12, fill: 0xffffff, align: 'left',
    fontWeight: 'bold', wordWrap: false,
};
const BODY_FONT: Partial<PIXI.ITextStyle> = {
    fontFamily: 'Geneva', fontSize: 11, fill: 0xdddddd, align: 'left',
    wordWrap: true, wordWrapWidth: 240,
};

export class HailDialog {
    container = new PIXI.Container();
    private content = new PIXI.Container();
    private controls: MenuControls;
    private closed = new Subject<void>();
    private phase: 'main' | 'haggle' = 'main';
    private context?: HailContext;

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
        });
    }

    /** Shows the dialog for a computed context; resolves when dismissed. */
    async show(context: HailContext): Promise<void> {
        this.context = context;
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
        const backgroundId = this.phase === 'haggle'
            ? HAIL_PICT_HAGGLE
            : context.variant === 'planet' ? HAIL_PICT_PLANET
                : context.variant === 'escort' ? HAIL_PICT_ESCORT
                    : HAIL_PICT_SHIP;
        // Load the background so its true size is known before layout.
        const background = await this.displayAssets
            .spriteFromPictAsync(backgroundId);
        background.anchor.set(0.5);
        background.interactive = true;
        this.content.addChild(background);

        const width = background.width || 300;
        const height = background.height || 200;
        const originX = -width / 2;
        const originY = -height / 2;

        if (this.phase === 'haggle') {
            this.renderHaggle(originX, originY, width, height);
        } else {
            await this.renderMain(context, originX, originY, width, height);
        }
    }

    private async renderMain(context: HailContext, originX: number,
        originY: number, width: number, height: number) {
        // Layout measured against the hail/*.png references (all comm
        // backgrounds share it): two stacked text boxes on the LEFT, a
        // vertical column of red buttons under them, and the target image
        // filling a framed box on the RIGHT. Offsets are proportional to
        // the (per-PICT) frame size, calibrated on the 423x215 ship frame.
        const leftX = originX + Math.round(width * 0.026);   // ~11 on ship
        const leftWidth = Math.round(width * 0.44);          // left column
        const buttonWidth = Math.round(width * 0.38);        // ~160 on ship

        // Target image on the RIGHT, filling the frame's image box.
        if (context.image) {
            try {
                const image = await this.displayAssets
                    .spriteFromPictAsync(context.image);
                image.anchor.set(0.5);
                const maxDim = Math.min(width * 0.46, height * 0.92);
                const scale = image.width > 0
                    ? Math.min(1, maxDim / Math.max(image.width, image.height))
                    : 1;
                image.scale.set(scale);
                image.position.set(originX + Math.round(width * 0.74),
                    originY + Math.round(height * 0.5));
                this.content.addChild(image);
            } catch {
                // Missing pict: skip the image, keep the text.
            }
        }

        const heading = new PIXI.Text(context.heading, HEADING_FONT);
        heading.position.set(leftX, originY + Math.round(height * 0.06));
        this.content.addChild(heading);

        const body = new PIXI.Text(context.body,
            { ...BODY_FONT, wordWrapWidth: leftWidth });
        body.position.set(leftX, originY + Math.round(height * 0.19));
        this.content.addChild(body);

        // Buttons: a bottom-anchored vertical column on the left, so
        // Close Channel sits on the reference's bottom row and any
        // Request Aid / Beg for Mercy stack above it.
        const buttonSpacing = 28;
        let buttonY = originY + height - 24;

        // Close Channel (the original's label for the dismiss button).
        const close = new Button(this.displayAssets, 'Close Channel',
            buttonWidth, { x: leftX, y: buttonY });
        close.click.subscribe(() => this.close());
        this.content.addChild(close.container);
        buttonY -= buttonSpacing;

        if (context.bribe) {
            const beg = new Button(this.displayAssets, 'Beg for Mercy',
                buttonWidth, { x: leftX, y: buttonY });
            beg.click.subscribe(() => {
                this.beep();
                this.phase = 'haggle';
                void this.render();
            });
            this.content.addChild(beg.container);
            buttonY -= buttonSpacing;
        }

        if (context.assist) {
            const label = context.assist.free
                ? 'Request Aid (free)' : 'Request Assistance';
            const button = new Button(this.displayAssets, label, buttonWidth,
                { x: leftX, y: buttonY });
            button.click.subscribe(() => {
                this.beep();
                const refusal = this.callbacks.requestAssistance();
                if (refusal !== undefined) {
                    // Refused (the ship is busy fighting). The channel stays
                    // OPEN showing its answer, so the player reads why; the
                    // offer button goes away so the same request can't be
                    // hammered at a ship that already said no, and the player
                    // closes the channel themselves.
                    this.context = { ...context, body: refusal, assist: undefined };
                    void this.render();
                    return;
                }
                this.close();
            });
            this.content.addChild(button.container);
            buttonY -= buttonSpacing;
        }

        if (context.escort) {
            // The original's escort comm MANAGES a hired escort; it does not
            // issue fleet commands (that's the keyboard escort-controls'
            // job). Per hail/hail_escort.png the column reads, top to bottom,
            // Upgrade Escort / Sell Escort / Release / Close Channel. Close
            // Channel is already placed at the bottom above; stack the three
            // management options over it (bottom-up: Release, then Sell
            // Escort, then Upgrade Escort). All three depend on state NovaJS
            // does not model yet — shipyard upgrade transfer, escort resale
            // value, and per-escort release (a future per-escort-control
            // feature) — so they render GREYED with no handler (seams).
            const seams = ['Release', 'Sell Escort', 'Upgrade Escort'];
            for (const label of seams) {
                const button = new Button(this.displayAssets, label,
                    buttonWidth, { x: leftX, y: buttonY });
                button.state = 'grey';
                this.content.addChild(button.container);
                buttonY -= buttonSpacing;
            }
        }
    }

    private renderHaggle(originX: number, originY: number, width: number,
        height: number) {
        const context = this.context;
        const bribe = context?.bribe;
        const heading = new PIXI.Text(context?.heading ?? '', HEADING_FONT);
        heading.position.set(originX + 16, originY + 14);
        this.content.addChild(heading);

        const demand = bribe
            ? `They demand ${bribe.amount.toLocaleString()} credits to let you `
            + `go. ${bribe.canAfford ? '' : 'You cannot afford it.'}`
            : 'They refuse to negotiate.';
        const body = new PIXI.Text(demand,
            { ...BODY_FONT, wordWrapWidth: width - 40 });
        body.position.set(originX + 16, originY + 40);
        this.content.addChild(body);

        const buttonY = originY + height - 30;
        if (bribe && bribe.canAfford) {
            const pay = new Button(this.displayAssets,
                `Pay ${bribe.amount.toLocaleString()} cr`, 140,
                { x: originX + 16, y: buttonY });
            pay.click.subscribe(() => {
                this.beep();
                this.callbacks.bribe();
                this.close();
            });
            this.content.addChild(pay.container);
        }
        const cancel = new Button(this.displayAssets, 'Never Mind', 100,
            { x: originX + width - 116, y: buttonY });
        cancel.click.subscribe(() => {
            this.beep();
            this.phase = 'main';
            void this.render();
        });
        this.content.addChild(cancel.container);
    }
}
