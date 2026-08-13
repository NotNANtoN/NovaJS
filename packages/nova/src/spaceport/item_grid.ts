import * as PIXI from 'pixi.js';
import { BehaviorSubject } from 'rxjs';
import { DisplayAssetDataInterface } from '../client/gamedata/display_asset_data.js';
import { displayName } from '../nova_plugin/display_name.js';


const TILE_SIZE = [83, 54];

export class ItemTile<I extends Item> {
    private font = {
        normal: {
            fontFamily: "Geneva", fontSize: 10, fill: 0xffffff,
            align: 'center', wordWrap: true, wordWrapWidth: TILE_SIZE[0]
        } as const,
        grey: {
            fontFamily: "Geneva", fontSize: 10, fill: 0x262626,
            align: 'center', wordWrap: true, wordWrapWidth: TILE_SIZE[0]
        } as const,
        count: {
            fontFamily: "Geneva", fontSize: 10, fill: 0xffffff,
            align: 'right', wordWrap: false, wordWrapWidth: TILE_SIZE[0]
        } as const,
    };

    // TODO: Use the colr resource
    private colors = {
        dim: 0x404040,
        bright: 0xFF0000,
    };
    private lineWidth = 1;
    private dimStyle = [this.lineWidth, this.colors.dim] as const;
    private brightStyle = [this.lineWidth, this.colors.bright] as const;
    private graphics = new PIXI.Graphics();
    private wrappedQuantity = 0;
    private quantityText: PIXI.Text;
    readonly container = new PIXI.Container();
    private wrappedActive = false;
    public built = false;
    public largePict = new PIXI.Container();

    constructor(private displayAssets: DisplayAssetDataInterface, readonly item: I) {
        // Outfit / ship tile captions hide the "; developer note" suffix.
        const nameText = new PIXI.Text(displayName(item.name), this.font.normal);
        nameText.anchor.x = 0.5;
        nameText.position.x = TILE_SIZE[0] / 2;
        nameText.position.y = TILE_SIZE[1] / 2;

        this.quantityText = new PIXI.Text("", this.font.normal);
        this.quantityText.anchor.x = 1;
        this.quantityText.position.x = TILE_SIZE[0] - 2;
        this.quantityText.position.y = 2;

        this.container.interactive = true;
        this.active = false;

        this.container.addChild(this.graphics);
        this.container.addChild(nameText);
        this.container.addChild(this.quantityText);
    }

    build() {
        if (this.built) {
            return;
        }

        if (this.item.pict) {
            const smallPict = this.displayAssets.spriteFromPict(this.item.pict);
            const largePict = this.displayAssets.spriteFromPict(this.item.pict);
            this.largePict.addChild(largePict);
            smallPict.anchor.x = 0.5;
            smallPict.position.x = TILE_SIZE[0] / 2;
            smallPict.position.y = 1;

            const scale = 0.15;
            smallPict.scale.x = scale;
            smallPict.scale.y = scale;

            this.container.addChildAt(smallPict, 1);
        }
        this.built = true;
    }

    draw() {
        this.graphics.clear();
        if (this.active) {
            this.graphics.lineStyle(...this.brightStyle);
        }
        else {
            this.graphics.lineStyle(...this.dimStyle);
        }

        this.graphics.beginFill(0x000000);
        this.graphics.drawRect(0, 0, TILE_SIZE[0], TILE_SIZE[1]);
    }

    hide() {
        this.container.visible = false;
    }

    show() {
        this.container.visible = true;
        this.build(); // Builds if not already built
    }

    moveTo(x: number, y: number) {
        this.container.position.x = x;
        this.container.position.y = y;
    }

    get quantity() {
        return this.wrappedQuantity;
    }

    set quantity(count: number) {
        this.wrappedQuantity = count;
        if (this.wrappedQuantity == 0) {
            this.quantityText.text = "";
        }
        else {
            this.quantityText.text = String(this.quantity);
        }
    }

    get active() {
        return this.wrappedActive;
    }

