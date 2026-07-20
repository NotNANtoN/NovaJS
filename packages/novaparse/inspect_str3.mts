import { NovaParse } from './src/nova_parse.js';
const np = new NovaParse('../nova/Nova_Data', false);
const idSpace = await np.idSpace;
if (idSpace instanceof Error) { console.error('ERR', idSpace); process.exit(1); }
const strn = (idSpace as any)["STR#"];
const ids = Object.keys(strn).map(Number).sort((a,b)=>a-b);
console.log('total STR# count:', ids.length);
console.log('first 20:', ids.slice(0,20));
console.log('all ids:', ids.join(','));
process.exit(0);
