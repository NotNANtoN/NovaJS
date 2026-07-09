import 'jasmine';
import { acos, asin, atan, atan2, cos, sin, tan } from './deterministic_math.js';

// Native implementations, captured in case something in the process
// installed the deterministic patch.
const native = {
    sin: Math.sin.bind(Math), cos: Math.cos.bind(Math),
    tan: Math.tan.bind(Math), atan: Math.atan.bind(Math),
    atan2: Math.atan2.bind(Math), asin: Math.asin.bind(Math),
    acos: Math.acos.bind(Math),
};

function inputs(count: number, scale: number): number[] {
    // Deterministic pseudo-random doubles via integer mixing.
    let s = 0x9e3779b9 >>> 0;
    const values: number[] = [];
    for (let i = 0; i < count; i++) {
        s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0;
        s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0;
        s = (s ^ (s >>> 16)) >>> 0;
        values.push((s / 4294967296 - 0.5) * scale);
    }
    return values;
}

function expectClose(actual: number, expected: number, context: string) {
    // A few ulps of slack relative to the value's magnitude, plus an
    // absolute floor near zeros.
    const tolerance = Math.max(Math.abs(expected) * 1e-13, 1e-15);
    if (Math.abs(actual - expected) > tolerance) {
        fail(`${context}: ${actual} vs native ${expected}`);
    }
}

describe('deterministic math', () => {
    it('matches native trig within a few ulps on game-scale angles', () => {
        for (const x of inputs(5000, 20)) {
            expectClose(sin(x), native.sin(x), `sin(${x})`);
            expectClose(cos(x), native.cos(x), `cos(${x})`);
            expectClose(atan(x), native.atan(x), `atan(${x})`);
        }
    });

    it('matches native tan away from poles', () => {
        for (const x of inputs(5000, 3)) {
            if (Math.abs(native.cos(x)) < 1e-3) {
                continue;
            }
            expectClose(tan(x), native.tan(x), `tan(${x})`);
        }
    });

    it('matches native atan2 in all quadrants', () => {
        const values = inputs(2000, 200);
        for (let i = 0; i + 1 < values.length; i += 2) {
            const y = values[i]!;
            const x = values[i + 1]!;
            expectClose(atan2(y, x), native.atan2(y, x), `atan2(${y}, ${x})`);
        }
        // Axes and zero-sign conventions.
        for (const y of [0, -0, 1, -1]) {
            for (const x of [0, -0, 1, -1]) {
                expect(atan2(y, x)).toBeCloseTo(native.atan2(y, x), 12);
                expect(Object.is(atan2(y, x) < 0, native.atan2(y, x) < 0))
                    .withContext(`atan2(${y}, ${x}) sign`).toBeTrue();
            }
        }
    });

    it('matches native asin and acos on [-1, 1]', () => {
        for (const raw of inputs(5000, 2)) {
            const x = Math.max(-1, Math.min(1, raw));
            expectClose(asin(x), native.asin(x), `asin(${x})`);
            expectClose(acos(x), native.acos(x), `acos(${x})`);
        }
        expect(asin(1)).toBeCloseTo(Math.PI / 2, 14);
        expect(acos(-1)).toBeCloseTo(Math.PI, 14);
    });

    it('handles non-finite inputs like native', () => {
        expect(sin(NaN)).toBeNaN();
        expect(cos(Infinity)).toBeNaN();
        expect(atan(Infinity)).toBeCloseTo(Math.PI / 2, 14);
        expect(atan(-Infinity)).toBeCloseTo(-Math.PI / 2, 14);
        expect(asin(1.5)).toBeNaN();
    });
});
