/**
 * Retail bar wording. STR# 150 supplies controls, STR# 8100 is named
 * “Commercials”, and STR# 8101 is named “Generic News” in the retail fork.
 * Keeping the indices here prevents UI code from replacing missing resources
 * with invented copy.
 */
export const BAR_STRING_LISTS = {
    buttons: 150,
    messages: 2002,
    commercials: 8100,
    news: 8101,
} as const;

/** One-based STR# 150 positions, as stored by the resource fork. */
export const BAR_BUTTON_STRING_INDEX = {
    done: 5,
    bar: 10,
    gamble: 11,
    holovid: 12,
    hireEscort: 13,
    bet1000: 14,
    bet5000: 15,
    missionBbs: 16,
    info: 48,
} as const;

/** One-based STR# 2002 positions used by escort UI. */
export const ESCORT_MESSAGE_STRING_INDEX = {
    noEscorts: 51,
    maximumEscorts: 124,
    hiredEscort: 166,
    noShipsForHire: 224,
    hiringPrice: 228,
    pay: 297,
    oneDefected: 302,
    someDefected: 303,
} as const;

export type BarFlavorKind = 'news' | 'holovid' | 'rumors' | 'leads';

export interface RetailStringLists {
    buttons?: readonly string[];
    messages?: readonly string[];
    commercials?: readonly string[];
    news?: readonly string[];
}

/** Read a one-based retail STR# entry without manufacturing fallback text. */
export function retailString(
    list: readonly string[] | undefined,
    oneBasedIndex: number,
): string | undefined {
    if (!list || !Number.isInteger(oneBasedIndex) || oneBasedIndex < 1) {
        return undefined;
    }
    const value = list[oneBasedIndex - 1];
    return value && value.length > 0 ? value : undefined;
}

export function barButtonLabel(
    lists: RetailStringLists,
    button: keyof typeof BAR_BUTTON_STRING_INDEX,
): string | undefined {
    return retailString(
        lists.buttons,
        BAR_BUTTON_STRING_INDEX[button],
    );
}

/**
 * Select retail flavor cyclically. Holovid uses STR# 8100 commercials while
 * ordinary bar talk uses STR# 8101 news; both names come from the resource
 * map, not inferred prose.
 */
export function barFlavorText(
    lists: RetailStringLists,
    kind: BarFlavorKind,
    index: number,
): string | undefined {
    const source = kind === 'holovid' ? lists.commercials : lists.news;
    if (!source || source.length === 0) {
        return undefined;
    }
    const normalized = ((Math.floor(index) % source.length)
        + source.length) % source.length;
    return source[normalized];
}

export type MeasureText = (text: string) => number;

/**
 * Wrap all source text into the measured pane. Long tokens are split only
 * when a complete token cannot fit, so no retail sentence is shortened.
 */
export function wrapBarText(
    text: string,
    width: number,
    measure: MeasureText,
): string {
    if (!(width > 0) || text.length === 0) {
        return text;
    }
    return text.split(/\r?\n/).map(paragraph => {
        const words = paragraph.split(/\s+/).filter(Boolean);
        const lines: string[] = [];
        let line = '';
        for (const word of words) {
            const candidate = line ? `${line} ${word}` : word;
            if (measure(candidate) <= width) {
                line = candidate;
                continue;
            }
            if (line) {
                lines.push(line);
                line = '';
            }
            if (measure(word) <= width) {
                line = word;
                continue;
            }
            let fragment = '';
            for (const character of word) {
                if (fragment && measure(fragment + character) > width) {
                    lines.push(fragment);
                    fragment = character;
                } else {
                    fragment += character;
                }
            }
            line = fragment;
        }
        if (line || words.length === 0) {
            lines.push(line);
        }
        return lines.join('\n');
    }).join('\n');
}

export interface BarRumorContext {
    planetName?: string;
    systemName?: string;
    governmentName?: string;
    governmentId?: string;
    legalStanding?: number;
    combatRating?: number;
    missionBits?: ReadonlySet<number> | readonly boolean[];
    credits?: number;
}

export const GENERIC_RUMORS = [
    "A grizzled freighter captain takes a long drink: 'Watch the outer asteroid fields. Scanners have picked up unidentified sensor ghosts jumping near the fringe.'",
    "A free trader grumbles: 'The hyperjump fuel prices keep climbing, yet the patrol fleets never seem to arrive when the pirates drop out of hyperspace.'",
    "A cargo broker whispers: 'There is a heavy demand for industrial metals and medical supplies in the border colonies. A smart pilot could turn a serious profit.'",
    "An old asteroid miner taps his glass: 'I swear I saw a derelict cruiser drifting in the deep halo last month. Engines cold, no transponder. Somebody is going to strike gold salvage.'",
    "A pilot at the next table warns: 'Keep your shields charged even in regulated lanes. Outlaw raiders have been using ion cannons to disable solitary haulers before they can jump.'",
];

