import { readResourceFork } from "resource_fork";
import { NovaResources, NovaResourceType } from "./resource_parsers/resource_holder_base.js";
import { BoomResource } from "./resource_parsers/boom_resource.js";
import { DescResource } from "./resource_parsers/desc_resource.js";
import { BaseResource } from "./resource_parsers/nova_resource_base.js";
import { OutfResource } from "./resource_parsers/outf_resource.js";
import { PictResource } from "./resource_parsers/pict_resource.js";
import { RledResource } from "./resource_parsers/rled_resource.js";
import { ShanResource } from "./resource_parsers/shan_resource.js";
import { ShipResource } from "./resource_parsers/ship_resource.js";
import { SpinResource } from "./resource_parsers/spin_resource.js";
import { SpobResource } from "./resource_parsers/spob_resource.js";
import { SystResource } from "./resource_parsers/syst_resource.js";
import { WeapResource } from "./resource_parsers/weap_resource.js";
import { SndResource } from "./resource_parsers/snd_resource.js";
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
