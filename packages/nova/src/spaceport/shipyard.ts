import { OutfitData } from 'novadatainterface/outfit_data';
import { ShipData } from 'novadatainterface/ship_data';
import { Entity } from 'nova_ecs/entity';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import * as PIXI from 'pixi.js';
import { Observable } from 'rxjs';
import { DisplayAssetDataInterface } from '../client/gamedata/display_asset_data.js';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { ControlEvent } from '../nova_plugin/controls_plugin.js';
import { ShipComponent } from '../nova_plugin/ship_plugin.js';
import { Button } from './button.js';
import { ItemGrid, ItemTile } from './item_grid.js';
import { Menu } from './menu.js';
import { FONT } from './outfitter.js';
import { ShipInfoDialog } from './ship_info.js';
import {
    SHIPYARD_PRICE_LABELS,
    ShipyardPriceReadout,
    shipyardPriceReadout,
} from './shipyard_content.js';
import {
    buildPurchasedShip,
    canBuyShip,
    purchaseContextFrom,
    ShipPurchaseContext,
} from './shipyard_rules.js';

export class Shipyard extends Menu<Entity> {
    private pictContainer = new PIXI.Container();
    itemGrid?: ItemGrid<ShipData>;
    private shipInfo: ShipInfoDialog;
    /**
     * Every outfit in the game, loaded once in build(). The purchase
     * rules need each owned outfit's price and persistence flag, and the
     * valuation must not depend on which outfits happen to be cached.
     */
    private allOutfits = new Map<string, OutfitData>();
    /** The ShipData of the hull the player is currently flying. */
    private currentShipData?: ShipData;
    private text = {
        description: new PIXI.Text("", FONT.normal),
        // The price pane under the ship picture. Labels and values in
        // two columns, in the original's wording and row order — see
        // shipyard_content.ts for the reference shot it is measured
        // against.
        shipPriceLabel: new PIXI.Text(SHIPYARD_PRICE_LABELS.shipPrice,
            FONT.normal),
        shipPrice: new PIXI.Text("", FONT.normal),
        tradeInLabel: new PIXI.Text(SHIPYARD_PRICE_LABELS.tradeIn, FONT.normal),
        tradeIn: new PIXI.Text("", FONT.normal),
        finalPriceLabel: new PIXI.Text(SHIPYARD_PRICE_LABELS.finalPrice,
            FONT.normal),
        finalPrice: new PIXI.Text("", FONT.normal),
        youHaveLabel: new PIXI.Text(SHIPYARD_PRICE_LABELS.youHave, FONT.normal),
        youHave: new PIXI.Text("", FONT.normal),
        // The denial caption, mirroring the outfitter's status line.
        status: new PIXI.Text("", { ...FONT.normal, wordWrapWidth: 145 }),
    }
    private buttons: { info: Button, buy: Button, done: Button };

    constructor(displayAssets: DisplayAssetDataInterface,
        simulationData: SimulationGameDataInterface,
        controlEvents: Observable<ControlEvent>) {
        super(displayAssets, simulationData, "nova:8502", controlEvents);
        this.container.name = 'Shipyard';
        const buttons = {
            info: new Button(displayAssets, "Info", 60, { x: -140, y: 126 }),
            buy: new Button(displayAssets, "Buy", 60, { x: -20, y: 126 }),
            done: new Button(displayAssets, "Done", 60, { x: 100, y: 126 }),
        };
        this.buttons = buttons;
        this.addButtons(buttons);

        buttons.info.click.subscribe(() => void this.showInfo());
        buttons.buy.click.subscribe(this.buyShip.bind(this));
        buttons.done.click.subscribe(this.done.bind(this));

        this.shipInfo = new ShipInfoDialog(displayAssets, simulationData,
            controlEvents);
        this.container.addChild(this.shipInfo.container);

        this.text.description.position.x = -27;
        this.text.description.position.y = -150;
        this.text.status.position.x = -27;
        this.text.status.position.y = 100;

        // The price pane, measured against
        // shipyard/earth_spaceport.png: labels at the same column the
        // outfitter's "Item Price:" uses (both menus share the nova:8502
        // frame), values 70px right of it, and rows on a 12px pitch with
        // a blank line before "Final Price:" and another before "You
        // Have:" — 58 / 70 / 94 / 118.
        const LABEL_X = 234, VALUE_X = 304;
        const rows = [
            [this.text.shipPriceLabel, this.text.shipPrice, 58],
            [this.text.tradeInLabel, this.text.tradeIn, 70],
            [this.text.finalPriceLabel, this.text.finalPrice, 94],
            [this.text.youHaveLabel, this.text.youHave, 118],
        ] as const;
        for (const [label, value, y] of rows) {
            label.position.set(LABEL_X, y);
            value.position.set(VALUE_X, y);
        }

        for (const t of Object.values(this.text)) {
            this.container.addChild(t);
        }
        this.pictContainer.position.x = 174;
        this.pictContainer.position.y = -152.5;
        this.container.addChild(this.pictContainer);
        this.build();
    }

    protected override async build() {
        await super.build();
        await this.loadOutfits();
        const itemGrid = await this.makeShipsGrid();
        this.itemGrid = itemGrid;
        this.container.addChild(itemGrid.container);

        this.itemGrid.drawGrid();
        this.itemGrid.container.position.x = -373;
        this.itemGrid.container.position.y = -153;
        this.itemGrid.activeTile.subscribe(this.setShipSelected.bind(this));

        this.controls.controls = {
            left: () => itemGrid.left(),
            right: () => itemGrid.right(),
            up: () => itemGrid.up(),
            down: () => itemGrid.down(),
            buy: this.buyShip.bind(this),
            depart: this.done.bind(this),
        };
    }

