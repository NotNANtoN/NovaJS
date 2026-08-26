/**
 * Prints candidate int16 fields from the tail of every sÿst resource so an
 * unmapped field (such as the asteroid density) can be located by its value
 * range. Development aid.
 *
 *     bun tools/syst_field_probe.ts "nova/Nova_Data/Nova Files"/*.ndat
 */
import { readResourceFork } from 'resource_fork';

interface Column { offset: number, values: number[] }

const columns = new Map<number, Column>();
const names: string[] = [];
let byteLength = 0;

for (const file of process.argv.slice(2)) {
    const fork = await readResourceFork(file, false);
    const systems = (fork as Record<string, any>)['sÿst'];
    if (!systems) {
        continue;
    }
    for (const id of Object.keys(systems)) {
        if (!/^\d+$/.test(id)) {
            continue;
        }
        const data: DataView = systems[id].data;
        byteLength = data.byteLength;
        names.push(`${id} ${systems[id].name}`);
        for (let offset = 96; offset + 1 < data.byteLength; offset += 2) {
            const column = columns.get(offset) ?? { offset, values: [] };
            column.values.push(data.getInt16(offset));
            columns.set(offset, column);
        }
    }
}

console.log(`sÿst resources: ${names.length}, byteLength ${byteLength}`);
for (const { offset, values } of columns.values()) {
    const min = Math.min(...values);
    const max = Math.max(...values);
    const nonZero = values.filter(value => value !== 0).length;
    const distinct = new Set(values).size;
    console.log(`offset ${String(offset).padStart(3)}  min ${
        String(min).padStart(6)}  max ${String(max).padStart(6)}  nonZero ${
        String(nonZero).padStart(4)}  distinct ${String(distinct).padStart(4)}`);
}
