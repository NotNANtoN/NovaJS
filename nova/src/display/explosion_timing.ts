import { framesToMilliseconds } from 'novaparse/src/parsers/Constants';

export interface ExplosionTimingState {
    startTime?: number;
    lifetime?: number;
}

/**
 * EV Nova's bööm FrameAdvance uses 100 for one image per 30 Hz game frame.
 * ExplosionParse exposes that value as a factor where 1 === 100.
 */
export function explosionFrameDurationMs(rate: number): number {
    const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    return framesToMilliseconds(1 / safeRate);
}

export function advanceExplosionTiming(
    state: ExplosionTimingState,
    now: number,
    frameCount: number,
    rate: number,
): { progress: number, done: boolean } {
    if (state.startTime === undefined || state.lifetime === undefined) {
        state.startTime = now;
        state.lifetime = explosionFrameDurationMs(rate)
            * Math.max(0, frameCount);
    }
    const progress = state.lifetime > 0
        ? Math.min(1, Math.max(0, (now - state.startTime) / state.lifetime))
        : 1;
    return { progress, done: progress >= 1 };
}
