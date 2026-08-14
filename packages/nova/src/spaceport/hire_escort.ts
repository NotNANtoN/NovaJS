import { PlanetData } from 'novadatainterface/planet_data';
import { ShipData } from 'novadatainterface/ship_data';
import * as PIXI from 'pixi.js';
import { firstValueFrom, Observable, Subject } from 'rxjs';
import { DisplayAssetDataInterface } from '../client/gamedata/display_asset_data.js';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { ControlEvent } from '../nova_plugin/controls_plugin.js';
import { makeDescTextContext, playerGender, resolveConditionalBlocks }
    from '../nova_plugin/desc_text.js';
import { Button } from './button.js';
import { ItemGrid, ItemTile } from './item_grid.js';
import { MenuControls } from './menu_controls.js';
import { FONT } from './outfitter.js';

/**
 * What the bar says when the day's hire pool comes up empty.
 *
 * This is stock Nova's own wording, verbatim: STR# 2002 ("misc strings")
 * index 223 (0-based) in Nova Data 5.ndat — the direct sibling of the
 * shipyard's "There are no ships available for purchase here." at index
 * 222. Note the hire string has no trailing "here".
 *
 * Kept as the fallback for a data set whose STR# 2002 is missing or too
 * short; `noShipsForHire()` below reads the real string from the table.
 */
export const NO_SHIPS_FOR_HIRE = 'There are no ships available for hire.';

/** The STR# table and index the hire message comes from. */
export const NO_SHIPS_FOR_HIRE_TABLE = 'nova:2002';
export const NO_SHIPS_FOR_HIRE_INDEX = 223;

/**
 * The "no pilots for hire today" message, read from STR# 2002 index 223.
 * Falls back to the constant above when the table is absent.
 */
export async function noShipsForHire(
    displayAssets: DisplayAssetDataInterface): Promise<string> {
    try {
        const table = await displayAssets.data.StringTable.get(
            NO_SHIPS_FOR_HIRE_TABLE);
        const text = table.strings[NO_SHIPS_FOR_HIRE_INDEX];
        return text?.trim() ? text : NO_SHIPS_FOR_HIRE;
    } catch {
        return NO_SHIPS_FOR_HIRE;
    }
}

/** The one-time fee to hire an escort: 10% of the ship's price.
 * Matches the original's observed behavior (a 300,000 cr Thunderhead
 * hires for 30,000 cr); the exact rule is not in the Bible. */
export function hirePrice(ship: ShipData): number {
    return Math.round(ship.price / 10);
}

/**
 * The bar's hire-escort dialog, on the shipyard frame (PICT 8501):
 * a grid of pilots for hire, the pilot description (dësc 14000+),
 * the ship pict, and the hiring price against the player's credits.
 *
 * Which ships appear follows the Bible's hire rules: a ship class
 * with HireRandom > 0 has that percent chance per day of a pilot
 * being available, gated by the stellar's tech level. Like the
 * mission board's AvailRandom, the roll happens once per opening with
 * plain Math.random — player-local UI; only hired-escort state
 * reaches the simulation. Documented gap: spöb SpecialTech levels are
 * not parsed onto PlanetData yet, so only the base TechLevel gates
 * the pool.
 *
 * Hiring charges the credits working copy (committed when the bar
 * session commits) and records the ship id for browser.ts to spawn
 * on launch (see pending_escorts.ts — in-system only, does not follow
 * through hyperspace).
 */
export class HireEscortDialog {
    container = new PIXI.Container();
    private controls: MenuControls;
    private closed = new Subject<void>();
    private ships: ShipData[] = [];
    private itemGrid?: ItemGrid<ShipData>;
    private gridContainer = new PIXI.Container();
    private pictContainer = new PIXI.Container();
    private credits: { credits: number } = { credits: 0 };
    private bits?: ReadonlySet<number>;
    private hired: string[] = [];
    private loadPromise?: Promise<void>;

    private text = {
        description: new PIXI.Text('', FONT.normal),
        hiringPrice: new PIXI.Text('Hiring Price:', FONT.normal),
        price: new PIXI.Text('', FONT.normal),
        youHave: new PIXI.Text('You Have:', FONT.normal),
        count: new PIXI.Text('', FONT.normal),
        status: new PIXI.Text('', FONT.normal),
    };
    private buttons: { hire: Button, done: Button };

