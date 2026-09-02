import { TradeCommodity } from 'novadatainterface/CommodityData';
import { PlanetData } from 'novadatainterface/PlanetData';
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
import { ncbTestContext } from '../nova_plugin/ncb_runtime';
import { OutfitsStateComponent } from '../nova_plugin/outfit_plugin';
import { Button } from './button';
import { Menu } from './menu';
import { MenuControls } from './menu_controls';
import {
    tradeAccountText,
    tradeColumnHeadings,
    tradeEmptyText,
    TradeDisplayOffer,
    tradeOfferRows,
    tradePriceRows,
    tradeSelectionText,
} from './trade_center_content';
import {
    TRADE_GLYPH_COLOR,
    TRADE_GLYPH_SIZE,
    tradeCommodityGlyph,
} from './trade_center_glyphs';
import {
    hasJunkTradeLocation as junkLocationExists,
    junkTradeOffersAt,
} from './trade_center_junk';
import { plainSnapshot } from 'nova_ecs/draft_snapshot';
import {
    TRADE_CENTER_LAYOUT,
    TRADE_CENTER_ROW_PITCH,
    TradeRect,
    tradeButtonSlots,
    tradeRowY,
    tradeSelectionPage,
} from './trade_center_layout';

export { buyCommodity, heldCommodityTons, sellCommodity };

const TRADE_FONT = {
    title: {
        fontFamily: 'Geneva', fontSize: 14, fill: 0xffffff,
        align: 'center', lineHeight: 16,
    } as const,
    heading: {
        fontFamily: 'Geneva', fontSize: 10, fill: 0xb8b8b8,
        align: 'left', lineHeight: 12,
    } as const,
    list: {
        fontFamily: 'Geneva', fontSize: 10, fill: 0xffffff,
        align: 'left', lineHeight: 12,
    } as const,
    detail: {
        fontFamily: 'Geneva', fontSize: 10, fill: 0xffffff,
        align: 'left', wordWrap: true, lineHeight: 12,
    } as const,
    status: {
        fontFamily: 'Geneva', fontSize: 10, fill: 0xffff00,
        align: 'left', wordWrap: true, lineHeight: 10,
    } as const,
};

function addPane(
    owner: PIXI.Container,
    region: TradeRect,
    style: PIXI.TextStyle | PIXI.TextStyleOptions,
    horizontal: 'left' | 'center' | 'right' = 'left',
): PIXI.Text {
    const text = new PIXI.Text({ text: '', style });
    text.position.set(
        horizontal === 'left'
            ? region.x
            : horizontal === 'center'
                ? region.x + region.width / 2
                : region.x + region.width,
        region.y,
    );
    text.anchor.x = horizontal === 'left' ? 0 : horizontal === 'center' ? 0.5 : 1;
    if (text.style.wordWrap) {
        text.style.wordWrapWidth = region.width;
    }
    const mask = new PIXI.Graphics();
    mask.rect(region.x, region.y, region.width, region.height).fill(0xffffff);
    text.mask = mask;
    owner.addChild(mask, text);
    return text;
}

function addRowTextPool(
    owner: PIXI.Container,
    region: TradeRect,
    style: PIXI.TextStyle | PIXI.TextStyleOptions,
    count: number,
): PIXI.Text[] {
    const mask = new PIXI.Graphics();
    mask.rect(region.x, region.y, region.width, region.height).fill(0xffffff);
    owner.addChild(mask);
    return Array.from({ length: count }, (_, row) => {
        const text = new PIXI.Text({ text: '', style });
        text.position.set(region.x + region.width, tradeRowY(region, row));
        text.anchor.x = 1;
        text.mask = mask;
        owner.addChild(text);
        return text;
    });
}

function addGlyphPool(
    owner: PIXI.Container,
    region: TradeRect,
    count: number,
): PIXI.Graphics[] {
    const mask = new PIXI.Graphics();
    mask.rect(region.x, region.y, region.width, region.height).fill(0xffffff);
    owner.addChild(mask);
    const x = region.x + Math.floor((region.width - TRADE_GLYPH_SIZE) / 2);
    const yOffset = Math.floor(
        (TRADE_CENTER_ROW_PITCH - TRADE_GLYPH_SIZE) / 2);
    return Array.from({ length: count }, (_, row) => {
        const graphics = new PIXI.Graphics();
        graphics.position.set(x, tradeRowY(region, row) + yOffset);
        graphics.mask = mask;
        owner.addChild(graphics);
        return graphics;
    });
}

function ordinaryCargoTons(state: PlayerState): number {
    const commodities = new Set(
        state.holds
            .filter(hold => !hold.isMissionCargo)
            .map(hold => hold.commodity),
    );
    return [...commodities].reduce(
        (total, commodity) => total + heldCommodityTons(state, commodity), 0);
}

