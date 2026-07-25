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
import { idPrefix } from "../nova_plugin/mission_logic.js";
import { Button, ButtonClick } from "./button.js";
import { ItemGrid, ItemTile } from "./item_grid.js";
import { Menu } from "./menu.js";
import { MissionSession } from "./mission_session.js";
import { MissionUniverse } from "./mission_universe.js";
import { BuyDenialReason, canBuyOutfit, canSellOutfit, freeCargo, freeMass, maxBuyCount, maxSellCount, OutfitterContext } from "./outfitter_rules.js";
import { QuantityDialog } from "./quantity_dialog.js";


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
    private quantityDialog: QuantityDialog;
    private pictContainer = new PIXI.Container();
    /** Working copies, committed to the ship entity on done. */
    private outfits: DefaultMap<string, number>;
    private controlBits: ControlBits = new Set();
    private records: LegalRecords = new Map();
    /** Every govt, sorted by id, loaded in build() for ModType 21. */
    private govts: (readonly [string, GovtData])[] = [];
    private shipData?: ShipData;
    /**
     * Built per-visit so outfit purchase/sell set strings can run the
     * mission operators Sxxx/Axxx/Fxxx (start/fail/abort a mission), not
     * just control-bit ops. Undefined until show() has built it (or if
     * the build failed — then set strings fall back to bit-only hooks).
     */
    private missionSession?: MissionSession;

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
        // The denial / purchase feedback line at the bottom of the
        // right info pane ("Can't have any more!" in the reference
        // outfitter screenshots).
        status: new PIXI.Text("", {
            ...FONT.normal, wordWrapWidth: 145,
        }),
    }
    private buttons: { buy: Button, sell: Button, done: Button };

    constructor(displayAssets: DisplayAssetDataInterface,
        simulationData: SimulationGameDataInterface,
        controlEvents: Observable<ControlEvent>) {
        super(displayAssets, simulationData, "nova:8502", controlEvents);
        this.container.name = 'Outfitter';

        this.outfits = new DefaultMap(() => 0);
        // Measured against outfitter/earth_outfitter.png: the pill
        // centers sit at -48 / +62 / +170 relative to the frame
        // center, on a row centered 147px below it.
        this.buttons = {
            buy: new Button(displayAssets, "Buy", 70, { x: -96, y: 134 }),
            sell: new Button(displayAssets, "Sell", 70, { x: 14, y: 134 }),
            done: new Button(displayAssets, "Done", 70, { x: 122, y: 134 })
        };

        // Option+click opens the bulk quantity dialog, as the
        // original's outfitter does.
        this.buttons.buy.click.subscribe(click => this.buyOutfit(click));
        this.buttons.sell.click.subscribe(click => this.sellOutfit(click));
        this.buttons.done.click.subscribe(this.done.bind(this));
        this.addButtons(this.buttons);

        this.quantityDialog = new QuantityDialog(controlEvents);

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

        // Bottom of the right info pane, under the Available row —
        // where the reference screenshots put "Can't have any more!".
        this.text.status.position.x = 234;
        this.text.status.position.y = 128;

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

        // On top of everything, so its modal shield covers the screen.
        this.container.addChild(this.quantityDialog.container);

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
    private runSetString(expression: string, resourcePrefix = 'nova') {
        if (!expression) {
            return;
        }
        // When a mission session is available, run the string through the
        // full mission machinery so Sxxx/Axxx/Fxxx (start/fail/abort a
        // mission) take effect, not just control-bit ops. The session
        // shares this.outfits' contents and this.controlBits, so sync the
        // outfit counts into it first (buy/sell mutate this.outfits).
        if (this.missionSession) {
            this.missionSession.outfits.clear();
            for (const [id, count] of this.outfits) {
                if (count > 0) {
                    this.missionSession.outfits.set(id, count);
                }
            }
            // Buying/selling a freeCargo outfit changes the hold; refresh
            // the session's cargo capacity so an OnPurchase/OnSell Sxxx that
            // starts a cargo mission checks against the current hold (L6).
            const context = this.makeContext();
            if (context) {
                this.missionSession.setCargoCapacity(freeCargo(context));
            }
            try {
                this.missionSession.runMissionSet(expression, resourcePrefix);
            } catch (error) {
                if (error instanceof NCBParseError) {
                    console.warn('Bad outfit mission set string:', error);
                } else {
                    throw error;
                }
            }
            // Reflect any Gxxx/Dxxx outfit grants back into the grid copy.
            this.outfits = new DefaultMap(() => 0,
                [...this.missionSession.outfits]);
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

    /** Applies one unit's purchase: count, ModType 21, OnPurchase. */
    private applyBuy(outfit: OutfitData) {
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
        this.runSetString(outfit.onPurchase, idPrefix(outfit.id));
    }

    /** Applies one unit's sale: count and OnSell. */
    private applySell(outfit: OutfitData) {
        this.outfits.set(outfit.id, Math.max(0, this.outfits.get(outfit.id) - 1));
        if (this.outfits.get(outfit.id) === 0) {
            this.outfits.delete(outfit.id);
        }
        this.runSetString(outfit.onSell, idPrefix(outfit.id));
    }

    /**
     * The original outfitter's denial captions (see the
     * outfitter/earth_outfitter_cant_*.png reference screenshots):
     * shown persistently at the bottom of the right info pane while a
     * denied selection is highlighted, with the Buy button greyed.
     */
    private denialCaption(reason: BuyDenialReason, owned: number,
        fallback: string): string {
        switch (reason) {
            case 'availability':
            case 'require':
                return owned > 0
                    ? "Can't have any more!"
                    : "Can't have any of this item!";
            case 'maxCount':
                return "Can't have any more!";
            case 'mass':
            case 'cargo':
                return owned > 0
                    ? "Can't hold any more of this item!"
                    : "Can't hold any of this item!";
            default:
                // Hardpoint / launcher denials keep the descriptive
                // rule message (the references don't show them).
                return fallback;
        }
    }

    /**
     * Recomputes the Buy/Sell button states and the persistent denial
     * caption for the current selection, as the original does.
     */
    private refreshTradeState() {
        const outfit = this.itemGrid?.selection;
        const context = this.makeContext();
        if (!outfit || !context) {
            this.buttons.buy.state = 'grey';
            this.buttons.sell.state = 'grey';
            return;
        }
        const buyCheck = canBuyOutfit(outfit, context);
        const sellCheck = canSellOutfit(outfit, context);
        this.buttons.buy.state = buyCheck.allowed ? 'normal' : 'grey';
        this.buttons.sell.state = sellCheck.allowed ? 'normal' : 'grey';
        this.text.status.text = buyCheck.allowed ? ''
            : this.denialCaption(buyCheck.reason,
                context.outfits.get(outfit.id) ?? 0, buyCheck.message);
    }

    private buyOutfit(click?: ButtonClick) {
        if (click?.option) {
            // Option+click: the bulk quantity dialog.
            void this.bulkBuy();
            return;
        }
        const outfit = this.itemGrid?.selection;
        const context = this.makeContext();
        if (!outfit || !context) {
            return;
        }

        if (!canBuyOutfit(outfit, context).allowed) {
            // The persistent caption and greyed button already explain.
            this.refreshTradeState();
            return;
        }

        this.applyBuy(outfit);
        this.itemGrid?.setCounts(this.outfits);
        this.setFreeMassText();
        this.refreshTradeState();
    }

    /**
     * The option-click bulk buy: a quantity dialog prefilled with (and
     * clamped to) the most the checks allow, then that many unit
     * purchases, each re-checked (OnPurchase effects can change what a
     * later unit is allowed to do).
     */
    private async bulkBuy() {
        const outfit = this.itemGrid?.selection;
        const context = this.makeContext();
        if (!outfit || !context) {
            return;
        }
        const max = maxBuyCount(outfit, context);
        if (max <= 0) {
            const check = canBuyOutfit(outfit, context);
            if (!check.allowed) {
                this.text.status.text = check.message;
            }
            return;
        }
        const quantity = await this.quantityDialog.show(
            { verb: 'Buy', initial: max, max });
        if (!quantity) {
            return;
        }
        let bought = 0;
        while (bought < quantity) {
            const step = this.makeContext();
            if (!step || !canBuyOutfit(outfit, step).allowed) {
                break;
            }
            this.applyBuy(outfit);
            bought++;
        }
        this.itemGrid?.setCounts(this.outfits);
        this.setFreeMassText();
        this.refreshTradeState();
        if (bought > 0 && !this.text.status.text) {
            this.text.status.text = `Bought ${bought} x ${outfit.name}.`;
        }
    }

    private sellOutfit(click?: ButtonClick) {
        if (click?.option) {
            // Option+click: the bulk quantity dialog.
            void this.bulkSell();
            return;
        }
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

        this.applySell(outfit);
        this.itemGrid?.setCounts(this.outfits);
        this.setFreeMassText();
        this.refreshTradeState();
    }

    /** The option-click bulk sell: prefilled with everything owned. */
    private async bulkSell() {
        const outfit = this.itemGrid?.selection;
        const context = this.makeContext();
        if (!outfit || !context) {
            return;
        }
        const max = maxSellCount(outfit, context);
        if (max <= 0) {
            const check = canSellOutfit(outfit, context);
            if (!check.allowed) {
                this.text.status.text = check.message;
            }
            return;
        }
        const quantity = await this.quantityDialog.show(
            { verb: 'Sell', initial: max, max });
        if (!quantity) {
            return;
        }
        let sold = 0;
        while (sold < quantity) {
            const step = this.makeContext();
            if (!step || !canSellOutfit(outfit, step).allowed) {
                break;
            }
            this.applySell(outfit);
            sold++;
        }
        this.itemGrid?.setCounts(this.outfits);
        this.setFreeMassText();
        this.refreshTradeState();
        if (sold > 0 && !this.text.status.text) {
            this.text.status.text = `Sold ${sold} x ${outfit.name}.`;
        }
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
        this.refreshTradeState();
    }

    private setFreeMassText() {
        const context = this.makeContext();
        if (context) {
            this.text.freeMass.text = formatMass(freeMass(context));
        }
    }

    override async show(input: Entity): Promise<Entity> {
        // Build a mission session so outfit set strings can run the
        // mission operators. Built before setInput seeds the working
        // copies; a failure just leaves set strings on the bit-only path.
        this.missionSession = undefined;
        try {
            const universe = MissionUniverse.shared(this.simulationData);
            // The planet id is only used for offer context (Sxxx
            // destination resolution); the entity carries the accepted-at
            // stellar, so a placeholder is fine for outfitter-run scripts.
            this.missionSession = await MissionSession.create(
                input, this.simulationData, universe, '<outfitter>');
        } catch (e) {
            console.warn('Outfitter mission session unavailable:', e);
        }
        return super.show(input);
    }

    protected override setInput(input: Entity) {
        super.setInput(input);
        // Share the mission session's working copies so purchases and
        // mission set strings mutate the same bits/outfits/records.
        if (this.missionSession) {
            const session = this.missionSession;
            this.outfits = new DefaultMap(() => 0, [...session.outfits]);
            this.controlBits = session.state.bits;
            this.records = session.state.records ?? new Map();
            this.shipData = undefined;
            const shipId = input.components.get(ShipComponent)?.id;
            if (shipId) {
                this.simulationData.data.Ship.get(shipId).then(shipData => {
                    if (this.input === input) {
                        this.shipData = shipData;
                        this.setFreeMassText();
                        this.refreshTradeState();
                    }
                });
            }
            this.text.status.text = "";
            this.itemGrid?.setCounts(this.outfits);
            return;
        }
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
                    this.refreshTradeState();
                }
            });
        }
        this.itemGrid?.setCounts(this.outfits);
    }

    protected override done() {
        if (this.missionSession) {
            // Push the final outfit counts into the session, then commit
            // it — that writes outfits, bits, records, and any mission /
            // cargo / credits / date changes an Sxxx/Axxx/Fxxx caused.
            this.missionSession.outfits.clear();
            for (const [id, count] of this.outfits) {
                if (count > 0) {
                    this.missionSession.outfits.set(id, count);
                }
            }
            this.missionSession.commit();
            super.done();
            return;
        }
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
