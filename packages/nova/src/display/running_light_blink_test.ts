import 'jasmine';
import { BlinkPattern } from 'novadatainterface/animation';
import { blinkPhaseFromUuid, runningLightState } from './running_light_blink.js';

// shän timings are in frames = 30ths of a second.
const FRAME_MS = 1000 / 30;
const frames = (n: number) => n * FRAME_MS;

describe('runningLightState', () => {
    it('is steady on for a null (non-blinking) pattern', () => {
        for (const t of [0, 123, 999, 5000]) {
            expect(runningLightState(null, t)).toEqual({ visible: true, alpha: 1 });
        }
    });

    describe('square (strobe) mode', () => {
        // The stock double-blink used by most Nova ships (Shuttle, etc.):
        // 4 frames on, 1 off, twice, then 20 frames off.
        const stock: BlinkPattern = {
            mode: 'square',
            onFrames: 4,
            offFrames: 1,
            blinksPerGroup: 2,
            groupDelayFrames: 20,
        };
        // Group layout in frames: [0,4) on, [4,5) off, [5,9) on, [9,10) off,
        // then [10,30) group delay off. Period = 4+1+4+1+20 = 30 frames.

        it('turns on during each blink and off between/after them', () => {
            // First blink on.
            expect(runningLightState(stock, frames(0)).visible).toBeTrue();
            expect(runningLightState(stock, frames(3.9)).visible).toBeTrue();
            // Between-blink off gap.
            expect(runningLightState(stock, frames(4.5)).visible).toBeFalse();
            // Second blink on.
            expect(runningLightState(stock, frames(5.5)).visible).toBeTrue();
            expect(runningLightState(stock, frames(8.9)).visible).toBeTrue();
            // Between-blink off after second blink.
            expect(runningLightState(stock, frames(9.5)).visible).toBeFalse();
            // Long group delay off.
            expect(runningLightState(stock, frames(15)).visible).toBeFalse();
            expect(runningLightState(stock, frames(29)).visible).toBeFalse();
        });

        it('repeats every group period', () => {
            const period = frames(30);
            for (const t of [0, frames(3), frames(5.5), frames(15)]) {
                expect(runningLightState(stock, t).visible)
                    .toEqual(runningLightState(stock, t + period).visible);
            }
        });

        it('produces exactly two on-bursts per period', () => {
            // Sample the whole period and count rising edges (off -> on).
            let bursts = 0;
            let prev = false;
            for (let f = 0; f < 30; f += 0.1) {
                const on = runningLightState(stock, frames(f)).visible;
                if (on && !prev) {
                    bursts++;
                }
                prev = on;
            }
            expect(bursts).toEqual(2);
        });

        it('alpha is full on and zero off (no partial)', () => {
            expect(runningLightState(stock, frames(1)).alpha).toEqual(1);
            expect(runningLightState(stock, frames(15)).alpha).toEqual(0);
        });

        it('treats an all-zero degenerate pattern as steady on', () => {
            const degenerate: BlinkPattern = {
                mode: 'square', onFrames: 0, offFrames: 0,
                blinksPerGroup: 0, groupDelayFrames: 0,
            };
            expect(runningLightState(degenerate, 1234))
                .toEqual({ visible: true, alpha: 1 });
        });
    });

    describe('triangle (pulse) mode', () => {
        // The stock pulse (Arachnid, etc.): min 10, +0.75/frame, max 32,
        // -0.75/frame. Intensity 1-32 maps to alpha via /32.
        const stock: BlinkPattern = {
            mode: 'triangle',
            minIntensity: 10,
            riseRate: 75,
            maxIntensity: 32,
            fallRate: 75,
        };
        // span = 22, rise/fall = 0.75/frame, so ~29.33 frames each way.
        const riseFrames = 22 / 0.75;

        it('is at minimum intensity at the start of the ramp', () => {
            expect(runningLightState(stock, 0).alpha)
                .toBeCloseTo(10 / 32, 5);
        });

        it('reaches maximum (full alpha) at the top of the ramp', () => {
            expect(runningLightState(stock, frames(riseFrames)).alpha)
                .toBeCloseTo(1, 3);
        });

        it('rises then falls over the period', () => {
            const quarter = runningLightState(stock, frames(riseFrames / 2)).alpha;
            const peak = runningLightState(stock, frames(riseFrames)).alpha;
            const threeQuarter =
                runningLightState(stock, frames(riseFrames * 1.5)).alpha;
            expect(quarter).toBeLessThan(peak);
            expect(threeQuarter).toBeLessThan(peak);
            expect(quarter).toBeGreaterThan(10 / 32 - 1e-6);
        });

        it('stays within [minIntensity, maxIntensity] alpha bounds', () => {
            for (let f = 0; f < 80; f += 1) {
                const a = runningLightState(stock, frames(f)).alpha;
                expect(a).toBeGreaterThanOrEqual(10 / 32 - 1e-6);
                expect(a).toBeLessThanOrEqual(1 + 1e-6);
            }
        });

        it('is always visible (never fully off)', () => {
            for (let f = 0; f < 80; f += 1) {
                expect(runningLightState(stock, frames(f)).visible).toBeTrue();
            }
        });

        it('holds intensity when there is no usable ramp', () => {
            const flat: BlinkPattern = {
                mode: 'triangle', minIntensity: 32, riseRate: 0,
                maxIntensity: 32, fallRate: 0,
            };
            expect(runningLightState(flat, 500).alpha).toBeCloseTo(1, 5);
        });
    });

    describe('random mode', () => {
        const pattern: BlinkPattern = {
            mode: 'random',
            minIntensity: 8,
            maxIntensity: 32,
            changeDelayFrames: 15,
        };

        it('holds a constant value within a change interval', () => {
            const a1 = runningLightState(pattern, frames(1)).alpha;
            const a2 = runningLightState(pattern, frames(14)).alpha;
            expect(a1).toEqual(a2);
        });

        it('changes value across interval boundaries (at least sometimes)', () => {
            const values = new Set<number>();
            for (let step = 0; step < 20; step++) {
                values.add(runningLightState(pattern, frames(step * 15 + 1)).alpha);
            }
            // Different steps should yield more than one distinct intensity.
            expect(values.size).toBeGreaterThan(1);
        });

        it('is deterministic (same time -> same value)', () => {
            expect(runningLightState(pattern, frames(100)).alpha)
                .toEqual(runningLightState(pattern, frames(100)).alpha);
        });

        it('stays within the [min, max] intensity band', () => {
            for (let step = 0; step < 50; step++) {
                const a = runningLightState(pattern, frames(step * 15 + 1)).alpha;
                expect(a).toBeGreaterThanOrEqual(8 / 32 - 1e-6);
                expect(a).toBeLessThanOrEqual(1 + 1e-6);
            }
        });
    });

    describe('phase offset', () => {
        const stock: BlinkPattern = {
            mode: 'square', onFrames: 4, offFrames: 1,
            blinksPerGroup: 2, groupDelayFrames: 20,
        };

        it('shifts the pattern in time', () => {
            // A phase offset equal to half a frame at a moment near an edge
            // can flip the on/off state; simply check the offset is applied by
            // finding a time where phase changes the result.
            let differed = false;
            for (let f = 0; f < 30; f += 0.25) {
                const a = runningLightState(stock, frames(f), 0).visible;
                const b = runningLightState(stock, frames(f), frames(5)).visible;
                if (a !== b) {
                    differed = true;
                    break;
                }
            }
            expect(differed).toBeTrue();
        });
    });
});

describe('blinkPhaseFromUuid', () => {
    it('is stable for the same uuid', () => {
        expect(blinkPhaseFromUuid('abc-123'))
            .toEqual(blinkPhaseFromUuid('abc-123'));
    });

    it('spreads different uuids to different phases (usually)', () => {
        const phases = new Set<number>();
        for (const u of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
            phases.add(blinkPhaseFromUuid(u));
        }
        // Not all identical.
        expect(phases.size).toBeGreaterThan(1);
    });

    it('stays within the 0-2000ms spread window', () => {
        for (const u of ['ship-1', 'ship-2', 'xyzzy', '00000000']) {
            const p = blinkPhaseFromUuid(u);
            expect(p).toBeGreaterThanOrEqual(0);
            expect(p).toBeLessThan(2000);
        }
    });
});
