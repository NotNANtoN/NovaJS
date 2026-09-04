import { OutfitData } from "novadatainterface/OutfitData";
import { PlanetData } from "novadatainterface/PlanetData";
import { DefaultMap } from "nova_ecs/utils";
import * as PIXI from 'pixi.js';
import { Observable } from "rxjs";
import { GameData } from "../client/gamedata/GameData";
import { ControlEvent } from "../nova_plugin/controls_plugin";
import { OutfitsState } from "../nova_plugin/outfit_plugin";
import { PlayerState } from "../nova_plugin/player_state";
import { Button } from "./button";
import { ShipData } from "novadatainterface/ShipData";
import { ItemGrid, ItemTile } from "./item_grid";
import { Menu } from "./menu";
import { isPurchaseAvailable } from "./availability";
import { executeSetOperations, parseSetExpression } from "../nova_plugin/ncb";


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

export class Outfitter extends Menu<OutfitsState> {
    private itemGrid?: ItemGrid<OutfitData>;
    private pictContainer = new PIXI.Container();
    private outfits: DefaultMap<string, number>;
    private playerState?: PlayerState;
    private planetData?: PlanetData;
    private shipData?: ShipData;
    private refreshPromise?: Promise<void>;

    private readonly outfitDataMap = new Map<string, OutfitData>();
    private text = {
        description: new PIXI.Text({ text: "", style: FONT.normal }),
        itemPrice: new PIXI.Text({ text: "Item Price:", style: FONT.normal }),
        price: new PIXI.Text({ text: "", style: FONT.normal }),
        youHave: new PIXI.Text({ text: "Credits:", style: FONT.normal }),
        count: new PIXI.Text({ text: "0 cr", style: FONT.normal }),
        itemMass: new PIXI.Text({ text: "Item Mass:", style: FONT.normal }),
        mass: new PIXI.Text({ text: "3", style: FONT.normal }),
        availableMass: new PIXI.Text({ text: "Available:", style: FONT.normal }),
        freeMass: new PIXI.Text({ text: "", style: FONT.normal }),
    }

