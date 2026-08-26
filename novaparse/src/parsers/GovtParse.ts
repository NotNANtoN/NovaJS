import { BaseData } from "novadatainterface/BaseData";
import { GovtResource } from "../resource_parsers/GovtResource";
import { BaseParse } from "./BaseParse";

export interface ParsedGovtData extends BaseData {
    color: number;
    flags: number;
    flags2: number;
    scanFine: number;
    classes: number[];
    allies: number[];
    enemies: number[];
    relations: {
        classes: number[];
        allies: number[];
        enemies: number[];
    };
    commName: string;
    targetName: string;
    mediumName: string;
    scanMask: number;
    crimeTolerance: number;
    initialRecord: number;
    maxOdds: number;
    penalties: {
        smuggling: number;
        disabling: number;
        boarding: number;
        killing: number;
        shooting: number;
    };
}

export async function GovtParse(govt: GovtResource,
    notFoundFunction: (message: string) => void): Promise<ParsedGovtData> {
    var base: BaseData = await BaseParse(govt, notFoundFunction);
    var relations = {
        classes: govt.classes,
        allies: govt.allies,
        enemies: govt.enemies,
    };
    return {
        ...base,
        color: govt.color & 0xffffff,
        flags: govt.flags,
        flags2: govt.flags2,
        scanFine: govt.scanFine,
        classes: govt.classes,
        allies: govt.allies,
        enemies: govt.enemies,
        relations,
        commName: govt.commName,
        targetName: govt.targetName,
        mediumName: govt.mediumName,
        scanMask: govt.scanMask,
        crimeTolerance: govt.crimeTolerance,
        initialRecord: govt.initialRecord,
        maxOdds: govt.maxOdds,
        penalties: {
            smuggling: govt.smugglingPenalty,
            disabling: govt.disablingPenalty,
            boarding: govt.boardingPenalty,
            killing: govt.killingPenalty,
            shooting: govt.shootingPenalty,
        },
    };
}
