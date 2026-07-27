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
        id: 'earth_trade_center',
        title: 'Earth trade center — commodity dialog',
        description: 'The Trade Center opened from the Earth spaceport '
            + '(a sub-dialog over the still-visible spaceport). Compare the '
            + 'dialog\'s top metal border and the Buy/Sell/Done button row '
            + 'against trade_center/earth_trade_center.png. The commodity '
            + 'list, prices and cargo lines legitimately differ (dynamic '
            + 'economy/cargo state); the compared regions are static chrome.',
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.landAt(page, 'planet nova:128');
            await driver.clickContainer(page, 'Button:Trade Center');
            await driver.waitForContainer(page, 'TradeCenter');
            await driver.sleep(1200);
        },
        references: [
            { name: 'earth_trade_center', file: 'trade_center/earth_trade_center.png' },
        ],
        regions: [
            region('trade_top_border', 'Trade dialog top metal border', 768, 414, 388, 14),
            region('trade_button_row', 'Buy / Sell / Done button row', 806, 636, 308, 22),
        ],
    },
    {
        id: 'earth_mission_bbs',
        title: 'Earth mission BBS — mission board dialog',
        description: 'The Mission BBS opened from the Earth spaceport. '
            + 'Compare the dialog\'s top metal border and the Accept/Leave '
            + 'button row against mission_bbs/earth_mission_bbs.png. The '
            + 'available-mission list and the selected description '
            + 'legitimately differ (mission generation is stateful); the '
            + 'compared regions are static chrome.',
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.landAt(page, 'planet nova:128');
            await driver.clickContainer(page, 'Button:Mission BBS');
            await driver.waitForContainer(page, 'MissionBoard-Mission BBS');
            await driver.sleep(1200);
        },
        references: [
            { name: 'earth_mission_bbs', file: 'mission_bbs/earth_mission_bbs.png' },
        ],
        regions: [
            region('mission_top_border', 'Mission dialog top metal border', 703, 438, 510, 14),
            region('mission_button_row', 'Accept / Leave button row', 970, 611, 200, 22),
        ],
    },
    {
        id: 'earth_bar',
        title: 'Earth bar — spaceport bar dialog',
        description: 'The Bar opened from the Earth spaceport. Compare the '
            + 'dialog\'s top metal border and the 2x2 button grid '
            + '(Hire Escort / Gamble / Holovid / Leave) against '
            + 'bar/bar_earth.png. The bar description text legitimately '
            + 'differs; the compared regions are static chrome.',
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.landAt(page, 'planet nova:128');
            await driver.clickContainer(page, 'Button:Bar');
            await driver.waitForContainer(page, 'Bar');
            await driver.sleep(1200);
        },
        references: [
            { name: 'bar_earth', file: 'bar/bar_earth.png' },
        ],
        regions: [
            region('bar_top_border', 'Bar dialog top metal border', 773, 448, 340, 14),
            region('bar_button_grid', 'Hire/Gamble/Holovid/Leave button grid', 812, 576, 308, 54),
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

    // ========================================================================
    // DIALOG SWEEP — landed/dialog UI variants (dialog-sweep agent).
    // Extends coverage to every remaining landed/dialog reference. Shared
    // frames (trade 8510, bar 8503, mission BBS 8505, player-info
    // 8518-8520, ship-info 8507, outfitter 8502) reuse the already-proven
    // frame coordinates; the point is to measure each reference and surface
    // any content/positioning drift, not to re-derive the chrome.
    // ========================================================================

    {
        id: 'port_kane_bar',
        title: 'Port Kane bar — second bar layout',
        description: 'The Bar at Port Kane (a second stellar\'s bar). Any '
            + 'entry mission-offer popup is dismissed first so the bar\'s own '
            + '2x2 button grid shows. Compares the 8503 top border and the '
            + 'Hire/Gamble/Holovid/Leave grid against bar/bar_port_kane.png; '
            + 'same chrome as the Earth bar, different description text.',
        params: { ship: 'nova:164', system: 'nova:128' },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.landAt(page, 'planet nova:137');
            await driver.clickContainer(page, 'Button:Bar');
            await driver.waitForContainer(page, 'Bar');
            await driver.sleep(800);
            await driver.dismissOfferPopup(page);
            await driver.sleep(600);
        },
        references: [
            { name: 'bar_port_kane', file: 'bar/bar_port_kane.png' },
        ],
        regions: [
            region('bar_top_border', 'Bar dialog top metal border', 773, 448, 340, 14),
            region('bar_button_grid', 'Hire/Gamble/Holovid/Leave button grid', 812, 576, 308, 54),
        ],
    },

    {
        id: 'port_kane_trade',
        title: 'Port Kane trade — price event + mission cargo',
        description: 'The Trade Center at Port Kane. The reference shows a '
            + 'deterministic food-surplus öops price event and a mission-cargo '
            + 'line; those are content. Compares the 8510 frame top border, '
            + 'the Buy/Sell/Done row and the price-event line position against '
            + 'trade_center/trade_center_port_kane_with_mission_cargo_and_'
            + 'lower_cost_food_event.png.',
        // A save so a mission-cargo line and a stocked economy exist; the
        // öops event is date-driven, so the default Jan 1 1177 date is kept.
        save: {
            ship: 'nova:164', outfits: [], system: 'nova:128',
            credits: 600000,
            cargo: [['mission:nova:700', 5]],
        },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.landAt(page, 'planet nova:137');
            await driver.clickContainer(page, 'Button:Trade Center');
            await driver.waitForContainer(page, 'TradeCenter');
            await driver.sleep(1000);
        },
        references: [
            { name: 'port_kane_trade', file: 'trade_center/trade_center_port_kane_with_mission_cargo_and_lower_cost_food_event.png' },
        ],
        regions: [
            region('trade_top_border', 'Trade dialog top metal border', 768, 414, 388, 14),
            region('trade_button_row', 'Buy / Sell / Done button row', 806, 636, 308, 22),
            region('trade_list_header', 'Commodity / In Hold / Price header', 790, 428, 340, 12),
        ],
    },

    {
        id: 'earth_trade_variants',
        title: 'Earth trade — content variants (chrome)',
        description: 'Our Earth Trade Center captured once, its static chrome '
            + '(8510 top border + Buy/Sell/Done row) compared against three '
            + 'content variants of the same fixed frame: the plain board, the '
            + 'Medical-Supplies selection, and a large cargo buy. Commodity '
            + 'rows / prices / selection legitimately differ; the frame does '
            + 'not.',
        save: {
            ship: 'nova:164', outfits: [], system: 'nova:130', credits: 5000000,
        },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.landAt(page, 'planet nova:128');
            await driver.clickContainer(page, 'Button:Trade Center');
            await driver.waitForContainer(page, 'TradeCenter');
            await driver.sleep(900);
        },
        references: [
            { name: 'earth_trade_center', file: 'trade_center/earth_trade_center.png' },
            { name: 'medical_390', file: 'trade_center/390_medical_supplies.png' },
            { name: 'buy_lots', file: 'trade_center/buy_lots_of_cargo.png' },
        ],
        regions: [
            region('trade_top_border', 'Trade dialog top metal border', 768, 414, 388, 14),
            region('trade_button_row', 'Buy / Sell / Done button row', 806, 636, 308, 22),
        ],
    },

    {
        id: 'trade_buy_quantity',
        title: 'Trade buy — bulk quantity dialog',
        description: 'Option-clicking Buy in the Trade Center opens the bulk '
            + 'quantity dialog. The reference (buy_quantity.png) is the '
            + 'original\'s NATIVE macOS dialog (blue default Buy button); ours '
            + 'is a drawn grey-bevel panel — an intentional ART difference. '
            + 'The measured region is the panel position, not its styling.',
        save: {
            ship: 'nova:164', outfits: [], system: 'nova:130', credits: 5000000,
        },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.landAt(page, 'planet nova:128');
            await driver.clickContainer(page, 'Button:Trade Center');
            await driver.waitForContainer(page, 'TradeCenter');
            await driver.sleep(900);
            // Medical Supplies (row 2) — matches the reference selection.
            await driver.pressKeyN(page, 'ArrowDown', 2);
            await driver.optionClick(page, 'Button:Buy');
            await driver.waitForContainer(page, 'QuantityDialog');
            await driver.sleep(500);
        },
        references: [
            { name: 'buy_quantity', file: 'trade_center/buy_quantity.png' },
        ],
        regions: [
            region('quantity_panel', 'Quantity dialog panel (position; ART styling)', 846, 486, 240, 104),
        ],
    },

    {
        id: 'earth_player_info_extras',
        title: "Player info — Extras page",
        description: 'The Extras page of the player-info dialog (KeyP → '
            + 'Extras tab): owned outfits and ship trade-in value. Compares '
            + 'the 8518-8520 frame, tab row (Extras greyed) and Done row '
            + 'against p_properties/extras.png. Listed outfits / values '
            + 'legitimately differ.',
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.openPlayerInfo(page);
            await driver.clickContainer(page, 'Button:Extras');
            await driver.sleep(400);
        },
        references: [
            { name: 'extras', file: 'p_properties/extras.png' },
        ],
        regions: [
            region('pinfo_frame', 'Whole dialog frame', 753, 425, 414, 231),
            region('pinfo_tab_row', 'Tab row (Extras greyed)', 757, 429, 406, 36),
            region('pinfo_done_row', 'Bottom strip with Done', 757, 615, 406, 37),
        ],
    },

    {
        id: 'earth_player_info_honors',
        title: "Player info — Honors page",
        description: 'The Honors page (KeyP → Honors tab). Ranks/honors are '
            + 'not parsed yet (shows "None."), a documented content gap. '
            + 'Compares the 8518-8520 frame, tab row (Honors greyed) and Done '
            + 'row against p_properties/honors.png.',
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.openPlayerInfo(page);
            await driver.clickContainer(page, 'Button:Honors');
            await driver.sleep(400);
        },
        references: [
            { name: 'honors', file: 'p_properties/honors.png' },
        ],
        regions: [
            region('pinfo_frame', 'Whole dialog frame', 753, 425, 414, 231),
            region('pinfo_tab_row', 'Tab row (Honors greyed)', 757, 429, 406, 36),
            region('pinfo_done_row', 'Bottom strip with Done', 757, 615, 406, 37),
        ],
    },

    {
        id: 'earth_player_info_cargo_stuff',
        title: "Player info — Cargo page with cargo aboard",
        description: 'The Cargo page with cargo actually in the hold (a save '
            + 'seeds Food + Medical Supplies), so the Jettison Cargo button '
            + 'shows (greyed) beside Done — unlike the empty-hold cargo page. '
            + 'Compares the frame, tab row and the Jettison/Done bottom row '
            + 'against p_properties/cargo_with_stuff.png.',
        save: {
            ship: 'nova:164', outfits: [], system: 'nova:130', credits: 200000,
            cargo: [['cargo:0', 30], ['cargo:2', 20]],
        },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.openPlayerInfo(page);
            await driver.clickContainer(page, 'Button:Cargo');
            await driver.sleep(400);
        },
        references: [
            { name: 'cargo_with_stuff', file: 'p_properties/cargo_with_stuff.png' },
        ],
        regions: [
            region('pinfo_frame', 'Whole dialog frame', 753, 425, 414, 231),
            region('pinfo_tab_row', 'Tab row (Cargo greyed)', 757, 429, 406, 36),
            region('pinfo_bottom_row', 'Jettison Cargo + Done row', 757, 615, 406, 37),
        ],
    },

    {
        id: 'heavy_shuttle_info',
        title: 'Shipyard ship info — Heavy Shuttle',
        description: 'The shipyard Info dialog for the Heavy Shuttle (a '
            + 'different ship than the base ship_info scenario). Compares the '
            + '8507 frame, name strip and Done button against '
            + 'shipyard/heavy_shuttle_info.png. Ship PICT/stats differ from '
            + 'the retail capture; the frame chrome should match.',
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.landAt(page, 'planet nova:128');
            await driver.clickContainer(page, 'Button:Shipyard');
            await driver.waitForContainer(page, 'Shipyard');
            await driver.sleep(400);
            // Grid is displayWeight-sorted; Heavy Shuttle is 19 steps in.
            await driver.pressKeyN(page, 'ArrowRight', 19);
            await driver.clickContainer(page, 'Button:Info');
            await driver.waitForContainer(page, 'ShipInfo');
            await driver.sleep(1000);
        },
        references: [
            { name: 'heavy_shuttle_info', file: 'shipyard/heavy_shuttle_info.png' },
        ],
        regions: [
            region('shipinfo_frame', 'Whole dialog frame', 653, 271, 614, 537),
            region('shipinfo_name_strip', 'Ship name strip', 655, 682, 610, 30),
            region('shipinfo_done', 'Done button', 1168, 780, 90, 24),
        ],
    },

    {
        id: 'ida_frigate_info',
        title: 'Shipyard ship info — IDA Frigate',
        description: 'The shipyard Info dialog for the IDA Frigate. Compares '
            + 'the 8507 frame, name strip and Done button against '
            + 'shipyard/ida_frigate_info.png.',
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.landAt(page, 'planet nova:128');
            await driver.clickContainer(page, 'Button:Shipyard');
            await driver.waitForContainer(page, 'Shipyard');
            await driver.sleep(400);
            await driver.pressKeyN(page, 'ArrowRight', 8);
            await driver.clickContainer(page, 'Button:Info');
            await driver.waitForContainer(page, 'ShipInfo');
            await driver.sleep(1000);
        },
        references: [
            { name: 'ida_frigate_info', file: 'shipyard/ida_frigate_info.png' },
        ],
        regions: [
            region('shipinfo_frame', 'Whole dialog frame', 653, 271, 614, 537),
            region('shipinfo_name_strip', 'Ship name strip', 655, 682, 610, 30),
            region('shipinfo_done', 'Done button', 1168, 780, 90, 24),
        ],
    },

    {
        id: 'earth_mission_bbs_selected',
        title: 'Mission BBS — selected mission',
        description: 'The Mission BBS with a mission selected (highlighted in '
            + 'the list, its brief shown in the right pane). Compares the 8505 '
            + 'top border, list pane, description pane and Accept/Leave row '
            + 'against mission_bbs/un_shipping_mission.png. Which mission is '
            + 'offered/selected legitimately differs (random generation); the '
            + 'panes and chrome do not.',
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.landAt(page, 'planet nova:128');
            await driver.clickContainer(page, 'Button:Mission BBS');
            await driver.waitForContainer(page, 'MissionBoard-Mission BBS');
            await driver.sleep(800);
            // Select the last offer, as the reference selects the bottom row.
            await driver.pressKeyN(page, 'ArrowDown', 4);
            await driver.sleep(400);
        },
        references: [
            { name: 'un_shipping_mission', file: 'mission_bbs/un_shipping_mission.png' },
        ],
        regions: [
            region('mission_top_border', 'Mission dialog top metal border', 703, 438, 510, 14),
            region('mission_button_row', 'Accept / Leave button row', 970, 611, 200, 22),
            region('mission_list_pane', 'Left mission-list pane', 712, 468, 205, 140),
            region('mission_desc_pane', 'Right description pane', 928, 478, 262, 120),
        ],
    },

    {
        id: 'earth_mission_bbs_accepted',
        title: 'Mission BBS — after accepting',
        description: 'The Mission BBS after accepting an offer: it moves under '
            + 'the "Active missions" header and the status line confirms it. '
            + 'Compares the 8505 top border, list pane and Accept/Leave row '
            + 'against mission_bbs/accepted_un_mission.png. The specific '
            + 'mission differs; the layout does not.',
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.landAt(page, 'planet nova:128');
            await driver.clickContainer(page, 'Button:Mission BBS');
            await driver.waitForContainer(page, 'MissionBoard-Mission BBS');
            await driver.sleep(800);
            // Accept the first acceptable listing (KeyA = accept control).
            await driver.pressKey(page, 'KeyA');
            await driver.sleep(600);
        },
        references: [
            { name: 'accepted_un_mission', file: 'mission_bbs/accepted_un_mission.png' },
        ],
        regions: [
            region('mission_top_border', 'Mission dialog top metal border', 703, 438, 510, 14),
            region('mission_button_row', 'Accept / Leave button row', 970, 611, 200, 22),
            region('mission_list_pane', 'Left mission-list pane', 712, 468, 205, 140),
        ],
    },

    {
        id: 'earth_outfitter_denial',
        title: 'Outfitter — denial caption + greyed Buy',
        description: 'The outfitter driven into a purchase-denial state '
            + '(mass/hold filled by bulk buys, then a further buy attempted): '
            + 'the right info pane shows a persistent "Can\'t ..." caption and '
            + 'the Buy button greys. The four denial references differ only in '
            + 'the caption WORDING (content) and which button greys; the '
            + 'measured chrome — info-pane block, caption line position and '
            + 'button row — is identical across all of them.',
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.landAt(page, 'planet nova:128');
            await driver.clickContainer(page, 'Button:Outfitter');
            await driver.waitForContainer(page, 'Outfitter');
            await driver.sleep(1500);
            // Fill the ship's outfit mass with bulk buys of several grid
            // outfits (the outfitter ignores credits), then a further buy
            // trips the "Can't hold ..." denial. Skip the first tile
            // (a mission-granting Trainee Program).
            for (let i = 0; i < 6; i++) {
                await driver.pressKey(page, 'ArrowRight');
                await driver.sleep(150);
                await driver.optionClick(page, 'Button:Buy');
                await driver.sleep(400);
                // Confirm the bulk quantity (fills to the max allowed).
                await driver.pressKey(page, 'Enter');
                await driver.sleep(300);
            }
            // A final plain buy on the current selection surfaces the
            // persistent denial caption + greys Buy.
            await driver.clickContainer(page, 'Button:Buy');
            await driver.sleep(400);
        },
        references: [
            { name: 'cant_have_any', file: 'outfitter/earth_outfitter_cant_have_any.png' },
            { name: 'cant_have_any_more', file: 'outfitter/earth_outfitter_cant_have_any_more.png' },
            { name: 'cant_hold_any', file: 'outfitter/earth_outfitter_cant_hold_any.png' },
            { name: 'cant_hold_any_more', file: 'outfitter/earth_outfitter_cant_hold_any_more.png' },
            { name: 'carbon_fiber_cant_hold_any_more', file: 'outfitter/earth_outfitter_carbon_fiber_cant_hold_any_more.png' },
        ],
        regions: [
            region('outfitter_frame', 'Whole dialog frame', 578, 380, 765, 321),
            region('outfitter_button_row', 'Buy/Sell/Done button row', 660, 668, 520, 30),
            region('outfitter_info_block', 'Right info pane (Price/Mass/caption)', 1188, 594, 148, 92),
        ],
    },

    {
        id: 'bar_offer_popup',
        title: 'Mission-offer popup (8521-8523) — frame & buttons',
        description: 'The mission-offer popup chrome. Our spaceport does not '
            + 'present offer popups on landing (only the bar and BBS surface '
            + 'missions), so this drives the Earth bar\'s entry offer to raise '
            + 'the same 8521-8523 offer frame, and measures its centered frame '
            + 'borders against spaceport/kiniké_kont_probe_mission_offer_in_'
            + 'spaceport.png. The popup is vertically CENTERED and its height '
            + 'tracks the (differing) text length, so only the vertical-centre '
            + 'border bands are position-comparable; the button-row Y and the '
            + 'text/background legitimately differ.',
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.landAt(page, 'planet nova:128');
            await driver.clickContainer(page, 'Button:Bar');
            await driver.waitForContainer(page, 'OfferPopup');
            await driver.sleep(1000);
        },
        references: [
            { name: 'kinike_offer', file: 'spaceport/kiniké_kont_probe_mission_offer_in_spaceport.png' },
        ],
        regions: [
            region('offer_left_border', 'Left metal frame border (vertical centre)', 740, 500, 16, 80),
            region('offer_right_border', 'Right metal frame border (vertical centre)', 1165, 500, 16, 80),
        ],
    },

    // ========================================================================
    // HAIL SWEEP — the communications (hail) dialogs (PICTs 8511-8514).
    // Merged in a5b7adc1; the layout was eyeballed. All comm backgrounds share
    // one structure in the references: two stacked text boxes top-LEFT, a
    // vertical red-button column under them, and the target image filling a box
    // on the RIGHT. Driven deterministically via window.novaHailDialog.show()
    // with a crafted context (centered like the plugin's own control path).
    // The image CONTENT (which ship/planet) legitimately differs; the frame,
    // its image box, the left text boxes and the button column are the
    // positionable chrome. Escort-comm button SEMANTICS diverge (ours offers
    // fleet commands, the original manages a hired escort) and the haggle
    // popup differs structurally — classified content, not MOVE.
    // ========================================================================

    {
        id: 'hail_ship',
        title: 'Hail — ship comm (8511)',
        description: 'The ship communications dialog (greeting + Request '
            + 'Assistance). Compares the 8511 frame, its left text/button '
            + 'column and the right image box against hail/hail.png, '
            + 'greetings.png and request_assistance.png (all the same 8511 '
            + 'layout, different greeting text / target).',
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.showHail(page, {
                variant: 'ship', heading: 'Class: Terrapin',
                image: 'nova:5003', body: 'Channel open.',
                assist: { free: false },
            });
            await driver.sleep(1200);
        },
        references: [
            { name: 'hail', file: 'hail/hail.png' },
            { name: 'greetings', file: 'hail/greetings.png' },
            { name: 'request_assistance', file: 'hail/request_assistance.png' },
        ],
        regions: [
            region('hail_frame', 'Whole comm frame', 748, 433, 423, 215),
            region('hail_left_col', 'Left text boxes + button column', 756, 440, 182, 200),
            region('hail_image_box', 'Right image box (border chrome)', 950, 435, 222, 208),
        ],
    },

    {
        id: 'hail_hostile',
        title: 'Hail — hostile ship (8511 + bribe)',
        description: 'A hostile ship comm: the hostile line plus a Beg for '
            + 'Mercy (bribe) button above Close Channel. Compares the 8511 '
            + 'frame, left column and image box against hail/hail_hostile.png.',
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.showHail(page, {
                variant: 'ship', heading: 'Class: Fed Destroyer',
                image: 'nova:5003',
                body: 'You are scum, and we will destroy you.',
                bribe: { amount: 20000, canAfford: true },
            });
            await driver.sleep(1200);
        },
        references: [
            { name: 'hail_hostile', file: 'hail/hail_hostile.png' },
        ],
        regions: [
            region('hail_frame', 'Whole comm frame', 748, 433, 423, 215),
            region('hail_left_col', 'Left text boxes + button column', 756, 440, 182, 200),
            region('hail_image_box', 'Right image box (border chrome)', 950, 435, 222, 208),
        ],
    },

    {
        id: 'hail_planet',
        title: 'Hail — planet comm (8512)',
        description: 'The planet communications dialog (larger 8512 frame). '
            + 'Compares the frame, left text/button column and right image box '
            + 'against hail/hail_planet.png. Our planet comm lacks the '
            + 'Demand Tribute button (content gap); Close Channel and the '
            + 'layout are compared.',
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.showHail(page, {
                variant: 'planet', heading: 'Earth',
                image: 'nova:10059',
                body: 'Channel open to Earth.\n[Earth/Luna System]',
            });
            await driver.sleep(1200);
        },
        references: [
            { name: 'hail_planet', file: 'hail/hail_planet.png' },
        ],
        regions: [
            region('hailp_frame', 'Whole planet comm frame', 690, 392, 540, 295),
            region('hailp_left_col', 'Left text boxes + button column', 698, 400, 210, 250),
            region('hailp_image_box', 'Right image box (border chrome)', 905, 398, 330, 285),
        ],
    },

    {
        id: 'hail_escort',
        title: 'Hail — escort comm (8513)',
        description: 'The escort communications dialog (8513). Our escort '
            + 'comm offers fleet commands (Attack/Defend/Formation/Hold/'
            + 'Return); the original manages a hired escort (Upgrade/Sell/'
            + 'Release) — a documented feature divergence, so the button '
            + 'CONTENT differs. Compares the frame, left column and image box '
            + 'against hail/hail_escort.png.',
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.showHail(page, {
                variant: 'escort', heading: 'Hired Escort:',
                image: 'nova:5003', body: 'Terrapin\nStandard',
                escortCommands: true,
            });
            await driver.sleep(1200);
        },
        references: [
            { name: 'hail_escort', file: 'hail/hail_escort.png' },
        ],
        regions: [
            region('haile_frame', 'Whole escort comm frame', 748, 410, 424, 259),
            region('haile_left_col', 'Left text boxes + button column', 756, 418, 182, 240),
            region('haile_image_box', 'Right image box (border chrome)', 950, 418, 222, 245),
        ],
    },

    {
        id: 'hail_haggle',
        title: 'Hail — beg for mercy / haggle (8514)',
        description: 'The bribe-haggle screen reached from a hostile ship\'s '
            + 'Beg for Mercy. The original shows a small 8514 popup ("Pay me X '
            + 'credits" / Lower Price / Accept Price) OVER the hostile dialog; '
            + 'ours replaces the dialog with the 8514 background and offers '
            + 'Pay / Never Mind — a documented structural divergence. Compared '
            + 'against hail/beg_mercy.png (frame position).',
        params: { ship: 'nova:164', system: 'nova:130' },
        hideDebug: true,
        setup: async (page, driver) => {
            await driver.showHail(page, {
                variant: 'ship', heading: 'Class: Fed Destroyer',
                image: 'nova:5003',
                body: 'I\'m in a bad mood today, so it\'s going to cost extra.',
                bribe: { amount: 20000, canAfford: true },
            });
            await driver.sleep(800);
            await driver.clickContainer(page, 'Button:Beg for Mercy');
            await driver.sleep(900);
        },
        references: [
            { name: 'beg_mercy', file: 'hail/beg_mercy.png' },
        ],
        regions: [
            region('haggle_frame', 'Haggle popup frame', 810, 462, 300, 156),
        ],
    },
];