    set active(val: boolean) {
        this.wrappedActive = val;
        this.draw();
    }
}


interface Item {
    name: string,
    id: string,
    desc: string,
    pict: string,
}

const BOX_COUNT = [4, 5];

/** The parts of a PIXI container raiseToTop needs. */
export interface LayerContainer<C> {
    readonly children: readonly C[];
    addChild(child: C): unknown;
}

/**
 * Raises `child` above every other child of `container`, relying on
 * addChild's move-to-the-end semantics rather than an explicit index.
 *
 * Regression guard: this used to be addChildAt(tile, visibleTiles - 1),
 * which was correct only while the container held exactly one child per
 * visible tile. Once tiles were pooled by id (so the container keeps
 * every tile ever built while the visible list is a subset of them), that
 * index dropped the selected tile near the BOTTOM of the pool, and the
 * neighbouring tiles' opaque backgrounds painted over its red highlight —
 * leaving red visible only at the grid's edges, and the whole grid
 * looking like two misaligned copies. Deriving the position from the
 * container itself makes that class of bug impossible.
 */
export function raiseToTop<C>(container: LayerContainer<C>, child: C): void {
    container.addChild(child);
}

export class ItemGrid<I extends Item> {
    public activeTile = new BehaviorSubject<ItemTile<I> | undefined>(undefined);
    public container = new PIXI.Container();
    private selectionIndex = -1;
    private scroll = 0;
    private tilesDict = new Map<string, ItemTile<I>>();
    private tiles: ItemTile<I>[];

    constructor(private displayAssets: DisplayAssetDataInterface,
        private items: I[]) {
        this.tiles = items.map(item => this.tileFor(item));
    }

    /** The tile for an item, built (and cached) on first use. Tiles are
     * pooled by id so setItems can show a different subset without
     * rebuilding sprites. */
    private tileFor(item: I): ItemTile<I> {
        const existing = this.tilesDict.get(item.id);
        if (existing) {
            return existing;
        }
        const tile = new ItemTile(this.displayAssets, item);
        this.container.addChild(tile.container);
        tile.container.on('pointerdown', () => this.tileClicked(tile));
        this.tilesDict.set(item.id, tile);
        return tile;
    }

    /**
     * Replaces the displayed items, keeping the selection on the same item
     * when it survives the change (matched by id, since the caller may pass
     * freshly-loaded data objects). Tiles for items that dropped out are
     * hidden but kept in the pool, so toggling an item back in is cheap.
     * The scroll is clamped so a shorter list can't leave the view past the
     * end.
     */
    setItems(items: I[]) {
        const selectedId = this.items[this.selectionIndex]?.id;
        const shown = new Set(items.map(item => item.id));
        for (const [id, tile] of this.tilesDict) {
            if (!shown.has(id)) {
                tile.hide();
            }
        }
        this.items = items;
        this.tiles = items.map(item => this.tileFor(item));
        this.selectionIndex = selectedId === undefined ? -1
            : items.findIndex(item => item.id === selectedId);
        this.scroll = Math.min(this.scroll, this.maxScroll);
        this.drawGrid();
    }

    get selection() {
        return this.items[this.selectionIndex];
    }

    set selection(item) {
        this.selectionIndex = this.items.indexOf(item);
        this.drawGrid();
    }

    tileClicked(tile: ItemTile<I>) {
        this.selectionIndex = this.tiles.indexOf(tile);

        this.drawGrid();
    }

