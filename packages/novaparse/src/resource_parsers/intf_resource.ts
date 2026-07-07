import { Resource } from "resource_fork";
import { BaseResource } from "./nova_resource_base.js";
import { Reader } from "./reader.js";
import { NovaResources } from "./resource_holder_base.js";

/** A Mac QuickDraw rectangle (TMPL RECT): top, left, bottom, right int16s. */
interface IntfRect {
    top: number;
    left: number;
    bottom: number;
    right: number;
}

const readRect = (r: Reader): IntfRect => ({
    top: r.int16(),
    left: r.int16(),
    bottom: r.int16(),
    right: r.int16(),
});

/**
 * The in-flight status bar interface: positions, colours and fonts of the
 * status-bar elements plus its background image. Selected per-ship via each
 * gövt's Interface field, so multiple ïntf resources can vary the status bar
 * by ship type. All colours are 00RRGGBB, matching HTML colours. A rectangle
 * with zero area (right=left or top=bottom) hides its indicator.
 *
 * Field layout follows ResForge's ïntf template (166 bytes), documented in
 * the EVN Bible p. 32.
 */
class IntfResource extends BaseResource {
    /** Bright text colour (00RRGGBB). */
    brightText: number;
    /** Dim text colour. */
    dimText: number;

    /** Bounds of the radar display. */
    radarArea: IntfRect;
    /** Bright radar pixel colour. */
    brightRadar: number;
    /** Dim radar pixel colour (overridden by an IFF outfit). */
    dimRadar: number;

    /** Bounds of the shield indicator. */
    shieldArea: IntfRect;
    /** Shield bar colour. */
    shieldColor: number;

    /** Bounds of the armour indicator. */
    armorArea: IntfRect;
    /** Armour bar colour. */
    armorColor: number;

    /** Bounds of the fuel indicator. */
    fuelArea: IntfRect;
    /** Colour of the "full jumps" portion of the fuel indicator. */
    fuelFull: number;
    /** Colour of the "partial fuel" portion of the fuel indicator. */
    fuelPartial: number;

    /** Bounds of the navigation display. */
    navArea: IntfRect;
    /** Bounds of the weapon display. */
    weaponArea: IntfRect;
    /** Bounds of the target display. */
    targetArea: IntfRect;
    /** Bounds of the cargo display. */
    cargoArea: IntfRect;

    /** Status bar font name. */
    statusFont: string;
    /** Normal status bar font size. */
    statusFontSize: number;
    /** Font size for ship subtitles. */
    subtitleSize: number;
    /** 'PICT' id used as the status-display backdrop; <128 is treated as 128. */
    statusBackground: number;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const r = new Reader(this.data);

        this.brightText = r.uint32();
        this.dimText = r.uint32();

        this.radarArea = readRect(r);
        this.brightRadar = r.uint32();
        this.dimRadar = r.uint32();

        this.shieldArea = readRect(r);
        this.shieldColor = r.uint32();

        this.armorArea = readRect(r);
        this.armorColor = r.uint32();

        this.fuelArea = readRect(r);
        this.fuelFull = r.uint32();
        this.fuelPartial = r.uint32();

        this.navArea = readRect(r);
        this.weaponArea = readRect(r);
        this.targetArea = readRect(r);
        this.cargoArea = readRect(r);

        this.statusFont = r.string(0x40);
        this.statusFontSize = r.int16();
        this.subtitleSize = r.int16();
        this.statusBackground = r.int16(-1);
    }
}

export { IntfResource, IntfRect };
