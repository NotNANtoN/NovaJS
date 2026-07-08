import { GovtData } from "novadatainterface/govt_data";
import { BaseData } from "novadatainterface/base_data";
import { GovtResource } from "../resource_parsers/govt_resource.js";
import { BaseParse } from "./base_parse.js";


/**
 * Maps a parsed gövt resource onto the GovtData shape served through the data
 * interface. The GovtResource already decodes every field (including the two
 * flag words into named booleans) and verifies its layout against the gövt
 * TMPL, so this is a straight projection plus the shared BaseData fields.
 */
export async function GovtParse(govt: GovtResource,
    notFoundFunction: (m: string) => void): Promise<GovtData> {
    const base: BaseData = await BaseParse(govt, notFoundFunction);

    return {
        ...base,
        classes: [...govt.classes],
        allies: [...govt.allies],
        enemies: [...govt.enemies],
        maxOdds: govt.maxOdds,
        skillMult: govt.skillMult,
        inhJam: [
            govt.inhJam[0] ?? 0,
            govt.inhJam[1] ?? 0,
            govt.inhJam[2] ?? 0,
            govt.inhJam[3] ?? 0,
        ],
        crimeTol: govt.crimeTol,
        scanFine: govt.scanFine,
        scanMask: govt.scanMask,
        smugglePenalty: govt.smugPenalty,
        disablePenalty: govt.disabPenalty,
        boardPenalty: govt.boardPenalty,
        killPenalty: govt.killPenalty,
        shootPenalty: govt.shootPenalty,
        initialRecord: govt.initialRec,
        flags: {
            xenophobic: govt.xenophobic,
            attacksPlayerIfCriminal: govt.attacksPlayerIfCriminal,
            alwaysAttacksPlayer: govt.alwaysAttacksPlayer,
            playerShotsPassThrough: govt.playerShotsPassThrough,
            warshipsRetreatAt25: govt.warshipsRetreatAt25,
            ignoredByOtherNosyGovts: govt.ignoredByOtherNosyGovts,
            neverAttacksPlayer: govt.neverAttacksPlayer,
            freightersHalfJamming: govt.freightersHalfJamming,
            persShipsImmortal: govt.persShipsImmortal,
            warshipsTakeBribes: govt.warshipsTakeBribes,
            cantBeHailed: govt.cantBeHailed,
            startsDisabled: govt.startsDisabled,
            plundersBeforeDestroying: govt.plundersBeforeDestroying,
            freightersTakeBribes: govt.freightersTakeBribes,
            planetsTakeBribes: govt.planetsTakeBribes,
            largerBribes: govt.largerBribes,
        },
        flags2: {
            noAssistOrMercy: govt.noAssistOrMercy,
            minorMapBoundaries: govt.minorMapBoundaries,
            noMapBoundaries: govt.noMapBoundaries,
            noDistressMessages: govt.noDistressMessages,
            roadsideAssistance: govt.roadsideAssistance,
            doesntUseHypergates: govt.doesntUseHypergates,
            prefersHypergates: govt.prefersHypergates,
            prefersWormholes: govt.prefersWormholes,
        },
        commName: govt.commName,
        targetCode: govt.targetCode,
        mediumName: govt.mediumName,
        color: govt.color,
        shipColor: govt.shipColor,
        require: govt.require.toString(),
        voiceType: govt.voiceType,
    };
}
