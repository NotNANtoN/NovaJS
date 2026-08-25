import { MissionBits } from './ncb';

export interface MissionRankTextValue {
    id: number;
    government?: number;
    weight?: number;
    convName?: string;
    shortName?: string;
    name?: string;
}

export interface MissionTextValues {
    destination?: string;
    destinationSystem?: string;
    returnDestination?: string;
    returnSystem?: string;
    cargo?: string;
    quantity?: number;
    deadline?: string | number;
    pay?: number | string;
    pilotName?: string;
    nickname?: string;
    shipName?: string;
    shipType?: string;
    registered?: boolean;
    daysSinceRegistration?: number;
    gender?: 'male' | 'female' | number;
    missionBits?: MissionBits;
    ranks?: readonly MissionRankTextValue[];
    activeRanks?: readonly number[];
    mostRecentRank?: MissionRankTextValue;
    offeringShipName?: string;
    specialShipName?: string;
}

function bitSet(bits: MissionBits | undefined, bit: number): boolean {
    if (!bits) {
        return false;
    }
    return bits instanceof Set ? bits.has(bit) : Boolean(bits[bit]);
}

function isMale(gender: MissionTextValues['gender']): boolean {
    return gender === 'male' || gender === 1;
}

function isRegistered(values: MissionTextValues, days?: number): boolean {
    if (values.registered === true) {
        return true;
    }
    return days !== undefined
        && values.daysSinceRegistration !== undefined
        && values.daysSinceRegistration < days;
}

function readQuoted(source: string, start: number): [string, number] {
    let value = '';
    let index = start + 1;
    while (index < source.length) {
        const character = source[index++];
        if (character === '"') {
            return [value, index];
        }
        if (character !== '\\' || index >= source.length) {
            value += character;
            continue;
        }
        const escaped = source[index++];
        switch (escaped) {
            case 'n':
                value += '\n';
                break;
            case 'r':
                value += '\r';
                break;
            case 't':
                value += '\t';
                break;
            default:
                value += escaped;
                break;
        }
    }
    return [value, index];
}

function readAlternatives(source: string): string[] {
    const alternatives: string[] = [];
    let index = 0;
    while (index < source.length) {
        while (/\s/.test(source[index] ?? '')) {
            index++;
        }
        if (index >= source.length) {
            break;
        }
        if (source[index] === '"') {
            const [value, end] = readQuoted(source, index);
            alternatives.push(value);
            index = end;
            continue;
        }
        const start = index;
        while (index < source.length && !/\s/.test(source[index])) {
            index++;
        }
        alternatives.push(source.slice(start, index));
    }
    return alternatives;
}

interface Conditional {
    negate: boolean;
    kind: 'bit' | 'gender' | 'registered';
    value?: number;
    alternatives: string[];
}

function parseConditional(source: string): Conditional | undefined {
    let body = source.trim();
    let negate = false;
    if (body.startsWith('!')) {
        negate = true;
        body = body.slice(1).trimStart();
    }

    let match = /^b(\d+)\s*(.*)$/is.exec(body);
    if (match) {
        return {
            negate,
            kind: 'bit',
            value: Number(match[1]),
            alternatives: readAlternatives(match[2]),
        };
    }

    // Also accept the readable form requested by converted data:
    // {B b001 "yes" "no"}.
    match = /^B\s+b(\d+)\s*(.*)$/is.exec(body);
    if (match) {
        return {
            negate,
            kind: 'bit',
            value: Number(match[1]),
            alternatives: readAlternatives(match[2]),
        };
    }

    match = /^G\s*(.*)$/is.exec(body);
    if (match) {
        return {
            negate,
            kind: 'gender',
            alternatives: readAlternatives(match[1]),
        };
    }

    match = /^P(\d*)\s*(.*)$/is.exec(body);
    if (match) {
        return {
            negate,
            kind: 'registered',
            value: match[1] ? Number(match[1]) : undefined,
            alternatives: readAlternatives(match[2]),
        };
    }
    return undefined;
}

