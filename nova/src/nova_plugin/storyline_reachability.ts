/**
 * Static storyline reachability over parsed game data.
 *
 * A mission is reachable when it can be offered (AvailBits satisfiable by
 * bits some reachable source can set) or is started by an NCB `S` from a
 * reachable source. The model is optimistic: negated bit tests always pass,
 * AvailStel/record/rating/random gates are assumed satisfiable. It answers
 * "which content can a player ever see", not "in which order".
 *
 * `engine` lists which sources this codebase executes. Keeping that list
 * next to the retail semantics makes a wiring regression show up as a
 * mission that is reachable in retail but not in the engine.
 */
import { MissionData } from 'novadatainterface/MissionData';
import { parseTestExpression, NcbTestExpression } from './ncb';

export interface ReachabilityData {
    missions: readonly MissionData[];
    crons: readonly { enableOn: string; onStart: string; onEnd: string }[];
    outfits: readonly { availabilityNCB: string; onPurchase: string; onSell?: string }[];
    ships: readonly { onPurchase: string; onCapture: string; onRetire: string }[];
    planets: readonly { onDominate?: string; onRelease?: string; onDestroy?: string; onRegen?: string }[];
}

export interface EngineWiring {
    shipOfferedMissions: boolean;
    requireContribute: boolean;
    autoAbortOnAbort: boolean;
    cronOnEnd: boolean;
    outfitStarts: boolean;
    outfitOnSell: boolean;
    shipOnCapture: boolean;
    shipOnRetire: boolean;
    planetOnDominate: boolean;
    planetOnDestroy: boolean;
}

/** What EV Nova itself does. */
export const RETAIL_WIRING: EngineWiring = {
    shipOfferedMissions: true,
    requireContribute: true,
    autoAbortOnAbort: true,
    cronOnEnd: true,
    outfitStarts: true,
    outfitOnSell: true,
    shipOnCapture: true,
    shipOnRetire: true,
    planetOnDominate: true,
    planetOnDestroy: true,
};

/**
 * What this engine executes: everything EV Nova does, including per-pilot
 * stellar destruction (stellar_destruction.ts).
 */
export const ENGINE_WIRING: EngineWiring = RETAIL_WIRING;

/**
 * What the unmodified retail data can trigger. No retail wëap is a
 * planet-type weapon (Flags2 0x0400) and no mïsn uses NCB Y, so spöb
 * OnDestroy only fires with plug-in content, in EV Nova as here.
 */
export const RETAIL_DATA_WIRING: EngineWiring = {
    ...RETAIL_WIRING,
    planetOnDestroy: false,
};

function numericId(id: string): number {
    return Number(id.replace(/^.*:/, ''));
}

const setBits = (expression: string | undefined) =>
    [...(expression ?? '').matchAll(/(^|[\s(])\^?b(\d+)/gi)].map(match => Number(match[2]));
const startIds = (expression: string | undefined) =>
    [...(expression ?? '').matchAll(/(^|[\s(])s(\d+)/gi)].map(match => Number(match[2]));

function satisfiable(expression: string | undefined, possible: ReadonlySet<number>): boolean {
    if (!expression?.trim()) return true;
    let ast: NcbTestExpression;
    try {
        ast = parseTestExpression(expression);
    } catch {
        return false;
    }
    const evaluate = (node: NcbTestExpression): boolean => {
        switch (node.type) {
            case 'literal': return node.value;
            case 'bit': return possible.has(node.bit);
            case 'not': return true;
            case 'and': return evaluate(node.left) && evaluate(node.right);
            case 'or': return evaluate(node.left) || evaluate(node.right);
            default: return true;
        }
    };
    return evaluate(ast);
}

export function reachableMissions(
    data: ReachabilityData,
    wiring: EngineWiring,
): Set<number> {
    const possible = new Set<number>();
    const reachable = new Set<number>();
    const started = new Set<number>();
    let changed = true;
    const add = (expression: string | undefined) => {
        for (const bit of setBits(expression)) {
            if (!possible.has(bit)) {
                possible.add(bit);
                changed = true;
            }
        }
    };
    const start = (expression: string | undefined) => {
        for (const id of startIds(expression)) {
            if (!started.has(id)) {
                started.add(id);
                changed = true;
            }
        }
    };
    const run = (expression: string | undefined, starts = true) => {
        add(expression);
        if (starts) start(expression);
    };

    for (const planet of data.planets) {
        if (wiring.planetOnDominate) run(planet.onDominate);
        if (wiring.planetOnDominate) run(planet.onRelease);
        if (wiring.planetOnDestroy) run(planet.onDestroy);
        if (wiring.planetOnDestroy) run(planet.onRegen);
    }
    for (const ship of data.ships) {
        run(ship.onPurchase);
        if (wiring.shipOnCapture) run(ship.onCapture);
        if (wiring.shipOnRetire) run(ship.onRetire);
    }

    while (changed) {
        changed = false;
        for (const mission of data.missions) {
            const id = numericId(mission.id);
            if (reachable.has(id)) continue;
            const hasRequire = mission.require.some(value => value !== 0);
            const offered = satisfiable(mission.availBits, possible)
                && mission.availRandom > 0
                && (wiring.shipOfferedMissions || mission.availLoc !== 2)
                && (wiring.requireContribute || !hasRequire);
            if (offered || started.has(id)) {
                reachable.add(id);
                changed = true;
            }
        }
        for (const mission of data.missions) {
            if (!reachable.has(numericId(mission.id))) continue;
            const autoAbort = (mission.flags & 0x0001) !== 0;
            run(mission.onAccept);
            run(mission.onSuccess);
            run(mission.onFailure);
            run(mission.onShipDone);
            if (!autoAbort || wiring.autoAbortOnAbort) run(mission.onAbort);
            if ((mission.flags & 0x0004) === 0) run(mission.onRefuse);
        }
        for (const cron of data.crons) {
            if (!satisfiable(cron.enableOn, possible)) continue;
            run(cron.onStart);
            if (wiring.cronOnEnd) run(cron.onEnd);
        }
        for (const outfit of data.outfits) {
            if (!satisfiable(outfit.availabilityNCB, possible)) continue;
            run(outfit.onPurchase, wiring.outfitStarts);
            if (wiring.outfitOnSell) run(outfit.onSell, wiring.outfitStarts);
        }
    }
    return reachable;
}
