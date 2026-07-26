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
    {
        id: 'port_kane_spaceport',
        title: 'Landed at Port Kane — standard landscape',
        description: 'Docked at Port Kane (CustPicID -1): the landing panel '
            + 'must show the STANDARD landscape for the stellar\'s Type, the '
            + 'pre-made PICT at 10000 + Type (10034 here — the station scene), '
            + 'not a placeholder. Compare against spaceport/port_kane.png.',
        params: { ship: 'nova:164', system: 'nova:128' },
        hideDebug: true,
        setup: async (page, driver) => { await driver.landAt(page, 'planet nova:137'); },
        references: [
            { name: 'port_kane', file: 'spaceport/port_kane.png' },
        ],
        regions: [
            region('spaceport_frame', 'Whole dialog frame', 651, 281, 618, 522),
            region('spaceport_landing_pict', 'Standard landscape (station scene)', 655, 286, 610, 268),
            region('spaceport_title', 'Stellar name title bar', 812, 578, 292, 26),
            region('spaceport_left_buttons', 'Left button column (Bar/BBS/Trade)', 658, 578, 158, 122),
            region('spaceport_right_buttons', 'Right button column (Outfitter/Leave)', 1122, 578, 150, 165),
        ],
    },
    {
        id: 'player_info_general',
        title: "Player info ('p') — General page",
        description: 'The player-info dialog toggled with KeyP in flight. '
            + 'Compare the 8518/8519/8520 three-part frame, tab row and Done '
            + 'row against p_properties/general.png. Text values legitimately '
            + 'differ (date, credits, ship).',
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: async (page, driver) => { await driver.openPlayerInfo(page); },
        references: [
            { name: 'general', file: 'p_properties/general.png' },
        ],
        regions: [
            region('pinfo_frame', 'Whole dialog frame', 753, 425, 414, 231),
            region('pinfo_tab_row', 'Tab row (General/Cargo/Extras/Honors)', 757, 429, 406, 36),
            region('pinfo_done_row', 'Bottom strip with Done', 757, 615, 406, 37),
        ],
    },
    {
        id: 'player_info_cargo',
        title: "Player info ('p') — Cargo page",
        description: 'The Cargo page: greyed Cargo tab, cargo listing, and the '
            + 'greyed Jettison Cargo button next to Done, against '
            + 'p_properties/cargo.png.',
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.openPlayerInfo(page);
            await driver.clickContainer(page, 'Button:Cargo');
        },
        references: [
            { name: 'cargo', file: 'p_properties/cargo.png' },
        ],
        regions: [
            region('pinfo_frame', 'Whole dialog frame', 753, 425, 414, 231),
            region('pinfo_tab_row', 'Tab row (Cargo tab greyed)', 757, 429, 406, 36),
            region('pinfo_bottom_row', 'Jettison Cargo + Done row', 757, 615, 406, 37),
        ],
    },
    {
        id: 'earth_outfitter',
        title: 'Earth outfitter — dialog chrome',
        description: 'The outfitter opened from the Earth spaceport. Compare '
            + 'the 8502 frame, item grid pane and button row against '
            + 'outfitter/earth_outfitter.png. Item selection state and the '
            + 'info-pane text legitimately differ.',
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.landAt(page, 'planet nova:128');
            await driver.clickContainer(page, 'Button:Outfitter');
            await driver.waitForContainer(page, 'Outfitter');
            await driver.sleep(1500);
        },
        references: [
            { name: 'earth_outfitter', file: 'outfitter/earth_outfitter.png' },
        ],
        regions: [
            region('outfitter_frame', 'Whole dialog frame', 578, 380, 765, 321),
            region('outfitter_grid', 'Item grid pane', 585, 388, 335, 278),
            region('outfitter_button_row', 'Buy/Sell/Done button row', 660, 668, 520, 30),
        ],
    },
    {
        id: 'title_screen',
        title: 'Title screen — layout, logo & buttons',
        description: 'The game entry screen (before the world is joined), '
            + 'rendered from the original resources (PICT 8000 background, '
            + 'animated title 8010, rollover emblem 8020, button sheets '
            + '8050-8055). Compared against title_screen/title_screen.png. '
            + 'The flame animation frame and the bottom pilot status '
            + 'legitimately differ; the frame chrome, logo placement and '
            + 'button cluster should match.',
        entry: 'title',
        params: {},
        hideDebug: false,
        setup: null,
        references: [
            { name: 'title_screen', file: 'title_screen/title_screen.png' },
        ],
        regions: [
            // Frame origin in the reference is screen (448,157); the art is
            // drawn at native 1024x768 centered, so the same rectangles
            // apply to our capture.
            region('title_button_cluster', 'Six corner buttons + emblem', 783, 565, 375, 210),
            region('title_logo', 'Flaming NOVA title logo', 636, 305, 660, 220),
            region('title_left_fan', 'Left fan chrome (text-free)', 890, 300, 130, 260),
            region('title_right_fan', 'Right fan chrome (text-free)', 900, 300, 130, 260),
            region('title_top_frame', 'Top metal frame band', 620, 165, 680, 90),
        ],
    },
    {
        id: 'ship_info',
        title: 'Shipyard ship info dialog (8507)',
        description: "The shipyard's Info button opens the ship-description "
            + 'dialog on the 8507 frame: the ship PICT, name strip, stat '
            + 'columns and Done button. Compare the frame chrome against '
            + 'shipyard/shuttle_info.png (the pictured ship, name and stat '
            + 'values legitimately differ — our parsed data is not the retail '
            + "capture's).",
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.landAt(page, 'planet nova:128');
            await driver.clickContainer(page, 'Button:Shipyard');
            await driver.waitForContainer(page, 'Shipyard');
            await driver.pressKey(page, 'ArrowRight'); // select a ship
            await driver.sleep(300);
            await driver.clickContainer(page, 'Button:Info');
            await driver.waitForContainer(page, 'ShipInfo');
            await driver.sleep(1200);
        },
        references: [
            { name: 'shuttle_info', file: 'shipyard/shuttle_info.png' },
        ],
        regions: [
            // The 614x537 8507 frame, centered on screen.
            region('shipinfo_frame', 'Whole dialog frame', 653, 271, 614, 537),
            region('shipinfo_name_strip', 'Ship name strip', 655, 682, 610, 30),
            region('shipinfo_done', 'Done button', 1168, 780, 90, 24),
        ],
    },
    {
        id: 'mission_info',
        title: "Mission info dialog (8517, 'i')",
        description: "The Mission Info dialog toggled with 'i' (KeyI) in "
            + 'flight, like the reference (missions_info.png is a flight '
            + 'capture). Compare the 8517 frame, the "Currently active '
            + 'missions:" header, the date strip and the Abort/Done row. The '
            + "list content legitimately differs (this capture's pilot has no "
            + 'active missions); the compared regions are the static chrome.',
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: async (page, driver) => {
            // In flight the plugin's own handler opens it for the world's
            // player ship (no landing / ambiguous button clicks needed).
            await driver.pressKey(page, 'KeyI');
            await driver.waitForContainer(page, 'MissionInfo');
            await driver.sleep(1000);
        },
        references: [
            { name: 'missions_info', file: 'missions/missions_info.png' },
        ],
        regions: [
            // The 471x155 8517 frame, centered on screen.
            region('missioninfo_frame', 'Whole dialog frame', 725, 463, 471, 155),
            region('missioninfo_header', 'Active-missions header', 731, 469, 200, 14),
            region('missioninfo_button_row', 'Abort / Done row', 731, 592, 460, 28),
        ],
    },
];
