import { JunkData } from 'novadatainterface/junk_data';
import { OopsData } from 'novadatainterface/oops_data';
import { PlanetData } from 'novadatainterface/planet_data';
import { Entity } from 'nova_ecs/entity';
import * as PIXI from 'pixi.js';
import { Observable } from 'rxjs';
import { DisplayAssetDataInterface } from '../client/gamedata/display_asset_data.js';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { CargoComponent } from '../nova_plugin/cargo_plugin.js';
import { ControlEvent } from '../nova_plugin/controls_plugin.js';
import { ControlBitsComponent } from '../nova_plugin/ncb_plugin.js';
import { dayNumber } from '../nova_plugin/calendar.js';
import { CreditsComponent, GameDateComponent } from '../nova_plugin/player_state_plugin.js';
import { activePriceEvents, applyPriceEvents } from '../nova_plugin/price_events.js';
import {
    buyGood,
    buyGoodQuantity,
    freeCargoSpace,
    junkTradeGood,
    maxBuyQuantity,
    maxSellQuantity,
    otherCargoNames,
    sellGood,
    sellGoodQuantity,
    standardTradeGoods,
    TradeGood,
    TradeWorkingState,
} from '../nova_plugin/trade_logic.js';
import { Button, ButtonClick } from './button.js';
import { Menu } from './menu.js';
import { computeCargoCapacity } from './mission_session.js';
import { QuantityDialog } from './quantity_dialog.js';

// Laid out to fit the 426x252 Trade dialog (PICT 8510): the main pane
// spans x 37..388, y 6..183; the strip below it y 189..213; the metal
// button row fills the bottom. Coordinates are center-anchored.
const PANE_LEFT = -176;
const PANE_RIGHT = 175;
const PANE_TOP = -118;
const LIST_TOP = PANE_TOP + 18;
const ROW_HEIGHT = 13;
const LIST_ROWS = 10;
// The "Other cargo" / "Free cargo space" lines at the pane's bottom.
const SUMMARY_TOP = 27;
// The narrow strip pane: status messages.
const STATUS_TOP = 66;
const BUTTON_Y = 90;
// Column x positions (right edges for the numeric columns).
const HOLD_RIGHT = 95;
const TIER_LEFT = 105;
const PRICE_RIGHT = PANE_RIGHT - 4;

const LIST_FONT: Partial<PIXI.ITextStyle> = {
    fontFamily: 'Geneva', fontSize: 10, fill: 0xffffff,
    align: 'left', wordWrap: false,
};
const RIGHT_FONT: Partial<PIXI.ITextStyle> =
    { ...LIST_FONT, align: 'right' };

/**
 * The commodity exchange (spöb flag 0x2): standard commodities at this
 * stellar's price tiers plus any jünk commodities traded here, bought
 * and sold against working copies of the player's cargo and credits.
 * Buy purchases as much as fits and is affordable; Sell sells the
 * whole held quantity — the original's one-click behavior. Commit on
 * Done, the outfitter/mission-session pattern. Mission cargo
 * ('mission:*') is never tradeable; it only counts against free space.
 */
export class TradeCenter extends Menu<Entity> {
    private planet?: PlanetData;
    private junks: JunkData[] = [];
    /** All öops price-event resources, matched against this stellar. */
    private oopses: OopsData[] = [];
    /** Standard cargo names (STR# 4000), loaded from any chär. */
    private cargoNames: string[] = [];
    private goods: TradeGood[] = [];
    private state: TradeWorkingState = {
        cargo: new Map(),
        credits: { credits: 0 },
        cargoCapacity: 0,
    };
    private selectedIndex = 0;
    private listContainer = new PIXI.Container();
    private highlight = new PIXI.Graphics();
    private rowTexts: PIXI.Text[] = [];
    /** Full-width transparent click targets, one per commodity row. */
    private rowHits: PIXI.Container[] = [];
    private buttons: {
        buy: Button, sell: Button, done: Button,
    };
    private quantityDialog: QuantityDialog;

