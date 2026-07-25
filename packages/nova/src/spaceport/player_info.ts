import { ShipData } from 'novadatainterface/ship_data';
import { Entity } from 'nova_ecs/entity';
import * as PIXI from 'pixi.js';
import { firstValueFrom, Observable, Subject } from 'rxjs';
import { DisplayAssetDataInterface } from '../client/gamedata/display_asset_data.js';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { formatDate } from '../nova_plugin/calendar.js';
import { CargoComponent } from '../nova_plugin/cargo_plugin.js';
import { ControlEvent } from '../nova_plugin/controls_plugin.js';
import { ArmorComponent, FuelComponent, ShieldComponent } from '../nova_plugin/health_plugin.js';
import { cargoName, missionCargoKey } from '../nova_plugin/mission_logic.js';
import { OutfitsStateComponent } from '../nova_plugin/outfit_plugin.js';
import { CreditsComponent, GameDateComponent, MissionsComponent } from '../nova_plugin/player_state_plugin.js';
import { combatRatingName } from '../nova_plugin/reputation.js';
import { CombatRatingComponent, LegalRecordsComponent } from '../nova_plugin/reputation_plugin.js';
import { ShipComponent, ShipPhysicsComponent } from '../nova_plugin/ship_plugin.js';
import { Button } from './button.js';
import { MenuControls } from './menu_controls.js';
import { computeCargoCapacity } from './mission_session.js';

// The player-info dialog composes the three PICTs 8518 (top strip,
// 413x40, tab row) / 8519 (black content pane, tiled or cropped to the
// content height) / 8520 (bottom strip, 413x40, Done row). Measured
// against the p_properties/*.png reference screenshots (1920x1080):
// the dialog is 413x230 overall, the four tab buttons' centers sit
// 149/50 px left and right of the dialog center, and Done sits at the
// bottom right with Jettison Cargo beside it on the cargo page.
const WIDTH = 413;
const TOP_HEIGHT = 40;
const CONTENT_HEIGHT = 150;
const BOTTOM_HEIGHT = 40;
const HEIGHT = TOP_HEIGHT + CONTENT_HEIGHT + BOTTOM_HEIGHT;
const ORIGIN_Y = -HEIGHT / 2;

const TAB_CENTERS = [-149, -50, 50, 150];
const TAB_WIDTH = 66;
// Button containers place their left cap at x+13.2 and are 25 tall.
const BUTTON_CAP = 13.2;
const TAB_Y = ORIGIN_Y + TOP_HEIGHT / 2 - 9.5;
const BOTTOM_BUTTON_Y = ORIGIN_Y + HEIGHT - BOTTOM_HEIGHT / 2 - 12.5;

const CONTENT_X = -190;
const CONTENT_TOP = ORIGIN_Y + TOP_HEIGHT + 8;
const ROW_HEIGHT = 16;
const VALUE_OFFSET = 78;
const RIGHT_COLUMN_X = 10;

const INFO_FONT: Partial<PIXI.ITextStyle> = {
    fontFamily: 'Geneva', fontSize: 10, fill: 0xffffff,
    align: 'left', wordWrap: false,
};
const PROSE_FONT: Partial<PIXI.ITextStyle> = {
    ...INFO_FONT, wordWrap: true, wordWrapWidth: 385,
};

type Page = 'general' | 'cargo' | 'extras' | 'honors';

/**
 * An approximation of the original's legal-status strings (STR# 7100
 * is not parsed yet): classifies the player's legal record with the
 * current system's government. A fresh pilot (record 0) is a
 * "Citizen", as in the p_properties/general.png reference.
 */
export function legalStatusName(record: number): string {
    if (record <= -200) {
        return 'Public Enemy';
    }
    if (record <= -25) {
        return 'Criminal';
    }
    if (record < 0) {
        return 'Offender';
    }
    if (record < 25) {
        return 'Citizen';
    }
    if (record < 100) {
        return 'Good Citizen';
    }
    return 'Pillar of Society';
}

/**
 * The player-info dialog ('p'): four pages — General, Cargo, Extras,
 * Honors — on the 8518/8519/8520 three-part frame, per the
 * p_properties reference screenshots. Toggles from flight and from the
 * spaceport; read-only (the reference's Jettison Cargo button is shown
 * greyed — jettison isn't modeled, and in flight the cargo hold
 * belongs to the simulation).
 */
