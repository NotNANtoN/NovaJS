/**
 * Bit-deterministic replacements for Math's transcendental functions.
 *
 * IEEE 754 requires exactly-rounded results for +, -, *, /, and sqrt —
 * but NOT for sin/cos/tan/atan/exp/log, and JS engines genuinely
 * differ: measured live, node 24 and current Chrome disagree at the
 * ulp level on sin, cos, tan, atan, atan2, asin, acos, exp, and log
 * (sqrt, pow, hypot, and cbrt agreed). A rollback-multiplayer
 * simulation whose peers and server archive compare world hashes
 * bit-for-bit cannot tolerate that: one weapon hit's atan2 differing
 * by an ulp compounds into a permanent desync between browser peers
 * and the node archive.
 *
 * These implementations (fdlibm-style kernels) use ONLY exact
 * operations, so they produce identical bits on every IEEE 754 JS
 * engine. Accuracy is within a few ulps of correctly rounded —
 * marginally worse than native and irrelevant to gameplay; the
 * contract is determinism, not precision.
 *
 * `installDeterministicMath()` patches the global Math in simulation
 * contexts (called by the game's world factory), which also covers
 * third-party simulation code — SAT.js rotates collision hulls with
 * Math.sin/cos internally. Display-only contexts keep native Math.
 *
 * CAVEAT: the `**` operator compiles to native exponentiation and does
 * NOT go through the Math.pow patch. Simulation code must call
 * Math.pow for fractional exponents (e.g. `Math.pow(x, 1.2)`, never
 * `x ** 1.2`). Integer exponents like `x ** 2` are IEEE-exact (just
 * repeated multiplication) and are fine.
 */

// fdlibm __kernel_sin coefficients.
const S1 = -1.66666666666666324348e-01;
const S2 = 8.33333333332248946124e-03;
const S3 = -1.98412698298579493134e-04;
const S4 = 2.75573137070700676789e-06;
const S5 = -2.50507602534068634195e-08;
const S6 = 1.58969099521155010221e-10;

// fdlibm __kernel_cos coefficients.
const C1 = 4.16666666666666019037e-02;
const C2 = -1.38888888888741095749e-03;
const C3 = 2.48015872894767294178e-05;
const C4 = -2.75573143513906633035e-07;
const C5 = 2.08757232129817482790e-09;
const C6 = -1.13596475577881948265e-11;

// Cody-Waite two-part π/2 for range reduction. Game angles are small
// (wrapped to [-π, π)), so two stages keep plenty of accuracy; huge
// arguments lose precision identically on every engine, which is what
// matters here.
const INV_PIO2 = 6.36619772367581382433e-01;
const PIO2_1 = 1.57079632673412561417e+00;
const PIO2_1T = 6.07710050650619224932e-11;
const PI = 3.141592653589793;
const PI_LO = 1.2246467991473531772e-16;

/** sin on [-π/4, π/4]. */
function kernelSin(x: number): number {
    const z = x * x;
    const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
    return x + (z * x) * (S1 + z * r);
}

/** cos on [-π/4, π/4]. */
function kernelCos(x: number): number {
    const z = x * x;
    const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
    const hz = 0.5 * z;
    const w = 1 - hz;
    return w + (((1 - w) - hz) + (z * r));
}

/** Reduces x to r in [-π/4, π/4] with quadrant n (mod 4). */
function remPio2(x: number): { n: number, r: number } {
    const n = Math.floor(x * INV_PIO2 + 0.5);
    const r = (x - n * PIO2_1) - n * PIO2_1T;
    return { n: n & 3 | 0, r };
}

export function sin(x: number): number {
    if (!Number.isFinite(x)) {
        return NaN;
    }
    const { n, r } = remPio2(x);
    switch (n) {
        case 0: return kernelSin(r);
        case 1: return kernelCos(r);
        case 2: return -kernelSin(r);
        default: return -kernelCos(r);
    }
}

export function cos(x: number): number {
    if (!Number.isFinite(x)) {
        return NaN;
    }
    const { n, r } = remPio2(x);
    switch (n) {
        case 0: return kernelCos(r);
        case 1: return -kernelSin(r);
        case 2: return -kernelCos(r);
        default: return kernelSin(r);
    }
}

