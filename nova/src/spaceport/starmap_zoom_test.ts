import 'jasmine';
import {
    clampMapScale,
    MAP_SCALE_DEFAULT,
    MAP_SCALE_MAX,
    MAP_SCALE_MIN,
    mapScaleForWheel,
    zoomedMapPosition,
} from './starmap_zoom';

describe('starmap zoom', () => {
    it('clamps scale at both ends and uses the retail default', () => {
        expect(MAP_SCALE_DEFAULT).toBe(2);
        expect(clampMapScale(MAP_SCALE_MIN - 1)).toBe(MAP_SCALE_MIN);
        expect(clampMapScale(MAP_SCALE_MAX + 1)).toBe(MAP_SCALE_MAX);
        expect(mapScaleForWheel(
            MAP_SCALE_MIN, 10000)).toBe(MAP_SCALE_MIN);
        expect(mapScaleForWheel(
            MAP_SCALE_MAX, -10000)).toBe(MAP_SCALE_MAX);
    });

    it('keeps the galaxy point beneath the pointer fixed', () => {
        const oldPosition = { x: -40, y: 75 };
        const pointer = { x: 180, y: 120 };
        const oldScale = 2;
        const newScale = 3;
        const newPosition = zoomedMapPosition(
            oldPosition, pointer, oldScale, newScale);
        const worldPoint = {
            x: (pointer.x - oldPosition.x) / oldScale,
            y: (pointer.y - oldPosition.y) / oldScale,
        };

        expect(newPosition.x + worldPoint.x * newScale)
            .toBeCloseTo(pointer.x);
        expect(newPosition.y + worldPoint.y * newScale)
            .toBeCloseTo(pointer.y);
    });
});
