import * as PIXI from 'pixi.js';
import { Subject } from 'rxjs';
import { DisplayAssetDataInterface } from '../client/gamedata/display_asset_data.js';
import { texturesFromFrames } from '../display/textures_from_frames.js';
import { isTextEntryActive } from '../input_focus.js';

/** The six title-screen commands, one per corner button. */
export type TitleAction =
    'newPilot' | 'openPilot' | 'quit' | 'enterShip' | 'setPrefs' | 'about';

/** Single-letter hotkeys for the six commands, matching the original
 * EV Nova title screen. Active only while the title owns the keyboard
 * (see `onKeyDown`). */
const HOTKEYS: { readonly [key: string]: TitleAction } = {
    n: 'newPilot',
    o: 'openPilot',
    q: 'quit',
    e: 'enterShip',
    p: 'setPrefs',
    a: 'about',
};

/**
 * The title command a bare key press maps to, or undefined for keys that
 * aren't hotkeys. Case-insensitive. A held modifier (Cmd/Ctrl/Alt) is not
 * a hotkey, so browser shortcuts like Cmd+Q keep working. Pure (no DOM),
 * so the mapping and modifier rule are unit-testable; the enabled /
 * text-entry gating that guards it lives in `onKeyDown`.
 */
export function hotkeyActionFor(
    event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean },
): TitleAction | undefined {
    if (event.metaKey || event.ctrlKey || event.altKey) {
        return undefined;
    }
    return HOTKEYS[event.key.toLowerCase()];
}

/** One line of the bottom status readout (label + value). */
export interface TitleStatus {
    pilotName: string;
    shipName: string;
    shipClass: string;
    shipSubtitle: string;
    legalStatus: string;
    combatRating: string;
    date: string;
}

interface ButtonSpec {
    /** SpriteSheet id (rlëD) holding the button's normal/pressed frames. */
    sheet: string;
    /** Human label, used only for the scene-graph container name. */
    label: string;
    action: TitleAction;
    /** Frame index in the rollover sheet (8020) for this button's emblem. */
    rollover: number;
    /** Top-left of the button art in background-local (1024x768) coords. */
    x: number;
    y: number;
}

// Native background (PICT 8000) is 1024x768; the layout is measured in
// that space with the origin at the frame's center (512,384). Positions
// were read off the 1920x1080 reference capture (title_screen.png).
const BG_W = 1024;
const BG_H = 768;
const BG_CX = BG_W / 2;
const BG_CY = BG_H / 2;

// The corner buttons: sheet id -> label/action/rollover-frame, with the
// art's top-left in background-local coords.
const BUTTONS: ButtonSpec[] = [
    { sheet: 'nova:8050', label: 'New Pilot', action: 'newPilot', rollover: 0, x: 349, y: 400 },
    { sheet: 'nova:8053', label: 'Enter Ship', action: 'enterShip', rollover: 3, x: 555, y: 401 },
    { sheet: 'nova:8051', label: 'Open Pilot', action: 'openPilot', rollover: 1, x: 344, y: 464 },
    { sheet: 'nova:8054', label: 'Set Prefs', action: 'setPrefs', rollover: 4, x: 581, y: 464 },
    { sheet: 'nova:8052', label: 'Quit Nova', action: 'quit', rollover: 2, x: 345, y: 528 },
    { sheet: 'nova:8055', label: 'About Nova', action: 'about', rollover: 5, x: 580, y: 528 },
];

/** Rollover frame shown in the center emblem when nothing is hovered. */
const IDLE_ROLLOVER_FRAME = 6;
/** Center emblem (rollover sheet 8020) art top-left in bg-local coords. */
const EMBLEM_X = 444;
const EMBLEM_Y = 465;
/** Title animation (PICT 8010) center in bg-local coords, and its
 * per-frame height (the PICT is a vertical 7-frame filmstrip). */
const TITLE_CX = 518;
const TITLE_CY = 266;
const TITLE_FRAME_W = 654;
const TITLE_FRAME_H = 209;
const TITLE_FRAMES = 7;

interface TitleButton {
    spec: ButtonSpec;
    container: PIXI.Container;
    sprite: PIXI.Sprite;
    normal: PIXI.Texture;
    pressed: PIXI.Texture;
}

