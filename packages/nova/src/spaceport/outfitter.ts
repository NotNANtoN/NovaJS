import { GovtData } from "novadatainterface/govt_data";
import { OutfitData } from "novadatainterface/outfit_data";
import { ShipData } from "novadatainterface/ship_data";
import { Entity } from "nova_ecs/entity";
import { DefaultMap } from "nova_ecs/utils";
import * as PIXI from 'pixi.js';
import { Observable } from "rxjs";
import { DisplayAssetDataInterface } from "../client/gamedata/display_asset_data.js";
import { SimulationGameDataInterface } from "../client/gamedata/simulation_game_data.js";
import { ControlEvent } from "../nova_plugin/controls_plugin.js";
import { makeControlBitHooks, NCBParseError, runNCBSet } from "../nova_plugin/ncb.js";
import { ControlBits, ControlBitsComponent } from "../nova_plugin/ncb_plugin.js";
import { OutfitsStateComponent } from "../nova_plugin/outfit_plugin.js";
import { cleanRecords, LegalRecords } from "../nova_plugin/reputation.js";
import { LegalRecordsComponent } from "../nova_plugin/reputation_plugin.js";
import { ShipComponent } from "../nova_plugin/ship_plugin.js";
import { Button } from "./button.js";
import { ItemGrid, ItemTile } from "./item_grid.js";
import { Menu } from "./menu.js";
import { canBuyOutfit, canSellOutfit, freeMass, OutfitterContext } from "./outfitter_rules.js";


const descWidth = 190;
export const FONT = {
    normal: {
        fontFamily: "Geneva", fontSize: 10, fill: 0xffffff,
        align: 'left', wordWrap: true, wordWrapWidth: descWidth
    } as const,
    grey: {
        fontFamily: "Geneva", fontSize: 10, fill: 0x262626,
        align: 'left', wordWrap: true, wordWrapWidth: descWidth
    } as const,
    count: {
        fontFamily: "Geneva", fontSize: 10, fill: 0xffffff,
        align: 'right', wordWrap: false, wordWrapWidth: descWidth
    } as const,
};

export class Outfitter extends Menu<Entity> {
    private itemGrid?: ItemGrid<OutfitData>;
    private pictContainer = new PIXI.Container();
    /** Working copies, committed to the ship entity on done. */
    private outfits: DefaultMap<string, number>;
    private controlBits: ControlBits = new Set();
    private records: LegalRecords = new Map();
    /** Every govt, sorted by id, loaded in build() for ModType 21. */
    private govts: (readonly [string, GovtData])[] = [];
    private shipData?: ShipData;

    private text = {
        description: new PIXI.Text("", FONT.normal),
        itemPrice: new PIXI.Text("Item Price:", FONT.normal),
        price: new PIXI.Text("5,000 cr", FONT.normal),
        youHave: new PIXI.Text("You Have:", FONT.normal),
        count: new PIXI.Text("∞ cr", FONT.normal),
        itemMass: new PIXI.Text("Item Mass:", FONT.normal),
        mass: new PIXI.Text("3", FONT.normal),
        availableMass: new PIXI.Text("Available:", FONT.normal),
        freeMass: new PIXI.Text("", FONT.normal),
        status: new PIXI.Text("", FONT.normal),
    }

    constructor(displayAssets: DisplayAssetDataInterface,
        simulationData: SimulationGameDataInterface,
        controlEvents: Observable<ControlEvent>) {
        super(displayAssets, simulationData, "nova:8502", controlEvents);

        this.outfits = new DefaultMap(() => 0);
        const buttons = {
            buy: new Button(displayAssets, "Buy", 60, { x: -100, y: 126 }),
            sell: new Button(displayAssets, "Sell", 60, { x: 0, y: 126 }),
            done: new Button(displayAssets, "Done", 60, { x: 100, y: 126 })
        };

        buttons.buy.click.subscribe(this.buyOutfit.bind(this));
        buttons.sell.click.subscribe(this.sellOutfit.bind(this));
        buttons.done.click.subscribe(this.done.bind(this));
        this.addButtons(buttons);

        this.pictContainer.position.x = 174;
        this.pictContainer.position.y = -152.5;
        this.pictContainer.scale.x = 1;
        this.pictContainer.scale.y = 1;
        this.container.addChild(this.pictContainer);

        this.text.description.position.x = -27;
        this.text.description.position.y = -150;

        this.text.itemPrice.position.x = 234;
        this.text.itemPrice.position.y = 58;

        this.text.price.position.x = 300;
        this.text.price.position.y = 58;

        this.text.youHave.position.x = 234;
        this.text.youHave.position.y = 70;

        this.text.count.position.x = 300;
        this.text.count.position.y = 70;

        this.text.itemMass.position.x = 234;
        this.text.itemMass.position.y = 94;

        this.text.mass.position.x = 300;
        this.text.mass.position.y = 94;

        this.text.availableMass.position.x = 234;
        this.text.availableMass.position.y = 106;

        this.text.freeMass.position.x = 300;
        this.text.freeMass.position.y = 106;

        this.text.status.position.x = -170;
        this.text.status.position.y = 118;

        for (const t of Object.values(this.text)) {
            this.container.addChild(t);
        }
    }

