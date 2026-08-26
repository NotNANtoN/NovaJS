/**
 * Renders the galaxy map's political overlay from a running server's data
 * and writes the raw RGBA field to /tmp for eyeballing. Development aid for
 * tuning the overlay without opening a browser.
 *
 *     NOVA_URL=http://localhost:8200 bun tools/territory_preview.ts
 */
import {
    computeTerritoryField,
    territoryRadius,
    TerritoryPoint,
} from '../nova/src/spaceport/territory_field';

const base = `${process.env.NOVA_URL ?? 'http://localhost:8200'}/gameData`;

async function getJson(path: string) {
    const response = await fetch(`${base}/${path}`);
    if (!response.ok) {
        throw new Error(`${path}: ${response.status}`);
    }
    return response.json() as Promise<any>;
}

const ids = await getJson('ids.json');
const systems: any[] = [];
// Sequentially, because a few hundred parallel requests trip the server's
// connection limits.
for (const id of ids.System as string[]) {
    systems.push(await getJson(`data/System/${id}.json?schema=2`));
}

const claimed = systems.filter(system => (system.government ?? -1) >= 128);
const colors = new Map<number, number>();
for (const government of new Set(claimed.map(s => s.government as number))) {
    const govt = await getJson(`data/Govt/nova:${government}.json?schema=2`);
    if (typeof govt.color === 'number') {
        colors.set(government, govt.color);
    }
}

const points: TerritoryPoint[] = claimed
    .filter(system => colors.has(system.government))
    .map(system => ({
        x: system.position[0],
        y: system.position[1],
        color: colors.get(system.government)!,
    }));

console.log(`systems=${systems.length} claimed=${points.length} `
    + `governments=${colors.size} radius=${territoryRadius(points).toFixed(1)}`);
const field = computeTerritoryField(points)!;
console.log(`field ${field.width}x${field.height}`);
await Bun.write('/tmp/territory.raw', new Uint8Array(field.pixels));
await Bun.write('/tmp/territory.json', JSON.stringify({
    width: field.width,
    height: field.height,
    origin: field.origin,
    size: field.size,
    systems: points.map(point => [point.x, point.y, point.color]),
}));
