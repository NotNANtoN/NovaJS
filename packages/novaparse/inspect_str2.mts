import { NovaParse } from './src/nova_parse.js';
const np = new NovaParse('../nova/Nova_Data', false);
const idSpace = await np.idSpace;
if (idSpace instanceof Error) { console.error('ERR', idSpace); process.exit(1); }
const strn = (idSpace as any)["STR#"];
const ids = Object.keys(strn).map(Number).filter(n => n >= 3900 && n <= 4100).sort((a,b)=>a-b);
console.log('STR# ids in [3900,4100]:', ids);
for (const id of ids) {
  console.log(`STR# ${id}:`, JSON.stringify(strn[id].strings));
}
process.exit(0);
