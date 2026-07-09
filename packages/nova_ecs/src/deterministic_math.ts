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

/**
 * Replaces Math's engine-dependent transcendental functions with the
 * deterministic ones, process-wide. Call in every context that runs
 * the simulation (the browser sim worker, the server, tests) before
 * any world steps. Idempotent. exp/log/pow are left native: the
 * simulation does not use them (pow, hypot, cbrt, and sqrt also
 * measured bit-identical across engines).
 */
export function installDeterministicMath() {
    const math = Math as typeof Math & { __deterministic?: boolean };
    if (math.__deterministic) {
        return;
    }
    math.__deterministic = true;
    math.sin = sin;
    math.cos = cos;
    math.tan = tan;
    math.atan = atan;
    math.atan2 = atan2;
    math.asin = asin;
    math.acos = acos;
}
