import { JunkData } from 'novadatainterface/junk_data';
import { PlanetData } from 'novadatainterface/planet_data';
import { Entity } from 'nova_ecs/entity';
import * as PIXI from 'pixi.js';
import { Observable } from 'rxjs';
import { DisplayAssetDataInterface } from '../client/gamedata/display_asset_data.js';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { CargoComponent } from '../nova_plugin/cargo_plugin.js';
import { ControlEvent } from '../nova_plugin/controls_plugin.js';
import { ControlBitsComponent } from '../nova_plugin/ncb_plugin.js';
import { CreditsComponent } from '../nova_plugin/player_state_plugin.js';
import {
    buyGood,
    freeCargoSpace,
    junkTradeGood,
    otherCargoNames,
    sellGood,
    standardTradeGoods,
    TradeGood,
    TradeWorkingState,
} from '../nova_plugin/trade_logic.js';
import { Button } from './button.js';
import { Menu } from './menu.js';
import { computeCargoCapacity } from './mission_session.js';

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
    private buttons: {
        buy: Button, sell: Button, done: Button,
    };

    private text = {
        headerCommodity: new PIXI.Text('Commodity:', LIST_FONT),
        headerHold: new PIXI.Text('In Hold:', RIGHT_FONT),
        headerPrice: new PIXI.Text('Price:', RIGHT_FONT),
        otherCargo: new PIXI.Text('', LIST_FONT),
        freeSpace: new PIXI.Text('', LIST_FONT),
        status: new PIXI.Text('', LIST_FONT),
    };

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
        this.buttons.buy.click.subscribe(this.buy.bind(this));
        this.buttons.sell.click.subscribe(this.sell.bind(this));
        this.buttons.done.click.subscribe(this.done.bind(this));
        this.addButtons(this.buttons);

        this.text.headerCommodity.position.set(PANE_LEFT + 4, PANE_TOP);
        this.text.headerHold.anchor.x = 1;
        this.text.headerHold.position.set(HOLD_RIGHT, PANE_TOP);
        this.text.headerPrice.anchor.x = 1;
        this.text.headerPrice.position.set(PRICE_RIGHT, PANE_TOP);
        this.text.otherCargo.position.set(PANE_LEFT + 4, SUMMARY_TOP);
        this.text.freeSpace.position.set(PANE_LEFT + 4, SUMMARY_TOP + 16);
        this.text.status.position.set(PANE_LEFT + 4, STATUS_TOP);

        this.container.addChild(this.highlight, this.listContainer);
        for (const t of Object.values(this.text)) {
            this.container.addChild(t);
        }

        this.controls.controls = {
            up: () => this.moveSelection(-1),
            down: () => this.moveSelection(1),
            buy: this.buy.bind(this),
            sell: this.sell.bind(this),
            depart: this.done.bind(this),
        };
    }

    protected override async build() {
        const [planet, junkIds] = await Promise.all([
            this.simulationData.data.Planet.get(this.planetId),
            this.simulationData.ids.then(ids => ids.Junk),
        ]);
        this.planet = planet;
        this.junks = await Promise.all(junkIds.map(
            id => this.simulationData.data.Junk.get(id)));
    }

    override async show(input: Entity): Promise<Entity> {
        await this.buildPromise;
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
        this.goods = this.planet ? standardTradeGoods(this.planet) : [];
        // Jünk rows follow the standard commodities, as in the
        // original's exchange listing.
        for (const junk of this.junks) {
            const row = junkTradeGood(junk, this.planetId, bits);
            if (row) {
                this.goods.push(row);
            }
        }
        this.selectedIndex = 0;
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

    private buy() {
        const good = this.selectedGood();
        if (!good || !this.canBuySelected()) {
            return;
        }
        const bought = buyGood(this.state, good);
        this.text.status.text = bought > 0
            ? `Bought ${bought} ton${bought === 1 ? '' : 's'} of ${good.name}.`
            : '';
        this.refresh();
    }

    private sell() {
        const good = this.selectedGood();
        if (!good || !this.canSellSelected()) {
            return;
        }
        const sold = sellGood(this.state, good);
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
            const held = this.state.cargo.get(good.key) ?? 0;
            const columns: [string, number, number][] = [
                [good.name, PANE_LEFT + 4, 0],
                [held > 0 ? `${held}` : '', HOLD_RIGHT, 1],
                [tierLabel[good.tier], TIER_LEFT, 0],
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
                text.interactive = true;
                text.cursor = 'pointer';
                text.on('pointerdown', () => {
                    this.selectedIndex = index;
                    this.text.status.text = '';
                    this.refresh();
                });
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
