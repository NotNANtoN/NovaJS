import { NovaParse } from './src/nova_parse.js';
const np = new NovaParse('../nova/Nova_Data', false);
const idSpace = await np.idSpace;
if (idSpace instanceof Error) { console.error('ERR', idSpace); process.exit(1); }
const strn = (idSpace as any)["STR#"];
for (const id of [4000, 4001, 4002, 4003, 4004]) {
  const list = strn[id];
  console.log(`STR# ${id}:`, list ? JSON.stringify(list.strings) : 'MISSING');
}
process.exit(0);
