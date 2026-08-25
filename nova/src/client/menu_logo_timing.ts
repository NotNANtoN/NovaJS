export const RETAIL_LOGO_FRAME_COUNT = 7;
/**
 * spïn 606 supplies only the frame grid; it has no animation-delay field.
 * Retail chooses one of those frames at random on its classic 30 Hz clock,
 * but does not visibly replace the logo on every game tick. Sampling every
 * third tick preserves the stock static shimmer without the 30 Hz flicker.
 */
export const RETAIL_LOGO_FRAME_DURATION_MS = 3 * 1000 / 30;

export function logoTickAt(
    elapsedMs: number,
    frameDurationMs = RETAIL_LOGO_FRAME_DURATION_MS,
): number {
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0
        || !Number.isFinite(frameDurationMs) || frameDurationMs <= 0) {
        return 0;
    }
    return Math.floor(elapsedMs / frameDurationMs);
}

export function shouldAdvanceLogoFrame(
    now: number,
    lastFrameAt: number,
    frameDurationMs = RETAIL_LOGO_FRAME_DURATION_MS,
): boolean {
    return Number.isFinite(now)
        && Number.isFinite(lastFrameAt)
        && Number.isFinite(frameDurationMs)
        && frameDurationMs > 0
        && now - lastFrameAt >= frameDurationMs;
}

export function nextLogoFrameDeadline(
    now: number,
    previousDeadline: number,
    frameDurationMs = RETAIL_LOGO_FRAME_DURATION_MS,
): number {
    if (!Number.isFinite(now) || !Number.isFinite(previousDeadline)
        || !Number.isFinite(frameDurationMs) || frameDurationMs <= 0) {
        return now;
    }
    // Keep the 30 Hz phase during normal rAF jitter. If more than one whole
    // frame was missed, drop the backlog so the browser never replays it.
    return now - previousDeadline >= frameDurationMs
        ? now + frameDurationMs
        : previousDeadline + frameDurationMs;
}

/**
 * EV Nova deliberately displays the main-logo spin in random order. A repeated
 * frame is valid retail behavior and also keeps the shimmer from looking like
 * a forced high-frequency flipbook.
 */
export function nextLogoFrame(
    _currentFrame: number,
    randomValue: number,
    frameCount = RETAIL_LOGO_FRAME_COUNT,
): number {
    if (!Number.isInteger(frameCount) || frameCount <= 1) {
        return 0;
    }
    const normalized = Number.isFinite(randomValue)
        ? Math.max(0, Math.min(1 - Number.EPSILON, randomValue))
        : 0;
    return Math.floor(normalized * frameCount);
}
