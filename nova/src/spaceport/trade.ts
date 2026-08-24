import {
    PlanetData,
} from 'novadatainterface/PlanetData';
import {
    TradeCommodity,
} from 'novadatainterface/CommodityData';
import { Entity } from 'nova_ecs/entity';
import * as PIXI from 'pixi.js';
import { Observable } from 'rxjs';
import { GameData } from '../client/gamedata/GameData';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import {
    cargoTons,
    getFreeSpace,
    PlayerState,
    PlayerStateComponent,
    setCargoCapacity,
} from '../nova_plugin/player_state';
import { ShipDataComponent } from '../nova_plugin/ship_plugin';
import {
    buyCommodity,
    heldCommodityTons,
    sellCommodity,
} from '../nova_plugin/trade_model';
import { Button } from './button';
import { Menu } from './menu';
import { MenuControls } from './menu_controls';

export { buyCommodity, heldCommodityTons, sellCommodity };

const TRADE_FONT = {
    title: {
        fontFamily: 'Geneva', fontSize: 16, fill: 0xffffff, align: 'center',
    } as const,
    list: {
        fontFamily: 'Geneva', fontSize: 12, fill: 0xffffff,
        align: 'left', wordWrap: true, wordWrapWidth: 420,
    } as const,
    detail: {
        fontFamily: 'Geneva', fontSize: 10, fill: 0xffffff,
        align: 'left', wordWrap: true, wordWrapWidth: 420,
    } as const,
    status: {
        fontFamily: 'Geneva', fontSize: 10, fill: 0xffff00,
        align: 'left', wordWrap: true, wordWrapWidth: 420,
    } as const,
};

export class TradeCenter extends Menu<Entity> {
    private readonly title = new PIXI.Text('Trade Center', TRADE_FONT.title);
    private readonly list = new PIXI.Text('', TRADE_FONT.list);
    private readonly detail = new PIXI.Text('', TRADE_FONT.detail);
    private readonly status = new PIXI.Text('', TRADE_FONT.status);
    private readonly buyButton: Button;
    private readonly sellButton: Button;
    private offers: TradeCommodity[] = [];
    private planet?: PlanetData;
    private selectionIndex = -1;
    private transactionMessage = '';

    constructor(
        gameData: GameData,
        private readonly planetId: string,
        controlEvents: Observable<ControlEvent>,
    ) {
        super(gameData, 'nova:8500', controlEvents);
        this.buyButton = new Button(gameData, 'Buy 1 ton', 90, {
            x: -110, y: 190,
        });
        this.sellButton = new Button(gameData, 'Sell 1 ton', 90, {
            x: 0, y: 190,
        });
        const done = new Button(gameData, 'Done', 65, { x: 110, y: 190 });
        this.addButtons({
            buy: this.buyButton,
            sell: this.sellButton,
            done,
        });
        this.buyButton.click.subscribe(() => this.buySelected());
        this.sellButton.click.subscribe(() => this.sellSelected());
        done.click.subscribe(this.done.bind(this));

        this.title.anchor.x = 0.5;
        this.title.position.set(0, -210);
        this.list.position.set(-290, -175);
        this.detail.position.set(-290, 80);
        this.status.position.set(-290, 145);
        this.container.addChild(
            this.title, this.list, this.detail, this.status);
        this.controls = new MenuControls(controlEvents, {
            up: () => this.moveSelection(-1),
            down: () => this.moveSelection(1),
            buy: () => this.buySelected(),
            sell: () => this.sellSelected(),
            tradeCenter: this.done.bind(this),
            depart: this.done.bind(this),
        });
    }

    override async show(input: Entity): Promise<Entity> {
        await this.buildPromise;
        this.setInput(input);
        await this.refresh();
        return super.show(input);
    }

    private async refresh() {
        const state = this.input.components.get(PlayerStateComponent);
        if (!state) {
            this.offers = [];
            this.render();
            return;
        }
        await this.syncCargoCapacity(state);
        try {
            this.planet = await this.gameData.data.Planet.get(this.planetId);
            this.offers = [...(this.planet.tradeCommodities ?? [])];
        } catch {
            this.planet = undefined;
            this.offers = [];
        }
        this.selectionIndex = this.offers.length > 0 ? 0 : -1;
        this.render();
    }

    private async syncCargoCapacity(state: PlayerState) {
        const shipData = this.input.components.get(ShipDataComponent);
        if (shipData) {
            setCargoCapacity(state, shipData.cargoCapacity);
            return;
        }
        try {
            const ship = await this.gameData.data.Ship.get(state.shipId);
            setCargoCapacity(state, ship.cargoCapacity);
        } catch {
            // Keep the capacity restored from the player save.
        }
    }

    private moveSelection(delta: number) {
        if (this.offers.length === 0) {
            return;
        }
        this.selectionIndex = Math.max(
            0,
            Math.min(this.offers.length - 1, this.selectionIndex + delta),
        );
        this.render();
    }

    private selected(): TradeCommodity | undefined {
        return this.offers[this.selectionIndex];
    }

    private render() {
        const state = this.input?.components.get(PlayerStateComponent);
        if (!state || this.offers.length === 0 || this.selectionIndex < 0) {
            this.list.text = 'This stellar has no commodity exchange.';
            this.detail.text = '';
            this.status.text = '';
            this.buyButton.state = 'grey';
            this.sellButton.state = 'grey';
            return;
        }
        this.list.text = this.offers.map((offer, index) => {
            const selected = index === this.selectionIndex ? '▶ ' : '  ';
            return `${selected}${offer.commodity}: ${offer.price.toLocaleString()} cr/t`
                + ` (${offer.priceLevel})  held ${heldCommodityTons(
                    state, offer.commodity)}`;
        }).join('\n');
        const selected = this.selected()!;
        this.title.text = this.planet?.name ?? 'Trade Center';
        this.detail.text = `Selected: ${selected.commodity}\n`
            + `Buy and sell price: ${selected.price.toLocaleString()} credits per ton`;
        const stats = `Credits: ${Math.floor(state.credits).toLocaleString()} cr`
            + `   Cargo: ${Math.floor(cargoTons(state))}/${state.cargoCapacity}`
            + ` tons   Free: ${getFreeSpace(state)}`;
        this.status.text = this.transactionMessage
            ? `${this.transactionMessage}\n${stats}` : stats;
        this.buyButton.state = state.credits >= selected.price
            && getFreeSpace(state) > 0 ? 'normal' : 'grey';
        this.sellButton.state = heldCommodityTons(
            state, selected.commodity) > 0 ? 'normal' : 'grey';
    }

    private buySelected() {
        const state = this.input.components.get(PlayerStateComponent);
        const selected = this.selected();
        if (!state || !selected) {
            return;
        }
        const result = buyCommodity(state, selected);
        this.transactionMessage = result.success
            ? `Bought ${result.tons} ton of ${selected.commodity} for ${result.total} cr.`
            : result.reason ?? 'Unable to buy cargo.';
        this.render();
    }

    private sellSelected() {
        const state = this.input.components.get(PlayerStateComponent);
        const selected = this.selected();
        if (!state || !selected) {
            return;
        }
        const result = sellCommodity(state, selected);
        this.transactionMessage = result.success
            ? `Sold ${result.tons} ton of ${selected.commodity} for ${result.total} cr.`
            : result.reason ?? 'Unable to sell cargo.';
        this.render();
    }
}

