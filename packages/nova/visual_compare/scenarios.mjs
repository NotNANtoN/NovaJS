// Scenario + region definitions for the visual-comparison harness.
//
// ============================================================================
// HOW TO ADD A SCENARIO
// ============================================================================
// Append an object to the `scenarios` array below:
//
//   {
//     id: 'unique_slug',
//     title: 'Human title for the report',
//     description: 'One line on what state this captures.',
//     params: { ship: 'nova:164', system: 'nova:130' },   // ?query params
//     hideDebug: true,                                     // hide FPS/AddEnemy
//     setup: async (page, driver) => { ... },              // optional: drive UI
//     references: [ { name, file } ],   // reference PNG(s), relative to REFERENCE_DIR
//     regions: [ region, ... ],
//   }
//
// A REGION is a named rectangle compared between the reference image and our
// capture. Because the game's UI chrome is either right-anchored (status bar)
// or centered (dialogs), the SAME rectangle is used on both images:
//
//   region('id', 'Label', x, y, width, height)
//
// If our render is offset from the reference, pass explicit rects instead:
//   { id, label, ref:{x,y,width,height}, ours:{x,y,width,height} }
//
// Regions are the unit that could later become a threshold assertion
// (result.diffPercent < N). This file is the only place you edit to extend
// coverage; run.mjs and report.mjs are generic.
// ============================================================================

const region = (id, label, x, y, width, height) => ({
    id, label, ref: { x, y, width, height }, ours: { x, y, width, height },
});

// --- Status-bar sub-regions (right 194px column, right-anchored) -------------
// Measured: our StatusBar container sits at x=1726, width=194; the reference
// frames put the identical chrome at the same left edge.
const STATUSBAR_REGIONS = [
    region('statusbar_column', 'Full status-bar column', 1726, 0, 194, 768),
    region('statusbar_radar', 'Radar box', 1734, 8, 178, 172),
    region('statusbar_bars', 'Shield / armor / fuel bars', 1732, 202, 184, 54),
    region('statusbar_bottom_chrome', 'Lower metal chrome (text-free)', 1726, 620, 194, 145),
];

export const scenarios = [
    {
        id: 'in_space',
        title: 'In space — status bar chrome',
        description: 'Flying in the Sol system; compare the right status-bar '
            + 'column against three reference frames. Dynamic text (target, '
            + 'credits, stellar nav) legitimately differs; the chrome should not.',
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: null,
        references: [
            { name: 'in_space', file: 'space/in_space.png' },
            { name: 'in_space_2', file: 'space/in_space_2.png' },
            { name: 'in_space_3', file: 'space/in_space_3.png' },
        ],
        regions: STATUSBAR_REGIONS,
    },
    {
        id: 'starmap',
        title: 'Star map — dialog chrome & buttons',
        description: 'Star map opened over space (KeyM). Compare the dialog '
            + 'frame, button row, right info panel and bottom info line against '
            + 'map_single_jump_route.png.',
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: async (page, driver) => { await driver.openStarmap(page); },
        references: [
            { name: 'map', file: 'map/map_single_jump_route.png' },
        ],
        regions: [
            region('map_frame', 'Whole dialog frame', 659, 281, 603, 517),
            region('map_button_row', 'Bottom button row', 660, 750, 601, 48),
            region('map_info_panel', 'Right info panel (Destination/Govt/...)', 1140, 300, 122, 420),
            region('map_bottom_info', 'Ports / Nav hazards / date line', 668, 718, 470, 44),
        ],
    },
    {
        id: 'earth_spaceport',
        title: 'Landed at Earth — spaceport dialog',
        description: 'Autopiloted to Earth and docked. Compare the spaceport '
            + 'dialog frame, landing PICT, title bar and both button columns '
            + 'against spaceport/earth.png.',
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: async (page, driver) => { await driver.landAt(page, 'planet nova:128'); },
        references: [
            { name: 'earth', file: 'spaceport/earth.png' },
        ],
        regions: [
            region('spaceport_frame', 'Whole dialog frame', 651, 281, 618, 522),
            region('spaceport_landing_pict', 'Landing PICT (planet/ship art)', 655, 286, 610, 268),
            region('spaceport_title', 'Stellar name title bar', 812, 578, 292, 26),
            region('spaceport_left_buttons', 'Left button column (Bar/BBS/Trade)', 658, 578, 158, 122),
            region('spaceport_right_buttons', 'Right button column (Shipyard/Outfitter/Leave)', 1122, 578, 150, 165),
        ],
    },
];