    constructor(gameData: GameData,
        controlEvents: Observable<ControlEvent>) {
        super(gameData, "nova:8502", controlEvents);

        this.outfits = new DefaultMap(() => 0);
        const buttons = {
            buy: new Button(gameData, "Buy", 60, { x: -100, y: 126 }),
            sell: new Button(gameData, "Sell", 60, { x: 0, y: 126 }),
            done: new Button(gameData, "Done", 60, { x: 100, y: 126 })
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

        for (const t of Object.values(this.text)) {
            this.container.addChild(t);
        }
    }

    protected override async build() {
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

    setPlayerState(playerState: PlayerState | undefined) {
        this.playerState = playerState;
        this.updateCreditsText();
        this.refreshPromise = this.refreshGrid();
    }

    setShipData(shipData: ShipData | undefined) {
        this.shipData = shipData;
        this.setFreeMassText();
    }

    setPlanetData(planetData: PlanetData | undefined) {
        this.planetData = planetData;
        this.refreshPromise = this.refreshGrid();
    }

    override async show(input: OutfitsState): Promise<OutfitsState> {
        await this.buildPromise;
        await this.refreshPromise;
        return super.show(input);
    }

    private async makeOutfitsGrid() {
        const ids = (await this.gameData.ids).Outfit;
        let outfits = await Promise.all(ids.map(id =>
            this.gameData.data.Outfit.get(id, 100)));
        if (this.planetData) {
            outfits = outfits.filter(outfit =>
                (this.outfits.get(outfit.id) > 0)
                || isPurchaseAvailable(
                    outfit,
                    this.planetData!,
                    this.playerState,
                    this.outfits,
                )
            );
        }
        for (const outfit of outfits) {
            this.outfitDataMap.set(outfit.id, outfit);
            if (outfit.pict) {
                void this.gameData.textureFromPictAsync(outfit.pict, 50).catch(() => {});
            }
        }
        outfits.sort((a, b) => b.displayWeight - a.displayWeight);
        const itemGrid = new ItemGrid(this.gameData, outfits);
        itemGrid.setCounts(this.outfits);
        return itemGrid;
    }

    private async refreshGrid() {
        // The grid is built asynchronously, so the planet can arrive first.
        // Waiting keeps that case from leaving the unfiltered initial grid up.
        await this.buildPromise;
        if (!this.itemGrid || !this.planetData) {
            return;
        }
        const itemGrid = await this.makeOutfitsGrid();
        this.container.removeChild(this.itemGrid.container);
        this.itemGrid = itemGrid;
        this.container.addChild(itemGrid.container);
        itemGrid.drawGrid();
        itemGrid.container.position.x = -373;
        itemGrid.container.position.y = -153;
        itemGrid.activeTile.subscribe(this.setOutfitSelected.bind(this));
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

    private getInstalledGunCount(): number {
        let count = 0;
        for (const [id, qty] of this.outfits) {
            if (qty <= 0) continue;
            const data = this.outfitDataMap.get(id);
            if (data?.flags && (data.flags & 0x0001) !== 0) {
                count += qty;
            }
        }
        return count;
    }

    private getInstalledTurretCount(): number {
        let count = 0;
        for (const [id, qty] of this.outfits) {
            if (qty <= 0) continue;
            const data = this.outfitDataMap.get(id);
            if (data?.flags && (data.flags & 0x0002) !== 0) {
                count += qty;
            }
        }
        return count;
    }

    private buyOutfit() {
        const outfit = this.itemGrid?.selection;
        if (!outfit) {
            return;
        }
        const currentCount = this.outfits.get(outfit.id);
        if (outfit.max > 0 && currentCount >= outfit.max) {
            console.warn(`Already at maximum (${outfit.max}) for outfit ${outfit.id}.`);
            return;
        }
        if (this.shipData && outfit.flags) {
            if ((outfit.flags & 0x0001) !== 0 && this.getInstalledGunCount() >= this.shipData.maxGuns) {
                console.warn(`No fixed gun mounts available (max: ${this.shipData.maxGuns}).`);
                return;
            }
            if ((outfit.flags & 0x0002) !== 0 && this.getInstalledTurretCount() >= this.shipData.maxTurrets) {
                console.warn(`No turret mounts available (max: ${this.shipData.maxTurrets}).`);
                return;
            }
        }
        const mass = outfit.physics.freeMass ?? 0;
        if (mass > 0 && mass > this.getAvailableMass()) {
            console.warn(`Not enough free mass to install outfit ${outfit.id}.`);
            return;
        }
        const price = Math.max(0, Math.floor(outfit.price));
        if (!this.playerState) {
            console.warn('Cannot buy outfit without player state.');
            return;
        }
        if (this.planetData && !isPurchaseAvailable(
            outfit,
            this.planetData,
            this.playerState,
            this.outfits,
        )) {
            console.warn(`Outfit ${outfit.id} is not available here.`);
            return;
        }
        if (this.playerState.credits < price) {
            console.warn(`Not enough credits to buy outfit ${outfit.id}`);
            return;
        }
        this.playerState.credits -= price;
        // EV Nova Bible: flag 0x0010 removes any items of this type after purchase
        // (used for permits/licenses that grant bits or trigger events).
        if (!outfit.flags || (outfit.flags & 0x0010) === 0) {
            this.outfits.set(outfit.id, currentCount + 1);
        }
        if (outfit.onPurchase) {
            try {
                const ops = parseSetExpression(outfit.onPurchase);
                executeSetOperations(ops, this.playerState.missionBits);
            } catch (e) {
                console.warn('Failed to execute onPurchase expression', e);
            }
        }

        this.itemGrid?.setCounts(this.outfits);
        this.updateCreditsText();
        this.setFreeMassText();
    }

    private sellOutfit() {
        const outfit = this.itemGrid?.selection;
        if (!outfit) {
            return;
        }
        // EV Nova Bible: flag 0x0008 means this item can't be sold.
        if (outfit.flags && (outfit.flags & 0x0008) !== 0) {
            console.warn(`Outfit ${outfit.id} cannot be sold.`);
            return;
        }
        const id = outfit.id;
        const currentCount = this.outfits.get(id);
        if (currentCount <= 0) {
            return;
        }
        if (!this.playerState) {
            console.warn('Cannot sell outfit without player state.');
            return;
        }
        this.outfits.set(id, currentCount - 1);
        // EV Nova's standard resale value is 25% of the purchase price.
        this.playerState.credits += Math.floor(Math.max(0, outfit.price) * 0.25);
        if (this.outfits.get(id) === 0) {
            this.outfits.delete(id);
        }
        this.itemGrid?.setCounts(this.outfits);
        this.updateCreditsText();
        this.setFreeMassText();
    }

    private setOutfitSelected(outfitTile: ItemTile<OutfitData> | undefined) {
        // Set Picture
        this.pictContainer.children.length = 0;
        this.text.description.text = "";
        this.text.price.text = "";
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
        this.updateCreditsText();

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

    private getUsedOutfitMass(): number {
        let total = 0;
        for (const [id, count] of this.outfits) {
            if (count <= 0) continue;
            const data = this.outfitDataMap.get(id);
            if (data?.physics?.freeMass) {
                total += data.physics.freeMass * count;
            }
        }
        return total;
    }

    private getAvailableMass(): number {
        const baseMass = this.shipData?.physics?.freeMass ?? 0;
        return Math.max(0, baseMass - this.getUsedOutfitMass());
    }

    private setFreeMassText() {
        this.text.freeMass.text = formatMass(this.getAvailableMass());
    }

    private updateCreditsText() {
        this.text.count.text = formatCredits(this.playerState?.credits ?? 0);
    }

    protected override setInput(input: OutfitsState) {
        this.outfits = new DefaultMap(() => 0, [...input].map(
            ([k, v]) => [k, v.count]));
        super.setInput(input);
        this.itemGrid?.setCounts(this.outfits);
        this.updateCreditsText();
        this.setFreeMassText();
    }

    protected override done() {
        this.input = new Map([...this.outfits]
            .map(([id, count]) => [id, { count }]));
        super.done();
    }
}

function addCommas(p: number) {
    return p.toLocaleString();
}

export function formatPrice(p: number) {
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

function formatCredits(credits: number) {
    return formatPrice(Math.max(0, Math.floor(credits)));
}

function formatMass(m: number) {
    return m.toLocaleString() + " tons";
};