export function tan(x: number): number {
    // sin/cos is a couple of ulps worse than a dedicated kernel;
    // determinism is unaffected.
    return sin(x) / cos(x);
}

// fdlibm atan coefficients and subrange constants.
const AT = [
    3.33333333333329318027e-01, -1.99999999998764832476e-01,
    1.42857142725034663711e-01, -1.11111104054623557880e-01,
    9.09088713343650656196e-02, -7.69187620504482999495e-02,
    6.66107313738753120669e-02, -5.83357013379057348645e-02,
    4.97687799461593236017e-02, -3.65315727442169155270e-02,
    1.62858201153657823623e-02,
];
const ATAN_HI = [
    4.63647609000806093515e-01, 7.85398163397448278999e-01,
    9.82793723247329054082e-01, 1.57079632679489655800e+00,
];
const ATAN_LO = [
    2.26987774529616870924e-17, 3.06161699786838301793e-17,
    1.39033110312309984516e-17, 6.12323399573676603587e-17,
];

export function atan(x: number): number {
    if (Number.isNaN(x)) {
        return NaN;
    }
    if (!Number.isFinite(x)) {
        return x > 0 ? ATAN_HI[3]! : -ATAN_HI[3]!;
    }
    const negative = x < 0;
    let t = negative ? -x : x;
    let id: number;
    if (t < 0.4375) {
        if (t < 1e-9) {
            return x;
        }
        id = -1;
    } else if (t < 0.6875) {
        id = 0;
        t = (2 * t - 1) / (2 + t);
    } else if (t < 1.1875) {
        id = 1;
        t = (t - 1) / (t + 1);
    } else if (t < 2.4375) {
        id = 2;
        t = (t - 1.5) / (1 + 1.5 * t);
    } else {
        id = 3;
        t = -1 / t;
    }
    const z = t * t;
    const w = z * z;
    const s1 = z * (AT[0]! + w * (AT[2]! + w * (AT[4]!
        + w * (AT[6]! + w * (AT[8]! + w * AT[10]!)))));
    const s2 = w * (AT[1]! + w * (AT[3]! + w * (AT[5]!
        + w * (AT[7]! + w * AT[9]!))));
    let result: number;
    if (id < 0) {
        result = t - t * (s1 + s2);
    } else {
        result = ATAN_HI[id]! - ((t * (s1 + s2) - ATAN_LO[id]!) - t);
    }
    return negative ? -result : result;
}

export function atan2(y: number, x: number): number {
    if (Number.isNaN(x) || Number.isNaN(y)) {
        return NaN;
    }
    if (x > 0) {
        return atan(y / x);
    }
    if (x === 0) {
        if (y > 0) {
            return ATAN_HI[3]!;
        }
        if (y < 0) {
            return -ATAN_HI[3]!;
        }
        // atan2(±0, ±0): match Math.atan2's zero-sign conventions.
        return Object.is(x, -0) ? (Object.is(y, -0) ? -PI : PI) : y;
    }
    // x < 0: fold across the y axis.
    if (y === 0) {
        return Object.is(y, -0) ? -PI : PI;
    }
    if (y > 0) {
        return PI - (atan(y / -x) - PI_LO);
    }
    return -PI + (atan(-y / -x) - PI_LO);
}

export function asin(x: number): number {
    if (Number.isNaN(x) || x < -1 || x > 1) {
        return NaN;
    }
    // Built from exact sqrt and deterministic atan2.
    return atan2(x, Math.sqrt((1 - x) * (1 + x)));
}

export function acos(x: number): number {
    if (Number.isNaN(x) || x < -1 || x > 1) {
        return NaN;
    }
    return atan2(Math.sqrt((1 - x) * (1 + x)), x);
}

// ---------------------------------------------------------------------------
// Float bit helpers (DataView operations are exact and deterministic).

const BITS = new DataView(new ArrayBuffer(8));

function highWord(x: number): number {
    BITS.setFloat64(0, x);
    return BITS.getUint32(0);
}

function setHighWord(x: number, high: number): number {
    BITS.setFloat64(0, x);
    BITS.setUint32(0, high >>> 0);
    return BITS.getFloat64(0);
}