/**
 * The game's entry screen — the EV Nova title with its six corner
 * buttons, rendered from the original's own resources (background PICT
 * 8000, animated title PICT 8010, rollover emblems rlëD 8020, and the
 * per-button rlëD sheets 8050-8055).
 *
 * Client-only: it draws directly on the Pixi stage and never touches
 * simulation or multiplayer state. A button activation (mouse or
 * keyboard) is published on `action`; the orchestrator (browser.ts)
 * decides what to do — open a dialog, or enter the game world.
 */
export class TitleScreen {
    readonly container = new PIXI.Container();
    /** Emits when a corner button is activated (click / Enter). */
    readonly action = new Subject<TitleAction>();

    /** Positioned at the background's center; everything hangs off it in
     * background-local coords minus (512,384). */
    private readonly frame = new PIXI.Container();
    private buttons: TitleButton[] = [];
    private emblem = new PIXI.Sprite();
    private emblemTextures: PIXI.Texture[] = [];
    private titleSprite = new PIXI.Sprite();
    private titleTextures: PIXI.Texture[] = [];
    private leftStatus = new PIXI.Text('');
    private rightStatus = new PIXI.Text('');

    private hovered?: TitleButton;
    /** Keyboard selection index into `buttons` (column-major order). */
    private selected = -1;
    private enabled = false;
    private titleFrameIndex = 0;
    private titleFrameTimer = 0;
    private screenW = 1920;
    private screenH = 1080;

    readonly buildPromise: Promise<void>;

    constructor(private displayAssets: DisplayAssetDataInterface) {
        this.container.name = 'TitleScreen';
        this.container.visible = false;
        this.frame.name = 'TitleFrame';
        this.container.addChild(this.frame);
        this.buildPromise = this.build();
        document.addEventListener('keydown', this.onKeyDown);
    }

    private statusStyle(): Partial<PIXI.ITextStyle> {
        return {
            fontFamily: 'Geneva', fontSize: 11, fill: 0xc42a1e,
            align: 'left', lineHeight: 14,
        };
    }

    private async build() {
        const assets = this.displayAssets;

        // Background frame (PICT 8000), drawn at native size, centered.
        const bgTexture = await assets.textureFromPictAsync('nova:8000');
        const bg = new PIXI.Sprite(bgTexture);
        bg.anchor.set(0.5);
        bg.name = 'TitleBackground';
        // So clicks on the background don't fall through to the game.
        bg.interactive = true;
        this.frame.addChildAt(bg, 0);

        // Animated title (PICT 8010): a vertical 7-frame filmstrip. Slice
        // it into per-frame sub-textures sharing the one base texture.
        const titleTexture = await assets.textureFromPictAsync('nova:8010');
        const base = titleTexture.baseTexture;
        // The title is a vertical filmstrip drawn at native scale; nearest
        // sampling stops a frame's edge rows from bleeding in the next
        // frame (which would show as a seam over the background starfield).
        base.scaleMode = PIXI.SCALE_MODES.NEAREST;
        for (let i = 0; i < TITLE_FRAMES; i++) {
            this.titleTextures.push(new PIXI.Texture(base,
                new PIXI.Rectangle(0, i * TITLE_FRAME_H,
                    TITLE_FRAME_W, TITLE_FRAME_H)));
        }
        this.titleSprite.texture = this.titleTextures[0];
        this.titleSprite.anchor.set(0.5);
        this.titleSprite.name = 'TitleLogo';
        this.titleSprite.position.set(TITLE_CX - BG_CX, TITLE_CY - BG_CY);
        this.frame.addChild(this.titleSprite);

        // Center emblem (rollover sheet 8020): the ATMOS logo at rest,
        // and one icon per corner button on hover.
        this.emblemTextures = await this.loadSheet('nova:8020');
        this.emblem.texture = this.emblemTextures[IDLE_ROLLOVER_FRAME]
            ?? this.emblemTextures[0];
        this.emblem.name = 'TitleEmblem';
        this.emblem.position.set(EMBLEM_X - BG_CX, EMBLEM_Y - BG_CY);
        this.frame.addChild(this.emblem);

        // The six corner buttons.
        for (const spec of BUTTONS) {
            const textures = await this.loadSheet(spec.sheet);
            const container = new PIXI.Container();
            // Named for scene-graph queries (headless UI driving), like
            // the spaceport's buttons.
            container.name = `Button:${spec.label}`;
            container.position.set(spec.x - BG_CX, spec.y - BG_CY);
            const sprite = new PIXI.Sprite(textures[0]);
            container.addChild(sprite);
            container.interactive = true;
            container.cursor = 'pointer';
            const button: TitleButton = {
                spec, container, sprite,
                normal: textures[0], pressed: textures[1] ?? textures[0],
            };
            container.on('pointerover', () => this.setHover(button));
            container.on('pointerout', () => {
                // Leaving clears the hover (emblem) AND any in-progress
                // press frame (a press-then-drag-off must not stick).
                this.setPressed(button, false);
                this.clearHover(button);
            });
            container.on('pointerdown', () => this.setPressed(button, true));
            container.on('pointerup', () => this.activate(button));
            container.on('pointerupoutside',
                () => this.setPressed(button, false));
            this.frame.addChild(container);
            this.buttons.push(button);
        }

        // Bottom status readout (two red columns).
        this.leftStatus.style = new PIXI.TextStyle(this.statusStyle());
        this.leftStatus.name = 'TitleStatusLeft';
        this.leftStatus.position.set(322 - BG_CX, 626 - BG_CY);
        this.frame.addChild(this.leftStatus);
        this.rightStatus.style = new PIXI.TextStyle(this.statusStyle());
        this.rightStatus.name = 'TitleStatusRight';
        this.rightStatus.position.set(632 - BG_CX, 626 - BG_CY);
        this.frame.addChild(this.rightStatus);

        this.layout();
    }