    private text = {
        headerCommodity: new PIXI.Text('Commodity:', LIST_FONT),
        headerHold: new PIXI.Text('In Hold:', RIGHT_FONT),
        headerPrice: new PIXI.Text('Price:', RIGHT_FONT),
        otherCargo: new PIXI.Text('', LIST_FONT),
        freeSpace: new PIXI.Text('', LIST_FONT),
        // The active price-event description line ("An enormous food
        // surplus has lowered the price of food."), shown persistently.
        event: new PIXI.Text('', LIST_FONT),
        status: new PIXI.Text('', LIST_FONT),
    };
    /** The active price-event description(s), the default status text. */
    private eventText = '';

    constructor(displayAssets: DisplayAssetDataInterface,
        simulationData: SimulationGameDataInterface,
        controlEvents: Observable<ControlEvent>,
        private planetId: string) {
        super(displayAssets, simulationData, 'nova:8510', controlEvents);
        this.container.name = 'TradeCenter';

        this.buttons = {
            buy: new Button(displayAssets, 'Buy', 60, { x: -150, y: BUTTON_Y }),
            sell: new Button(displayAssets, 'Sell', 60, { x: -30, y: BUTTON_Y }),
            done: new Button(displayAssets, 'Done', 60, { x: 90, y: BUTTON_Y }),
        };
        // Option+click opens the bulk quantity dialog, as the
        // original's exchange does.
        this.buttons.buy.click.subscribe(click => this.buy(click));
        this.buttons.sell.click.subscribe(click => this.sell(click));
        this.buttons.done.click.subscribe(this.done.bind(this));
        this.addButtons(this.buttons);

        this.quantityDialog = new QuantityDialog(controlEvents);

        this.text.headerCommodity.position.set(PANE_LEFT + 4, PANE_TOP);
        this.text.headerHold.anchor.x = 1;
        this.text.headerHold.position.set(HOLD_RIGHT, PANE_TOP);
        this.text.headerPrice.anchor.x = 1;
        this.text.headerPrice.position.set(PRICE_RIGHT, PANE_TOP);
        this.text.otherCargo.position.set(PANE_LEFT + 4, SUMMARY_TOP);
        this.text.freeSpace.position.set(PANE_LEFT + 4, SUMMARY_TOP + 16);
        // The event line sits in the strip below the pane (the reference
        // screenshot's "food surplus" position); transaction feedback
        // shows just under it.
        this.text.event.position.set(PANE_LEFT + 4, STATUS_TOP);
        this.text.status.position.set(PANE_LEFT + 4, STATUS_TOP + 13);

        this.container.addChild(this.highlight, this.listContainer);
        for (const t of Object.values(this.text)) {
            this.container.addChild(t);
        }
        // On top of everything, so its modal shield covers the screen.
        this.container.addChild(this.quantityDialog.container);

        this.controls.controls = {
            up: () => this.moveSelection(-1),
            down: () => this.moveSelection(1),
            buy: this.buy.bind(this),
            sell: this.sell.bind(this),
            depart: this.done.bind(this),
        };
    }

    private loadPromise?: Promise<void>;

    /**
     * Lazily loads the planet and jünk data. NOT Menu.build: that runs
     * synchronously from the Menu constructor, before this subclass's
     * planetId parameter property is assigned.
     */
    private load(): Promise<void> {
        this.loadPromise ??= (async () => {
            const [planet, ids] = await Promise.all([
                this.simulationData.data.Planet.get(this.planetId),
                this.simulationData.ids,
            ]);
            this.planet = planet;
            this.junks = await Promise.all(ids.Junk.map(
                id => this.simulationData.data.Junk.get(id)));
            this.oopses = await Promise.all(ids.Oops.map(
                id => this.simulationData.data.Oops.get(id)));
            // Standard commodity names (STR# 4000) ride on every chär.
            try {
                if (ids.PlayerStart[0]) {
                    this.cargoNames = [...(await this.simulationData.data
                        .PlayerStart.get(ids.PlayerStart[0])).cargoNames];
                }
            } catch (e) {
                console.warn('Trade center cargo names unavailable:', e);
            }
        })();
        return this.loadPromise;
    }

