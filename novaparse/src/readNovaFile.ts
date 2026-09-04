import { RankResource } from "./resource_parsers/RankResource";
import { OopsResource } from "./resource_parsers/OopsResource";
import { CronResource } from "./resource_parsers/CronResource";
import { readResourceFork } from "resource_fork";
import { NovaResources, NovaResourceType } from "./resource_parsers/ResourceHolderBase";
import { BoomResource } from "./resource_parsers/BoomResource";
import { DudeResource } from "./resource_parsers/DudeResource";
import { DescResource } from "./resource_parsers/DescResource";
import { FletResource } from "./resource_parsers/FletResource";
import { GovtResource } from "./resource_parsers/GovtResource";
import { BaseResource } from "./resource_parsers/NovaResourceBase";
import { MisnResource } from "./resource_parsers/MisnResource";
import { OutfResource } from "./resource_parsers/OutfResource";
import { PictResource } from "./resource_parsers/PictResource";
import { RledResource } from "./resource_parsers/RledResource";
import { ShanResource } from "./resource_parsers/ShanResource";
import { ShipResource } from "./resource_parsers/ShipResource";
import { SpinResource } from "./resource_parsers/SpinResource";
import { SpobResource } from "./resource_parsers/SpobResource";
import { SystResource } from "./resource_parsers/SystResource";
import { WeapResource } from "./resource_parsers/WeapResource";
import { SndResource } from "./resource_parsers/SndResource";
import { NebuResource } from "./resource_parsers/NebuResource";
import { StrhResource } from "./resource_parsers/StrhResource";
import { RoidResource } from "./resource_parsers/RoidResource";
import { JunkResource } from "./resource_parsers/JunkResource";
import { PersResource } from "./resource_parsers/PersResource";


// Reads a single plugin or nova file
// Puts results in localIDSpace.
async function readNovaFile(filePath: string, localIDSpace: NovaResources) {
    const rf = await read(filePath);

    for (const resourceType of Object.values(NovaResourceType)) {
        const parser = getParser(<NovaResourceType>resourceType);
        const resourcesOfType = rf[resourceType];
        if (!resourcesOfType) {
            continue;
        }

        // STR# is named STRH in NovaResources because # is not a valid
        // identifier. Keep the resource-fork spelling at the input boundary.
        const localResourceType = resourceType === NovaResourceType.STRH ? "STRH" : resourceType;
        for (const id in resourcesOfType) {
            localIDSpace[localResourceType][id] = new parser(resourcesOfType[id], localIDSpace);
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
parserMap[NovaResourceType.crön] = CronResource;
parserMap[NovaResourceType.dësc] = DescResource;
//parserMap[NovaResourceType.DITL] = ;
//parserMap[NovaResourceType.DLOG] = ;
parserMap[NovaResourceType.düde] = DudeResource;
parserMap[NovaResourceType.flët] = FletResource;
parserMap[NovaResourceType.gövt] = GovtResource;
//parserMap[NovaResourceType.ïntf] = ;
parserMap[NovaResourceType.jünk] = JunkResource;
parserMap[NovaResourceType.mïsn] = MisnResource;
//parserMap[NovaResourceType.nëbu] = ;
parserMap[NovaResourceType.öops] = OopsResource;
parserMap[NovaResourceType.oütf] = OutfResource;
parserMap[NovaResourceType.përs] = PersResource;
parserMap[NovaResourceType.PICT] = PictResource;
parserMap[NovaResourceType.ränk] = RankResource;
//parserMap[NovaResourceType.rlë8] = ;
parserMap[NovaResourceType.rlëD] = RledResource;
parserMap[NovaResourceType.nëbu] = NebuResource;
parserMap[NovaResourceType.röid] = RoidResource;
parserMap[NovaResourceType.shän] = ShanResource;
parserMap[NovaResourceType.shïp] = ShipResource;
parserMap[NovaResourceType.snd] = SndResource;
parserMap[NovaResourceType.spïn] = SpinResource;
parserMap[NovaResourceType.spöb] = SpobResource;
//parserMap[NovaResourceType.STR] = ;
parserMap[NovaResourceType.STRH] = StrhResource;
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