    /** Loads a rlëD SpriteSheet and returns its per-frame textures. */
    private async loadSheet(id: string): Promise<PIXI.Texture[]> {
        const framesData = await this.displayAssets.data
            .SpriteSheetFrames.get(id);
        return texturesFromFrames(framesData.frames);
    }

    /** Swaps a button between its normal (frame 0) and pressed (frame 1)
     * art. The second frame is the PRESSED state — shown only while the
     * pointer is actually down on the button, never for hover or keyboard
     * selection (those change only the center emblem). */
    private setPressed(button: TitleButton, pressed: boolean) {
        button.sprite.texture = pressed ? button.pressed : button.normal;
    }

    private setHover(button: TitleButton) {
        this.hovered = button;
        this.selected = this.buttons.indexOf(button);
        this.updateEmblem();
    }

    private clearHover(button: TitleButton) {
        // Moving the mouse off a button returns to rest. `setHover` also
        // set `selected` (so Enter activates the hovered button), so
        // clearing only `hovered` would leave the emblem lit via the
        // keyboard-selection fallback in updateEmblem. Drop the selection
        // too. Keyboard navigation is unaffected: it leaves `hovered`
        // undefined, so this guard never fires for it.
        if (this.hovered === button) {
            this.hovered = undefined;
            this.selected = -1;
            this.updateEmblem();
        }
    }

    /** Shows the hovered/selected button's rollover emblem in the center
     * (the ATMOS logo at rest). The button ART never changes here: its
     * second frame is the PRESSED state (see setPressed), not a hover
     * highlight, so hover and keyboard selection swap only the emblem. */
    private updateEmblem() {
        const active = this.hovered
            ?? (this.selected >= 0 ? this.buttons[this.selected] : undefined);
        const frame = active?.spec.rollover ?? IDLE_ROLLOVER_FRAME;
        if (this.emblemTextures[frame]) {
            this.emblem.texture = this.emblemTextures[frame];
        }
    }

    private activate(button: TitleButton) {
        if (!this.enabled) {
            return;
        }
        this.setPressed(button, false);
        this.action.next(button.spec.action);
    }