    override async show(input: Entity): Promise<Entity> {
        try {
            await this.load();
        } catch (e) {
            console.warn('Trade center failed to load:', e);
            return input;
        }
        this.state = {
            cargo: new Map(input.components.get(CargoComponent) ?? []),
            credits: {
                credits: input.components.get(CreditsComponent)?.credits ?? 0,
            },
            cargoCapacity: await computeCargoCapacity(
                input, this.simulationData),
        };
        const bits = input.components.get(ControlBitsComponent)
            ?? new Set<number>();
        this.goods = this.planet
            ? standardTradeGoods(this.planet, this.cargoNames) : [];
        // Jünk rows follow the standard commodities, as in the
        // original's exchange listing.
        for (const junk of this.junks) {
            const row = junkTradeGood(junk, this.planetId, bits);
            if (row) {
                this.goods.push(row);
            }
        }
        // Apply any active öops price events to the standard commodities.
        // Prices are keyed to the player's own game date, so this stays a
        // deterministic per-player computation (no shared state, no RNG).
        const date = input.components.get(GameDateComponent);
        if (date) {
            const events = activePriceEvents(
                this.oopses, this.planetId, dayNumber(date), bits);
            this.goods = applyPriceEvents(this.goods, events);
            this.eventText = events.map(e => e.name).join(' ');
        } else {
            this.eventText = '';
        }
        this.selectedIndex = 0;
        this.text.event.text = this.eventText;
        this.text.status.text = '';
        this.refresh();
        return super.show(input);
    }

    private selectedGood(): TradeGood | undefined {
        return this.goods[this.selectedIndex];
    }

    private moveSelection(delta: number) {
        if (this.goods.length === 0) {
            return;
        }
        this.selectedIndex = Math.max(0, Math.min(
            this.goods.length - 1, this.selectedIndex + delta));
        this.refresh();
    }

    private buy(click?: ButtonClick) {
        const good = this.selectedGood();
        if (!good || !this.canBuySelected()) {
            return;
        }
        if (click?.option) {
            // Option+click: the bulk quantity dialog.
            void this.bulkBuy(good);
            return;
        }
        const bought = buyGood(this.state, good);
        this.text.status.text = bought > 0
            ? `Bought ${bought} ton${bought === 1 ? '' : 's'} of ${good.name}.`
            : '';
        this.refresh();
    }

    /**
     * The option-click bulk buy: a quantity dialog prefilled with (and
     * clamped to) the most that fits and is affordable.
     */
    private async bulkBuy(good: TradeGood) {
        const max = maxBuyQuantity(this.state, good);
        if (max <= 0) {
            return;
        }
        const quantity = await this.quantityDialog.show(
            { verb: 'Buy', initial: max, max });
        if (!quantity) {
            return;
        }
        const bought = buyGoodQuantity(this.state, good, quantity);
        this.text.status.text = bought > 0
            ? `Bought ${bought} ton${bought === 1 ? '' : 's'} of ${good.name}.`
            : '';
        this.refresh();
    }

    private sell(click?: ButtonClick) {
        const good = this.selectedGood();
        if (!good || !this.canSellSelected()) {
            return;
        }
        if (click?.option) {
            // Option+click: the bulk quantity dialog.
            void this.bulkSell(good);
            return;
        }
        const sold = sellGood(this.state, good);
        this.text.status.text = sold > 0
            ? `Sold ${sold} ton${sold === 1 ? '' : 's'} of ${good.name}.`
            : '';
        this.refresh();
    }

    /**
     * The option-click bulk sell: prefilled with the held tonnage, as
     * in the trade_center_hold_option_amount reference screenshot.
     */
    private async bulkSell(good: TradeGood) {
        const max = maxSellQuantity(this.state, good);
        if (max <= 0) {
            return;
        }
        const quantity = await this.quantityDialog.show(
            { verb: 'Sell', initial: max, max });
        if (!quantity) {
            return;
        }
        const sold = sellGoodQuantity(this.state, good, quantity);
        this.text.status.text = sold > 0
            ? `Sold ${sold} ton${sold === 1 ? '' : 's'} of ${good.name}.`
            : '';
        this.refresh();
    }

    private canBuySelected(): boolean {
        const good = this.selectedGood();
        return !!good && good.canBuy
            && this.state.credits.credits >= good.price
            && freeCargoSpace(this.state) > 0;
    }