function conditionalValue(
    conditional: Conditional,
    values: MissionTextValues,
): boolean {
    let value: boolean;
    switch (conditional.kind) {
        case 'bit':
            value = bitSet(values.missionBits, conditional.value!);
            break;
        case 'gender':
            value = isMale(values.gender);
            break;
        case 'registered':
            value = isRegistered(values, conditional.value);
            break;
    }
    return conditional.negate ? !value : value;
}

function substituteConditionals(
    text: string,
    values: MissionTextValues,
): string {
    let result = '';
    let cursor = 0;
    while (cursor < text.length) {
        const opening = text.indexOf('{', cursor);
        if (opening < 0) {
            result += text.slice(cursor);
            break;
        }
        result += text.slice(cursor, opening);
        const closing = text.indexOf('}', opening + 1);
        if (closing < 0) {
            result += text.slice(opening);
            break;
        }
        const conditional = parseConditional(
            text.slice(opening + 1, closing));
        if (!conditional || conditional.alternatives.length === 0) {
            result += text.slice(opening, closing + 1);
        } else {
            result += conditionalValue(conditional, values)
                ? conditional.alternatives[0] ?? ''
                : conditional.alternatives[1] ?? '';
        }
        cursor = closing + 1;
    }
    return result;
}

function rankFor(
    values: MissionTextValues,
    government?: number,
): MissionRankTextValue | undefined {
    const active = new Set(values.activeRanks ?? []);
    const candidates = (values.ranks ?? []).filter(rank => active.has(rank.id));
    const governmentCandidates = government === undefined
        ? candidates
        : candidates.filter(rank => rank.government === government);
    return [...governmentCandidates].sort((a, b) =>
        (b.weight ?? 0) - (a.weight ?? 0))[0];
}

function rankName(
    values: MissionTextValues,
    short: boolean,
    government?: number,
): string {
    const rank = rankFor(values, government);
    if (!rank) {
        return 'captain';
    }
    return (short ? rank.shortName : rank.convName)
        ?? rank.name
        ?? 'captain';
}

/**
 * Expand both the angle-bracket mission wildcards and the mutable dësc
 * conditionals. Unknown angle tags and malformed conditionals are preserved,
 * matching Nova's useful behavior for plug-ins that introduce their own
 * text markers.
 */
export function formatMissionText(
    text: string,
    values: MissionTextValues = {},
): string {
    const destination = values.destination ?? '';
    const returnDestination = values.returnDestination ?? destination;
    const replacements: Record<string, string> = {
        DSY: values.destinationSystem ?? '',
        DST: destination,
        RSY: values.returnSystem ?? '',
        RST: returnDestination,
        // Friendly aliases used by converted mission data.
        SYS: values.destinationSystem ?? destination,
        RET: returnDestination,
        CT: values.cargo ?? '',
        CQ: values.quantity === undefined ? '' : String(values.quantity),
        DL: values.deadline === undefined ? '' : String(values.deadline),
        PAY: values.pay === undefined ? '' : typeof values.pay === 'number'
            ? String(Math.abs(values.pay)) : values.pay,
        REG: isRegistered(values) ? 'REGISTERED' : 'UNREGISTERED',
        PN: values.pilotName ?? 'Captain',
        PNN: values.nickname ?? values.pilotName ?? 'Captain',
        PNM: values.pilotName ?? 'Captain',
        PSN: values.shipName ?? 'Nova',
        PST: values.shipType ?? '',
        SHT: values.shipType ?? '',
        PRK: rankName(values, false),
        SRK: rankName(values, true),
        PSR: rankName(values, true),
        RRK: values.mostRecentRank?.convName
            ?? values.mostRecentRank?.name
            ?? 'captain',
        OSN: values.offeringShipName ?? '',
        SN: values.specialShipName ?? '',
    };

    let result = substituteConditionals(text, values);
    result = result.replace(
        /<([A-Za-z][A-Za-z0-9]*)>/g,
        (whole, rawKey: string) => {
            const key = rawKey.toUpperCase();
            const rankMatch = /^(PRK|SRK)(\d+)$/.exec(key);
            if (rankMatch) {
                return rankName(
                    values,
                    rankMatch[1] === 'SRK',
                    Number(rankMatch[2]));
            }
            return Object.prototype.hasOwnProperty.call(replacements, key)
                ? replacements[key]
                : whole;
        });
    return result;
}