export class PlayerInfoDialog {
    container = new PIXI.Container();
    private controls: MenuControls;
    private closed = new Subject<void>();
    private tabs: { [page in Page]: Button };
    private jettison: Button;
    private content = new PIXI.Container();
    private page: Page = 'general';
    private entity?: Entity;
    private shipData?: ShipData;
    private cargoCapacity = 0;
    /** Standard cargo names (STR# 4000), loaded on first show. */
    private cargoNames: string[] = [];
    private outfitNames = new Map<string, { name: string, price: number }>();

    constructor(private displayAssets: DisplayAssetDataInterface,
        private simulationData: SimulationGameDataInterface,
        controlEvents: Observable<ControlEvent>,
        /** The system the player is currently in (for Legal Status). */
        private getSystemId?: () => string | undefined) {
        this.container.name = 'PlayerInfo';
        this.container.visible = false;

        // A modal shield behind the frame, so clicks can't reach the
        // screen underneath while the dialog is up.
        const shield = new PIXI.Graphics()
            .beginFill(0x000000, 0.001)
            .drawRect(-4000, -4000, 8000, 8000)
            .endFill();
        shield.interactive = true;
        this.container.addChild(shield);

        const top = displayAssets.spriteFromPict('nova:8518');
        top.position.set(-WIDTH / 2, ORIGIN_Y);
        const middle = new PIXI.TilingSprite(
            displayAssets.textureFromPict('nova:8519'),
            WIDTH, CONTENT_HEIGHT);
        middle.position.set(-WIDTH / 2, ORIGIN_Y + TOP_HEIGHT);
        const bottom = displayAssets.spriteFromPict('nova:8520');
        bottom.position.set(-WIDTH / 2, ORIGIN_Y + TOP_HEIGHT + CONTENT_HEIGHT);
        top.interactive = middle.interactive = bottom.interactive = true;
        this.container.addChild(top, middle, bottom);

        const tabButton = (label: string, page: Page, slot: number) => {
            const button = new Button(displayAssets, label, TAB_WIDTH, {
                x: TAB_CENTERS[slot] - BUTTON_CAP - TAB_WIDTH / 2,
                y: TAB_Y,
            });
            button.click.subscribe(() => this.showPage(page));
            return button;
        };
        this.tabs = {
            general: tabButton('General', 'general', 0),
            cargo: tabButton('Cargo', 'cargo', 1),
            extras: tabButton('Extras', 'extras', 2),
            honors: tabButton('Honors', 'honors', 3),
        };
        for (const tab of Object.values(this.tabs)) {
            this.container.addChild(tab.container);
        }

        // The reference's Jettison Cargo button (cargo page only).
        // Greyed: jettison isn't modeled yet, and the dialog is
        // read-only in flight.
        this.jettison = new Button(displayAssets, 'Jettison Cargo', 100,
            { x: -72 - BUTTON_CAP - 50, y: BOTTOM_BUTTON_Y });
        this.jettison.state = 'grey';
        this.jettison.container.visible = false;
        this.container.addChild(this.jettison.container);

        const done = new Button(displayAssets, 'Done', 60,
            { x: 135 - BUTTON_CAP - 30, y: BOTTOM_BUTTON_Y });
        done.click.subscribe(() => this.closed.next());
        this.container.addChild(done.container);

        this.container.addChild(this.content);

        this.controls = new MenuControls(controlEvents, {
            // 'p' toggles the dialog closed again; 'd' backs out too.
            properties: () => this.closed.next(),
            depart: () => this.closed.next(),
        });
    }

    /** Shows the dialog and resolves when the player dismisses it. */
    async show(entity: Entity): Promise<void> {
        this.entity = entity;
        try {
            await this.load(entity);
        } catch (e) {
            console.warn('Player info failed to load game data:', e);
        }
        this.showPage(this.page);
        this.container.visible = true;
        this.controls.bind();
        await firstValueFrom(this.closed);
        this.controls.unbind();
        this.container.visible = false;
    }

