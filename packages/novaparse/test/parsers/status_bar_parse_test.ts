import "jasmine";
import { IntfResource } from "../../src/resource_parsers/intf_resource.js";
import { StatusBarParse } from "../../src/parsers/status_bar_parse.js";
import { getEmptyNovaResources } from "../../src/resource_parsers/resource_holder_base.js";
import { ResourceBuilder } from "../resource_parsers/resource_builder.js";

/**
 * An ïntf resource with recognizable, projection-friendly values. Rectangles
 * are written as {top, left, bottom, right} so the expected [position, size]
 * projection is easy to read off.
 */
function buildIntf(statusBackground = 700): ResourceBuilder {
    const b = new ResourceBuilder();
    b.uint32(0x00ffffff)                          // brightText
        .uint32(0x00808080)                       // dimText
        .array([8, 8, 184, 184], v => b.int16(v)) // radarArea (t,l,b,r)
        .uint32(0x00ff0000)                       // brightRadar
        .uint32(0x00800000)                       // dimRadar
        .array([199, 35, 206, 184], v => b.int16(v))// shieldArea
        .uint32(0x00bf0000)                       // shieldColor
        .array([216, 35, 223, 184], v => b.int16(v))// armorArea
        .uint32(0x00a6a6a6)                       // armorColor
        .array([234, 35, 241, 184], v => b.int16(v))// fuelArea
        .uint32(0x004b5a70)                       // fuelFull
        .uint32(0x0028313f)                       // fuelPartial
        .array([254, 8, 286, 184], v => b.int16(v))// navArea
        .array([300, 8, 315, 184], v => b.int16(v))// weaponArea
        .array([330, 8, 442, 184], v => b.int16(v))// targetArea
        .array([458, 8, 552, 184], v => b.int16(v))// cargoArea
        .string("Geneva", 0x40)                   // statusFont
        .int16(12)                                // statusFontSize
        .int16(10)                                // subtitleSize
        .int16(statusBackground);                 // statusBackground
    return b;
}

function parseIntf(statusBackground = 700, withPict = true) {
    const idSpace = getEmptyNovaResources();
    if (withPict) {
        // The status-bar background resolves to this PICT's global id.
        idSpace.PICT[statusBackground] = { globalID: `nova:${statusBackground}` } as any;
    }
    const resource = new IntfResource(
        buildIntf(statusBackground).resource("ïntf", 128, "Default status bar"),
        idSpace);
    // IDSpaceHandler sets these in the real pipeline; BaseParse requires them.
    resource.globalID = "nova:128";
    resource.prefix = "nova";
    return StatusBarParse(resource, () => { });
}

describe("StatusBarParse", () => {
    it("carries the BaseData fields", async () => {
        const data = await parseIntf();
        expect(data.id).toBe("nova:128");
        expect(data.name).toBe("Default status bar");
        expect(data.prefix).toBe("nova");
    });

    it("resolves the background PICT to its global id", async () => {
        const data = await parseIntf(700);
        expect(data.image).toBe("nova:700");
    });

    it("projects font sizes", async () => {
        const data = await parseIntf();
        expect(data.fontSize).toBe(12);
        expect(data.subtitleSize).toBe(10);
    });

    it("masks LCOL colours down to RGB", async () => {
        const data = await parseIntf();
        expect(data.colors.brightText).toBe(0xffffff);
        expect(data.colors.dimText).toBe(0x808080);
        expect(data.colors.shield).toBe(0xbf0000);
        expect(data.colors.armor).toBe(0xa6a6a6);
        expect(data.colors.fuelFull).toBe(0x4b5a70);
        expect(data.colors.fuelPartial).toBe(0x28313f);
    });

    it("projects RECT areas to [position, size]", async () => {
        const data = await parseIntf();
        // radar 8,8 176x176 — matches the stock civilian layout (ïntf 128).
        expect(data.dataAreas.radar).toEqual({
            position: [8, 8], size: [176, 176],
        });
        expect(data.dataAreas.shield).toEqual({
            position: [35, 199], size: [149, 7],
        });
        expect(data.dataAreas.targeting).toEqual({
            position: [8, 330], size: [176, 112],
        });
        expect(data.dataAreas.cargo).toEqual({
            position: [8, 458], size: [176, 94],
        });
    });

    it("falls back to the default civilian PICT when unresolved", async () => {
        // StatusBkgnd < 128 means "use the default" (700), and with no PICT
        // in the id space the image is built from the prefix.
        const data = await parseIntf(0, false);
        expect(data.image).toBe("nova:700");
    });
});
