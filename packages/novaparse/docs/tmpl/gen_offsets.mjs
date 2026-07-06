// Generate a per-TMPL field/offset reference from tmpl_dump.json.
// Semantics per ResForge TemplateParser.swift + TemplateEditor README.
import fs from 'fs';
const t = JSON.parse(fs.readFileSync(new URL('./tmpl_dump.json', import.meta.url)));

const FIXED = {
    DBYT: 1, UBYT: 1, HBYT: 1, KBYT: 1, KUBT: 1, KHBT: 1, CHAR: 1, BORV: 1, BFLG: 1, FBYT: 1, BOOL: 2,
    DWRD: 2, UWRD: 2, HWRD: 2, KWRD: 2, KUWD: 2, KHWD: 2, RSID: 2, WORV: 2, WFLG: 2, FWRD: 2, WCOL: 2,
    DLNG: 4, ULNG: 4, HLNG: 4, KLNG: 4, KULG: 4, KHLG: 4, LRID: 4, LORV: 4, LFLG: 4, FLNG: 4, LCOL: 4,
    DATE: 4, FIXD: 4, REAL: 4, 'PNT ': 4, TNAM: 4,
    DQWD: 8, UQWD: 8, HQWD: 8, QORV: 8, DOUB: 8, RECT: 8,
    COLR: 6,
};
// 0-byte meta/cosmetic elements
const META = new Set(['CASE', 'CASR', 'DVDR', 'RREF', 'PACK', 'KEYB', 'KEYE', 'KRID', 'SKPE',
    'FCNT', 'LSTB', 'LSTC', 'LSTS', 'LSTZ', 'LSTE', 'TMPL', 'RNAM', 'LTLE', 'BIGE', 'BNDN', 'LNDN']);
const BITS = { B: 8, W: 16, L: 32, Q: 64 };

let out = '';
for (const [name, tm] of Object.entries(t)) {
    out += `=== TMPL "${name}" ===\n`;
    let off = 0, repeat = 1, bitContainer = 0, bitsUsed = 0, ok = true;
    const flushWarn = () => {
        if (bitsUsed > 0) { out += `        !! ${bitsUsed} stray bits not aligned to container\n`; ok = false; }
        bitContainer = 0; bitsUsed = 0;
    };
    for (const f of tm.fields) {
        const label = f.label.replace(/[\r\n]+/g, ' | ');
        const type = f.type;
        if (META.has(type)) {
            // Rnnn applies to the single immediately following element, even a
            // zero-byte one like PACK — the repeat must NOT fall through to the
            // next data field (see ResForge TemplateParser: "R" wraps one element).
            if (repeat !== 1 && type !== 'CASE' && type !== 'CASR' && type !== 'DVDR') {
                out += `        (repeat x${repeat} consumed by 0-byte ${type})\n`;
                repeat = 1;
            }
            if (type === 'FCNT' || type === 'LSTC' || type === 'LSTB' || type === 'LSTS' || type === 'LSTZ') {
                out += `        !! ${type} list — offsets below are WRONG unless expanded by hand\n`;
                ok = false;
            }
            out += `        ${type}  ${label}\n`;
            continue;
        }
        let m;
        if ((m = type.match(/^R([0-9A-F]{3})$/))) {
            repeat = parseInt(m[1], 16);
            out += `        REPEAT next field x${repeat}  ${label}\n`;
            continue;
        }
        // Bit fields: accumulate bits inside a container that advances offset when full.
        if ((m = type.match(/^([BWLQ])(BIT|[BF][0-9]{2})$/))) {
            const containerBits = BITS[m[1]];
            // Bit-field counts are DECIMAL (ResForge ElementBBIT: Int(type.suffix(2))),
            // unlike Xnnn string/fill lengths which are hex.
            const n = m[2] === 'BIT' ? 1 : parseInt(m[2].slice(1), 10);
            for (let r = 0; r < repeat; r++) {
                if (bitsUsed === 0) bitContainer = containerBits;
                if (bitContainer !== containerBits) { out += `        !! bit container mismatch at ${type}\n`; ok = false; }
                bitsUsed += n;
            }
            out += `${String(off).padStart(6)}+ ${type}${repeat > 1 ? ' x' + repeat : ''}  ${label}  (${n * repeat} bits of ${m[1]}-container)\n`;
            if (bitsUsed >= bitContainer) {
                if (bitsUsed > bitContainer) { out += `        !! bit overflow\n`; ok = false; }
                off += bitContainer / 8;
                bitsUsed = 0;
            }
            repeat = 1;
            continue;
        }
        flushWarn();
        let size;
        if (type in FIXED) size = FIXED[type];
        else if ((m = type.match(/^[CPHFTUn]([0-9A-F]{3})$/))) size = parseInt(m[1], 16);
        else { out += `${String(off).padStart(6)}? ${type}  ${label}  (UNKNOWN/VARIABLE — offsets below unreliable)\n`; ok = false; repeat = 1; continue; }
        out += `${String(off).padStart(6)}  ${type}${repeat > 1 ? ' x' + repeat : ''}  ${label}  (${size * repeat}B)\n`;
        off += size * repeat;
        repeat = 1;
    }
    flushWarn();
    out += `   total size: ${off}${ok ? '' : '  (WARNINGS above)'}\n\n`;
}
fs.writeFileSync(new URL('./tmpl_offsets.txt', import.meta.url), out);
console.log('written');
