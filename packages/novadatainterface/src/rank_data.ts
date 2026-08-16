import { BaseData, getDefaultBaseData } from "./base_data.js";

/**
 * A player rank ("ränk"). The EVN Bible: "The rank resource is used to give
 * the player a feeling of 'belonging' to a given government. It can also be
 * used to give the player certain advantages that come with rank. When a rank
 * is made active (which is accomplished through any suitable control bit set
 * string) the player is given all the privileges of that rank, whatever they
 * might be, and the name of that rank is displayed in the player-info dialog."
 *
 * Ranks are activated and deactivated by the `Kxxx` / `Lxxx` control-bit set
 * operators (ncb.ts), which makes the active set PLAYER-LOCAL state exactly
 * like the control bits themselves — see nova_plugin/rank_logic.ts.
 *
 * The single most load-bearing stock rank is nova:147, "Have Access to
 * Hypergate System" (affilGovt nova:183, flags 0x0208): its 0x0200 bit is what
 * makes the hypergate network — every working gate is MinStatus 32767, "Player
 * can never land" — usable at all, once the Sigma Shipyards mission string
 * grants it.
 */
export interface RankData extends BaseData {
    /**
     * "The importance of this rank, relative to the other rank resources that
     * might be active. Ranks with higher weight are displayed first in the
     * player-info dialog, and the active rank with the highest weight is
     * selected for the <PRK> and <PSR> mission briefing tags."
     */
    weight: number;

    /**
     * The global id of the government affiliated with this rank, or null when
     * the resource names no government (AffilGovt -1). Every flag below that
     * speaks of "the affiliated government" is inert for such a rank.
     */
    affilGovt: string | null;

    /**
     * "Another 64 bits of Contribute values that kick in when the rank is
     * active. These can be used to prevent the player from buying certain
     * items or doing certain missions until achieving a certain rank."
     *
     * A DECIMAL string, like crön/mïsn Contribute — the value is namespaced
     * per plug-in (novaparse's flag_namespace.ts) so it may exceed 64 bits and
     * would not survive as a JS number.
     */
    contribute: string;

    /** "The number of credits that the affiliated government will pay the player, per day". */
    salary: number;

    /**
     * "The maximum amount of money the player can have before the affiliated
     * government stops paying the salary. Set to 0 or -1 if unused."
     */
    salaryCap: number;

    /**
     * "Used to modify the prices of items and ships at planets owned by the
     * affiliated government. A value of 100 equals 100% of original price
     * (i.e. prices are unchanged)."
     */
    priceMod: number;

    /** The raw Flags word, kept so unmodelled bits are still inspectable. */
    flags: number;

    /** The Flags bits, decoded. Bible wording is quoted on each. */
    rankFlags: RankFlags;

    /**
     * "The rank name as used in conversation, through mission briefings and
     * the <PRK> tag. If this is set to an empty string, the rank will never be
     * used in conversation."
     */
    convName: string;

    /** "The short rank named as used in conversation ... and the <PSR> tag." */
    shortName: string;
}

/** The ränk Flags word (EVN Bible, ränk section), bit by bit. */
export interface RankFlags {
    /**
     * 0x0001 "Deactivate all other active ranks affiliated with this same govt
     * when this rank is activated (excludes permanent ranks)"
     */
    dropOtherRanksWhenActivated: boolean;
    /**
     * 0x0002 "Deactivate all other active ranks affiliated with this same govt
     * when this rank is deactivated (excludes permanent ranks)"
     */
    dropOtherRanksWhenDeactivated: boolean;
    /**
     * 0x0004 "Deactivate this rank if player destroys or disables a ship of the
     * affiliated government or its allies"
     */
    dropIfDestroyGovtOrAllyShip: boolean;
    /**
     * 0x0008 "Rank is permanent and cannot be deactivated except if explicitly
     * done by a control bit eval string"
     */
    permanent: boolean;
    /**
     * 0x0010 "Deactivate all other active and lower-weighted ranks affiliated
     * with this same govt when this rank is activated (excludes permanent
     * ranks)"
     */
    dropLowerRanksWhenActivated: boolean;
    /**
     * 0x0020 "Deactivate all other active and lower-weighted ranks affiliated
     * with this same govt when this rank is deactivated (excludes permanent
     * ranks)"
     */
    dropLowerRanksWhenDeactivated: boolean;
    /**
     * 0x0040 "Deactivate this rank if the player commits any crime against the
     * affiliated government"
     */
    dropIfCrimeAgainstGovt: boolean;
    /**
     * 0x0100 "Ships of the affiliated government will not automatically attack
     * the player when he has this rank"
     */
    govtShipsWontAttack: boolean;
    /**
     * 0x0200 "All planets of the affiliated government will let the player land
     * when he has this rank, regardless of their MinStatus field"
     */
    canAlwaysLandOnGovtStellars: boolean;
    /**
     * 0x0400 "Player can always request battle assistance from ships of the
     * affiliated government, who will also call in reinforcements on the
     * player's behalf if they are available."
     */
    canRequestBattleAssistance: boolean;
    /**
     * 0x0800 "Ships allied with the affiliated govt will always repair or
     * refuel the player for free."
     */
    freeRefuelAndRepair: boolean;
}

export function getDefaultRankFlags(): RankFlags {
    return {
        dropOtherRanksWhenActivated: false,
        dropOtherRanksWhenDeactivated: false,
        dropIfDestroyGovtOrAllyShip: false,
        permanent: false,
        dropLowerRanksWhenActivated: false,
        dropLowerRanksWhenDeactivated: false,
        dropIfCrimeAgainstGovt: false,
        govtShipsWontAttack: false,
        canAlwaysLandOnGovtStellars: false,
        canRequestBattleAssistance: false,
        freeRefuelAndRepair: false,
    };
}

export function getDefaultRankData(): RankData {
    return {
        ...getDefaultBaseData(),
        weight: 0,
        affilGovt: null,
        contribute: '0',
        salary: 0,
        salaryCap: 0,
        priceMod: 100,
        flags: 0,
        rankFlags: getDefaultRankFlags(),
        convName: '',
        shortName: '',
    };
}
