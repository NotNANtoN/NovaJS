import 'jasmine';
import {
    computeTerritoryField,
    readableColor,
    territoryRadius,
    TerritoryPoint,
} from './territory_field';

const RED = 0xff0000;
const BLUE = 0x0000ff;

function sampleAt(
    field: NonNullable<ReturnType<typeof computeTerritoryField>>,
    x: number, y: number,
) {
    const column = Math.min(field.width - 1, Math.max(0, Math.floor(
        (x - field.origin.x) / field.size.x * field.width)));
    const row = Math.min(field.height - 1, Math.max(0, Math.floor(
        (y - field.origin.y) / field.size.y * field.height)));
    const offset = (row * field.width + column) * 4;
    return {
        red: field.pixels[offset],
        green: field.pixels[offset + 1],
        blue: field.pixels[offset + 2],
        alpha: field.pixels[offset + 3],
    };
}

describe('territory field', () => {
    it('produces nothing when no system is claimed', () => {
        expect(computeTerritoryField([])).toBeUndefined();
    });

    it('derives its reach from how far apart systems sit', () => {
        const near: TerritoryPoint[] = [
            { x: 0, y: 0, color: RED },
            { x: 40, y: 0, color: RED },
        ];
        const far: TerritoryPoint[] = [
            { x: 0, y: 0, color: RED },
            { x: 400, y: 0, color: RED },
        ];
        expect(territoryRadius(far)).toBeGreaterThan(territoryRadius(near));
    });

    it('paints a claimed system in its government colour', () => {
        const field = computeTerritoryField(
            [{ x: 0, y: 0, color: RED }], { radius: 100 })!;
        const centre = sampleAt(field, 0, 0);
        expect(centre.red).toBeGreaterThan(200);
        expect(centre.blue).toBeLessThan(40);
        expect(centre.alpha).toBeGreaterThan(200);
    });

    it('fades out towards unclaimed space', () => {
        const field = computeTerritoryField(
            [{ x: 0, y: 0, color: RED }], { radius: 100 })!;
        expect(sampleAt(field, 0, 0).alpha)
            .toBeGreaterThan(sampleAt(field, 70, 0).alpha);
        // The very corner of the field is beyond the system's reach.
        expect(sampleAt(field, field.origin.x, field.origin.y).alpha).toBe(0);
    });

    it('blends neighbouring governments into each other', () => {
        const field = computeTerritoryField([
            { x: -100, y: 0, color: RED },
            { x: 100, y: 0, color: BLUE },
        ], { radius: 300 })!;

        const nearRed = sampleAt(field, -100, 0);
        const nearBlue = sampleAt(field, 100, 0);
        const between = sampleAt(field, 0, 0);

        expect(nearRed.red).toBeGreaterThan(nearRed.blue);
        expect(nearBlue.blue).toBeGreaterThan(nearBlue.red);
        // The midpoint is a mix of both, which is what makes the boundary
        // read as a smooth tessellation rather than two discs.
        expect(Math.abs(between.red - between.blue)).toBeLessThan(40);
        expect(between.red).toBeGreaterThan(40);
        expect(between.blue).toBeGreaterThan(40);
    });

    it('keeps a government pure well inside its own space', () => {
        const field = computeTerritoryField([
            { x: 0, y: 0, color: RED },
            { x: 20, y: 0, color: RED },
            { x: 600, y: 0, color: BLUE },
        ], { radius: 200 })!;
        const core = sampleAt(field, 10, 0);
        expect(core.red).toBeGreaterThan(230);
        expect(core.blue).toBeLessThan(10);
    });

    it('lifts near black government colours without shifting their hue', () => {
        // The Federation, Auroran and Polaris colours are bright enough to
        // pass through untouched.
        expect(readableColor(0x2c2caf)).toBe(0x2c2caf);
        expect(readableColor(0xcf0c0c)).toBe(0xcf0c0c);

        // The Wild Geese are almost black in the retail data.
        const lifted = readableColor(0x003300);
        expect((lifted >> 8) & 0xff).toBeGreaterThan(0x33);
        expect(lifted & 0xff).toBe(0);
        expect((lifted >> 16) & 0xff).toBe(0);

        expect(readableColor(0x000000)).toBeGreaterThan(0);
    });

    it('covers the claimed systems with a margin', () => {
        const field = computeTerritoryField([
            { x: 0, y: 0, color: RED },
            { x: 300, y: 200, color: BLUE },
        ], { radius: 50 })!;
        expect(field.origin.x).toBeLessThan(0);
        expect(field.origin.y).toBeLessThan(0);
        expect(field.origin.x + field.size.x).toBeGreaterThan(300);
        expect(field.origin.y + field.size.y).toBeGreaterThan(200);
        expect(field.pixels.length).toBe(field.width * field.height * 4);
    });

    it('respects the requested resolution cap', () => {
        const field = computeTerritoryField([
            { x: 0, y: 0, color: RED },
            { x: 1_000, y: 0, color: BLUE },
        ], { maxResolution: 64 })!;
        expect(Math.max(field.width, field.height)).toBeLessThanOrEqual(64);
    });
});
