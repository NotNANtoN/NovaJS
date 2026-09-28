/**
 * Retail storyline audit: which control bits gate missions, who sets them,
 * and which resource fields carry control-bit strings.
 *
 * Needs nova/Nova_Data. Bundle and run like the test runner does:
 *   node -e "require('esbuild').build({entryPoints:['scripts/audit_missions.ts'],
 *     bundle:true,platform:'node',outfile:'/tmp/audit.cjs',external:['sharp'],
 *     plugins:[...packedPngPlugin]})" && NOVAJS_ROOT=$PWD node /tmp/audit.cjs
 *   --details               dump Require/ship-offered/auto-abort/crön tables
 *
 * Mission reachability is in nova/src/nova_plugin/storyline_reachability.ts.
 */
import * as path from 'path';
import { NovaParse } from '../novaparse/NovaParse';
import { NovaResourceType } from '../novaparse/src/resource_parsers/ResourceHolderBase';

const root = process.env.NOVAJS_ROOT ?? path.resolve(__dirname, '..');
const parser = new NovaParse(path.join(root, 'nova', 'Nova_Data'), false);

type Source = { kind: string; id: number; name: string; field: string; expr: string };

function cstr(d: DataView, start: number, len: number): string {
    let s = '';
    for (let i = start; i < Math.min(start + len, d.byteLength); i++) {
        const c = d.getUint8(i);
        if (c === 0) break;
        s += String.fromCharCode(c);
    }
    return s;
}

const setterSources: Source[] = [];
const testSources: Source[] = [];

