import { BaseData } from "novadatainterface/base_data";
import { RankData } from "novadatainterface/rank_data";
import { FlagNamespaceMap, resolveResourceFlags } from "../flag_namespace.js";
import { RankResource } from "../resource_parsers/rank_resource.js";
import { BaseParse } from "./base_parse.js";

/**
 * Maps a parsed ränk resource onto the RankData shape.
 *
 * AffilGovt becomes a GLOBAL gövt id (the same resolution planet_parse does
 * for spöb Govt), so a rank written by a plug-in points at that plug-in's
 * government rather than at whatever stock govt happens to share the number.
 * An unresolvable or unset (-1) AffilGovt comes out as null.
 *
 * Contribute goes through the per-plug-in flag namespacing (flag_namespace.ts)
 * exactly as oütf/crön/mïsn Contribute does, and is carried as a DECIMAL
 * string because the namespaced value may exceed 64 bits.
 */
export async function RankParse(rank: RankResource,
    notFoundFunction: (m: string) => void,
    flagMap: FlagNamespaceMap | null = null): Promise<RankData> {
    const base: BaseData = await BaseParse(rank, notFoundFunction);

    let affilGovt: string | null = null;
    if (rank.affilGovt >= 0) {
        affilGovt = rank.idSpace.gövt[rank.affilGovt]?.globalID ?? null;
        if (affilGovt === null) {
            notFoundFunction(
                `No gövt ${rank.affilGovt} for ränk ${base.id}`);
        }
    }

    return {
        ...base,
        weight: rank.weight,
        affilGovt,
        contribute:
            resolveResourceFlags(flagMap, rank, rank.contribute).toString(),
        salary: rank.salary,
        salaryCap: rank.salaryCap,
        priceMod: rank.priceMod,
        flags: rank.flags,
        rankFlags: {
            dropOtherRanksWhenActivated: rank.dropOtherRanksWhenActivated,
            dropOtherRanksWhenDeactivated: rank.dropOtherRanksWhenDeactivated,
            dropIfDestroyGovtOrAllyShip: rank.dropIfDestroyGovtOrAllyShip,
            permanent: rank.permanent,
            dropLowerRanksWhenActivated: rank.dropLowerRanksWhenActivated,
            dropLowerRanksWhenDeactivated: rank.dropLowerRanksWhenDeactivated,
            dropIfCrimeAgainstGovt: rank.dropIfCrimeAgainstGovt,
            govtShipsWontAttack: rank.govtShipsWontAttack,
            canAlwaysLandOnGovtStellars: rank.canAlwaysLandOnGovtStellars,
            canRequestBattleAssistance: rank.canRequestBattleAssistance,
            freeRefuelAndRepair: rank.freeRefuelAndRepair,
        },
        convName: rank.convName,
        shortName: rank.convShortName,
    };
}
