/**
 * Mission dësc "wildcard" expansion, per the EVN Bible: whenever a
 * mission description is shown, tags like <DST> are replaced with
 * pertinent mission information.
 *
 * The player-identity tags (<PN>, <PNN>, <PSN>, <PST>) take their real
 * values from spaceport/player_identity.ts (pilot profile + current
 * hull); the rank tags still fall back to placeholders until ranks
 * exist.
 */
import { displayName } from './display_name.js';
import { NCBTestContext } from './ncb.js';
import { resolveConditionalBlocks } from './desc_text.js';

export interface MissionTextSubstitutions {
    /** <DST> destination stellar name. */
    destinationStellar?: string;
    /** <DSY> destination system name. */
    destinationSystem?: string;
    /** <RST> return stellar name. */
    returnStellar?: string;
    /** <RSY> return system name. */
    returnSystem?: string;
    /** <CT> cargo type name. */
    cargoType?: string;
    /** <CQ> cargo quantity. */
    cargoQty?: number;
    /** <DL> mission deadline date, formatted. */
    deadline?: string;
    /** <PAY> absolute mission payment. */
    payment?: number;
    /** <PN> the player's name. */
    playerName?: string;
    /** <PNN> the player's nickname (falls back to the full name). */
    playerNickname?: string;
    /** <PSN> the player's ship's name. */
    playerShipName?: string;
    /** <PST> the player's ship type name. */
    playerShipType?: string;
}

/**
 * The displayable part of a mïsn resource name: scenario authors
 * append "; comment" annotations (e.g. "Delivery to Earth; Vellos1")
 * that the game hides. Thin alias of the shared {@link displayName}
 * helper, kept for the mission-specific call sites.
 */
export function missionDisplayName(name: string): string {
    return displayName(name);
}

export function expandMissionText(text: string,
    subs: MissionTextSubstitutions,
    ctx?: NCBTestContext): string {
    // Bible order: resolve dësc conditional blocks first (against the real
    // player context), then expand mission wildcards. Conditionals and
    // wildcards are independent, but resolving conditionals first keeps their
    // quoted strings from confusing the wildcard pass and lets a chosen string
    // itself contain a wildcard.
    const conditional = ctx ? resolveConditionalBlocks(text, ctx) : text;
    const replacements: [string, string][] = [
        ['<DSY>', subs.destinationSystem ?? 'an unknown system'],
        ['<DST>', subs.destinationStellar ?? 'an unknown stellar'],
        ['<RSY>', subs.returnSystem ?? 'an unknown system'],
        ['<RST>', subs.returnStellar ?? 'an unknown stellar'],
        ['<CT>', subs.cargoType ?? 'cargo'],
        ['<CQ>', subs.cargoQty !== undefined ? String(subs.cargoQty) : 'some'],
        ['<DL>', subs.deadline ?? 'no deadline'],
        ['<PAY>', subs.payment !== undefined
            ? Math.abs(subs.payment).toLocaleString() : '0'],
        ['<REG>', 'NovaJS'],
        ['<PN>', subs.playerName ?? 'Captain'],
        // "If no nickname was specified, Nova will use the player's full
        // name here instead" (Bible <PNN>).
        ['<PNN>', subs.playerNickname ?? subs.playerName ?? 'Captain'],
        ['<PSN>', subs.playerShipName ?? 'your ship'],
        ['<PST>', subs.playerShipType ?? 'ship'],
        ['<PRK>', 'captain'],
        ['<SRK>', 'captain'],
    ];
    let expanded = conditional;
    for (const [tag, value] of replacements) {
        expanded = expanded.split(tag).join(value);
    }
    // Nova line-break convention: dëscs use \n literally already, but
    // also carriage returns from MacRoman text.
    return expanded.replace(/\r/g, '\n');
}