function bitsSet(expr: string): number[] {
    // b123 but not !b123 / ^b123 counts as "sets"; ^ toggles could set too.
    return [...expr.matchAll(/(^|[\s(])\^?b(\d+)/gi)].map(m => Number(m[2]));
}
function bitsTested(expr: string): number[] {
    return [...expr.matchAll(/b(\d+)/gi)].map(m => Number(m[1]));
}
function starts(expr: string): number[] {
    return [...expr.matchAll(/(^|[\s(])s(\d+)/gi)].map(m => Number(m[2]));
}

(async () => {
    const idSpace = await parser.idSpace;
    if (idSpace instanceof Error) throw idSpace;
    const res = idSpace as any;

    // mïsn
    const missions = new Map<number, any>();
    for (const [id, m] of Object.entries<any>(res[NovaResourceType.mïsn])) {
        missions.set(Number(String(id).replace(/^.*:/, "")), m);
        const name = m.name;
        testSources.push({ kind: 'misn', id: Number(String(id).replace(/^.*:/, "")), name, field: 'availBits', expr: m.availBits });
        for (const f of ['onAccept', 'onRefuse', 'onSuccess', 'onFailure', 'onAbort', 'onShipDone']) {
            setterSources.push({ kind: 'misn', id: Number(String(id).replace(/^.*:/, "")), name, field: f, expr: m[f] });
        }
    }
    // crön
    for (const [id, c] of Object.entries<any>(res[NovaResourceType.crön])) {
        testSources.push({ kind: 'cron', id: Number(String(id).replace(/^.*:/, "")), name: c.name, field: 'enableOn', expr: c.enableOn });
        setterSources.push({ kind: 'cron', id: Number(String(id).replace(/^.*:/, "")), name: c.name, field: 'onStart', expr: c.onStart });
        setterSources.push({ kind: 'cron', id: Number(String(id).replace(/^.*:/, "")), name: c.name, field: 'onEnd', expr: c.onEnd });
    }
    // oütf
    for (const [id, o] of Object.entries<any>(res[NovaResourceType.oütf])) {
        testSources.push({ kind: 'outf', id: Number(String(id).replace(/^.*:/, "")), name: o.name, field: 'availability', expr: o.availabilityNCB });
        setterSources.push({ kind: 'outf', id: Number(String(id).replace(/^.*:/, "")), name: o.name, field: 'onPurchase', expr: o.onPurchase });
        setterSources.push({ kind: 'outf', id: Number(String(id).replace(/^.*:/, "")), name: o.name, field: 'onSell', expr: cstr(o.data, 560, 255) });
    }
    // shïp
    for (const [id, s] of Object.entries<any>(res[NovaResourceType.shïp])) {
        setterSources.push({ kind: 'ship', id: Number(String(id).replace(/^.*:/, "")), name: s.name, field: 'onPurchase', expr: s.onPurchase });
        setterSources.push({ kind: 'ship', id: Number(String(id).replace(/^.*:/, "")), name: s.name, field: 'onCapture', expr: s.onCapture });
        setterSources.push({ kind: 'ship', id: Number(String(id).replace(/^.*:/, "")), name: s.name, field: 'onRetire', expr: s.onRetire });
    }
    // chär: OnStart at offset 50 (256 bytes) per the Bible field order.
    for (const [id, c] of Object.entries<any>(res[NovaResourceType.chär])) {
        const d: DataView = c.data;
        setterSources.push({ kind: 'char', id: Number(String(id).replace(/^.*:/, "")), name: c.name, field: 'onStart', expr: cstr(d, 50, 256) });
    }
    // spöb: dump every NCB-looking C string (OnDominate/OnRelease/OnDestroy/OnRegen)
    for (const [id, p] of Object.entries<any>(res[NovaResourceType.spöb])) {
        const d: DataView = p.data;
        for (let off = 0; off < d.byteLength; off++) {
            const s = cstr(d, off, 255);
            if (s.length >= 2 && /^[\s!^()|&a-zA-Z0-9]+$/.test(s) && /[bB]\d/.test(s) && (off === 0 || d.getUint8(off - 1) === 0)) {
                setterSources.push({ kind: 'spob', id: Number(String(id).replace(/^.*:/, "")), name: p.name, field: `@${off}`, expr: s });
                off += s.length;
            }
        }
    }
    // përs: activateOn test string
    for (const [id, p] of Object.entries<any>(res[NovaResourceType.përs])) {
        const d: DataView = p.data;
        for (let off = 0; off < d.byteLength; off++) {
            const s = cstr(d, off, 255);
            if (s.length >= 2 && /[bB]\d/.test(s) && /^[\s!^()|&a-zA-Z0-9]+$/.test(s) && (off === 0 || d.getUint8(off - 1) === 0)) {
                testSources.push({ kind: 'pers', id: Number(String(id).replace(/^.*:/, "")), name: p.name, field: `@${off}`, expr: s });
                off += s.length;
            }
        }
    }

    const nonEmpty = (s: Source) => s.expr && s.expr.trim().length > 0;
    const setters = setterSources.filter(nonEmpty);
    const tests = testSources.filter(nonEmpty);

    const countBy = (list: Source[]) => {
        const m = new Map<string, number>();
        for (const s of list) m.set(`${s.kind}.${s.field.startsWith('@') ? 'raw' : s.field}`, (m.get(`${s.kind}.${s.field.startsWith('@') ? 'raw' : s.field}`) ?? 0) + 1);
        return Object.fromEntries([...m].sort());
    };
    console.log('Setter strings by source:', countBy(setters));
    console.log('Test strings by source:', countBy(tests));

    // Operators used in setter strings
    const ops = new Map<string, number>();
    for (const s of setters) {
        for (const tok of s.expr.split(/[\s()]+/).filter(Boolean)) {
            const k = tok.replace(/\d+/g, 'N');
            ops.set(k, (ops.get(k) ?? 0) + 1);
        }
    }
    console.log('Set operators:', Object.fromEntries([...ops].sort((a, b) => b[1] - a[1])));

    const testOps = new Map<string, number>();
    for (const s of tests) {
        for (const m of s.expr.matchAll(/([a-zA-Z])\d+/g)) {
            testOps.set(m[1].toLowerCase(), (testOps.get(m[1].toLowerCase()) ?? 0) + 1);
        }
    }
    console.log('Test operand letters:', Object.fromEntries(testOps));

    // Bits tested by missions and who can set them
    const setBy = new Map<number, Source[]>();
    for (const s of setters) for (const b of bitsSet(s.expr)) {
        const list = setBy.get(b) ?? []; list.push(s); setBy.set(b, list);
    }
    const handled = new Set(['misn', 'cron', 'outf', 'ship', 'char', 'spob.@54', 'spob.@310']);
    const isHandled = (s: Source) => handled.has(s.kind) || handled.has(`${s.kind}.${s.field}`);

    const missionTestedBits = new Set<number>();
    for (const s of tests.filter(t => t.kind === 'misn')) for (const b of bitsTested(s.expr)) missionTestedBits.add(b);
    const orphan: number[] = [];
    const onlyUnhandled: Array<[number, Source[]]> = [];
    for (const b of missionTestedBits) {
        const src = setBy.get(b) ?? [];
        if (src.length === 0) orphan.push(b);
        else if (!src.some(isHandled)) onlyUnhandled.push([b, src]);
    }
    console.log(`\nBits tested by mïsn AvailBits: ${missionTestedBits.size}`);
    console.log(`  never set by any resource: ${orphan.length}`, orphan.sort((a, b) => a - b).join(' '));
    console.log(`  only set by sources the engine ignores: ${onlyUnhandled.length}`);
    for (const [b, src] of onlyUnhandled) {
        console.log(`   b${b}: ${src.map(s => `${s.kind}#${s.id} ${s.name} ${s.field}="${s.expr}"`).join(' ; ')}`);
    }

    // Missions by availLoc; and those reachable only via S from set strings
    const startedBy = new Map<number, Source[]>();
    for (const s of setters) for (const id of starts(s.expr)) {
        const list = startedBy.get(id) ?? []; list.push(s); startedBy.set(id, list);
    }
    const byLoc = new Map<number, number>();
    for (const m of missions.values()) byLoc.set(m.availLoc, (byLoc.get(m.availLoc) ?? 0) + 1);
    console.log('\nMissions by AvailLoc:', Object.fromEntries(byLoc));
    const shipLoc = [...missions.values()].filter(m => m.availLoc === 2);
    console.log(`AvailLoc 2 (ship-offered) missions: ${shipLoc.length}`);

    // Unique non-bit set operators with source kinds
    const special = setters.filter(s => /(^|[\s(])[acdeghklmnpqstuxyfACDEGHKLMNPQSTUXYF]\d/.test(s.expr));
    const specialKinds = new Map<string, number>();
    for (const s of special) for (const m of s.expr.matchAll(/(^|[\s(])([a-zA-Z])(\d+)/g)) {
        if (/[bBrR]/.test(m[2])) continue;
        const k = `${m[2].toUpperCase()} via ${s.kind}.${s.field.startsWith('@') ? 'raw' : s.field}`;
        specialKinds.set(k, (specialKinds.get(k) ?? 0) + 1);
    }
    console.log('Non-bit operators by source:', Object.fromEntries([...specialKinds].sort()));

    // Missions that require outfits / contribute bits
    const withRequire = [...missions.values()].filter(m => m.require.some((x: number) => x !== 0));
    console.log(`Missions with Require bits: ${withRequire.length}`);

    // Mission flags usage
    const flagCounts = new Map<string, number>();
    for (const m of missions.values()) {
        for (let bit = 0; bit < 16; bit++) {
            if (m.flags & (1 << bit)) flagCounts.set(`flags 0x${(1 << bit).toString(16).padStart(4, '0')}`, (flagCounts.get(`flags 0x${(1 << bit).toString(16).padStart(4, '0')}`) ?? 0) + 1);
            if (m.flags2 & (1 << bit)) flagCounts.set(`flags2 0x${(1 << bit).toString(16).padStart(4, '0')}`, (flagCounts.get(`flags2 0x${(1 << bit).toString(16).padStart(4, '0')}`) ?? 0) + 1);
        }
    }
    console.log('Mission flag usage:', Object.fromEntries([...flagCounts].sort()));

    // Pay values that are special
    const specialPay = [...missions.values()].filter(m => m.payVal < -1);
    console.log(`Missions with special PayVal (<-1): ${specialPay.length}`, [...new Set(specialPay.map(m => Math.floor(m.payVal / 10000) * 10000))]);

    const chars = setters.filter(s => s.kind === 'char');
    console.log('\nchär resources:', Object.entries<any>(res[NovaResourceType.chär]).map(([id, c]) => {
        const d: DataView = c.data;
        return { id, name: c.name, cash: d.getInt32(0), ship: d.getInt16(4), systems: [6, 8, 10, 12].map(o => d.getInt16(o)), onStart: cstr(d, 50, 256), flags: d.getInt16(306) };
    }));
    void chars;
    if (process.argv.includes('--details')) await details(res);
    await blockers(res);
    await reachability(res);
})();

export async function details(res: any) {
    const misn = Object.entries<any>(res[NovaResourceType.mïsn]).map(([id, m]) => ({ ...m, nid: Number(String(id).replace(/^.*:/, '')), name: m.name, availBits: m.availBits, onAbort: m.onAbort, onSuccess: m.onSuccess, onAccept: m.onAccept, require: m.require, availLoc: m.availLoc, flags: m.flags }));
    const tested = (b: number) => misn.filter(m => new RegExp(`b${b}(?!\\d)`, 'i').test(m.availBits)).map(m => `${m.nid} ${m.name}`);
    console.log('\n== Missions with Require ==');
    for (const m of misn.filter(m => m.require.some((x: number) => x))) console.log(m.nid, m.name, JSON.stringify(m.require), 'avail:', m.availBits);
    console.log('\n== AvailLoc 2 (ship) missions ==');
    for (const m of misn.filter(m => m.availLoc === 2)) console.log(m.nid, m.name, 'avail:', m.availBits, '| onAccept:', m.onAccept, '| onSuccess:', m.onSuccess);
    console.log('\n== Auto-abort (flags 0x0001) missions ==');
    for (const m of misn.filter(m => m.flags & 1)) console.log(m.nid, m.name, '| onAccept:', m.onAccept, '| onAbort:', m.onAbort, '| onSuccess:', m.onSuccess, '| shipCount', m.shipCount, 'goal', m.shipGoal);
    console.log('\n== Missions gated on spöb OnDestroy bits / never-set bits ==');
    for (const b of [6200, 6201, 6202, 6203, 6204, 6205, 6206, 9, 503, 3005, 6100, 6101, 6102, 6103, 6104, 6105, 6106]) console.log(`b${b}:`, tested(b).join(', '));
    console.log('\n== crön ==');
    for (const [id, c] of Object.entries<any>(res[NovaResourceType.crön])) {
        if (!c.onStart && !c.onEnd) continue;
        console.log(id, c.name, `dur=${c.duration} pre=${c.preHoldoff} post=${c.postHoldoff} rnd=${c.random} flags=${c.flags}`, `enable="${c.enableOn}" start="${c.onStart}" end="${c.onEnd}"`, `date=${c.firstDay}/${c.firstMonth}/${c.firstYear}-${c.lastDay}/${c.lastMonth}/${c.lastYear}`);
    }
    console.log('\n== Outfit/ship onPurchase with non-bit ops ==');
    for (const [id, o] of Object.entries<any>(res[NovaResourceType.oütf])) if (/[A-Za-z]\d/.test(o.onPurchase.replace(/!?\^?b\d+/gi, ''))) console.log('outf', id, o.name, o.onPurchase);
}

export async function blockers(res: any) {
    const nid = (id: string) => Number(String(id).replace(/^.*:/, ''));
    const misn = Object.entries<any>(res[NovaResourceType.mïsn]).map(([id, m]) => ({ m, id: nid(id) }));
    const crons = Object.entries<any>(res[NovaResourceType.crön]).map(([id, c]) => ({ c, id: nid(id) }));
    const setIn = (expr: string, b: number) => new RegExp(`(^|[\\s(])\\^?b${b}(?!\\d)`, 'i').test(expr ?? '');
    const testedPositively = (expr: string, b: number) => new RegExp(`(^|[^!])b${b}(?!\\d)`, 'i').test(expr ?? '');
    const allBits = new Set<number>();
    for (const { m } of misn) for (const x of (m.availBits ?? '').matchAll(/b(\d+)/gi)) allBits.add(Number(x[1]));
    console.log('\n== Bits positively required by mïsn but only set by a crön onEnd with duration>0, preHoldoff, or auto-abort/ship-offered mïsn ==');
    for (const b of [...allBits].sort((a, z) => a - z)) {
        const needers = misn.filter(({ m }) => testedPositively(m.availBits, b));
        if (!needers.length) continue;
        const bySetters: string[] = [];
        let healthy = false;
        for (const { m, id } of misn) {
            for (const f of ['onAccept', 'onRefuse', 'onSuccess', 'onFailure', 'onAbort', 'onShipDone']) {
                if (!setIn(m[f], b)) continue;
                const autoAbort = (m.flags & 1) !== 0;
                const broken = m.availLoc === 2 || (autoAbort && f === 'onAbort') || (m.require ?? []).some((x: number) => x);
                bySetters.push(`misn${id}.${f}${broken ? '(BROKEN)' : ''}`);
                if (!broken) healthy = true;
            }
        }
        for (const { c, id } of crons) {
            if (setIn(c.onStart, b)) { const broken = c.preHoldoff > 0; bySetters.push(`cron${id}.onStart${broken ? `(pre=${c.preHoldoff} IGNORED)` : ''}`); healthy = true; }
            if (setIn(c.onEnd, b)) { const broken = c.duration > 0; bySetters.push(`cron${id}.onEnd${broken ? `(dur=${c.duration} NEVER RUNS)` : `(pre=${c.preHoldoff})`}`); if (!broken) healthy = true; }
        }
        for (const [id, o] of Object.entries<any>(res[NovaResourceType.oütf])) if (setIn(o.onPurchase, b)) { bySetters.push(`outf${nid(id)}.onPurchase`); healthy = true; }
        for (const [id, s] of Object.entries<any>(res[NovaResourceType.shïp])) {
            if (setIn(s.onPurchase, b)) { bySetters.push(`ship${nid(id)}.onPurchase`); healthy = true; }
            if (setIn(s.onCapture, b)) bySetters.push(`ship${nid(id)}.onCapture(IGNORED)`);
        }
        if (!healthy && bySetters.length) console.log(`b${b} needed by [${needers.map(n => `${n.id} ${n.m.name}`).slice(0, 4).join(' | ')}${needers.length > 4 ? ` +${needers.length - 4}` : ''}] set by: ${bySetters.join(', ')}`);
        else if (bySetters.some(s => /NEVER|BROKEN|IGNORED/.test(s)) && !healthy) console.log('?', b);
    }
    console.log('\n== Ships/outfits with Contribute bits ==');
    for (const [id, s] of Object.entries<any>(res[NovaResourceType.shïp])) if (s.contribute?.some((x: number) => x)) console.log('ship', nid(id), s.name, s.contribute);
    for (const [id, o] of Object.entries<any>(res[NovaResourceType.oütf])) if (o.contribute?.some((x: number) => x)) console.log('outf', nid(id), o.name, o.contribute);
    console.log('\n== mïsn with non-empty onRefuse containing S or G (spaceport-dialog refuse path) ==');
    for (const { m, id } of misn) if (/(^|[\s(])[SG]\d/.test(m.onRefuse) ) console.log(id, `loc=${m.availLoc}`, m.name, '| onRefuse:', m.onRefuse);
    console.log('\n== outf onPurchase with non-bit ops ==');
    for (const [id, o] of Object.entries<any>(res[NovaResourceType.oütf])) if (/(^|[\s(])[A-QS-Za-qs-z]\d/.test(o.onPurchase.replace(/[!^]?b\d+/gi, ''))) console.log(nid(id), o.name, '|', o.onPurchase);
    console.log('\n== Q (leave stellar) users ==');
    console.log(misn.filter(({ m }) => ['onAccept', 'onSuccess', 'onShipDone', 'onFailure'].some(f => /(^|[\s(])Q\d/.test(m[f]))).length, 'missions');
    console.log('\n== Special PayVal missions ==');
    for (const { m, id } of misn) if (m.payVal < -1) console.log(id, m.name, m.payVal);
}

/**
 * Reachability now lives in nova/src/nova_plugin/storyline_reachability.ts
 * and is enforced by storyline_reachability_retail_test.ts.
 */
export async function reachability(_res: unknown) {
    console.log('\nReachability: run `bun scripts/test.mjs storyline_reachability`.');
}
