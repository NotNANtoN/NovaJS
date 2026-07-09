import 'jasmine';
import { acos, acosh, asin, asinh, atan, atan2, atanh, cbrt, cos, cosh, exp, expm1, hypot, log, log10, log1p, log2, pow, sin, sinh, sort, tan, tanh } from './deterministic_math.js';

// Native implementations, captured in case something in the process
// installed the deterministic patch.
const native = {
    sin: Math.sin.bind(Math), cos: Math.cos.bind(Math),
    tan: Math.tan.bind(Math), atan: Math.atan.bind(Math),
    atan2: Math.atan2.bind(Math), asin: Math.asin.bind(Math),
    acos: Math.acos.bind(Math),
    exp: Math.exp.bind(Math), log: Math.log.bind(Math),
    expm1: Math.expm1.bind(Math), log1p: Math.log1p.bind(Math),
    log2: Math.log2.bind(Math), log10: Math.log10.bind(Math),
    pow: Math.pow.bind(Math), cbrt: Math.cbrt.bind(Math),
    hypot: Math.hypot.bind(Math),
    sinh: Math.sinh.bind(Math), cosh: Math.cosh.bind(Math),
    tanh: Math.tanh.bind(Math), asinh: Math.asinh.bind(Math),
    acosh: Math.acosh.bind(Math), atanh: Math.atanh.bind(Math),
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

    it('matches native exp and log families within relative tolerance', () => {
        for (const x of inputs(5000, 20)) {
            expectClose(exp(x), native.exp(x), `exp(${x})`);
            expectClose(expm1(x), native.expm1(x), `expm1(${x})`);
            const positive = Math.abs(x) + 1e-9;
            expectClose(log(positive), native.log(positive), `log(${positive})`);
            expectClose(log2(positive), native.log2(positive), `log2(${positive})`);
            expectClose(log10(positive), native.log10(positive), `log10(${positive})`);
            expectClose(log1p(Math.abs(x)), native.log1p(Math.abs(x)),
                `log1p(${Math.abs(x)})`);
        }
        // Wide magnitudes and near-zero accuracy (no cancellation).
        for (const x of [1e-300, 1e-15, 1e15, 1e300]) {
            expectClose(log(x), native.log(x), `log(${x})`);
        }
        expectClose(expm1(1e-10), native.expm1(1e-10), 'expm1 near zero');
        expectClose(log1p(1e-10), native.log1p(1e-10), 'log1p near zero');
        expect(exp(0)).toBe(1);
        expect(log(1)).toBe(0);
        expect(log(0)).toBe(-Infinity);
        expect(log(-1)).toBeNaN();
        expect(exp(1000)).toBe(Infinity);
        expect(exp(-1000)).toBe(0);
        // Powers of two stay exact through log2's exponent split.
        expect(log2(8)).toBe(3);
        expect(log2(1024)).toBe(10);
        expect(log2(0.25)).toBe(-2);
    });

    it('matches native pow, cbrt, and hypot', () => {
        const values = inputs(4000, 40);
        for (let i = 0; i + 1 < values.length; i += 2) {
            const base = Math.abs(values[i]!) + 0.1;
            const exponent = values[i + 1]! / 4;
            expectClose(pow(base, exponent), native.pow(base, exponent),
                `pow(${base}, ${exponent})`);
            expectClose(cbrt(values[i]!), native.cbrt(values[i]!),
                `cbrt(${values[i]})`);
            expectClose(hypot(values[i]!, values[i + 1]!),
                native.hypot(values[i]!, values[i + 1]!),
                `hypot(${values[i]}, ${values[i + 1]})`);
        }
        // Integer powers are bit-exact.
        expect(pow(2, 10)).toBe(1024);
        expect(pow(10, 6)).toBe(1000000);
        expect(pow(2, -3)).toBe(0.125);
        expect(pow(-2, 3)).toBe(-8);
        expect(pow(-2, 0.5)).toBeNaN();
        expect(pow(1, NaN)).toBeNaN();
        expect(pow(NaN, 0)).toBe(1);
        expect(pow(0, -1)).toBe(Infinity);
        expect(cbrt(-8)).toBeCloseTo(-2, 14);
        expect(cbrt(27)).toBeCloseTo(3, 14);
        expect(hypot(3, 4)).toBe(5);
        expect(hypot()).toBe(0);
        expect(hypot(Infinity, NaN)).toBe(Infinity);
        // Overflow-safe: naive x*x would be Infinity here.
        expectClose(hypot(1e300, 1e300), native.hypot(1e300, 1e300), 'hypot overflow-safe');
    });

    it('matches native hyperbolics', () => {
        for (const x of inputs(5000, 20)) {
            expectClose(sinh(x), native.sinh(x), `sinh(${x})`);
            expectClose(cosh(x), native.cosh(x), `cosh(${x})`);
            expectClose(tanh(x), native.tanh(x), `tanh(${x})`);
            expectClose(asinh(x), native.asinh(x), `asinh(${x})`);
            const geOne = Math.abs(x) + 1;
            expectClose(acosh(geOne), native.acosh(geOne), `acosh(${geOne})`);
            const inUnit = (x % 2) / 2.0001;
            expectClose(atanh(inUnit), native.atanh(inUnit), `atanh(${inUnit})`);
        }
        expect(tanh(Infinity)).toBe(1);
        expect(tanh(-Infinity)).toBe(-1);
        expect(sinh(0)).toBe(0);
        expect(cosh(0)).toBe(1);
        expect(acosh(1)).toBe(0);
        expect(acosh(0.5)).toBeNaN();
        expect(atanh(1)).toBe(Infinity);
        expect(atanh(-1)).toBe(-Infinity);
        expect(sinh(1000)).toBe(Infinity);
        expect(cosh(-1000)).toBe(Infinity);
    });

    describe('deterministic sort', () => {
        const sortArray = <T>(array: T[],
            comparator?: (a: T, b: T) => number) =>
            sort.call(array, comparator as never) as T[];

        it('matches native sort for well-formed comparators', () => {
            const values = inputs(2000, 1000);
            const nativeSorted = [...values].sort((a, b) => a - b);
            const ours = sortArray([...values], (a, b) => a - b);
            expect(ours).toEqual(nativeSorted);
        });

        it('uses the spec default comparator (lexicographic strings)', () => {
            expect(sortArray([10, 9, 1, 100])).toEqual([1, 10, 100, 9]);
            expect(sortArray(['b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
        });

        it('is stable', () => {
            const items = [
                { key: 1, tag: 'a' }, { key: 0, tag: 'b' },
                { key: 1, tag: 'c' }, { key: 0, tag: 'd' },
                { key: 1, tag: 'e' },
            ];
            const sorted = sortArray(items, (a, b) => a.key - b.key);
            expect(sorted.map(item => item.tag))
                .toEqual(['b', 'd', 'a', 'c', 'e']);
        });

        it('is deterministic under an ill-formed comparator', () => {
            // One NaN key makes (a, b) => a - b inconsistent: native
            // ordering becomes implementation-defined; ours treats
            // NaN comparisons as ties and preserves original order.
            const keys = [3, NaN, 1, NaN, 2];
            const indexed = keys.map((key, index) => ({ key, index }));
            const sorted = sortArray(indexed, (a, b) => a.key - b.key);
            // Golden order from the merge sort's fixed tie behavior.
            expect(sorted.map(item => item.index)).toEqual([2, 0, 1, 3, 4]);
            // Repeat runs agree (trivially, but guards regressions).
            const again = sortArray(keys.map((key, index) => ({ key, index })),
                (a, b) => a.key - b.key);
            expect(again.map(item => item.index)).toEqual([2, 0, 1, 3, 4]);
        });

        it('sorts undefineds to the end and returns the array', () => {
            const array = [undefined, 3, undefined, 1];
            const result = sortArray(array, (a, b) => (a as number) - (b as number));
            expect(result).toBe(array);
            expect(result).toEqual([1, 3, undefined, undefined]);
        });
    });
});
