// Generates a self-contained HTML closeness dashboard from run results.
// All images referenced are written next to report.html in output/.

function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Color a diff % from green (close) to red (far).
function pctColor(pct) {
    const p = Math.min(100, pct);
    if (p < 2) return '#1f9d55';
    if (p < 8) return '#7bb31a';
    if (p < 20) return '#c9a227';
    if (p < 40) return '#d97706';
    return '#c53030';
}

/**
 * A region is a "localized hotspot" when its overall diff is low but the
 * error is piled into a few grid cells (e.g. one misplaced widget), rather
 * than sprinkled evenly (starfield noise / dynamic text). These deserve
 * attention despite the reassuring overall number.
 */
export function isLocalizedHotspot(rg) {
    return (rg.diffPercent ?? 0) < 10
        && (rg.concentration ?? 0) >= 4
        && (rg.maxCellPercent ?? 0) >= 15;
}

function concentrationLine(rg) {
    if (rg.maxCellPercent === undefined) {
        return ''; // Old result objects without the metric.
    }
    const flag = isLocalizedHotspot(rg)
        ? `<div class="hotflag">&#9888; localized hotspot &mdash; low overall diff
           but the error is concentrated (likely a misplaced element)</div>`
        : '';
    return `
        <div class="rmeta conc">
          max cell <b style="color:${pctColor(rg.maxCellPercent)}">${rg.maxCellPercent.toFixed(1)}%</b>
          · mean cell ${rg.meanCellPercent.toFixed(2)}%
          · concentration <b>${rg.concentration.toFixed(1)}×</b>
          ${rg.grid ? `(${rg.grid.cols}×${rg.grid.rows} grid)` : ''}
        </div>${flag}`;
}

function regionRow(rg) {
    const { rect } = rg;
    const heat = rg.files.heat
        ? `<td><figure><img src="${esc(rg.files.heat)}" loading="lazy"><figcaption>hotspots (worst cell outlined)</figcaption></figure></td>`
        : '<td></td>';
    return `
    <tr${isLocalizedHotspot(rg) ? ' class="hotspot"' : ''}>
      <td>
        <div class="rid">${esc(rg.label)}</div>
        <div class="rmeta">${esc(rg.id)} · ${rect.width}×${rect.height} @ (${rect.x},${rect.y})</div>
        <div class="pct" style="color:${pctColor(rg.diffPercent)}">
          ${rg.diffPercent.toFixed(2)}%
          <span class="rmeta">(${rg.diffPixels.toLocaleString()} / ${rg.totalPixels.toLocaleString()} px)</span>
        </div>
        ${concentrationLine(rg)}
      </td>
      <td><figure><img src="${esc(rg.files.ref)}" loading="lazy"><figcaption>reference</figcaption></figure></td>
      <td><figure><img src="${esc(rg.files.ours)}" loading="lazy"><figcaption>ours</figcaption></figure></td>
      <td><figure><img src="${esc(rg.files.diff)}" loading="lazy"><figcaption>diff</figcaption></figure></td>
      ${heat}
    </tr>`;
}

function referenceBlock(ref) {
    return `
    <div class="refblock">
      <h3>vs <code>${esc(ref.file)}</code></h3>
      <table class="regions">
        <thead><tr><th>region</th><th>reference crop</th><th>our crop</th><th>pixelmatch diff</th><th>hotspot heatmap</th></tr></thead>
        <tbody>${ref.regions.map(regionRow).join('')}</tbody>
      </table>
    </div>`;
}

function scenarioBlock(s) {
    const firstRefFull = s.references[0]?.fullFile;
    const errors = s.pageErrors && s.pageErrors.length
        ? `<details class="errs"><summary>${s.pageErrors.length} console error(s)</summary><pre>${esc(s.pageErrors.join('\n'))}</pre></details>`
        : '';
    return `
  <section class="scenario">
    <h2>${esc(s.title)}</h2>
    <p class="desc">${esc(s.description)}</p>
    ${errors}
    <div class="fullpair">
      ${firstRefFull ? `<figure><img src="${esc(firstRefFull)}" loading="lazy"><figcaption>reference (full frame)</figcaption></figure>` : ''}
      <figure><img src="${esc(s.oursFullFile)}" loading="lazy"><figcaption>ours (full frame)</figcaption></figure>
    </div>
    ${s.references.map(referenceBlock).join('')}
  </section>`;
}

