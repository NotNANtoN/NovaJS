import * as fs from "fs";
import * as path from "path";
import { readNovaFile } from "./src/readNovaFile";
import { NebulaParse } from "./src/parsers/NebulaParse";
import { NebuResource } from "./src/resource_parsers/NebuResource";
import { BaseResource } from "./src/resource_parsers/NovaResourceBase";
import {
    getEmptyNovaResources,
    NovaResourceType,
    NovaResources,
} from "./src/resource_parsers/ResourceHolderBase";

const dataPath = process.argv[2];

function numericResourceIDs(
    resources: { [index: string]: BaseResource },
): string[] {
    return Object.keys(resources).filter(id => /^\d+$/.test(id));
}

async function main() {
    const resources: NovaResources = getEmptyNovaResources();
    for (const file of fs.readdirSync(dataPath)
        .filter(file => file.endsWith(".ndat")).sort()) {
        await readNovaFile(path.join(dataPath, file), resources);
    }

    for (const resourceType of Object.values(NovaResourceType)) {
        const localResourceType =
            resourceType === NovaResourceType.STRH ? "STRH" : resourceType;
        const resourceList = resources[localResourceType];
        for (const id of numericResourceIDs(resourceList)) {
            const resource = resourceList[id];
            resource.globalID = "nova:" + id;
            resource.prefix = "nova";
            resourceList["nova:" + id] = resource;
        }
    }

    for (const id of numericResourceIDs(resources.nëbu)) {
        const parsed = await NebulaParse(
            resources.nëbu[id] as NebuResource, m => console.log('  warn:', m));
        console.log(JSON.stringify(parsed));
    }
}

main();
