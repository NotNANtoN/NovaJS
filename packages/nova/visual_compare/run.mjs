// Visual-comparison runner.
//
// Captures OUR game with puppeteer and diffs named UI regions against the
// original-game reference screenshots, then writes a self-contained HTML
// report. This is a closeness DASHBOARD, not a CI gate — it is intentionally
// not wired into `turbo test`.
//
// Usage (from packages/nova):  npm run visual-compare
//   PORT=8210            port to drive (reused if a server already answers,
//                        otherwise the runner spawns its own dist/server.js)
//   NOVA_REF_DIR=...     override the reference-screenshot directory
//   CHROME_PATH=...      override the system Chrome path
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import * as driver from './driver.mjs';
import { readPng, writePng, compareRegion } from './compare.mjs';
import { renderReport } from './report.mjs';
import {
    OUTPUT_DIR, REFERENCE_DIR, NOVA_ROOT, BASE_URL, PORT,
    ensureOutputDir,
} from './config.mjs';

function httpOk(url) {
    return new Promise((resolve) => {
        const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode < 500); });
        req.on('error', () => resolve(false));
        req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    });
}

async function ensureServer() {
    if (await httpOk(`${BASE_URL}/`)) {
        console.log(`Reusing server already listening on ${BASE_URL}`);
        return null; // not ours to kill
    }
    console.log(`Starting dist/server.js on port ${PORT} ...`);
    const child = spawn('node', ['dist/server.js'], {
        cwd: NOVA_ROOT,
        env: { ...process.env, PORT: String(PORT) },
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    const start = Date.now();
    while (Date.now() - start < 30000) {
        if (await httpOk(`${BASE_URL}/`)) { console.log('Server is up.'); return child; }
        await driver.sleep(500);
    }
    child.kill('SIGKILL');
    throw new Error(`Server did not come up on ${BASE_URL} within 30s`);
}

async function run() {
    ensureOutputDir();
    const { scenarios } = await import('./scenarios.mjs');

    if (!fs.existsSync(REFERENCE_DIR)) {
        throw new Error(`Reference dir not found: ${REFERENCE_DIR}\n`
            + `Set NOVA_REF_DIR to the original-game screenshot directory.`);
    }

    const serverChild = await ensureServer();
    const browser = await driver.launchBrowser();
    const results = []; // one entry per scenario

    try {
        for (const scenario of scenarios) {
            console.log(`\n=== Scenario: ${scenario.id} ===`);
            const page = await driver.openGame(browser, scenario.params,
                { entry: scenario.entry ?? 'game' });
            try {
                if (scenario.setup) await scenario.setup(page, driver);
                if (scenario.hideDebug) await driver.hideDebugOverlays(page);
                await driver.sleep(500);

                const oursFull = path.join(OUTPUT_DIR, `${scenario.id}__ours_full.png`);
                await driver.capture(page, oursFull);
                const oursPng = readPng(oursFull);

                const refEntries = [];
                for (const ref of scenario.references) {
                    const refAbs = path.join(REFERENCE_DIR, ref.file);
                    if (!fs.existsSync(refAbs)) {
                        console.warn(`  missing reference ${ref.file}, skipping`);
                        continue;
                    }
                    // Copy the reference full frame next to the report so it is
                    // self-contained.
                    const refFullOut = `ref__${ref.name}__full.png`;
                    fs.copyFileSync(refAbs, path.join(OUTPUT_DIR, refFullOut));
                    const refPng = readPng(refAbs);

                    const regionResults = [];
                    for (const rgn of scenario.regions) {
                        const cmp = compareRegion(refPng, oursPng, rgn);
                        const base = `${scenario.id}__${ref.name}__${rgn.id}`;
                        const files = {
                            ref: `${base}__ref.png`,
                            ours: `${base}__ours.png`,
                            diff: `${base}__diff.png`,
                        };
                        writePng(cmp.refCrop, path.join(OUTPUT_DIR, files.ref));
                        writePng(cmp.oursCrop, path.join(OUTPUT_DIR, files.ours));
                        writePng(cmp.diffPng, path.join(OUTPUT_DIR, files.diff));
                        regionResults.push({
                            id: rgn.id, label: rgn.label,
                            rect: rgn.ref,
                            diffPixels: cmp.diffPixels,
                            totalPixels: cmp.totalPixels,
                            diffPercent: cmp.diffPercent,
                            files,
                        });
                        console.log(`  [${ref.name}] ${rgn.id}: `
                            + `${cmp.diffPercent.toFixed(1)}% (${cmp.diffPixels}/${cmp.totalPixels})`);
                    }
                    refEntries.push({ name: ref.name, file: ref.file,
                        fullFile: refFullOut, regions: regionResults });
                }

                results.push({
                    id: scenario.id, title: scenario.title,
                    description: scenario.description,
                    oursFullFile: path.basename(oursFull),
                    references: refEntries,
                    pageErrors: (page._vcErrors || []).slice(0, 10),
                });
            } finally {
                await page.close();
            }
        }
    } finally {
        await browser.close();
        if (serverChild) { serverChild.kill('SIGKILL'); console.log('Stopped spawned server.'); }
    }

    const reportPath = path.join(OUTPUT_DIR, 'report.html');
    fs.writeFileSync(reportPath, renderReport(results, { referenceDir: REFERENCE_DIR }));
    console.log(`\nReport written: ${reportPath}`);

    // Console summary: worst regions first.
    const flat = [];
    for (const s of results)
        for (const r of s.references)
            for (const rg of r.regions)
                flat.push({ scenario: s.id, ref: r.name, region: rg.id, pct: rg.diffPercent });
    flat.sort((a, b) => b.pct - a.pct);
    console.log('\nBiggest region mismatches:');
    for (const f of flat.slice(0, 12))
        console.log(`  ${f.pct.toFixed(1).padStart(6)}%  ${f.scenario} / ${f.region} (vs ${f.ref})`);
}

run().catch((e) => { console.error(e); process.exit(1); });