export function renderReport(results, { referenceDir } = {}) {
    // Summary table across everything, worst first.
    const flat = [];
    for (const s of results)
        for (const r of s.references)
            for (const rg of r.regions)
                flat.push({
                    scenario: s.id, ref: r.name, region: rg.label,
                    pct: rg.diffPercent,
                    maxCell: rg.maxCellPercent,
                    conc: rg.concentration,
                    hot: isLocalizedHotspot(rg),
                });
    flat.sort((a, b) => b.pct - a.pct);

    const summaryRows = flat.map(f => `
      <tr${f.hot ? ' class="hotspot"' : ''}>
        <td>${esc(f.scenario)}</td><td>${esc(f.region)}${f.hot ? ' <span class="hotmark" title="localized hotspot">&#9888;</span>' : ''}</td><td>${esc(f.ref)}</td>
        <td style="color:${pctColor(f.pct)};font-weight:600;text-align:right">${f.pct.toFixed(2)}%</td>
        <td style="text-align:right">${f.maxCell === undefined ? '' : `<span style="color:${pctColor(f.maxCell)}">${f.maxCell.toFixed(1)}%</span>`}</td>
        <td style="text-align:right">${f.conc === undefined ? '' : `${f.conc.toFixed(1)}×`}</td>
      </tr>`).join('');

    const hotspots = flat.filter(f => f.hot);
    const hotspotBlock = hotspots.length ? `
  <h2>&#9888; Localized hotspots</h2>
  <p class="rmeta">Regions whose OVERALL diff is low but whose error is
    concentrated in a few grid cells — the signature of a misplaced widget
    rather than diffuse noise. (diff &lt; 10%, concentration &ge; 4×, worst
    cell &ge; 15%.)</p>
  <table class="summary">
    <thead><tr><th>scenario</th><th>region</th><th>reference</th><th>diff %</th><th>max cell</th><th>conc.</th></tr></thead>
    <tbody>${hotspots.map(f => `
      <tr class="hotspot">
        <td>${esc(f.scenario)}</td><td>${esc(f.region)}</td><td>${esc(f.ref)}</td>
        <td style="text-align:right">${f.pct.toFixed(2)}%</td>
        <td style="text-align:right;color:${pctColor(f.maxCell)}">${f.maxCell.toFixed(1)}%</td>
        <td style="text-align:right">${f.conc.toFixed(1)}×</td>
      </tr>`).join('')}</tbody>
  </table>` : '';

    return `<!doctype html>
<html><head><meta charset="utf-8"><title>NovaJS visual comparison</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 24px 32px; background:#0d0f12; color:#e6e6e6; }
  h1 { margin: 0 0 4px; }
  .sub { color:#9aa0a6; margin: 0 0 20px; }
  code { background:#1b1f24; padding:1px 5px; border-radius:4px; }
  section.scenario { border-top:1px solid #2a2f36; padding-top:20px; margin-top:28px; }
  .desc { color:#b6bcc4; max-width:70ch; }
  .fullpair { display:flex; gap:16px; flex-wrap:wrap; margin:14px 0; }
  .fullpair img { width:640px; max-width:46vw; border:1px solid #2a2f36; }
  figure { margin:0; }
  figcaption { color:#9aa0a6; font-size:12px; text-align:center; margin-top:4px; }
  table.regions { border-collapse:collapse; width:100%; margin:10px 0 6px; }
  table.regions th { text-align:left; color:#9aa0a6; font-weight:500; border-bottom:1px solid #2a2f36; padding:6px 8px; }
  table.regions td { border-bottom:1px solid #191d22; padding:8px; vertical-align:top; }
  table.regions img { display:block; max-width:520px; image-rendering:pixelated; background:#000; border:1px solid #2a2f36; }
  .rid { font-weight:600; }
  .rmeta { color:#7d848c; font-size:12px; }
  .pct { font-size:18px; font-weight:700; margin-top:6px; }
  .refblock h3 { margin:16px 0 4px; color:#c8ccd2; font-weight:600; }
  table.summary { border-collapse:collapse; margin:8px 0 4px; min-width:520px; }
  table.summary th, table.summary td { padding:5px 12px; border-bottom:1px solid #23282e; }
  table.summary th { text-align:left; color:#9aa0a6; }
  details.errs { margin:8px 0; }
  details.errs pre { background:#1b1f24; padding:8px; overflow:auto; font-size:12px; }
  .legend span { display:inline-block; margin-right:14px; }
  .dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:4px; vertical-align:middle; }
  .conc { margin-top:4px; }
  tr.hotspot { background:rgba(217,119,6,0.10); }
  tr.hotspot td { border-left:none; }
  .hotflag { color:#f0a840; font-size:12px; margin-top:4px; max-width:32ch; }
  .hotmark { color:#f0a840; }
</style></head>
<body>
  <h1>NovaJS visual comparison</h1>
  <p class="sub">Pixel diff of our render vs original-game reference screenshots ·
    generated ${new Date().toISOString()}<br>
    reference dir: <code>${esc(referenceDir || '')}</code></p>

  <div class="legend">
    <span><i class="dot" style="background:#1f9d55"></i>&lt;2%</span>
    <span><i class="dot" style="background:#7bb31a"></i>&lt;8%</span>
    <span><i class="dot" style="background:#c9a227"></i>&lt;20%</span>
    <span><i class="dot" style="background:#d97706"></i>&lt;40%</span>
    <span><i class="dot" style="background:#c53030"></i>≥40%</span>
  </div>

  ${hotspotBlock}

  <h2>Summary — biggest mismatches first</h2>
  <table class="summary">
    <thead><tr><th>scenario</th><th>region</th><th>reference</th><th>diff %</th><th>max cell</th><th>conc.</th></tr></thead>
    <tbody>${summaryRows}</tbody>
  </table>
  <p class="rmeta">Diff % = fraction of pixels in the region that pixelmatch flags
    as different (threshold 0.1). High numbers on dynamic content (map graph,
    live text, blips) are expected; watch the chrome-only regions.<br>
    Max cell = worst grid-cell diff density; conc. = worst cell ÷ mean cell.
    Low diff % with high concentration = a small element in the wrong place.</p>

  ${results.map(scenarioBlock).join('')}
</body></html>`;
}
