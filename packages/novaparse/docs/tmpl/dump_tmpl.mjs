// Dump TMPL resources from ResForge's Templates.rsrc
// TMPL format: sequence of [pascal string label][4-char type code]
import { readResourceFork } from '/Users/matthew/Projects/novajs-parsing/packages/resource_fork/dist/index.js';

const path = '/Users/matthew/Projects/ResForge/Plugins/Sources/NovaTools/Templates.rsrc';
const resources = await readResourceFork(path, false);

const tmpls = resources['TMPL'] ?? {};
const out = {};
for (const [id, res] of Object.entries(tmpls)) {
    const d = res.data;
    const fields = [];
    let pos = 0;
    while (pos < d.byteLength) {
        const labelLen = d.getUint8(pos);
        pos += 1;
        let label = '';
        for (let i = 0; i < labelLen; i++) {
            label += String.fromCharCode(d.getUint8(pos + i));
        }
        pos += labelLen;
        let type = '';
        for (let i = 0; i < 4; i++) {
            type += String.fromCharCode(d.getUint8(pos + i));
        }
        pos += 4;
        fields.push({ label, type });
    }
    out[res.name] = { id: res.id, fields };
}

console.log(JSON.stringify(out, null, 1));
