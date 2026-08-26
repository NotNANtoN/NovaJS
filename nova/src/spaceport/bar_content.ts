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

export type BarFlavorKind = 'news' | 'holovid';

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