/** x * 2^k via exponent-bit construction: exact and deterministic. */
function scalbn(x: number, k: number): number {
    if (x === 0 || !Number.isFinite(x)) {
        return x;
    }
    // Two-step through representable powers of two so intermediate
    // factors never overflow to Infinity or flush to zero.
    while (k > 1023) {
        x *= TWO_1023;
        k -= 1023;
        if (!Number.isFinite(x)) {
            return x;
        }
    }
    while (k < -1022) {
        x *= TWO_M1022;
        k += 1022;
        if (x === 0) {
            return x;
        }
    }
    BITS.setUint32(0, (k + 1023) << 20);
    BITS.setUint32(4, 0);
    return x * BITS.getFloat64(0);
}
const TWO_1023 = 8.98846567431158e+307;
const TWO_M1022 = 2.2250738585072014e-308;

// ---------------------------------------------------------------------------
// exp and log (fdlibm e_exp / e_log).

const EXP_P1 = 1.66666666666666019037e-01;
const EXP_P2 = -2.77777777770155933842e-03;
const EXP_P3 = 6.61375632143793436117e-05;
const EXP_P4 = -1.65339022054652515390e-06;
const EXP_P5 = 4.13813679705723846039e-08;
const LN2_HI = 6.93147180369123816490e-01;
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.44269504088896338700e+00;
const EXP_OVERFLOW = 7.09782712893383973096e+02;
const EXP_UNDERFLOW = -7.45133219101941108420e+02;

export function exp(x: number): number {
    if (Number.isNaN(x)) {
        return NaN;
    }
    if (x > EXP_OVERFLOW) {
        return Infinity;
    }
    if (x < EXP_UNDERFLOW) {
        return 0;
    }
    let hi = 0;
    let lo = 0;
    let k = 0;
    const absX = x < 0 ? -x : x;
    if (absX > 0.5 * LN2_HI) {
        if (absX < 1.5 * LN2_HI) {
            k = x < 0 ? -1 : 1;
            hi = x - k * LN2_HI;
            lo = k * LN2_LO;
        } else {
            // trunc, not floor: this ports fdlibm's (int) cast, which
            // truncates toward zero — floor is off by one for x < 0
            // and pushes the reduced argument out of kernel range.
            k = Math.trunc(INV_LN2 * x + (x < 0 ? -0.5 : 0.5));
            hi = x - k * LN2_HI;
            lo = k * LN2_LO;
        }
        x = hi - lo;
    } else if (absX < 3.725290298461914e-09) { // 2^-28
        return 1 + x;
    }
    const t = x * x;
    const c = x - t * (EXP_P1 + t * (EXP_P2 + t * (EXP_P3
        + t * (EXP_P4 + t * EXP_P5))));
    if (k === 0) {
        return 1 - ((x * c) / (c - 2) - x);
    }
    const y = 1 - ((lo - (x * c) / (2 - c)) - hi);
    return scalbn(y, k);
}

const LG1 = 6.666666666666735130e-01;
const LG2 = 3.999999999940941908e-01;
const LG3 = 2.857142874366239149e-01;
const LG4 = 2.222219843214978396e-01;
const LG5 = 1.818357216161805012e-01;
const LG6 = 1.531383769920937332e-01;
const LG7 = 1.479819860511658591e-01;

