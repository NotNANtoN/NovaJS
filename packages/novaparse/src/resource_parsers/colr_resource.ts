import { Resource } from "resource_fork";
import { BaseResource } from "./nova_resource_base.js";
import { Reader } from "./reader.js";
import { NovaResources } from "./resource_holder_base.js";

/**
 * A point (TMPL PNT): two int16s stored x-then-y. Unlike a QuickDraw Point,
 * PNT template fields store the horizontal coordinate first — ResForge's
 * ElementPNT reads x first, and the EVN Bible names these fields
 * "Button1x & y", "LogoX & Y", etc.
 */
interface Point {
    x: number;
    y: number;
}

/** A Mac QuickDraw rectangle (TMPL RECT): top, left, bottom, right int16s. */
interface Rect {
    top: number;
    left: number;
    bottom: number;
    right: number;
}

const readPoint = (r: Reader): Point => {
    const x = r.int16();
    const y = r.int16();
    return { x, y };
};

/**
 * Game-wide interface customization: colours, fonts and layout positions used
 * across Nova's menus and dialogs. All colour fields are 00RRGGBB, matching
 * HTML colours. Only the first cölr resource is loaded by the game.
 *
 * Field layout follows ResForge's cölr template (244 bytes), documented in
 * the EVN Bible p. 19.
 */
class ColrResource extends BaseResource {
    /** Normal button text colour (00RRGGBB). */
    buttonUp: number;
    /** Pressed button text colour. */
    buttonDown: number;
    /** Greyed-out button text colour. */
    buttonDisabled: number;

    /** Main menu font name. */
    menuFont: string;
    /** Main menu font size. */
    menuFontSize: number;
    /** Bright colour for the main menu. */
    menuBright: number;
    /** Dim colour for the main menu. */
    menuDim: number;

    /** Shipyard/outfit dialog grid selection-square colour. */
    gridBright: number;
    /** Shipyard/outfit dialog grid colour. */
    gridDim: number;

    /** Loading progress bar position/shape, relative to the window centre. */
    progressBarPosition: Rect;
    /** Bright progress bar colour. */
    progressBright: number;
    /** Dim progress bar colour. */
    progressDim: number;
    /** Progress bar outline colour. */
    progressOutline: number;

    /**
     * Positions of the six main-menu buttons, relative to the top-left of a
     * 1024x768 main-menu background.
     */
    menuButtons: Point[];

    /** Floating hyperspace map / escort menu border colour. */
    floatingMapBorder: number;
    /** List text colour. */
    listText: number;
    /** List background colour. */
    listBackground: number;
    /** List highlight colour. */
    listHighlight: number;
    /** Escort menu item highlight colour. */
    escortHighlight: number;

    /** Button font name. */
    buttonFont: string;
    /** Button font size. */
    buttonFontSize: number;

    /** Logo animation position. */
    logoPosition: Point;
    /** Rollover animation position. */
    rolloverPosition: Point;
    /** Sliding button positions. */
    slide1: Point;
    slide2: Point;
    slide3: Point;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const r = new Reader(this.data);

        this.buttonUp = r.uint32();
        this.buttonDown = r.uint32();
        this.buttonDisabled = r.uint32();

        this.menuFont = r.string(0x40);
        this.menuFontSize = r.int16();
        this.menuBright = r.uint32();
        this.menuDim = r.uint32();

        this.gridBright = r.uint32();
        this.gridDim = r.uint32();

        this.progressBarPosition = {
            top: r.int16(),
            left: r.int16(),
            bottom: r.int16(),
            right: r.int16(),
        };
        this.progressBright = r.uint32();
        this.progressDim = r.uint32();
        this.progressOutline = r.uint32();

        this.menuButtons = r.array(6, () => readPoint(r));

        this.floatingMapBorder = r.uint32();
        this.listText = r.uint32();
        this.listBackground = r.uint32();
        this.listHighlight = r.uint32();
        this.escortHighlight = r.uint32();

        this.buttonFont = r.string(0x40);
        this.buttonFontSize = r.int16();

        this.logoPosition = readPoint(r);
        this.rolloverPosition = readPoint(r);
        this.slide1 = readPoint(r);
        this.slide2 = readPoint(r);
        this.slide3 = readPoint(r);
    }
}

export { ColrResource, Point, Rect };