    private onKeyDown = (event: KeyboardEvent) => {
        // Ignore keys while the title is disabled (a dialog is open, or the
        // game is running) or while any text field owns the keyboard (e.g.
        // typing a pilot name into the New Pilot dialog): the letter
        // hotkeys below must never fire mid-typing.
        if (!this.enabled || isTextEntryActive()) {
            return;
        }
        // Letter hotkeys for the six commands (n/o/q/e/p/a).
        const action = hotkeyActionFor(event);
        if (action) {
            const button = this.buttons.find(b => b.spec.action === action);
            if (button) {
                this.selected = this.buttons.indexOf(button);
                this.hovered = undefined;
                this.updateEmblem();
                this.activate(button);
                event.preventDefault();
                return;
            }
        }
        // Column-major grid: indices 0/1 top row, 2/3 middle, 4/5 bottom.
        // Even indices are the left column, odd the right.
        switch (event.key) {
            case 'ArrowUp':
                this.moveSelection(-2);
                event.preventDefault();
                break;
            case 'ArrowDown':
                this.moveSelection(2);
                event.preventDefault();
                break;
            case 'ArrowLeft':
                this.moveSelection(-1);
                event.preventDefault();
                break;
            case 'ArrowRight':
                this.moveSelection(1);
                event.preventDefault();
                break;
            case 'Enter':
            case ' ':
                if (this.selected >= 0) {
                    this.activate(this.buttons[this.selected]);
                    event.preventDefault();
                }
                break;
            default:
                break;
        }
    };

    private moveSelection(delta: number) {
        const count = this.buttons.length;
        if (this.selected < 0) {
            this.selected = delta > 0 ? 0 : count - 1;
        } else {
            this.selected = (this.selected + delta + count) % count;
        }
        this.hovered = undefined;
        this.updateEmblem();
    }

    /** Fills the bottom status columns from the current pilot/save. */
    setStatus(status: TitleStatus) {
        this.leftStatus.text =
            `Pilot Name:\n  ${status.pilotName}\n\n` +
            `Ship Name:\n  ${status.shipName}\n\n` +
            `Ship Class:\n  ${status.shipClass}` +
            (status.shipSubtitle ? `\n  ${status.shipSubtitle}` : '');
        this.rightStatus.text =
            `Legal status in\ncurrent system:\n  ${status.legalStatus}\n\n` +
            `Combat Rating:\n  ${status.combatRating}\n\n` +
            `Current Date:\n  ${status.date}`;
    }

    /** Shows the title and accepts input. */
    show() {
        this.container.visible = true;
        this.enabled = true;
        this.updateEmblem();
    }

    /** Hides the title (e.g. once the game world is entered). */
    hide() {
        this.container.visible = false;
        this.enabled = false;
    }

    /** Enables/disables input without hiding — used while a modal dialog
     * (About, New Pilot, ...) is open over the title. */
    setEnabled(enabled: boolean) {
        this.enabled = enabled;
        for (const button of this.buttons) {
            button.container.interactive = enabled;
        }
        if (!enabled) {
            this.hovered = undefined;
            this.selected = -1;
            // Clear the emblem and drop any stuck pressed frame.
            for (const button of this.buttons) {
                this.setPressed(button, false);
            }
            this.updateEmblem();
        }
    }

    /** Advances the flame animation on the title logo. Call each frame. */
    tick(deltaMs: number) {
        if (!this.container.visible || this.titleTextures.length === 0) {
            return;
        }
        this.titleFrameTimer += deltaMs;
        if (this.titleFrameTimer >= 120) {
            this.titleFrameTimer = 0;
            this.titleFrameIndex =
                (this.titleFrameIndex + 1) % this.titleTextures.length;
            this.titleSprite.texture =
                this.titleTextures[this.titleFrameIndex];
        }
    }

    /** Re-centers and scales the title to the current screen size. */
    resize(width: number, height: number) {
        this.screenW = width;
        this.screenH = height;
        this.layout();
    }

    private layout() {
        // Center the frame; scale down to fit small screens, never up
        // (the reference shows the 1024x768 art at native size on a
        // 1920x1080 display).
        const scale = Math.min(1,
            this.screenW / (BG_W + 16), this.screenH / (BG_H + 16));
        this.frame.scale.set(scale);
        this.frame.position.set(this.screenW / 2, this.screenH / 2);
    }

    destroy() {
        document.removeEventListener('keydown', this.onKeyDown);
        this.container.destroy({ children: true });
    }
}
