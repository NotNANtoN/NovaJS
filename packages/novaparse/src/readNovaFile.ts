import { readResourceFork } from "resource_fork";
import { NovaResources, NovaResourceType } from "./resource_parsers/ResourceHolderBase.js";
import { BoomResource } from "./resource_parsers/BoomResource.js";
import { DescResource } from "./resource_parsers/DescResource.js";
import { BaseResource } from "./resource_parsers/NovaResourceBase.js";
import { OutfResource } from "./resource_parsers/OutfResource.js";
import { PictResource } from "./resource_parsers/PictResource.js";
import { RledResource } from "./resource_parsers/RledResource.js";
import { ShanResource } from "./resource_parsers/ShanResource.js";
import { ShipResource } from "./resource_parsers/ShipResource.js";
import { SpinResource } from "./resource_parsers/SpinResource.js";
import { SpobResource } from "./resource_parsers/SpobResource.js";
import { SystResource } from "./resource_parsers/SystResource.js";
import { WeapResource } from "./resource_parsers/WeapResource.js";
import { SndResource } from "./resource_parsers/SndResource.js";
import { $enum } from "ts-enum-util";


// Reads a single plugin or nova file
// Puts results in localIDSpace.
async function readNovaFile(filePath: string, localIDSpace: NovaResources) {
    const rf = await read(filePath);

    for (const resourceType of $enum(NovaResourceType).values()) {
        const parser = getParser(<NovaResourceType>resourceType);

        for (const id in rf[resourceType]) {
            localIDSpace[resourceType][id] = new parser(rf[resourceType][id], localIDSpace);
        }
    }
}

function read(path: string) {
    // Whether or not to use resource fork
    var useRF = path.slice(-5) !== ".ndat" && path.slice(-5) !== ".npif"
        && path.slice(-4) !== ".rez";
    return readResourceFork(path, useRF);
}


// Since we're storing subclasses, not instances of subclasses.
// TODO: Fill this out as more are implemented
var parserMap: { [index: string]: typeof BaseResource } = {};
parserMap[NovaResourceType.bööm] = BoomResource;
//parserMap[NovaResourceType.chär] = ;
//parserMap[NovaResourceType.cicn] = ;
//parserMap[NovaResourceType.cölr] = ;
//parserMap[NovaResourceType.crön] = ;
parserMap[NovaResourceType.dësc] = DescResource;
//parserMap[NovaResourceType.DITL] = ;
//parserMap[NovaResourceType.DLOG] = ;
//parserMap[NovaResourceType.düde] = ;
//parserMap[NovaResourceType.flët] = ;
//parserMap[NovaResourceType.gövt] = ;
//parserMap[NovaResourceType.ïntf] = ;
//parserMap[NovaResourceType.jünk] = ;
//parserMap[NovaResourceType.mïsn] = ;
//parserMap[NovaResourceType.nëbu] = ;
//parserMap[NovaResourceType.öops] = ;
parserMap[NovaResourceType.oütf] = OutfResource;
//parserMap[NovaResourceType.përs] = ;
parserMap[NovaResourceType.PICT] = PictResource;
//parserMap[NovaResourceType.ränk] = ;
//parserMap[NovaResourceType.rlë8] = ;
parserMap[NovaResourceType.rlëD] = RledResource;
//parserMap[NovaResourceType.röid] = ;
parserMap[NovaResourceType.shän] = ShanResource;
parserMap[NovaResourceType.shïp] = ShipResource;
parserMap[NovaResourceType.snd] = SndResource;
parserMap[NovaResourceType.spïn] = SpinResource;
parserMap[NovaResourceType.spöb] = SpobResource;
//parserMap[NovaResourceType.STR] = ;
//parserMap[NovaResourceType.STRH] = ;
parserMap[NovaResourceType.sÿst] = SystResource;
//parserMap[NovaResourceType.vers] = ;
parserMap[NovaResourceType.wëap] = WeapResource;


function getParser(resourceType: NovaResourceType): typeof BaseResource {
    if (parserMap[resourceType]) {
        return parserMap[resourceType];
    }
    else {
        return BaseResource;
        //throw new Error("Unknown data type " + resourceType);
    }
}

export { readNovaFile };