export function log(x: number): number {
    if (Number.isNaN(x) || x < 0) {
        return NaN;
    }
    if (x === 0) {
        return -Infinity;
    }
    if (!Number.isFinite(x)) {
        return x;
    }
    let k = 0;
    let hx = highWord(x);
    if (hx < 0x00100000) {
        // Subnormal: normalize.
        k -= 54;
        x *= 18014398509481984; // 2^54
        hx = highWord(x);
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000fffff;
    const i = (hx + 0x95f64) & 0x100000;
    x = setHighWord(x, hx | (i ^ 0x3ff00000));
    k += i >> 20;
    const f = x - 1;
    if (f === 0) {
        return k === 0 ? 0 : k * LN2_HI + k * LN2_LO;
    }
    const s = f / (2 + f);
    const z = s * s;
    const w = z * z;
    const t1 = w * (LG2 + w * (LG4 + w * LG6));
    const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    const r = t1 + t2;
    const hfsq = 0.5 * f * f;
    if (k === 0) {
        return f - (hfsq - s * (hfsq + r));
    }
    return k * LN2_HI - ((hfsq - (s * (hfsq + r) + k * LN2_LO)) - f);
}

// Goldberg's corrections keep expm1/log1p accurate near zero while
// reusing the deterministic exp/log kernels.
export function expm1(x: number): number {
    if (Number.isNaN(x)) {
        return NaN;
    }
    const u = exp(x);
    if (u === 1) {
        return x;
    }
    const y = u - 1;
    if (!Number.isFinite(u) || u === 0) {
        return u === 0 ? -1 : u;
    }
    if (x > 0.5 || x < -0.5) {
        // Far from zero exp(x) is far from 1: the subtraction does
        // not cancel, and Goldberg's correction would only add error.
        return y;
    }
    return y * (x / log(u));
}

export function log1p(x: number): number {
    if (Number.isNaN(x) || x < -1) {
        return NaN;
    }
    if (x === -1) {
        return -Infinity;
    }
    const u = 1 + x;
    if (u === 1) {
        return x;
    }
    return log(u) * (x / (u - 1));
}

const INV_LN10 = 0.4342944819032518;

export function log2(x: number): number {
    if (Number.isNaN(x) || x < 0) {
        return NaN;
    }
    if (x === 0) {
        return -Infinity;
    }
    if (!Number.isFinite(x)) {
        return x;
    }
    // Split off the exponent so powers of two come out exact.
    let hx = highWord(x);
    let k = 0;
    if (hx < 0x00100000) {
        k -= 54;
        x *= 18014398509481984;
        hx = highWord(x);
    }
    k += (hx >> 20) - 1023;
    const m = setHighWord(x, (hx & 0x000fffff) | 0x3ff00000);
    return k + log(m) * INV_LN2;
}

export function log10(x: number): number {
    if (Number.isNaN(x) || x < 0) {
        return NaN;
    }
    if (x === 0) {
        return -Infinity;
    }
    if (!Number.isFinite(x)) {
        return x;
    }
    return log(x) * INV_LN10;
}

export function pow(x: number, y: number): number {
    // Special cases first (the subset the spec and games rely on).
    if (y === 0) {
        return 1;
    }
    if (Number.isNaN(x) || Number.isNaN(y)) {
        // Unlike C99, JS defines pow(1, NaN) as NaN.
        return NaN;
    }
    if (Number.isInteger(y) && Math.abs(y) <= 1024) {
        // Exact-multiplication path: keeps pow(2, 10) === 1024 and
        // friends bit-exact, and integer powers deterministic.
        let base = y < 0 ? 1 / x : x;
        let n = y < 0 ? -y : y;
        let result = 1;
        while (n > 0) {
            if (n % 2 === 1) {
                result *= base;
            }
            base *= base;
            n = Math.floor(n / 2);
        }
        return result;
    }
    if (x < 0) {
        // Non-integer exponent of a negative base.
        return NaN;
    }
    if (y === 0.5) {
        return Math.sqrt(x);
    }
    if (y === -0.5) {
        return 1 / Math.sqrt(x);
    }
    if (x === 0) {
        return y > 0 ? 0 : Infinity;
    }
    if (!Number.isFinite(x)) {
        return y > 0 ? Infinity : 0;
    }
    if (!Number.isFinite(y)) {
        const absX = Math.abs(x);
        if (absX === 1) {
            return NaN;
        }
        return (absX > 1) === (y > 0) ? Infinity : 0;
    }
    return exp(y * log(x));
}

// fdlibm s_cbrt.
const CBRT_B1 = 715094163;
const CBRT_B2 = 696219795;
const CBRT_P0 = 1.87595182427177009643;
const CBRT_P1 = -1.88497979543377169875;
const CBRT_P2 = 1.621429720105354466140;
const CBRT_P3 = -0.758397934778766047437;
const CBRT_P4 = 0.145996192886612446982;

export function cbrt(x: number): number {
    if (!Number.isFinite(x) || x === 0) {
        return x;
    }
    const negative = x < 0;
    const absX = negative ? -x : x;
    let t: number;
    if (highWord(absX) < 0x00100000) {
        const scaled = absX * 18014398509481984; // 2^54
        t = setHighWord(0, Math.floor(highWord(scaled) / 3) + CBRT_B2);
    } else {
        t = setHighWord(0, Math.floor(highWord(absX) / 3) + CBRT_B1);
    }
    // Polynomial refinement to ~47 bits.
    const r = (t * t) * (t / absX);
    t = t * ((CBRT_P0 + r * (CBRT_P1 + r * CBRT_P2))
        + ((r * r) * r) * (CBRT_P3 + r * CBRT_P4));
    // One Newton round to full precision.
    const s = t * t;
    let q = absX / s;
    const w = t + t;
    q = (q - t) / (w + q);
    t = t + t * q;
    return negative ? -t : t;
}

export function hypot(...values: number[]): number {
    let max = 0;
    for (const value of values) {
        if (Number.isNaN(value)) {
            // Infinity beats NaN per spec; check the rest first.
            if (values.some(v => v === Infinity || v === -Infinity)) {
                return Infinity;
            }
            return NaN;
        }
        const abs = value < 0 ? -value : value;
        if (abs > max) {
            max = abs;
        }
    }
    if (max === 0) {
        return 0;
    }
    if (max === Infinity) {
        return Infinity;
    }
    let sum = 0;
    for (const value of values) {
        const scaled = value / max;
        sum += scaled * scaled;
    }
    return max * Math.sqrt(sum);
}

// Hyperbolics, built on the deterministic exp/expm1/log1p kernels
// (musl-style formulations that avoid cancellation near zero).

export function sinh(x: number): number {
    if (!Number.isFinite(x) || x === 0) {
        return x;
    }
    const negative = x < 0;
    const absX = negative ? -x : x;
    let result: number;
    if (absX >= EXP_OVERFLOW) {
        result = Infinity;
    } else {
        const t = expm1(absX);
        result = 0.5 * (t + t / (t + 1));
    }
    return negative ? -result : result;
}

export function cosh(x: number): number {
    if (Number.isNaN(x)) {
        return NaN;
    }
    const absX = x < 0 ? -x : x;
    if (absX >= EXP_OVERFLOW) {
        return Infinity;
    }
    const t = expm1(absX);
    return 1 + (t * t) / (2 * (1 + t));
}

export function tanh(x: number): number {
    if (Number.isNaN(x)) {
        return NaN;
    }
    if (x === 0) {
        return x;
    }
    const negative = x < 0;
    const absX = negative ? -x : x;
    let result: number;
    if (absX > 20) {
        result = 1;
    } else {
        const t = expm1(-2 * absX);
        result = -t / (t + 2);
    }
    return negative ? -result : result;
}

export function asinh(x: number): number {
    if (!Number.isFinite(x) || x === 0) {
        return x;
    }
    const negative = x < 0;
    const absX = negative ? -x : x;
    let result: number;
    if (absX >= 67108864) { // 2^26: sqrt(x^2+1) ~ |x|
        result = log(absX) + LN2_HI + LN2_LO;
    } else {
        result = log1p(absX
            + (absX * absX) / (1 + Math.sqrt(absX * absX + 1)));
    }
    return negative ? -result : result;
}

export function acosh(x: number): number {
    if (Number.isNaN(x) || x < 1) {
        return NaN;
    }
    if (x === 1) {
        return 0;
    }
    if (!Number.isFinite(x)) {
        return x;
    }
    if (x >= 67108864) {
        return log(x) + LN2_HI + LN2_LO;
    }
    if (x > 2) {
        return log(2 * x - 1 / (x + Math.sqrt(x * x - 1)));
    }
    const t = x - 1;
    return log1p(t + Math.sqrt(2 * t + t * t));
}

export function atanh(x: number): number {
    if (Number.isNaN(x) || x < -1 || x > 1) {
        return NaN;
    }
    if (x === 0) {
        return x;
    }
    const negative = x < 0;
    const absX = negative ? -x : x;
    let result: number;
    if (absX === 1) {
        result = Infinity;
    } else if (absX < 0.5) {
        result = 0.5 * log1p(2 * absX + (2 * absX * absX) / (1 - absX));
    } else {
        result = 0.5 * log1p((2 * absX) / (1 - absX));
    }
    return negative ? -result : result;
}

// ---------------------------------------------------------------------------
// Array.prototype.sort.
//
// Since ES2019 sort must be stable, so a well-formed comparator is
// already deterministic — but an ill-formed one (a single NaN sort
// key makes `(a, b) => a - b` inconsistent) leaves the order
// implementation-defined. This stable merge sort clamps comparator
// results to {-1, 0, 1} (NaN becomes "equal", preserving original
// order), so even buggy comparators sort deterministically on every
// engine.

function mergeSort<T>(items: T[], compare: (a: T, b: T) => number): T[] {
    if (items.length <= 1) {
        return items;
    }
    const middle = items.length >> 1;
    const left = mergeSort(items.slice(0, middle), compare);
    const right = mergeSort(items.slice(middle), compare);
    const merged: T[] = [];
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) {
        // <= keeps the sort stable: ties take from the left run.
        if (compare(left[i]!, right[j]!) <= 0) {
            merged.push(left[i]!);
            i++;
        } else {
            merged.push(right[j]!);
            j++;
        }
    }
    while (i < left.length) {
        merged.push(left[i]!);
        i++;
    }
    while (j < right.length) {
        merged.push(right[j]!);
        j++;
    }
    return merged;
}