    protected override async build() {
        // ModType 21 (clean legal record) needs govt data: ModVal -1
        // cleans every govt, and cleaning consults InitialRec.
        const govtIds = [...(await this.simulationData.ids).Govt].sort();
        this.govts = await Promise.all(govtIds.map(async id =>
            [id, await this.simulationData.data.Govt.get(id)] as const));
        const itemGrid = await this.makeOutfitsGrid();
        this.itemGrid = itemGrid;
        this.container.addChild(this.itemGrid.container);

        this.itemGrid.drawGrid();
        this.itemGrid.container.position.x = -373;
        this.itemGrid.container.position.y = -153;
        this.itemGrid.activeTile.subscribe(this.setOutfitSelected.bind(this));

        this.controls.controls = {
            left: () => itemGrid.left(),
            right: () => itemGrid.right(),
            up: () => itemGrid.up(),
            down: () => itemGrid.down(),
            buy: this.buyOutfit.bind(this),
            sell: this.sellOutfit.bind(this),
            depart: this.done.bind(this),
        };
    }

    private async makeOutfitsGrid() {
        const ids = (await this.simulationData.ids).Outfit;
        const outfits = await Promise.all(ids.map(id =>
            this.simulationData.data.Outfit.get(id, 100)));
        outfits.sort((a, b) => b.displayWeight - a.displayWeight);

        // Purchase checks look weapons up synchronously, so warm the
        // cache with every weapon the outfits grant or feed ammo to.
        const weaponIds = new Set<string>();
        for (const outfit of outfits) {
            for (const weaponId of Object.keys(outfit.weapons)) {
                weaponIds.add(weaponId);
            }
            if (outfit.ammoFor) {
                weaponIds.add(outfit.ammoFor);
            }
        }
        await Promise.all([...weaponIds].map(id =>
            this.simulationData.data.Weapon.get(id, 100)));

        const itemGrid = new ItemGrid(this.displayAssets, outfits);
        itemGrid.setCounts(this.outfits);
        return itemGrid;
    }

    private makeContext(): OutfitterContext | undefined {
        if (!this.shipData) {
            return undefined;
        }
        return {
            shipData: this.shipData,
            outfits: this.outfits,
            getOutfit: id => this.simulationData.data.Outfit.getCached(id),
            getWeapon: id => this.simulationData.data.Weapon.getCached(id),
            bits: this.controlBits,
        };
    }

    /**
     * Runs an outfit's OnPurchase / OnSell control bit set string
     * against the working outfits and control bits. Gxxx grants here
     * intentionally bypass the purchase checks.
     */
    private runSetString(expression: string) {
        if (!expression) {
            return;
        }
        try {
            // The purchase itself is a player decision, not simulation
            // logic, so plain randomness is fine for R(a b) here: only
            // the resulting state reaches the simulation.
            runNCBSet(expression, makeControlBitHooks(this.controlBits, {
                outfits: this.outfits,
                resolveId: id => `nova:${id}`,
            }), Math.random);
        } catch (error) {
            if (error instanceof NCBParseError) {
                console.warn('Bad control bit set string:', error);
                return;
            }
            throw error;
        }
    }

