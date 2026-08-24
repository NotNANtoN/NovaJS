import * as fs from "fs";
import * as path from "path";
import { readNovaFile } from "./src/readNovaFile";
import { MissionParse, standardCargoNames } from "./src/parsers/MissionParse";
import { SystemParse } from "./src/parsers/SystemParse";
import { BaseResource } from "./src/resource_parsers/NovaResourceBase";
import {
    getEmptyNovaResources,
    NovaResourceType,
    NovaResources,
} from "./src/resource_parsers/ResourceHolderBase";

const dataPath = "/tmp/Nova Files ndat";

function numericResourceIDs(resources: { [index: string]: BaseResource }): string[] {
    return Object.keys(resources).filter(id => /^\d+$/.test(id));
}

async function main() {
    var resources: NovaResources = getEmptyNovaResources();
    var files = fs.readdirSync(dataPath)
        .filter(file => file.endsWith(".ndat"))
        .sort();
    for (var file of files) {
        await readNovaFile(path.join(dataPath, file), resources);
    }

    // readNovaFile stores local IDs. This smoke script uses one synthetic
    // namespace so BaseParse and cross-resource references work like NovaParse.
    for (var resourceType of Object.values(NovaResourceType)) {
        var localResourceType = resourceType === NovaResourceType.STRH ? "STRH" : resourceType;
        var resourceList = resources[localResourceType];
        for (var id of numericResourceIDs(resourceList)) {
            var resource = resourceList[id];
            resource.globalID = "nova:" + id;
            resource.prefix = "nova";
            resourceList["nova:" + id] = resource;
        }
    }

    var missions = [];
    for (var id of numericResourceIDs(resources.mïsn)) {
        missions.push(await MissionParse(resources.mïsn[id], () => { }));
    }
    console.log("missions parsed:", missions.length);
    console.log("standard cargo type 2:", standardCargoNames[2]);

    var medicalSamples = missions.filter(mission => mission.cargo === "medical supplies");
    var samples = (medicalSamples.length >= 3 ? medicalSamples : missions
        .filter(mission => mission.cargo !== null && mission.briefText !== ""))
        .slice(0, 3);
    for (var mission of samples) {
        console.log(JSON.stringify({
            id: mission.id,
            pay: mission.pay,
            cargo: mission.cargo,
            availLoc: mission.availLoc,
            briefText: mission.briefText.slice(0, 80),
        }));
    }

    console.log("dudes:", numericResourceIDs(resources.düde).length);
    console.log("flets:", numericResourceIDs(resources.flët).length);
    console.log("govts:", numericResourceIDs(resources.gövt).length);
    console.log("govt 128:", resources.gövt[128].name);

    var system = await SystemParse(resources.sÿst[128], () => { });
    console.log("system 128 spawn table:", JSON.stringify({
        id: system.id,
        name: system.name,
        dudes: system.dudes,
        avgShips: system.avgShips,
    }));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
