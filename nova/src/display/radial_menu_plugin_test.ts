import "jasmine";
import {
    computeRadialSelection,
    cycleRadialIndex,
    drawActionIcon,
    gamepadRadialSelection,
    RADIAL_OPTIONS,
} from "./radial_menu_plugin";

describe("Radial menu pure helpers", () => {
    const NUM_OPTIONS = 8;

    describe("computeRadialSelection", () => {
        it("returns -1 when within deadzone or too far", () => {
            expect(computeRadialSelection(0, 0, NUM_OPTIONS, 45, 145)).toBe(-1);
            expect(computeRadialSelection(20, 20, NUM_OPTIONS, 45, 145)).toBe(-1);
            expect(computeRadialSelection(300, 300, NUM_OPTIONS, 45, 145)).toBe(-1);
        });

        it("computes correct sector based on angle starting from top", () => {
            expect(computeRadialSelection(0, -100, NUM_OPTIONS, 45, 145)).toBe(0);
            const rightSector = computeRadialSelection(100, 0, NUM_OPTIONS, 45, 145);
            expect(rightSector).toBeGreaterThan(0);
            expect(rightSector).toBeLessThan(NUM_OPTIONS);
        });
    });

    describe("cycleRadialIndex", () => {
        it("cycles forward and wraps", () => {
            expect(cycleRadialIndex(-1, 1, NUM_OPTIONS)).toBe(0);
            expect(cycleRadialIndex(0, 1, NUM_OPTIONS)).toBe(1);
            expect(cycleRadialIndex(7, 1, NUM_OPTIONS)).toBe(0);
        });

        it("cycles backward and wraps", () => {
            expect(cycleRadialIndex(-1, -1, NUM_OPTIONS)).toBe(7);
            expect(cycleRadialIndex(0, -1, NUM_OPTIONS)).toBe(7);
            expect(cycleRadialIndex(3, -1, NUM_OPTIONS)).toBe(2);
        });
    });

    describe("gamepadRadialSelection", () => {
        it("ignores stick inputs within deadzone threshold", () => {
            expect(gamepadRadialSelection(0, 0, NUM_OPTIONS, 0.4)).toBeUndefined();
            expect(gamepadRadialSelection(0.2, -0.2, NUM_OPTIONS, 0.4)).toBeUndefined();
        });

        it("selects sector when stick pushed past threshold", () => {
            expect(gamepadRadialSelection(0, -0.9, NUM_OPTIONS, 0.4)).toBe(0);
            const rightSector = gamepadRadialSelection(0.9, 0, NUM_OPTIONS, 0.4);
            expect(rightSector).toBeDefined();
            expect(rightSector).toBeGreaterThan(0);
        });
    });

    describe("RADIAL_OPTIONS & custom icon rendering", () => {
        it("defines all 8 tactical in-flight actions with custom icon identifiers", () => {
            expect(RADIAL_OPTIONS.length).toBe(8);
            const expectedIds = ["hail", "board", "transfer", "sos", "coords", "jettison", "map", "directory"];
            expect(RADIAL_OPTIONS.map(o => o.id)).toEqual(expectedIds);
        });

        it("invokes vector drawing commands for all action icons without throwing", () => {
            const recordedCalls: string[] = [];
            const mockGraphics = {
                lineStyle(...args: any[]) { recordedCalls.push("lineStyle"); return this; },
                beginFill(...args: any[]) { recordedCalls.push("beginFill"); return this; },
                endFill(...args: any[]) { recordedCalls.push("endFill"); return this; },
                moveTo(...args: any[]) { recordedCalls.push("moveTo"); return this; },
                lineTo(...args: any[]) { recordedCalls.push("lineTo"); return this; },
                arc(...args: any[]) { recordedCalls.push("arc"); return this; },
                drawCircle(...args: any[]) { recordedCalls.push("drawCircle"); return this; },
                rect(...args: any[]) { recordedCalls.push("rect"); return this; },
                drawRect(...args: any[]) { recordedCalls.push("drawRect"); return this; },
                closePath(...args: any[]) { recordedCalls.push("closePath"); return this; },
            } as any;

            for (const opt of RADIAL_OPTIONS) {
                recordedCalls.length = 0;
                expect(() => drawActionIcon(mockGraphics, opt.id, 100, 100, 0xffcc88, false)).not.toThrow();
                expect(recordedCalls.length).toBeGreaterThan(0);

                recordedCalls.length = 0;
                expect(() => drawActionIcon(mockGraphics, opt.id, 100, 100, 0xffea00, true)).not.toThrow();
                expect(recordedCalls.length).toBeGreaterThan(0);
            }
        });
    });
});