    private buyOutfit() {
        const outfit = this.itemGrid?.selection;
        const context = this.makeContext();
        if (!outfit || !context) {
            return;
        }

        const check = canBuyOutfit(outfit, context);
        if (!check.allowed) {
            this.text.status.text = check.message;
            return;
        }
        this.text.status.text = "";

        this.outfits.set(outfit.id, this.outfits.get(outfit.id) + 1);
        // ModType 21: buying the outfit cleans (raises to at least 0)
        // the player's legal record with the ModVal govt, or with every
        // govt when ModVal is -1. Applies once, at purchase.
        if (outfit.cleanLegalRecord !== null) {
            if (outfit.cleanLegalRecord === -1) {
                cleanRecords(this.records, 'all', undefined, this.govts);
            } else {
                const govtId = `nova:${outfit.cleanLegalRecord}`;
                cleanRecords(this.records, 'govt',
                    this.govts.find(([id]) => id === govtId)?.[1],
                    this.govts);
            }
        }
        this.runSetString(outfit.onPurchase);
        this.itemGrid?.setCounts(this.outfits);
        this.setFreeMassText();
    }

    private sellOutfit() {
        const outfit = this.itemGrid?.selection;
        const context = this.makeContext();
        if (!outfit || !context) {
            return;
        }

        const check = canSellOutfit(outfit, context);
        if (!check.allowed) {
            this.text.status.text = check.message;
            return;
        }
        this.text.status.text = "";

        this.outfits.set(outfit.id, Math.max(0, this.outfits.get(outfit.id) - 1));
        if (this.outfits.get(outfit.id) === 0) {
            this.outfits.delete(outfit.id);
        }
        this.runSetString(outfit.onSell);
        this.itemGrid?.setCounts(this.outfits);
        this.setFreeMassText();
    }

    private setOutfitSelected(outfitTile: ItemTile<OutfitData> | undefined) {
        // Set Picture
        this.pictContainer.removeChildren();
        this.text.description.text = "";
        this.text.price.text = "";
        this.text.status.text = "";
        this.text.mass.visible = false;
        this.text.itemMass.visible = false;
        this.text.availableMass.visible = false;
        this.text.freeMass.visible = false;

        if (!outfitTile) {
            return;
        }

        if (outfitTile.largePict) {
            this.pictContainer.addChild(outfitTile.largePict);
        }

        // Set Description
        this.text.description.text = outfitTile.item.desc;

        // Set price text
        this.text.price.text = formatPrice(outfitTile.item.price);

        if (outfitTile.item.physics.freeMass > 0) {
            // Set mass text
            this.text.mass.text = outfitTile.item.physics.freeMass + " tons";
            this.setFreeMassText();
            this.text.mass.visible = true;
            this.text.itemMass.visible = true;
            this.text.availableMass.visible = true;
            this.text.freeMass.visible = true;
        }
    }

    private setFreeMassText() {
        const context = this.makeContext();
        if (context) {
            this.text.freeMass.text = formatMass(freeMass(context));
        }
    }

    protected override setInput(input: Entity) {
        super.setInput(input);
        const outfitsState = input.components.get(OutfitsStateComponent)
            ?? new Map();
        this.outfits = new DefaultMap(() => 0, [...outfitsState].map(
            ([k, v]) => [k, v.count]));
        this.controlBits = new Set(
            input.components.get(ControlBitsComponent) ?? []);
        this.records = new Map(
            input.components.get(LegalRecordsComponent) ?? []);
        this.text.status.text = "";

        this.shipData = undefined;
        const shipId = input.components.get(ShipComponent)?.id;
        if (shipId) {
            this.simulationData.data.Ship.get(shipId).then(shipData => {
                // Ignore stale loads after the input changes.
                if (this.input === input) {
                    this.shipData = shipData;
                    this.setFreeMassText();
                }
            });
        }
        this.itemGrid?.setCounts(this.outfits);
    }

    protected override done() {
        this.input.components.set(OutfitsStateComponent, new Map(
            [...this.outfits]
                .filter(([, count]) => count > 0)
                .map(([id, count]) => [id, { count }])));
        this.input.components.set(ControlBitsComponent, this.controlBits);
        this.input.components.set(LegalRecordsComponent, this.records);
        super.done();
    }
}

function addCommas(p: number) {
    return p.toLocaleString();
}

function formatPrice(p: number) {
    var mil = 1000000;
    if (p >= mil) {
        var modmil = String(p % mil).substring(0, 3);
        modmil += "0".repeat(3 - modmil.length);
        return addCommas(Math.floor(p / mil)) + "." + modmil + "M cr";
    }
    else {
        return addCommas(p) + " cr";
    }
};

function formatMass(m: number) {
    return m.toLocaleString() + " tons";
};
