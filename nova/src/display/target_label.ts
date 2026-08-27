export interface TargetGovernmentNames {
    name?: string;
    commName?: string;
    targetName?: string;
}

export interface TargetLabelPieces {
    name: string;
    subtitle?: string;
    government?: string;
}

export const TARGET_GOVERNMENT_MAX_LENGTH = 8;

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
 * Keep the association text inside the right-hand side of the 176-unit target
 * status row. A government's TargetName is already its authored short form;
 * any resolved name that is still too long is clipped as a final safeguard.
 */
export function abbreviateTargetGovernment(
    government: TargetGovernmentNames | undefined,
    maxLength = TARGET_GOVERNMENT_MAX_LENGTH,
): string | undefined {
    const name = targetGovernmentName(government);
    if (!name || maxLength <= 0) {
        return undefined;
    }
    if (name.length <= maxLength) {
        return name;
    }
    if (maxLength === 1) {
        return '…';
    }
    return `${name.slice(0, maxLength - 1).trimEnd()}…`;
}

export function targetLabel(
    shipName: string,
    subtitle: string | undefined,
    government: TargetGovernmentNames | undefined,
): TargetLabelPieces {
    const label: TargetLabelPieces = {
        name: shipName,
        subtitle: nonEmpty(subtitle),
    };
    const governmentName = targetGovernmentName(government);
    if (!governmentName || namesItsGovernment(shipName, governmentName)) {
        return label;
    }
    label.government = abbreviateTargetGovernment(government);
    return label;
}
