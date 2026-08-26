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
    scanMask: number;
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
        scanMask: govt.scanMask,
    };
}
