import { MAP_WELL, mapWellOrigin } from './starmap_layout';

describe('starmap layout', () => {
    it('puts the well inside the frame', () => {
        const origin = mapWellOrigin();
        expect(origin.x).toBe(-295.5);
        expect(origin.y).toBe(-252.5);
        expect(origin.x + MAP_WELL.size.x)
            .toBeLessThanOrEqual(MAP_WELL.frame.x / 2);
        expect(origin.y + MAP_WELL.size.y)
            .toBeLessThanOrEqual(MAP_WELL.frame.y / 2);
    });

    it('insets the well by the same margin the bevel leaves', () => {
        const origin = mapWellOrigin();
        expect(origin.x + MAP_WELL.frame.x / 2).toBe(MAP_WELL.inset.x);
        expect(origin.y + MAP_WELL.frame.y / 2).toBe(MAP_WELL.inset.y);
    });

    it('scales with the frame it is given', () => {
        expect(mapWellOrigin({
            frame: { x: 100, y: 200 },
            inset: { x: 4, y: 6 },
            size: { x: 90, y: 180 },
        })).toEqual({ x: -46, y: -94 });
    });
});