export const FACTION_RUMORS: Record<string, string[]> = {
    // Federation / Core
    federation: [
        "A naval officer mutters: 'Command is tightening security around the core jumpgates. Too many rebel sympathizers slipping contraband through the network.'",
        "A supply sergeant talks quietly: 'The fleet is dispatching heavy destroyers to the border. The Auroran clans have been testing our patrol perimeters again.'",
        "A civil administrator sighs: 'The Bureau of Internal Security is running full diagnostic audits on all incoming shipping containers. Expect delays at customs.'",
    ],
    // Auroran / Clans
    auroran: [
        "A clan warrior slams his gauntlet on the bar: 'The Moash and the Tekel clans trade words, but honor is proven in the void with railguns and heavy armor.'",
        "A weapon smith grins fiercely: 'Our hulls may not have Polaris shielding, but our reinforced armor plates can take a blast that would vaporize a Federation scout.'",
        "A clan elder speaks with measured pride: 'The Federation sends diplomats with paper treaties. True Aurorans respect only strength and unwavering loyalty.'",
    ],
    // Polaris / Mystic
    polaris: [
        "A cloaked Polaris observer murmurs: 'The Mu'ursh watch the outer stars. Those who tamper with forbidden bioship tech invite the reckoning of the Raven.'",
        "A technician speaks softly: 'Polaris capacitor banks replenish shields faster than any standard human generator. But outsiders will never understand the symbiosis.'",
        "A quiet scholar observes: 'Energy ripples have been detected along the galactic rim. The ancient artifacts are awakening.'",
    ],
    // Rebel / Insurgency
    rebel: [
        "A freedom fighter whispers: 'The Council on Earth claims peace, but out here we see the true cost of their tyranny. Every liberated shipment counts.'",
        "A scout reports: 'Underground cells have established safe hyperlane waypoints for friendly commanders. Keep your eyes open for the beacon frequencies.'",
        "A rebel technician smiles: 'We just retrofitted a captured gunship with military-grade blasters. The core fleets are in for a surprise.'",
    ],
    // Pirate / Syndicate
    pirate: [
        "A scarred corsair laughs: 'The fat ore convoys coming out of the refinery worlds have half-strength escort wings this rotation. Time to collect a tax.'",
        "A smuggler winks: 'If you know how to mask your cargo hold emissions, you can slip right past the patrol scans and make triple on contraband.'",
        "A mercenary grunts: 'Watch out for local bounty hunters. If you have a price on your hull, stay away from the primary stellar nav-buoys.'",
    ],
};

/**
 * Generates dynamic, context-aware spaceport bar rumors based on planet,
 * government, player standing, and active mission control bitstrings.
 */
export function barRumorText(
    context: BarRumorContext = {},
    index = 0,
): string {
    const pool: string[] = [];

    // Legal status reactivity
    if (context.legalStanding !== undefined && context.legalStanding < 0) {
        pool.push(
            "A patron looks up from their glass, eyes darting to your transponder: 'Word is local security has your hull flagged for deep inspection. If you value your freedom, don't linger around the landing pads.'",
            "A shadowy mercenary smiles faintly: 'You have quite a bounty on your head, Commander. Be glad I am having a drink and not looking for work today.'"
        );
    }

    // High combat rating reactivity
    if (context.combatRating !== undefined && context.combatRating >= 4) {
        pool.push(
            "A rookie pilot stares in admiration: 'You are the ace who broke through that pirate ambush in the outer rim! Drinks are on me, Commander.'",
            "A veteran mercenary nods respectfully: 'Rare to see a combat pilot of your ranking out in this sector. People around here know better than to pick a fight with you.'"
        );
    }

    // Faction-specific rumors
    const govtKey = (context.governmentId || '').toLowerCase().replace(/^.*:/, '');
    const factionPool = FACTION_RUMORS[govtKey]
        || (context.governmentName?.toLowerCase().includes('auror') ? FACTION_RUMORS.auroran : undefined)
        || (context.governmentName?.toLowerCase().includes('polar') ? FACTION_RUMORS.polaris : undefined)
        || (context.governmentName?.toLowerCase().includes('rebel') ? FACTION_RUMORS.rebel : undefined)
        || (context.governmentName?.toLowerCase().includes('pirat') ? FACTION_RUMORS.pirate : undefined)
        || (context.governmentName?.toLowerCase().includes('fed') ? FACTION_RUMORS.federation : undefined);

    if (factionPool && factionPool.length > 0) {
        pool.push(...factionPool);
    }

    // Mission / Story NCB bitstring leads
    if (context.missionBits) {
        const hasBit = (bit: number) => context.missionBits instanceof Set
            ? context.missionBits.has(bit)
            : Boolean((context.missionBits as readonly boolean[])[bit]);

        if (hasBit(100) || hasBit(1)) {
            pool.push("An informant whispers: 'The contacts you are seeking have relocated to the border systems. Watch for encrypted hails near the jump corridors.'");
        }
        if (hasBit(200) || hasBit(2)) {
            pool.push("A courier leans in: 'Rumors say a classified research vessel vanished near uncharted space. Major bounties are being quietly offered for its recovery.'");
        }
    }

    // Always include generic world rumors
    pool.push(...GENERIC_RUMORS);

    const normalized = ((Math.floor(index) % pool.length) + pool.length) % pool.length;
    return pool[normalized];
}