    drawGrid() {
        // Hide everything first. Reveal them later
        this.tiles.forEach(function(t) {
            t.hide();
        });

        const start = BOX_COUNT[0] * this.scroll;

        for (let i = 0; i < Math.min(this.items.length - start, BOX_COUNT[0] * BOX_COUNT[1]); i++) {
            var itemIndex = i + start;
            var tile = this.tiles[itemIndex];
            let xcount = i % BOX_COUNT[0];
            let ycount = Math.floor(i / BOX_COUNT[0]);

            tile.show();
            if (itemIndex === this.selectionIndex) {
                tile.active = true;
                // send which one is selected
                this.activeTile.next(tile);

                // Make sure it is above the others
                raiseToTop(this.container, tile.container);
            }

            else {
                tile.active = false;
            }

            tile.moveTo(xcount * TILE_SIZE[0], ycount * TILE_SIZE[1])
            tile.draw();
        }
        // No selection (e.g. setItems emptied the grid, or the selected
        // item vanished): tell subscribers so detail panes clear instead
        // of lingering on the last selection. Guarded so redraws with a
        // live selection don't churn the subject.
        if (this.selectionIndex === -1 && this.activeTile.value !== undefined) {
            this.activeTile.next(undefined);
        }
    }

    /** The furthest the grid can scroll: the top row of the last page. */
    private get maxScroll() {
        const rows = Math.ceil(this.items.length / BOX_COUNT[0]);
        return Math.max(0, rows - BOX_COUNT[1]);
    }

    /** True when more items exist above / below the visible page. */
    get canScrollUp() {
        return this.scroll > 0;
    }
    get canScrollDown() {
        return this.scroll < this.maxScroll;
    }

    /** Scrolls the visible page up/down by a page, for the scroll-arrow
     * buttons (the view moves without changing the selection). */
    scrollUp() {
        if (this.scroll <= 0) {
            return;
        }
        this.scroll = Math.max(0, this.scroll - BOX_COUNT[1]);
        this.drawGrid();
    }
    scrollDown() {
        if (this.scroll >= this.maxScroll) {
            return;
        }
        this.scroll = Math.min(this.maxScroll, this.scroll + BOX_COUNT[1]);
        this.drawGrid();
    }

    setCounts(items: Map<string, number>) {
        for (const tile of this.tiles) {
            tile.quantity = 0;
        }

        for (const [id, count] of items) {
            const tile = this.tilesDict.get(id);
            if (tile) {
                tile.quantity = count;
            }
        }
    }

    left() {
        if (this.selectionIndex === -1) {
            this.selectionIndex = Math.min(BOX_COUNT[0] * BOX_COUNT[1],
                this.items.length);
        }
        else {
            this.selectionIndex -= 1;
            if (this.selectionIndex < 0) {
                this.selectionIndex = 0;
            }
        }

        if (this.scroll * BOX_COUNT[0] > this.selectionIndex) {
            this.scroll -= 1;
        }
        this.drawGrid();
    }

    right() {
        if (this.selectionIndex === -1) {
            this.selectionIndex = 0;
        }
        else {
            this.selectionIndex += 1;
            if (this.selectionIndex > this.items.length - 1) {
                this.selectionIndex = this.items.length - 1;
            }

        }
        if (this.scroll * BOX_COUNT[0] +
            BOX_COUNT[0] * BOX_COUNT[1] <= this.selectionIndex) {
            this.scroll += 1;
        }
        this.drawGrid();
    }

    up() {
        if (this.selectionIndex === -1) {
            this.selectionIndex = Math.min(BOX_COUNT[0] * BOX_COUNT[1],
                this.items.length);
        }
        else if (this.selectionIndex - BOX_COUNT[0] >= 0) {
            this.selectionIndex -= BOX_COUNT[0];
        }

        if (this.scroll * BOX_COUNT[0] > this.selectionIndex) {
            this.scroll -= 1;
        }
        this.drawGrid();
    }

    down() {
        if (this.selectionIndex === -1) {
            this.selectionIndex = 0;
        }
        else if (this.selectionIndex + BOX_COUNT[0] < this.items.length) {
            this.selectionIndex += BOX_COUNT[0];
        }
        else {
            this.selectionIndex = this.items.length - 1;
        }

        if (this.scroll * BOX_COUNT[0] +
            BOX_COUNT[0] * BOX_COUNT[1] <= this.selectionIndex) {
            this.scroll += 1;
        }

        this.drawGrid();
    }

}
