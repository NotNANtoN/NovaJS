import { isLeft } from 'fp-ts/lib/Either.js';
import 'jasmine';
import { BOUNDARY, Position, PositionType, WORLD_SIZE, wrapNearestDelta } from './position.js';

describe('Position', () => {
    it('adds positions', () => {
        const v1 = new Position(3, 4);
        const v2 = new Position(7, 9);

        const sum = v1.add(v2);

        expect(sum).toEqual(new Position(10, 13));
        expect(v1).toEqual(new Position(3, 4));
        expect(v2).toEqual(new Position(7, 9));
    });

    it('PositionType decodes into Position', () => {
        const vec = { x: 123, y: 456 };
        const decoded = PositionType.decode(vec);

        if (isLeft(decoded)) {
            fail('Failed to decode position');
            return;
        }

        const position = decoded.right;
        expect(position).toBeInstanceOf(Position);
        expect(position.x).toEqual(vec.x);
        expect(position.y).toEqual(vec.y);
    });

    it('returns positions from its methods', () => {
        const pos = new Position(1, 2);
        expect(pos.scale(1)).toBeInstanceOf(Position);
    })
});

describe('wrapNearestDelta', () => {
    it('leaves small deltas unchanged', () => {
        expect(wrapNearestDelta(0)).toBe(0);
        expect(wrapNearestDelta(500)).toBe(500);
        expect(wrapNearestDelta(-500)).toBe(-500);
    });

    it('wraps a delta larger than the boundary to the near side', () => {
        // Two wrapped positions near opposite seams: the raw delta is almost a
        // whole world, but the toroidal-nearest delta is small.
        const a = BOUNDARY - 100;   // 9900: just inside the +x edge
        const b = -(BOUNDARY - 100); // -9900: just inside the -x edge
        // Raw delta 19800, but they are only 200 apart across the seam.
        expect(wrapNearestDelta(a - b)).toBe(-200);
        expect(wrapNearestDelta(b - a)).toBe(200);
    });

    it('is antisymmetric across the seam', () => {
        expect(wrapNearestDelta(BOUNDARY + 1)).toBe(BOUNDARY + 1 - WORLD_SIZE);
        expect(wrapNearestDelta(-BOUNDARY - 1)).toBe(-BOUNDARY - 1 + WORLD_SIZE);
    });
});
