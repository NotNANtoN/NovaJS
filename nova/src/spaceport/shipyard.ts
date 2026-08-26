import { ShipData } from 'novadatainterface/ShipData';
import { Entity } from 'nova_ecs/entity';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import * as PIXI from 'pixi.js';
import { Observable } from 'rxjs';
import { GameData } from '../client/gamedata/GameData';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import { makeShip } from '../nova_plugin/make_ship';
import { PlayerShipSelector } from '../nova_plugin/player_ship_plugin';
import {
    PlayerState,
    PlayerStateComponent,
    setCargoCapacity,
} from '../nova_plugin/player_state';
import { Button } from './button';
import { ItemGrid, ItemTile } from './item_grid';
import { Menu } from './menu';
import { FONT, formatPrice } from './outfitter';
import { isPurchaseAvailable } from './availability';
import { PlanetData } from 'novadatainterface/PlanetData';


export class Shipyard extends Menu<Entity> {
    private pictContainer = new PIXI.Container();
    itemGrid?: ItemGrid<ShipData>;
    private text = {
        description: new PIXI.Text("", FONT.normal),
        itemPrice: new PIXI.Text("Price:", FONT.normal),
        price: new PIXI.Text("", FONT.normal),
        credits: new PIXI.Text("Credits:", FONT.normal),
        creditAmount: new PIXI.Text("", FONT.normal),
    }
    private playerState?: PlayerState;
    private planetData?: PlanetData;
    private refreshPromise?: Promise<void>;

    constructor(gameData: GameData,
        controlEvents: Observable<ControlEvent>) {
        super(gameData, "nova:8502", controlEvents);
        const buttons = {
            buy: new Button(gameData, "Buy", 60, { x: -20, y: 126 }),
            done: new Button(gameData, "Done", 60, { x: 100, y: 126 }),
        };
        this.addButtons(buttons);

        buttons.buy.click.subscribe(this.buyShip.bind(this));
        buttons.done.click.subscribe(this.done.bind(this));

        this.text.description.position.x = -27;
        this.text.description.position.y = -150;
        this.container.addChild(this.text.description);
        this.text.itemPrice.position.x = 234;
        this.text.itemPrice.position.y = 58;
        this.text.price.position.x = 300;
        this.text.price.position.y = 58;
        this.text.credits.position.x = 234;
        this.text.credits.position.y = 70;
        this.text.creditAmount.position.x = 300;
        this.text.creditAmount.position.y = 70;
        this.container.addChild(this.text.itemPrice);
        this.container.addChild(this.text.price);
        this.container.addChild(this.text.credits);
        this.container.addChild(this.text.creditAmount);
        this.pictContainer.position.x = 174;
        this.pictContainer.position.y = -152.5;
        this.container.addChild(this.pictContainer);
    }

    protected override async build() {
        await super.build();
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

    setPlayerState(playerState: PlayerState | undefined) {
        this.playerState = playerState;
        this.updateCreditsText();
        this.refreshPromise = this.refreshGrid();
    }

    setPlanetData(planetData: PlanetData | undefined) {
        this.planetData = planetData;
        this.refreshPromise = this.refreshGrid();
    }

    override async show(input: Entity): Promise<Entity> {
        await this.buildPromise;
        await this.refreshPromise;
        return super.show(input);
    }

    private async makeShipsGrid() {
        const ids = (await this.gameData.ids).Ship;
        let ships = await Promise.all(ids.map(id =>
            this.gameData.data.Ship.get(id, 100)));
        if (this.planetData) {
            ships = ships.filter(ship => isPurchaseAvailable(
                ship,
                this.planetData!,
                this.playerState,
            ));
        }
        ships.sort((a, b) => b.displayWeight - a.displayWeight);
        const itemGrid = new ItemGrid(this.gameData, ships);
        return itemGrid;
    }

    private async refreshGrid() {
        // The grid is built asynchronously, so the planet can arrive first.
        // Waiting keeps that case from leaving the unfiltered initial grid up.
        await this.buildPromise;
        if (!this.itemGrid || !this.planetData) {
            return;
        }
        const itemGrid = await this.makeShipsGrid();
        this.container.removeChild(this.itemGrid.container);
        this.itemGrid = itemGrid;
        this.container.addChild(itemGrid.container);
        itemGrid.drawGrid();
        itemGrid.container.position.x = -373;
        itemGrid.container.position.y = -153;
        itemGrid.activeTile.subscribe(this.setShipSelected.bind(this));
        this.controls.controls = {
            left: () => itemGrid.left(),
            right: () => itemGrid.right(),
            up: () => itemGrid.up(),
            down: () => itemGrid.down(),
            buy: this.buyShip.bind(this),
            depart: this.done.bind(this),
        };
    }

    private setShipSelected(shipTile: ItemTile<ShipData> | undefined) {
        this.pictContainer.children.length = 0;
        if (!shipTile) {
            return;
        }

        if (shipTile.largePict) {
            this.pictContainer.addChild(shipTile.largePict);
        }

        // Set Description
        this.text.description.text = shipTile.item.desc;
        this.text.price.text = formatPrice(
            Math.max(0, Math.floor(shipTile.item.cost)));
        this.updateCreditsText();
    }

    private buyShip() {
        const selection = this.itemGrid?.selection;
        if (!selection) {
            return;
        }
        if (!this.playerState) {
            console.warn('Cannot buy ship without player state.');
            return;
        }
        if (this.planetData && !isPurchaseAvailable(
            selection,
            this.planetData,
            this.playerState,
        )) {
            console.warn(`Ship ${selection.id} is not available here.`);
            return;
        }
        const multiplayerData = this.input.components.get(MultiplayerData);
        if (!multiplayerData) {
            console.warn('Missing multiplayer data for prior ship.');
            return;
        }

        const cost = Math.max(0, Math.floor(selection.cost));
        if (this.playerState.credits < cost) {
            console.warn(`Not enough credits to buy ship ${selection.id}`);
            return;
        }
        this.playerState.credits -= cost;
        this.playerState.shipId = selection.id;
        setCargoCapacity(this.playerState, selection.cargoCapacity);
        this.input = makeShip(selection);
        this.input.components.set(PlayerShipSelector, undefined);
        this.input.components.set(MultiplayerData, multiplayerData);
        this.input.components.set(PlayerStateComponent, this.playerState);
        // For convenience
        (window as any).myShip = this.input;
        this.updateCreditsText();
    }

    private updateCreditsText() {
        this.text.creditAmount.text = formatPrice(
            Math.max(0, Math.floor(this.playerState?.credits ?? 0)));
    }
}