    private canSellSelected(): boolean {
        const good = this.selectedGood();
        return !!good && good.canSell
            && (this.state.cargo.get(good.key) ?? 0) > 0;
    }

    /** Redraws the list, summary lines, and button states. */
    private refresh() {
        for (const text of this.rowTexts) {
            this.listContainer.removeChild(text);
            text.destroy();
        }
        this.rowTexts = [];
        for (const hit of this.rowHits) {
            this.listContainer.removeChild(hit);
            hit.destroy();
        }
        this.rowHits = [];
        this.highlight.clear();

        const start = Math.max(0, Math.min(
            this.selectedIndex - (LIST_ROWS - 2),
            this.goods.length - LIST_ROWS));
        const visible = this.goods.slice(start, start + LIST_ROWS);
        const tierLabel = { low: 'Low', med: 'Med', high: 'High' } as const;
        visible.forEach((good, i) => {
            const index = start + i;
            // Jünk rows sit below the standard commodities with a
            // blank line between, as in the original.
            const junkGap = good.key.startsWith('junk:') ? ROW_HEIGHT / 2 : 0;
            const y = LIST_TOP + i * ROW_HEIGHT + junkGap;
            if (index === this.selectedIndex) {
                // The original's full-width selection bar.
                this.highlight.beginFill(0x8b0000)
                    .drawRect(PANE_LEFT + 2, y,
                        PANE_RIGHT - PANE_LEFT - 4, ROW_HEIGHT)
                    .endFill();
            }
            // A full-width transparent hit target so the whole row —
            // everywhere the selection bar renders, not just the column
            // text — selects the commodity. Matches the highlight bounds.
            const hit = new PIXI.Container();
            hit.interactive = true;
            hit.cursor = 'pointer';
            hit.hitArea = new PIXI.Rectangle(
                PANE_LEFT + 2, y, PANE_RIGHT - PANE_LEFT - 4, ROW_HEIGHT);
            hit.on('pointerdown', () => {
                this.selectedIndex = index;
                this.text.status.text = '';
                this.refresh();
            });
            this.listContainer.addChild(hit);
            this.rowHits.push(hit);
            const held = this.state.cargo.get(good.key) ?? 0;
            // A price event replaces the Low/Med/High word with the
            // comparative "Lower"/"Higher", as in the reference.
            const tierWord = good.event
                ? (good.event.direction === 'lower' ? 'Lower' : 'Higher')
                : tierLabel[good.tier];
            const columns: [string, number, number][] = [
                [good.name, PANE_LEFT + 4, 0],
                [held > 0 ? `${held}` : '', HOLD_RIGHT, 1],
                [tierWord, TIER_LEFT, 0],
                [`${good.price.toLocaleString()}`, PRICE_RIGHT, 1],
            ];
            for (const [label, x, anchor] of columns) {
                if (!label) {
                    continue;
                }
                const text = new PIXI.Text(label,
                    anchor ? RIGHT_FONT : LIST_FONT);
                text.anchor.x = anchor;
                text.position.set(x, y);
                this.listContainer.addChild(text);
                this.rowTexts.push(text);
            }
        });
        if (this.goods.length === 0) {
            const text = new PIXI.Text(
                '(no goods traded here)', LIST_FONT);
            text.position.set(PANE_LEFT + 4, LIST_TOP);
            this.listContainer.addChild(text);
            this.rowTexts.push(text);
        }

        const other = otherCargoNames(this.state.cargo, this.goods);
        this.text.otherCargo.text = other.length > 0
            ? `Other cargo: ${other.join(', ')}` : '';
        this.text.freeSpace.text =
            `Free cargo space: ${freeCargoSpace(this.state)} tons`;

        this.buttons.buy.state = this.canBuySelected() ? 'normal' : 'grey';
        this.buttons.sell.state = this.canSellSelected() ? 'normal' : 'grey';
    }

    /** Commits the working cargo and credits back onto the entity. */
    protected override done() {
        this.input.components.set(CargoComponent, this.state.cargo);
        this.input.components.set(CreditsComponent,
            { credits: this.state.credits.credits });
        super.done();
    }
}
