/** Normalize an injected random source for deterministic game logic. */
export function clampRandom(random: number): number {
    return Number.isFinite(random)
        ? Math.min(0.9999999999999999, Math.max(0, random))
        : 0;
}

export function randomIndex(
    length: number,
    random: () => number = Math.random,
): number | undefined {
    if (length <= 0) {
        return undefined;
    }
    return Math.floor(clampRandom(random()) * length);
}