    private async load(entity: Entity) {
        const shipId = entity.components.get(ShipComponent)?.id;
        this.shipData = shipId
            ? await this.simulationData.data.Ship.get(shipId) : undefined;
        this.cargoCapacity =
            await computeCargoCapacity(entity, this.simulationData);
        if (this.cargoNames.length === 0) {
            const ids = await this.simulationData.ids;
            if (ids.PlayerStart[0]) {
                this.cargoNames = [...(await this.simulationData.data
                    .PlayerStart.get(ids.PlayerStart[0])).cargoNames];
            }
        }
        // Outfit names and prices, for the Extras page.
        this.outfitNames.clear();
        const outfits = entity.components.get(OutfitsStateComponent);
        if (outfits) {
            for (const id of outfits.keys()) {
                try {
                    const outfit =
                        await this.simulationData.data.Outfit.get(id);
                    this.outfitNames.set(id,
                        { name: outfit.name, price: outfit.price });
                } catch {
                    this.outfitNames.set(id, { name: id, price: 0 });
                }
            }
        }
    }

    private showPage(page: Page) {
        this.page = page;
        // The current page's tab is the greyed one, as in the
        // reference screenshots.
        for (const [name, tab] of Object.entries(this.tabs)) {
            tab.state = name === page ? 'grey' : 'normal';
        }
        // Jettison Cargo only appears on the cargo page and only when
        // there is cargo aboard (compare p_properties/cargo.png — no
        // button — with cargo_with_stuff.png). Greyed: jettison isn't
        // modeled yet.
        const cargo = this.entity?.components.get(CargoComponent);
        const hasCargo = !![...(cargo ?? new Map())]
            .find(([, count]) => count > 0);
        this.jettison.container.visible = page === 'cargo' && hasCargo;
        this.content.removeChildren();
        if (!this.entity) {
            return;
        }
        switch (page) {
            case 'general':
                this.renderGeneral(this.entity);
                break;
            case 'cargo':
                this.renderCargo(this.entity);
                break;
            case 'extras':
                this.renderExtras(this.entity);
                break;
            case 'honors':
                this.renderHonors();
                break;
        }
    }

    private addRows(rows: [string, string][], x: number) {
        rows.forEach(([label, value], i) => {
            const labelText = new PIXI.Text(label, INFO_FONT);
            labelText.position.set(x, CONTENT_TOP + i * ROW_HEIGHT);
            const valueText = new PIXI.Text(value, INFO_FONT);
            valueText.position.set(x + VALUE_OFFSET,
                CONTENT_TOP + i * ROW_HEIGHT);
            this.content.addChild(labelText, valueText);
        });
    }

    private addProse(lines: string[]) {
        const text = new PIXI.Text(lines.join('\n\n'), PROSE_FONT);
        text.position.set(CONTENT_X, CONTENT_TOP);
        this.content.addChild(text);
    }

    private renderGeneral(entity: Entity) {
        const date = entity.components.get(GameDateComponent);
        const credits = entity.components.get(CreditsComponent);
        const shield = entity.components.get(ShieldComponent);
        const armor = entity.components.get(ArmorComponent);
        const fuel = entity.components.get(FuelComponent);
        const rating = entity.components.get(CombatRatingComponent);
        const records = entity.components.get(LegalRecordsComponent);
        const physics = entity.components.get(ShipPhysicsComponent)
            ?? this.shipData?.physics;

        const percent = (part?: { current: number, max: number }) =>
            part && part.max > 0
                ? `${Math.round(100 * part.current / part.max)}%` : '-';

        const systemId = this.getSystemId?.();
        // Legal status is with the current system's government. The
        // system's govt id keys the player's legal records.
        let legal = '-';
        if (systemId) {
            const record = this.systemGovtRecord(systemId, records);
            if (record !== undefined) {
                legal = legalStatusName(record);
            }
        }

        const left: [string, string][] = [
            // Pilot naming isn't modeled (the original shows the
            // save-file pilot's name here).
            ['Pilot Name:', '-'],
            ['Current Date:', date ? formatDate(date) : '-'],
            ['System:', this.systemName ?? '-'],
            ['Legal Status:', legal],
            ['Combat Rating:', combatRatingName(rating?.kills ?? 0)],
            ['Shield Status:', percent(shield)],
            ['Armor Status:', percent(armor)],
            ['Energy Status:', fuel
                ? `${percent(fuel)} (${Math.floor(fuel.current / 100)} jumps)`
                : '-'],
        ];
        // Turn rate is stored in rad/sec (raw EVN units * 0.3°/sec);
        // speed and acceleration in px/sec (raw * 30/100). Display the
        // original's raw-unit numbers, as the reference does.
        const degPerSec = physics
            ? Math.round(physics.turnRate * 180 / Math.PI) : undefined;
        const rawSpeed = physics
            ? Math.round(physics.speed * 100 / 30) : undefined;
        const rawAccel = physics
            ? Math.round(physics.acceleration * 100 / 30) : undefined;
        const right: [string, string][] = [
            // Player ship naming isn't modeled; both rows show the
            // class (the original's Ship Name is the pilot's own).
            ['Ship Name:', this.shipData?.name ?? '-'],
            ['Ship Class:', this.shipData?.name ?? '-'],
            ['Turn Rate:', degPerSec !== undefined
                ? `${degPerSec}°/sec` : '-'],
            ['Accel Rate:', rawAccel !== undefined ? `${rawAccel}` : '-'],
            ['Max Speed:', rawSpeed !== undefined ? `${rawSpeed}` : '-'],
            ['Credits:', credits
                ? credits.credits.toLocaleString() : '-'],
        ];
        this.addRows(left, CONTENT_X);
        this.addRows(right, RIGHT_COLUMN_X);
    }