    constructor(private displayAssets: DisplayAssetDataInterface,
        private simulationData: SimulationGameDataInterface,
        controlEvents: Observable<ControlEvent>,
        private planetId: string) {
        this.container.name = 'HireEscortDialog';
        this.container.visible = false;

        const background = displayAssets.spriteFromPict('nova:8501');
        background.anchor.set(0.5);
        background.interactive = true;
        this.container.addChild(background);

        this.buttons = {
            hire: new Button(displayAssets, 'Hire Escort', 90,
                { x: -35, y: 126 }),
            done: new Button(displayAssets, 'Done', 60, { x: 100, y: 126 }),
        };
        this.buttons.hire.click.subscribe(this.hire.bind(this));
        this.buttons.done.click.subscribe(() => this.closed.next());
        for (const button of Object.values(this.buttons)) {
            this.container.addChild(button.container);
        }

        // The shipyard/outfitter panes: grid left, description middle,
        // pict upper right, prices lower right.
        this.gridContainer.position.set(-373, -153);
        this.pictContainer.position.set(174, -152.5);
        this.text.description.position.set(-27, -150);
        this.text.hiringPrice.position.set(234, 58);
        this.text.price.position.set(310, 58);
        this.text.youHave.position.set(234, 70);
        this.text.count.position.set(310, 70);
        this.text.status.position.set(-170, 118);
        this.container.addChild(this.gridContainer, this.pictContainer);
        for (const t of Object.values(this.text)) {
            this.container.addChild(t);
        }

        this.controls = new MenuControls(controlEvents, {
            left: () => this.itemGrid?.left(),
            right: () => this.itemGrid?.right(),
            up: () => this.itemGrid?.up(),
            down: () => this.itemGrid?.down(),
            buy: this.hire.bind(this),
            hire: this.hire.bind(this),
            depart: () => this.closed.next(),
        });
    }

    private load(): Promise<void> {
        this.loadPromise ??= (async () => {
            const [planet, ids] = await Promise.all([
                this.simulationData.data.Planet.get(this.planetId),
                this.simulationData.ids,
            ]);
            const ships = await Promise.all(ids.Ship.map(
                id => this.simulationData.data.Ship.get(id, 100)));
            this.ships = ships.filter(
                ship => shipHireable(ship, planet));
            this.ships.sort((a, b) => b.displayWeight - a.displayWeight);
        })();
        return this.loadPromise;
    }

    /** Rolls the day's pool once per opening (see class doc). */
    private rollPool(): ShipData[] {
        return this.ships.filter(
            ship => Math.random() * 100 < ship.hireRandom);
    }

    private setShipSelected(tile: ItemTile<ShipData> | undefined) {
        this.pictContainer.removeChildren();
        this.text.description.text = '';
        this.text.price.text = '';
        this.text.status.text = '';
        if (!tile) {
            this.refreshButtons();
            return;
        }
        if (tile.largePict) {
            this.pictContainer.addChild(tile.largePict);
        }
        this.text.description.text = resolveConditionalBlocks(
            tile.item.pilotDesc || tile.item.desc,
            makeDescTextContext(this.bits ?? [], playerGender()));
        this.text.price.text =
            `${hirePrice(tile.item).toLocaleString()} cr`;
        this.refreshButtons();
    }

    private refreshButtons() {
        this.text.count.text = `${this.credits.credits.toLocaleString()} cr`;
        const ship = this.itemGrid?.selection;
        this.buttons.hire.state =
            ship && this.credits.credits >= hirePrice(ship)
                ? 'normal' : 'grey';
    }

    private hire() {
        const ship = this.itemGrid?.selection;
        if (!ship) {
            return;
        }
        const price = hirePrice(ship);
        if (this.credits.credits < price) {
            this.text.status.text = 'You cannot afford this pilot\'s fee.';
            return;
        }
        this.credits.credits -= price;
        this.hired.push(ship.id);
        this.text.status.text = `${ship.name} hired: the pilot will `
            + `join you in formation when you lift off.`;
        this.refreshButtons();
    }

    /**
     * Shows the dialog. Hire fees settle into `credits` (a working
     * copy the caller commits); hired ship ids append to `hired`.
     *
     * Returns 'empty' WITHOUT opening the shipyard frame when the day's
     * roll turns up no pilots: an empty grid is not what the original
     * shows, it just says so and stays in the bar. The caller presents
     * NO_SHIPS_FOR_HIRE (see bar.ts) rather than this dialog doing it,
     * so the message uses the bar's own popup machinery.
     */
    async show(credits: { credits: number },
        hired: string[],
        bits?: ReadonlySet<number>): Promise<'closed' | 'empty'> {
        this.credits = credits;
        this.hired = hired;
        this.bits = bits;
        try {
            await this.load();
        } catch (e) {
            console.warn('Hire escort dialog failed to load:', e);
        }

        const pool = this.rollPool();
        if (pool.length === 0) {
            return 'empty';
        }

        this.gridContainer.removeChildren();
        this.itemGrid = new ItemGrid(this.displayAssets, pool);
        this.gridContainer.addChild(this.itemGrid.container);
        this.itemGrid.activeTile.subscribe(this.setShipSelected.bind(this));
        this.itemGrid.drawGrid();

        this.text.status.text = '';
        this.setShipSelected(undefined);

        this.container.visible = true;
        this.controls.bind();
        await firstValueFrom(this.closed);
        this.controls.unbind();
        this.container.visible = false;
        return 'closed';
    }
}

/** Whether a ship class can ever offer a pilot at this stellar. */
export function shipHireable(ship: ShipData, planet: PlanetData): boolean {
    return ship.hireRandom > 0 && ship.price > 0
        && ship.techLevel <= planet.techLevel;
}
