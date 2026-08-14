// Sweeps the shipyard button row's y in the live page and reports the
// region diff for each candidate, so the row's position is chosen by
// measurement instead of inference. Run like the harness:
//   PORT=8317 node visual_compare/sweep_button_y.mjs
import path from 'node:path';
import fs from 'node:fs';
import * as driver from './driver.mjs';
import { readPng, compareRegion } from './compare.mjs';
import { OUTPUT_DIR, REFERENCE_DIR, ensureOutputDir } from './config.mjs';

const REGION = {
    id: 'shipyard_button_row',
    ref: { x: 820, y: 660, width: 360, height: 45 },
    ours: { x: 820, y: 660, width: 360, height: 45 },
};

ensureOutputDir();
const refPng = readPng(path.join(REFERENCE_DIR, 'shipyard/earth_spaceport.png'));

const browser = await driver.launchBrowser();
const page = await driver.openGame(browser, { ship: 'nova:164', system: 'nova:130' });
const tmp = path.join(OUTPUT_DIR, 'sweep_tmp.png');
try {
    await driver.landAt(page, 'planet nova:128');
    await driver.dismissOfferPopup(page);
    await driver.clickContainer(page, 'Button:Shipyard');
    await driver.waitForContainer(page, 'Shipyard');
    await driver.pressKey(page, 'ArrowRight');
    await driver.sleep(1000);
    await driver.hideDebugOverlays(page);

    // AXIS=x sweeps the whole row's horizontal offset at the chosen y;
    // anything else sweeps y.
    const axis = process.env.AXIS ?? 'y';
    const fixedY = parseInt(process.env.FIXED_Y ?? '128', 10);
    const range = axis === 'x' ? [-4, 4] : [112, 136];
    const results = [];
    for (let y = range[0]; y <= range[1]; y++) {
        await page.evaluate(({ v, axis, fixedY }) => {
            let shipyard = null;
            (function walk(node) {
                if (!node) return;
                if (node.name === 'Shipyard' && node.worldVisible) shipyard = node;
                (node.children || []).forEach(walk);
            })(window.app.stage);
            for (const child of shipyard.children) {
                if (typeof child.name === 'string' && child.name.startsWith('Button:')) {
                    if (axis === 'x') {
                        if (child.baseX === undefined) child.baseX = child.position.x;
                        child.position.x = child.baseX + v;
                        child.position.y = fixedY;
                    } else {
                        child.position.y = v;
                    }
                }
            }
        }, { v: y, axis, fixedY });
        await driver.sleep(120);
        await driver.capture(page, tmp);
        const ours = readPng(tmp);
        const cmp = compareRegion(refPng, ours, REGION);
        results.push({ y, pct: cmp.diffPercent });
        console.log(`  y=${y}  ${cmp.diffPercent.toFixed(2)}%`);
    }
    results.sort((a, b) => a.pct - b.pct);
    console.log('\nBest three:');
    for (const r of results.slice(0, 3)) {
        console.log(`  y=${r.y}  ${r.pct.toFixed(2)}%`);
    }
} finally {
    fs.rmSync(tmp, { force: true });
    await browser.close();
}