/**
 * Retail's compact commodity exchange. PICT 8510 provides one list pane, so
 * synchronized text columns keep prices and quantities aligned without
 * relying on spaces in Geneva.
 */
export class TradeCenter extends Menu<Entity> {
    private readonly title: PIXI.Text;
    private readonly commodityHeading: PIXI.Text;
    private readonly priceHeading: PIXI.Text;
    private readonly heldHeading: PIXI.Text;
    private readonly commodityList: PIXI.Text;
    private readonly heldList: PIXI.Text;
    private readonly priceRows: PIXI.Text[];
    private readonly commodityGlyphs: PIXI.Graphics[];
    private readonly detail: PIXI.Text;
    private readonly status: PIXI.Text;
    private readonly buyButton: Button;
    private readonly sellButton: Button;
    private offers: TradeDisplayOffer[] = [];
    private planet?: PlanetData;
    private selectionIndex = -1;
    private pageStart = 0;
    private transactionMessage = '';

    constructor(
        gameData: GameData,
        private readonly planetId: string,
        controlEvents: Observable<ControlEvent>,
    ) {
        super(gameData, TRADE_CENTER_LAYOUT.background, controlEvents);
        this.title = addPane(
            this.container, TRADE_CENTER_LAYOUT.title, TRADE_FONT.title, 'center');
        this.commodityHeading = addPane(
            this.container, TRADE_CENTER_LAYOUT.commodityHeading,
            TRADE_FONT.heading);
        this.heldHeading = addPane(
            this.container, TRADE_CENTER_LAYOUT.heldHeading,
            TRADE_FONT.heading, 'right');
        this.priceHeading = addPane(
            this.container, TRADE_CENTER_LAYOUT.priceHeading,
            TRADE_FONT.heading, 'right');
        this.commodityList = addPane(
            this.container, TRADE_CENTER_LAYOUT.commodityList, TRADE_FONT.list);
        this.heldList = addPane(
            this.container, TRADE_CENTER_LAYOUT.heldList,
            TRADE_FONT.list, 'right');
        this.priceRows = addRowTextPool(
            this.container,
            TRADE_CENTER_LAYOUT.priceList,
            TRADE_FONT.list,
            TRADE_CENTER_LAYOUT.visibleRows,
        );
        this.commodityGlyphs = addGlyphPool(
            this.container,
            TRADE_CENTER_LAYOUT.commodityGlyphs,
            TRADE_CENTER_LAYOUT.visibleRows,
        );
        this.detail = addPane(
            this.container, TRADE_CENTER_LAYOUT.detail, TRADE_FONT.detail);
        this.status = addPane(
            this.container, TRADE_CENTER_LAYOUT.status, TRADE_FONT.status);

        const headings = tradeColumnHeadings();
        this.commodityHeading.text = headings.commodities;
        this.heldHeading.text = headings.held;
        this.priceHeading.text = headings.prices;

        const [buySlot, sellSlot, doneSlot] =
            tradeButtonSlots([48, 48, 38]);
        this.buyButton = new Button(
            gameData, 'Buy 1', buySlot!.width, buySlot);
        this.sellButton = new Button(
            gameData, 'Sell 1', sellSlot!.width, sellSlot);
        const done = new Button(gameData, 'Done', doneSlot!.width, doneSlot);
        this.addButtons({
            buy: this.buyButton,
            sell: this.sellButton,
            done,
        });
        this.buyButton.click.subscribe(() => this.buySelected());
        this.sellButton.click.subscribe(() => this.sellSelected());
        done.click.subscribe(this.done.bind(this));

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
        this.transactionMessage = '';
        await this.refresh();
        return super.show(input);
    }

    /** Some retail jünk routes exist at spöbs without the commodity flag. */
    async hasJunkTradeLocation(): Promise<boolean> {
        const junkGoods = await this.loadJunkGoods();
        return junkLocationExists(junkGoods, this.planetId);
    }

    private async loadJunkGoods() {
        const ids = await this.gameData.ids;
        return Promise.all(
            (ids.Junk ?? []).map(id => this.gameData.data.Junk.get(id)));
    }

    private async refresh() {
        this.planet = undefined;
        this.offers = [];
        const shipId = this.input.components
            .get(PlayerStateComponent)?.shipId;
        if (shipId !== undefined) {
            await this.syncCargoCapacity(shipId);
        }
        // Copied once the capacity is written, because the awaits below let
        // the world step, which revokes the component draft.
        const state = plainSnapshot(
            this.input.components.get(PlayerStateComponent));
        if (state) {
            try {
                this.planet = await this.gameData.data.Planet.get(this.planetId);
                const junkGoods = await this.loadJunkGoods();
                this.offers = [
                    ...(this.planet.tradeCommodities ?? []),
                    ...junkTradeOffersAt(
                        junkGoods,
                        this.planetId,
                        ncbTestContext(
                            state,
                            this.input.components.get(OutfitsStateComponent),
                        ),
                    ),
                ];
            } catch {
                // A missing stellar is displayed as an unavailable market.
            }
        }
        this.selectionIndex = this.offers.length > 0 ? 0 : -1;
        this.pageStart = 0;
        this.render();
    }

