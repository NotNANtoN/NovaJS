import { NovaParse } from './src/nova_parse.js';
const np = new NovaParse('../nova/Nova_Data', false);
const idSpace = await np.idSpace;
if (idSpace instanceof Error) { console.error('ERR', idSpace); process.exit(1); }
const strn = (idSpace as any)["STR#"];
const keys = Object.keys(strn);
console.log('sample keys:', keys.slice(0,10));
// find keys ending in 4000-4004
for (const k of keys) {
  const m = k.match(/(\d+)$/);
  if (m) { const n = +m[1]; if (n>=4000 && n<=4004) console.log(k, '=>', JSON.stringify(strn[k].strings)); }
}
process.exit(0);
