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
} from '../nova_plugin/player_state';
import { Button } from './button';
import { ItemGrid, ItemTile } from './item_grid';
import { Menu } from './menu';
import { FONT, formatPrice } from './outfitter';


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
        this.build();
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
    }

    private async makeShipsGrid() {
        const ids = (await this.gameData.ids).Ship;
        const ships = await Promise.all(ids.map(id =>
            this.gameData.data.Ship.get(id, 100)));
        ships.sort((a, b) => b.displayWeight - a.displayWeight);
        const itemGrid = new ItemGrid(this.gameData, ships);
        return itemGrid;
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
        // ShipData does not currently expose cost; use the field when the
        // data interface grows it, while keeping old data playable.
        const cost = (shipTile.item as any).cost ?? 0;
        this.text.price.text = formatPrice(Math.max(0, Math.floor(cost)));
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
        const multiplayerData = this.input.components.get(MultiplayerData);
        if (!multiplayerData) {
            console.warn('Missing multiplayer data for prior ship.');
            return;
        }

        // ShipData does not expose cost yet; this is intentionally defensive
        // until the data-interface change lands.
        const cost = Math.max(0, Math.floor((selection as any).cost ?? 0));
        if (this.playerState.credits < cost) {
            console.warn(`Not enough credits to buy ship ${selection.id}`);
            return;
        }
        this.playerState.credits -= cost;
        this.playerState.shipId = selection.id;
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
