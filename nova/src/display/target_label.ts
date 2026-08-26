export interface TargetGovernmentNames {
    name?: string;
    commName?: string;
    targetName?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed || undefined;
}

/**
 * The gövt TargetName field is retail's short form for the targeting display.
 * Older or hand-authored data may omit it, so retain a useful fallback.
 */
export function targetGovernmentName(
    government: TargetGovernmentNames | undefined,
): string | undefined {
    return nonEmpty(government?.targetName)
        ?? nonEmpty(government?.commName)
        ?? nonEmpty(government?.name);
}

/** Letters only, so "Fed." and "Fed" compare equal. */
function words(value: string): string[] {
    return value.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
}

/**
 * Whether the ship's own name already says who owns it. Many retail hulls are
 * government-specific and carry the government in their name, so the
 * Federation's TargetName of "Fed." beside a "Fed Destroyer" would only repeat
 * itself. Generic hulls such as a Shuttle carry no such hint and do need the
 * line.
 */
export function namesItsGovernment(
    shipName: string,
    governmentName: string,
): boolean {
    const shipWords = new Set(words(shipName));
    const governmentWords = words(governmentName);
    return governmentWords.length > 0
        && governmentWords.every(word => shipWords.has(word));
}

/**
 * The targeting pane is only 176 units wide in the retail interface, so the
 * government gets its own line rather than competing with the ship name.
 */
export function targetLabel(
    shipName: string,
    government: TargetGovernmentNames | undefined,
): string {
    const governmentName = targetGovernmentName(government);
    if (!governmentName || namesItsGovernment(shipName, governmentName)) {
        return shipName;
    }
    return `${shipName}\n${governmentName}`;
}