    /**
     * Capacity is written to the component as it stands after the await,
     * because loading ship data lets the world step: a draft read beforehand
     * is revoked by then, and writing to a copy would drop the change.
     */
    private async syncCargoCapacity(shipId: string) {
        const shipData = this.input.components.get(ShipDataComponent);
        let capacity = shipData?.cargoCapacity;
        if (capacity === undefined) {
            try {
                capacity = (await this.gameData.data.Ship.get(shipId))
                    .cargoCapacity;
            } catch {
                // Keep the capacity restored from the player save.
                return;
            }
        }
        const live = this.input.components.get(PlayerStateComponent);
        if (live) {
            setCargoCapacity(live, capacity);
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
        const page = tradeSelectionPage(
            this.offers.length, this.selectionIndex, this.pageStart);
        this.pageStart = page.start;
        this.render();
    }

    private selected(): TradeDisplayOffer | undefined {
        return this.offers[this.selectionIndex];
    }

    private render() {
        const state = this.input.components.get(PlayerStateComponent);
        this.title.text = this.planet?.name ?? 'Trade Center';
        const page = tradeSelectionPage(
            this.offers.length, this.selectionIndex, this.pageStart);
        this.pageStart = page.start;
        const rows = tradeOfferRows(
            this.offers,
            this.selectionIndex,
            commodity => state
                ? heldCommodityTons(state, commodity)
                : 0,
            page.start,
            page.end,
        );
        this.commodityList.text = rows.commodities;
        this.heldList.text = rows.held;
        const priceRows = tradePriceRows(
            this.offers, page.start, page.end);
        for (const [rowIndex, text] of this.priceRows.entries()) {
            const price = priceRows[rowIndex];
            text.text = price?.text ?? '';
            text.visible = price !== undefined;
            if (price) {
                text.style.fill = price.color;
            }
        }
        const visibleOffers = this.offers.slice(page.start, page.end);
        for (const [rowIndex, graphics] of this.commodityGlyphs.entries()) {
            const offer = visibleOffers[rowIndex];
            graphics.clear();
            graphics.visible = offer !== undefined;
            if (offer) {
                tradeCommodityGlyph(offer.commodity)(
                    graphics, TRADE_GLYPH_COLOR);
            }
        }

        const selected = this.selected();
        this.detail.text = selected
            ? tradeSelectionText(selected)
            : tradeEmptyText(state !== undefined);
        this.status.text = state
            ? tradeAccountText({
                credits: state.credits,
                cargoTons: cargoTons(state),
                cargoCapacity: state.cargoCapacity,
                heldCommodityTons: ordinaryCargoTons(state),
                transactionMessage: this.transactionMessage,
            })
            : '';
        this.buyButton.state = state && selected
            && selected.canBuy !== false
            && state.credits >= selected.price
            && getFreeSpace(state) > 0 ? 'normal' : 'grey';
        this.sellButton.state = state && selected
            && selected.canSell !== false
            && heldCommodityTons(
                state, selected.cargoKey ?? selected.commodity) > 0
            ? 'normal' : 'grey';
    }

    private buySelected() {
        const state = this.input.components.get(PlayerStateComponent);
        const selected = this.selected();
        if (!state || !selected) {
            return;
        }
        if (selected.canBuy === false) {
            this.transactionMessage =
                'This stellar does not sell that special cargo.';
            this.render();
            return;
        }
        const result = buyCommodity(state, {
            ...selected,
            commodity: selected.cargoKey ?? selected.commodity,
        } as TradeCommodity);
        this.transactionMessage = result.success
            ? `Bought ${result.tons}t ${selected.commodity} for ${
                result.total.toLocaleString()} cr.`
            : result.reason ?? 'Unable to buy cargo.';
        this.render();
    }

    private sellSelected() {
        const state = this.input.components.get(PlayerStateComponent);
        const selected = this.selected();
        if (!state || !selected) {
            return;
        }
        if (selected.canSell === false) {
            this.transactionMessage =
                'This stellar does not buy that special cargo.';
            this.render();
            return;
        }
        const result = sellCommodity(state, {
            ...selected,
            commodity: selected.cargoKey ?? selected.commodity,
        } as TradeCommodity);
        this.transactionMessage = result.success
            ? `Sold ${result.tons}t ${selected.commodity} for ${
                result.total.toLocaleString()} cr.`
            : result.reason ?? 'Unable to sell cargo.';
        this.render();
    }
}