    private async makeShipsGrid() {
        const ids = (await this.simulationData.ids).Ship;
        const ships = await Promise.all(ids.map(id =>
            this.simulationData.data.Ship.get(id, 100)));
        ships.sort((a, b) => b.displayWeight - a.displayWeight);
        const itemGrid = new ItemGrid(this.displayAssets, ships);
        return itemGrid;
    }

    /** Loads every outfit once, for the trade-in valuation. */
    private async loadOutfits() {
        try {
            const ids = (await this.simulationData.ids).Outfit;
            const outfits = await Promise.all(ids.map(id =>
                this.simulationData.data.Outfit.get(id)));
            this.allOutfits = new Map(outfits.map(o => [o.id, o]));
        } catch (e) {
            console.warn('Failed to load outfits for ship pricing:', e);
        }
    }

    /**
     * The current ship + outfits + credits the purchase rules price
     * against, or undefined while the current hull's data is still
     * loading (in which case no purchase may proceed).
     */
    private purchaseContext(): ShipPurchaseContext | undefined {
        if (!this.currentShipData || !this.input) {
            return undefined;
        }
        return purchaseContextFrom(this.input, this.currentShipData,
            id => this.allOutfits.get(id));
    }

    protected override setInput(input: Entity) {
        super.setInput(input);
        this.text.status.text = "";
        this.currentShipData = undefined;
        const shipId = input.components.get(ShipComponent)?.id;
        if (shipId) {
            this.simulationData.data.Ship.get(shipId).then(shipData => {
                // Ignore stale loads after the input changes.
                if (this.input === input) {
                    this.currentShipData = shipData;
                    this.refreshTradeState();
                }
            }).catch(e => console.warn('Failed to load current ship:', e));
        }
        this.refreshTradeState();
    }

    /**
     * Re-quotes the price pane, greys the Buy button for a ship the
     * player cannot afford, and shows the denial caption as the
     * outfitter does for outfits.
     *
     * Every path that can change either the quote or its answer runs
     * this: a new selection (setShipSelected), a new input entity or its
     * ShipData arriving (setInput), and a completed purchase (buyShip) —
     * which is what makes a second trade in the same visit quote against
     * the hull just bought and the credits just spent.
     */
    private refreshTradeState() {
        const ship = this.itemGrid?.selection;
        const context = this.purchaseContext();
        this.setPriceText(shipyardPriceReadout(ship, context));
        if (!ship || !context) {
            this.buttons.buy.state = 'grey';
            return;
        }
        const check = canBuyShip(ship, context);
        this.buttons.buy.state = check.allowed ? 'normal' : 'grey';
        this.text.status.text = check.allowed ? '' : check.message;
    }

    /**
     * Writes the price pane, or blanks it (labels and all, as the
     * original's empty info pane does) when there is nothing to quote.
     */
    private setPriceText(readout: ShipyardPriceReadout | undefined) {
        const fields = ['shipPrice', 'tradeIn', 'finalPrice', 'youHave'] as const;
        for (const field of fields) {
            this.text[field].text = readout?.[field] ?? "";
            this.text[field].visible = readout !== undefined;
            this.text[`${field}Label` as const].visible = readout !== undefined;
        }
    }

    private setShipSelected(shipTile: ItemTile<ShipData> | undefined) {
        this.pictContainer.removeChildren();
        if (!shipTile) {
            // Nothing selected: clear the description and blank the
            // price pane rather than leave the last ship's quote up.
            this.text.description.text = "";
            this.refreshTradeState();
            return;
        }

        if (shipTile.largePict) {
            this.pictContainer.addChild(shipTile.largePict);
        }

        // Set Description
        this.text.description.text = shipTile.item.desc;
        this.refreshTradeState();
    }

    /** Opens the ship info dialog for the selected ship. */
    private async showInfo() {
        const ship = this.itemGrid?.selection;
        if (!ship) {
            return;
        }
        this.controls.unbind();
        // Re-adding moves the dialog to the top of the shipyard's
        // display list, so it draws over the ship grid.
        this.container.addChild(this.shipInfo.container);
        await this.shipInfo.show(ship);
        this.controls.bind();
    }

    private buyShip() {
        const newShip = this.itemGrid?.selection;
        if (!newShip) {
            return;
        }
        const multiplayerData = this.input.components.get(MultiplayerData);
        if (!multiplayerData) {
            console.warn('Missing multiplayer data for prior ship.');
            return;
        }
        const context = this.purchaseContext();
        if (!context) {
            // Ship or outfit data still loading; refuse rather than
            // charge a price computed from an incomplete valuation.
            return;
        }
        const check = canBuyShip(newShip, context);
        if (!check.allowed) {
            // Affordability is already reflected in the greyed Buy
            // button; this covers the keyboard shortcut path too.
            this.text.status.text = check.message;
            return;
        }
        // Swapping this.input is how a ship purchase is communicated:
        // Menu.done() emits it, and the Spaceport re-runs the stat
        // providers on the entity it gets back (spaceport.ts).
        this.input = buildPurchasedShip(this.input, newShip, context);
        // The hull just bought is what a SECOND purchase in this same
        // visit trades in, so the valuation must follow it immediately
        // rather than keep pricing against the ship we no longer own.
        this.currentShipData = newShip;

        this.text.status.text = "";
        this.refreshTradeState();
        // For convenience
        (window as any).myShip = this.input;
    }
}
