import { GovtData } from "novadatainterface/GovtData";
import { GameDataInterface } from "novadatainterface/GameDataInterface";
import { Resource } from "nova_ecs/resource";
import { resourceId } from "../common/resource_id";

export type GovernmentRelation = "ally" | "neutral" | "enemy";

/**
 * These are the bits in the gövt resource's Flags field that affect combat
 * targeting. The remaining legal-record and weapon-immunity flags belong to a
 * later wave.
 */
export const GovernmentFlags = {
    xenophobic: 0x0001,
    alwaysAttacksPlayer: 0x0004,
    cannotHail: 0x0400,
    neverAttacksPlayer: 0x0040,
} as const;

export interface GovernmentData extends GovtData {
    commName?: string;
    targetName?: string;
}

function values(values: readonly number[] | undefined): number[] {
    return (values ?? []).filter(value => Number.isFinite(value) && value >= 0);
}

function sharesClass(classes: readonly number[], classList: readonly number[]) {
    const otherClasses = new Set(values(classes));
    return values(classList).some(value => otherClasses.has(value));
}

function governmentNumber(id: string | number | undefined): number | undefined {
    if (typeof id === "number") {
        return Number.isFinite(id) ? id : undefined;
    }
    if (typeof id !== "string") {
        return undefined;
    }
    const match = /^(?:[^:]+:)?(-?\d+)$/.exec(id);
    return match ? Number(match[1]) : undefined;
}

/**
 * Compute the relation from govtA's point of view.
 *
 * Class fields are arbitrary class numbers. They are not government IDs, and
 * merely sharing a class does not establish an alliance (EV Nova Bible,
 * gövt/Class). An enemy match wins if malformed data puts a class in both
 * lists. Xenophobic governments treat every non-ally as an enemy.
 */
export function relation(
    govtA: GovernmentData,
    govtB: GovernmentData,
): GovernmentRelation {
    if (govtA === govtB || (
        governmentNumber(govtA.id) !== undefined
        && governmentNumber(govtA.id) === governmentNumber(govtB.id)
    )) {
        return "ally";
    }

    if (sharesClass(govtB.classes, govtA.enemies)) {
        return "enemy";
    }

    if (sharesClass(govtB.classes, govtA.allies)) {
        return "ally";
    }

    if ((govtA.flags ?? 0) & GovernmentFlags.xenophobic) {
        return "enemy";
    }

    return "neutral";
}

/**
 * Player targeting is separate from govt-vs-govt relations. A normal
 * government has no hostile legal-status input yet; that is deliberately
 * left for the legal-record wave. Provocation is the session-local combat
 * exception for now.
 *
 * TODO: add the current system's legal record and CrimeTol/Flag 0x0002
 * handling here, plus the ScanFine and penalty bookkeeping.
 */
export function canTargetPlayer(
    govt: GovernmentData,
    provoked = false,
): boolean {
    const flags = govt.flags ?? 0;
    if (flags & GovernmentFlags.neverAttacksPlayer) {
        return false;
    }
    if (flags & GovernmentFlags.alwaysAttacksPlayer) {
        return true;
    }
    if (flags & GovernmentFlags.xenophobic) {
        return true;
    }
    return provoked;
}

export function canHailGovernment(govt: GovernmentData): boolean {
    return !((govt.flags ?? 0) & GovernmentFlags.cannotHail);
}

export function getGovernmentCommName(govt: GovernmentData): string {
    return govt.commName ?? govt.name;
}

/**
 * Synchronous relation cache used by ECS systems. Government JSON is loaded
 * asynchronously, so the first lookup starts a load and returns undefined;
 * targeting retries on a later simulation step.
 */
export class GovernmentRelationStore {
    private readonly loaded = new Map<number, GovernmentData>();
    private readonly loading = new Map<number, Promise<GovernmentData | undefined>>();

    constructor(private readonly gameData: GameDataInterface) { }

    getCached(id: number): GovernmentData | undefined {
        const cached = this.loaded.get(id);
        if (cached) {
            return cached;
        }

        if (!this.loading.has(id)) {
            this.loading.set(id, this.load(id));
        }
        return undefined;
    }

    relation(a: number, b: number): GovernmentRelation | undefined {
        if (a === b) {
            return "ally";
        }
        const govtA = this.getCached(a);
        const govtB = this.getCached(b);
        if (!govtA || !govtB) {
            return undefined;
        }
        return relation(govtA, govtB);
    }

    private async load(id: number): Promise<GovernmentData | undefined> {
        const gettable = this.gameData.data.Govt;
        if (!gettable) {
            return undefined;
        }

        // Government references in düde/ship resources are resource IDs
        // (normally 128+). Also accept zero-based indexes for hand-authored
        // data and old callers.
        const resourceIds = id >= 128
            ? [resourceId(id), String(id)]
            : [resourceId(id + 128), resourceId(id)];

        for (const resourceId of resourceIds) {
            try {
                const govt = await gettable.get(resourceId);
                const resourceNumber = governmentNumber(govt.id);
                if (resourceNumber !== undefined) {
                    this.loaded.set(resourceNumber, govt);
                    if (resourceNumber >= 128) {
                        this.loaded.set(resourceNumber - 128, govt);
                    }
                }
                this.loaded.set(id, govt);
                return govt;
            } catch (_error) {
                // Try the alternate ID spelling before treating the govt as
                // unavailable. The caller will retry via getCached if needed.
            }
        }
        return undefined;
    }
}

export const GovernmentRelationResource =
    new Resource<GovernmentRelationStore>("GovernmentRelationStore");