    private systemName?: string;

    /** Loads the current system's name and the player's record there. */
    private systemGovtRecord(systemId: string,
        records?: ReadonlyMap<string, number>): number | undefined {
        // Kick off (or reuse) the async load; the value shows on the
        // next page render if it wasn't ready yet.
        void this.simulationData.data.System.get(systemId).then(system => {
            this.systemName = system.name;
        }).catch(() => undefined);
        const cached = this.simulationData.data.System.getCached(systemId);
        if (!cached) {
            return records ? 0 : undefined;
        }
        this.systemName = cached.name;
        if (!cached.govt) {
            return 0;
        }
        return records?.get(cached.govt) ?? 0;
    }

    private renderCargo(entity: Entity) {
        const cargo = entity.components.get(CargoComponent) ?? new Map();
        const missions = entity.components.get(MissionsComponent);
        const lines: string[] = ['Current cargo in your ship:'];
        let held = 0;
        const itemLines: string[] = [];
        for (const [key, count] of cargo) {
            if (count <= 0) {
                continue;
            }
            held += count;
            if (key.startsWith('cargo:')) {
                const index = Number(key.slice('cargo:'.length));
                itemLines.push(`${count} tons of `
                    + `${cargoName(index, this.cargoNames)}.`);
            } else if (key.startsWith('junk:')) {
                itemLines.push(`${count} tons of cargo.`);
            } else {
                // Mission cargo: name it from the active mission that
                // carries it, as the reference does ("Space probe.").
                let named = false;
                if (missions) {
                    for (const [missionId, active] of missions) {
                        if (missionCargoKey(missionId) === key
                            && active.cargoType >= 0) {
                            itemLines.push(cargoName(active.cargoType,
                                this.cargoNames) + '.');
                            named = true;
                            break;
                        }
                    }
                }
                if (!named) {
                    itemLines.push(`${count} tons of mission cargo.`);
                }
            }
        }
        if (itemLines.length === 0) {
            itemLines.push('Nothing.');
        }
        lines.push(itemLines.join('\n'));
        lines.push('Free cargo space: '
            + `${Math.max(0, this.cargoCapacity - held)} tons`);
        this.addProse(lines);
    }

    private renderExtras(entity: Entity) {
        const outfits = entity.components.get(OutfitsStateComponent);
        const parts: string[] = [];
        let outfitValue = 0;
        if (outfits) {
            for (const [id, { count }] of outfits) {
                if (count <= 0) {
                    continue;
                }
                const info = this.outfitNames.get(id);
                const name = info?.name ?? id;
                parts.push(count > 1 ? `${count} x ${name}` : name);
                outfitValue += (info?.price ?? 0) * count;
            }
        }
        const lines = ['Current extras for your ship:',
            parts.length > 0 ? parts.join(', ') + '.' : 'None.'];
        if (this.shipData) {
            // Trade-in at 25% of the ship's and outfits' original
            // cost (the original's shipyard trade-in rate).
            const tradeIn = Math.floor(
                0.25 * (this.shipData.price + outfitValue));
            lines.push(`Ship trade-in value: `
                + `${tradeIn.toLocaleString()} credits`);
        }
        this.addProse(lines);
    }

    private renderHonors() {
        // Ränk resources aren't parsed yet, so there are no ranks or
        // honors to report (documented gap).
        this.addProse(['Your ranks and honors:', 'None.']);
    }
}
