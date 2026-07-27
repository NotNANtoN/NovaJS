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
 * Escort-capture screens (hail_escort_upgrading / captured / sell) depend on
 * boarding, which a sibling agent owns (PICTs 8515-8516) — the escort variant
 * here builds only the command buttons and leaves those options out; see the
 * plugin for the documented seam.
 */

/** Comms-dialog background PICT ids (see novajs-spaceport-ui memory map). */
export const HAIL_PICT_SHIP = 'nova:8511';
export const HAIL_PICT_PLANET = 'nova:8512';
export const HAIL_PICT_ESCORT = 'nova:8513';
export const HAIL_PICT_HAGGLE = 'nova:8514';

/** An escort command offered as a button in the escort comm dialog. */
export type EscortCommandName =
    'attack' | 'defend' | 'formation' | 'holdPosition' | 'returnToBay';

/** What the plugin tells the dialog to display. Pure data, no world refs. */
export interface HailContext {
    /** Which comms background / layout to use. */
    variant: 'ship' | 'planet' | 'escort';
    /** Header line: govt comm name, person name, or planet name. */
    heading: string;
    /** PICT id for the target image (e.g. 'nova:3001' ship pict, a pers
     * hailPict, or a planet pict), or null for no image. */
    image: string | null;
    /** Body: greeting, hostile line, or planet/escort status text. */
    body: string;
    /** Request-assistance offer (fuel/repair), when eligible. */
    assist?: { free: boolean };
    /** Bribe / beg-for-mercy offer against a hostile ship, when eligible. */
    bribe?: { amount: number, canAfford: boolean };
    /** Escort command buttons (escort variant only). */
    escortCommands?: boolean;
}

/** Callbacks the dialog fires; each routes to the deterministic input path. */
export interface HailCallbacks {
    requestAssistance(): void;
    bribe(): void;
    escortCommand(command: EscortCommandName): void;
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
        this.controls.bind();
        await firstValueFrom(this.closed);
        this.controls.unbind();
        this.container.visible = false;
    }

    private close() {
        this.closed.next();
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
        // Target image on the left, per the reference screenshots.
        if (context.image) {
            try {
                const image = await this.displayAssets
                    .spriteFromPictAsync(context.image);
                image.anchor.set(0.5);
                const maxDim = Math.min(96, height - 90);
                const scale = image.width > 0
                    ? Math.min(1, maxDim / Math.max(image.width, image.height))
                    : 1;
                image.scale.set(scale);
                image.position.set(originX + 60, originY + 60);
                this.content.addChild(image);
            } catch {
                // Missing pict: skip the image, keep the text.
            }
        }

        const textX = originX + 120;
        const heading = new PIXI.Text(context.heading, HEADING_FONT);
        heading.position.set(textX, originY + 14);
        this.content.addChild(heading);

        const body = new PIXI.Text(context.body,
            { ...BODY_FONT, wordWrapWidth: width - 130 });
        body.position.set(textX, originY + 36);
        this.content.addChild(body);

        // Buttons along the bottom.
        const buttonY = originY + height - 30;
        let bx = originX + 16;
        const place = (button: Button) => {
            button.container.position.set(bx, buttonY);
            this.content.addChild(button.container);
            bx += 96;
        };

        if (context.escortCommands) {
            const commands: [EscortCommandName, string][] = [
                ['attack', 'Attack'], ['defend', 'Defend'],
                ['formation', 'Formation'], ['holdPosition', 'Hold'],
                ['returnToBay', 'Return'],
            ];
            // Two rows of command buttons to fit the escort frame.
            commands.forEach(([command, label], i) => {
                const button = new Button(this.displayAssets, label, 78);
                const row = Math.floor(i / 3);
                const col = i % 3;
                button.container.position.set(originX + 16 + col * 84,
                    buttonY - (1 - row) * 30);
                button.click.subscribe(() => {
                    this.callbacks.escortCommand(command);
                    this.close();
                });
                this.content.addChild(button.container);
            });
        }

        if (context.assist) {
            const label = context.assist.free
                ? 'Request Aid (free)' : 'Request Aid';
            const button = new Button(this.displayAssets, label, 130);
            button.click.subscribe(() => {
                this.callbacks.requestAssistance();
                this.close();
            });
            place(button);
            bx += 40;
        }

        if (context.bribe) {
            const beg = new Button(this.displayAssets, 'Beg for Mercy', 110);
            beg.click.subscribe(() => {
                this.phase = 'haggle';
                void this.render();
            });
            place(beg);
            bx += 20;
        }

        // Done button, right-aligned.
        const done = new Button(this.displayAssets, 'Done', 70,
            { x: originX + width - 86, y: buttonY });
        done.click.subscribe(() => this.close());
        this.content.addChild(done.container);
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
                this.callbacks.bribe();
                this.close();
            });
            this.content.addChild(pay.container);
        }
        const cancel = new Button(this.displayAssets, 'Never Mind', 100,
            { x: originX + width - 116, y: buttonY });
        cancel.click.subscribe(() => {
            this.phase = 'main';
            void this.render();
        });
        this.content.addChild(cancel.container);
    }
}