/** The spec's default comparator: lexicographic on String(value). */
function defaultComparator(a: unknown, b: unknown): number {
    const sa = String(a);
    const sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function deterministicSort<T>(this: T[],
    comparator?: (a: T, b: T) => number): T[] {
    if (comparator !== undefined && typeof comparator !== 'function') {
        throw new TypeError('The comparison function must be either a '
            + 'function or undefined');
    }
    const length = this.length >>> 0;
    // Per spec: holes sort past undefineds, which sort past values.
    const items: T[] = [];
    let undefinedCount = 0;
    for (let i = 0; i < length; i++) {
        if (!(i in this)) {
            continue;
        }
        const value = this[i] as T;
        if (value === undefined) {
            undefinedCount++;
        } else {
            items.push(value);
        }
    }
    const compare = comparator ?? defaultComparator;
    const sorted = mergeSort(items, (a, b) => {
        const result = Number(compare(a, b));
        return result < 0 ? -1 : result > 0 ? 1 : 0;
    });
    for (let i = 0; i < sorted.length; i++) {
        this[i] = sorted[i]!;
    }
    for (let i = 0; i < undefinedCount; i++) {
        this[sorted.length + i] = undefined as T;
    }
    for (let i = sorted.length + undefinedCount; i < length; i++) {
        delete this[i];
    }
    return this;
}

export { deterministicSort as sort };

/**
 * Replaces Math's engine-dependent functions with the deterministic
 * ones, process-wide. Call in every context that runs the simulation
 * (the browser sim worker, the server, tests) before any world steps.
 * Idempotent.
 *
 * The whole transcendental surface is patched — including functions
 * that happened to measure identical on today's engines (cosh, log2,
 * pow, hypot, cbrt) — so the rule is simply: in a simulation context,
 * every Math function is deterministic. Untouched: functions IEEE 754
 * requires to be exactly rounded (sqrt, abs, floor, ceil, round,
 * trunc, sign, fround, min/max, imul, clz32) and Math.random, which
 * simulation code must never call (use the seeded Random resource).
 *
 * Array.prototype.sort (and toSorted) are also replaced: stable sort
 * is spec'd since ES2019, but an ill-formed comparator (one NaN sort
 * key is enough) leaves the order implementation-defined, and the
 * replacement is deterministic even then.
 */
export function installDeterministicMath() {
    const math = Math as typeof Math & { __deterministic?: boolean };
    if (math.__deterministic) {
        return;
    }
    math.__deterministic = true;
    // eslint-disable-next-line no-extend-native
    Array.prototype.sort = deterministicSort;
    const arrayProto = Array.prototype as unknown as
        { toSorted?: (comparator?: (a: unknown, b: unknown) => number) => unknown[] };
    if (arrayProto.toSorted) {
        arrayProto.toSorted = function (comparator) {
            return deterministicSort.call([...this as unknown[]], comparator);
        };
    }
    math.sin = sin;
    math.cos = cos;
    math.tan = tan;
    math.atan = atan;
    math.atan2 = atan2;
    math.asin = asin;
    math.acos = acos;
    math.exp = exp;
    math.log = log;
    math.expm1 = expm1;
    math.log1p = log1p;
    math.log2 = log2;
    math.log10 = log10;
    math.pow = pow;
    math.cbrt = cbrt;
    math.hypot = hypot;
    math.sinh = sinh;
    math.cosh = cosh;
    math.tanh = tanh;
    math.asinh = asinh;
    math.acosh = acosh;
    math.atanh = atanh;
}
