/**
 * Dumps every int16 in each röid resource next to its name so the resource
 * layout can be checked against the values retail ships. Development aid.
 *
 *     bun tools/roid_field_probe.ts "nova/Nova_Data/Nova Files"/*.ndat
 */
import { readResourceFork } from 'resource_fork';

for (const file of process.argv.slice(2)) {
    const fork = await readResourceFork(file, false);
    const roids = (fork as Record<string, any>)['röid'];
    if (!roids) {
        continue;
    }
    for (const id of Object.keys(roids).sort()) {
        if (!/^\d+$/.test(id)) {
            continue;
        }
        const data: DataView = roids[id].data;
        const words: string[] = [];
        for (let offset = 0; offset + 1 < data.byteLength; offset += 2) {
            words.push(`${offset}:${data.getInt16(offset)}`);
        }
        console.log(`${id} ${String(roids[id].name).padEnd(16)} len=${
            data.byteLength} ${words.join(' ')}`);
    }
}
