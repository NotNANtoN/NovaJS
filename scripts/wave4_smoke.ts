import * as fs from 'fs';
import * as path from 'path';
import {
    generateProceduralMissions,
    jumpDistanceBFS,
} from '../nova/src/nova_plugin/procedural_missions';
import { getTradeCommodities } from '../novadatainterface/CommodityData';
import { SystemParse } from '../novaparse/src/parsers/SystemParse';
import { readNovaFile } from '../novaparse/src/readNovaFile';
import {
    getEmptyNovaResources,
    NovaResourceType,
    NovaResources,
} from '../novaparse/src/resource_parsers/ResourceHolderBase';

const dataPath = process.env.NOVA_DATA_PATH
    ?? path.join(process.cwd(), 'nova', 'Nova_Data', 'Nova Files');

function numericResourceIDs(
    resources: { [index: string]: { id: number } },
): string[] {
    return Object.keys(resources).filter(id => /^\d+$/.test(id));
}

function addGlobalResourceAliases(resources: NovaResources) {
    for (const resourceType of Object.values(NovaResourceType)) {
        const localResourceType = resourceType === NovaResourceType.STRH
            ? 'STRH' : resourceType;
        const resourceList = resources[localResourceType];
        for (const id of numericResourceIDs(resourceList)) {
            const resource = resourceList[id];
            resource.globalID = `nova:${id}`;
            resource.prefix = 'nova';
            resourceList[`nova:${id}`] = resource;
        }
    }
}

async function main() {
    const resources = getEmptyNovaResources();
    for (const file of fs.readdirSync(dataPath)
        .filter(file => file.endsWith('.ndat')).sort()) {
        await readNovaFile(path.join(dataPath, file), resources);
    }
    addGlobalResourceAliases(resources);

    const systems = (await Promise.all(
        numericResourceIDs(resources.sÿst).map(id =>
            SystemParse(resources.sÿst[id], () => { })),
    )).sort((a, b) => a.id.localeCompare(b.id));
    const systemByPlanet = new Map<string, string>();
    for (const system of systems) {
        for (const planetId of system.planets) {
            systemByPlanet.set(planetId, system.id);
        }
    }
    const planets = numericResourceIDs(resources.spöb).map(id => {
        const resource = resources.spöb[id];
        return {
            id: resource.globalID,
            name: resource.name,
            inhabited: (resource.flags & 0x20) === 0,
            systemId: systemByPlanet.get(resource.globalID),
        };
    });
    const startSystem = systems.find(system => system.id === 'nova:130');
    if (!startSystem) {
        throw new Error('Retail data is missing starting system nova:130');
    }
    const startPlanet = planets.find(planet =>
        planet.systemId === startSystem.id && planet.inhabited);
    if (!startPlanet) {
        throw new Error('Starting system has no inhabited stellar');
    }
    const offers = generateProceduralMissions({
        currentSystemId: startSystem.id,
        currentPlanetId: startPlanet.id,
        gameDate: 0,
        systems,
        planets,
        freeSpace: 10,
    });
    console.log(`mission computer at ${startSystem.id}/${startPlanet.name}:`);
    for (const offer of offers) {
        console.log(JSON.stringify({
            type: offer.type,
            tons: offer.mission.cargoQty,
            destination: offer.destinationPlanetId,
            distance: offer.jumpDistance,
            pay: offer.mission.payVal,
            available: offer.available,
        }));
    }

    const tradeCenters = numericResourceIDs(resources.spöb)
        .map(id => resources.spöb[id])
        .map(resource => ({
            id: resource.globalID,
            name: resource.name,
            commodities: getTradeCommodities(resource.flags),
        }))
        .filter(stellar => stellar.commodities.length > 0)
        .slice(0, 2);
    console.log('trade center price samples:');
    for (const stellar of tradeCenters) {
        console.log(JSON.stringify(stellar));
    }

    const markets = numericResourceIDs(resources.spöb)
        .map(id => resources.spöb[id])
        .map(resource => ({
            id: resource.globalID,
            name: resource.name,
            systemId: systemByPlanet.get(resource.globalID),
            commodities: getTradeCommodities(resource.flags),
        }))
        .filter(market => market.systemId !== undefined
            && market.commodities.length > 0);
    for (const source of markets) {
        const low = source.commodities.find(item =>
            item.priceLevel === 'low');
        if (!low) {
            continue;
        }
        const destination = markets.find(market => {
            const high = market.commodities.find(item =>
                item.commodity === low.commodity
                && item.priceLevel === 'high');
            return high !== undefined
                && jumpDistanceBFS(
                    source.systemId!, market.systemId!, systems) !== undefined;
        });
        if (destination) {
            const high = destination.commodities.find(item =>
                item.commodity === low.commodity
                && item.priceLevel === 'high')!;
            console.log('classic low/high route:', JSON.stringify({
                commodity: low.commodity,
                source: `${source.name} (${source.id})`,
                buy: low.price,
                destination: `${destination.name} (${destination.id})`,
                sell: high.price,
                jumps: jumpDistanceBFS(
                    source.systemId!, destination.systemId!, systems),
                profitPerTon: high.price - low.price,
            }));
            break;
        }
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

