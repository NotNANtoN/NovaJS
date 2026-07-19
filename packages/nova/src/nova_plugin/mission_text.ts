/**
 * Mission dësc "wildcard" expansion, per the EVN Bible: whenever a
 * mission description is shown, tags like <DST> are replaced with
 * pertinent mission information.
 *
 * Only the mission-shape tags are handled; the player-identity tags
 * (<PN>, <PSN>, ranks, ...) fall back to placeholders until player
 * naming exists.
 */
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
    /** <PSN> the player's ship's name. */
    playerShipName?: string;
    /** <PST> the player's ship type name. */
    playerShipType?: string;
}

export function expandMissionText(text: string,
    subs: MissionTextSubstitutions): string {
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
        ['<PNN>', subs.playerName ?? 'Captain'],
        ['<PSN>', subs.playerShipName ?? 'your ship'],
        ['<PST>', subs.playerShipType ?? 'ship'],
        ['<PRK>', 'captain'],
        ['<SRK>', 'captain'],
    ];
    let expanded = text;
    for (const [tag, value] of replacements) {
        expanded = expanded.split(tag).join(value);
    }
    // Nova line-break convention: dëscs use \n literally already, but
    // also carriage returns from MacRoman text.
    return expanded.replace(/\r/g, '\n');
}
