import { PlanetData } from 'novadatainterface/PlanetData';
import { AsyncSystemResource } from 'nova_ecs/async_system';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { World } from 'nova_ecs/world';
import * as PIXI from 'pixi.js';
import { Observable } from 'rxjs';
import { GameData } from '../client/gamedata/GameData';
import { AnimationGraphic } from '../display/animation_graphic';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import { GameDataResource } from '../nova_plugin/game_data_resource';
import { ArmorComponent, IonizationComponent, ShieldComponent } from '../nova_plugin/health_plugin';
import { MissionNotice } from '../nova_plugin/mission_plugin';
import { OutfitsStateComponent } from '../nova_plugin/outfit_plugin';
import type { PlanetType } from '../nova_plugin/planet_plugin';
import { PlayerStateComponent } from '../nova_plugin/player_state';
import {
    buyFuel,
    FUEL_PRICE_PER_JUMP,
    refuelsOnLanding,
} from '../nova_plugin/fuel';
import {
    ShipDataComponent,
    ShipPhysicsComponent,
} from '../nova_plugin/ship_plugin';
import { SystemIdResource } from '../nova_plugin/system_id_resource';
import { SystemPlugin } from '../nova_plugin/system_plugin';
import { WeaponsStateComponent } from '../nova_plugin/weapons_state';
import { Button } from './button';
import {
    SERVICE_COLUMN,
    SERVICE_FLAG,
    SPACEPORT_LAYOUT,
    SPACEPORT_SERVICE_COLUMNS,
    SPACEPORT_SERVICES,
    spaceportButtonColumn,
    SpaceportButtonColumn,
    SpaceportService,
} from './spaceport_layout';
import { Bar } from './bar';
import { Menu } from './menu';
import { MenuControls } from './menu_controls';
import { MissionBbs, MissionBoard, MissionInfo } from './mission_bbs';
import { Outfitter } from './outfitter';
import { ShipInfo } from './ship_info';
import { Shipyard } from './shipyard';
import { TradeCenter } from './trade_center';
import { LandingNoticeDialog } from './landing_notice_dialog';
import { plainSnapshot } from 'nova_ecs/draft_snapshot';
import {
    hasSpaceportService,
    resolveSpaceportPlanetData,
} from './availability';

/** Initial slot for a service button before the column is laid out. */
function buttonSlot(column: SpaceportButtonColumn, index: number) {
    const { firstY, pitch } = SPACEPORT_LAYOUT.buttons;
    const { x } = SPACEPORT_LAYOUT.buttons[column];
    return { x, y: firstY + index * pitch };
}

const LANDSCAPE_WIDTH = 612;
const LANDSCAPE_HEIGHT = 285;
const LANDSCAPE_X = -306;
const LANDSCAPE_Y = -256;

/**
 * Each opener closes its dialog in a `finally`, so a rejected `show()` looks
 * exactly like a screen that never opened. Log it instead of discarding it.
 */
function reportDialogFailure(dialog: string, error: unknown) {
    console.error(`Spaceport ${dialog} failed to open`, error);
}

export class Spaceport extends Menu<Entity> {
    private outfitter: Outfitter;
    private shipyard: Shipyard;
    private missionBbs: MissionBbs;
    private bar: Bar;
    private tradeCenter: TradeCenter;
    private tradeCenterAvailable = false;
    private missionInfo: MissionInfo;
    private shipInfo: ShipInfo;
    private landingNoticeDialog: LandingNoticeDialog;
    private readonly dialogContainers = new Set<PIXI.Container>();
    private data?: PlanetData;
    private readonly id: string;
    private serviceButtons?: Record<SpaceportService, Button>;
    private missionNotice = new PIXI.Text("", {
        fontFamily: "Geneva", fontSize: 10, fill: 0xffff00,
        align: "left", wordWrap: true, wordWrapWidth: 420,
    } as const);
    // The status bar, which is where a pilot would otherwise watch their fuel
    // and credits change, is hidden behind the landing screen. One click buys
    // every missing jump, so without a receipt the deduction looks arbitrary.
    private rechargeNotice = new PIXI.Text("", {
        fontFamily: "Geneva", fontSize: 10, fill: 0xffffff,
        align: "left", wordWrap: true, wordWrapWidth: 420,
    } as const);

    private font = {
        title: {
            fontFamily: "Geneva", fontSize: 18, fill: 0xffffff,
            align: 'center'
        } as const,
        desc: {
            fontFamily: "Geneva", fontSize: 9, fill: 0xffffff,
            align: 'left', wordWrap: true, wordWrapWidth: 301
        } as const,
    };

    constructor(
        gameData: GameData,
        private readonly authoritativePlanet: PlanetType,
        controlEvents: Observable<ControlEvent>) {
        super(gameData, "nova:8500", controlEvents);
        this.id = authoritativePlanet.id;
        this.container.name = 'Spaceport';

        const buttons = {
            // Positions come from the metal strip measured on PICT 8500;
            // the column is re-laid out per stellar in updateServiceButtons.
            outfitter: new Button(
                gameData, "Outfitter", SPACEPORT_LAYOUT.buttons.right.width,
                buttonSlot('right', 1)),
            shipyard: new Button(
                gameData, "Shipyard", SPACEPORT_LAYOUT.buttons.right.width,
                buttonSlot('right', 0)),
            missionBBS: new Button(
                gameData, "Mission BBS", SPACEPORT_LAYOUT.buttons.left.width,
                buttonSlot('left', 1)),
            bar: new Button(
                gameData, "Bar", SPACEPORT_LAYOUT.buttons.left.width,
                buttonSlot('left', 0)),
            tradeCenter: new Button(
                gameData, "Trade Center",
                SPACEPORT_LAYOUT.buttons.left.width,
                buttonSlot('left', 2)),
            // STR# 150 string 6. Retail sells fuel by the jump on landing.
            recharge: new Button(
                gameData, "Recharge", SPACEPORT_LAYOUT.buttons.right.width,
                buttonSlot('right', 2)),
            leave: new Button(
                gameData, "Leave", SPACEPORT_LAYOUT.buttons.right.width, {
                x: SPACEPORT_LAYOUT.buttons.right.x,
                y: SPACEPORT_LAYOUT.buttons.leaveY,
            })
        };
        this.serviceButtons = {
            shipyard: buttons.shipyard,
            outfitter: buttons.outfitter,
            tradeCenter: buttons.tradeCenter,
            bar: buttons.bar,
            missionBBS: buttons.missionBBS,
            recharge: buttons.recharge,
        };

        buttons.recharge.click.subscribe(() => this.recharge());
        buttons.leave.click.subscribe(this.done.bind(this));

        this.outfitter = new Outfitter(gameData, controlEvents);
        const showOutfitter = async () => {
            if (!this.data || !hasSpaceportService(this.data, "outfitter")) {
                return;
            }
            this.controls.unbind();
            this.setActiveDialog(this.outfitter.container);
            // The dialog holds these for its whole session, which spans many
            // world steps, so it is given copies and its results are written
            // back explicitly. A retained draft would be revoked, and the
            // credits it deducts would be lost with it.
            const outfits = plainSnapshot(
                this.input.components.get(OutfitsStateComponent)) ?? new Map();
            const playerState = plainSnapshot(
                this.input.components.get(PlayerStateComponent));
            try {
                this.outfitter.setPlayerState(playerState);
                this.outfitter.setShipData(plainSnapshot(
                    this.input.components.get(ShipDataComponent)));
                const newOutfits = await this.outfitter.show(outfits);
                this.input.components.set(OutfitsStateComponent, newOutfits);
                if (playerState) {
                    this.input.components.set(
                        PlayerStateComponent, playerState);
                }
                // Delete these so they are re-created with the new outfits.
                // TODO: Find a better way to do this.
                this.input.components.delete(WeaponsStateComponent);
                this.input.components.delete(ShipPhysicsComponent);
            } catch (error) {
                reportDialogFailure('outfitter', error);
            } finally {
                this.setActiveDialog();
                this.controls.bind();
            }
        };
        buttons.outfitter.click.subscribe(showOutfitter);

        this.shipyard = new Shipyard(gameData, controlEvents);

        const showShipyard = async () => {
            if (!this.data || !hasSpaceportService(this.data, "shipyard")) {
                return;
            }
            this.controls.unbind();
            this.setActiveDialog(this.shipyard.container);
            try {
                // Copied for the same reason as the outfitter above. The
                // shipyard writes the state back itself when a hull is bought.
                this.shipyard.setPlayerState(plainSnapshot(
                    this.input.components.get(PlayerStateComponent)));
                const newInput = await this.shipyard.show(this.input);
                if (newInput !== this.input) {
                    // Construct a fake system and run providers so that outfits of the new
                    // ship are provided.
                    const shipBuildWorld = new World('outfit builder');
                    shipBuildWorld.resources.set(GameDataResource, gameData);
                    shipBuildWorld.resources.set(SystemIdResource, 'nova:128');
                    await shipBuildWorld.addPlugin(SystemPlugin);
                    shipBuildWorld.entities.set('ship', newInput);
                    shipBuildWorld.step();
                    await shipBuildWorld.resources.get(AsyncSystemResource)?.done;
                    shipBuildWorld.step();
                    shipBuildWorld.entities.delete('ship');
                }
                this.input = newInput;
            } catch (error) {
                reportDialogFailure('shipyard', error);
            } finally {
                this.setActiveDialog();
                this.controls.bind();
            }
        };
        buttons.shipyard.click.subscribe(showShipyard);

        this.missionInfo = new MissionInfo(gameData, controlEvents);
        this.landingNoticeDialog = new LandingNoticeDialog(gameData, controlEvents);
        /**
         * `from` is the board the mission log was opened from, so control and
         * visibility return to that board rather than always to the mission
         * computer. Getting this wrong leaves the bar's pending show() behind
         * a hidden container, which cannot then be closed.
         */
        const showMissionInfo = async (from?: MissionBoard) => {
            this.controls.unbind();
            from?.suspendControls();
            this.setActiveDialog(this.missionInfo.container);
            try {
                await this.missionInfo.show(this.input);
            } catch (error) {
                reportDialogFailure('mission log', error);
            } finally {
                if (from) {
                    this.setActiveDialog(from.container);
                    from.resumeControls();
                } else {
                    this.setActiveDialog();
                    this.controls.bind();
                }
            }
        };
        this.missionBbs = new MissionBbs(
            gameData, this.id, controlEvents,
            () => showMissionInfo(this.missionBbs));
        this.bar = new Bar(
            gameData, this.id, controlEvents, () => showMissionInfo(this.bar));
        this.tradeCenter = new TradeCenter(gameData, this.id, controlEvents);
        this.dialogContainers.add(this.outfitter.container);
        this.dialogContainers.add(this.shipyard.container);
        this.dialogContainers.add(this.missionBbs.container);
        this.dialogContainers.add(this.bar.container);
        this.dialogContainers.add(this.tradeCenter.container);
        this.dialogContainers.add(this.missionInfo.container);
        this.dialogContainers.add(this.landingNoticeDialog.container);

        const showMissionBbs = async () => {
            this.controls.unbind();
            this.setActiveDialog(this.missionBbs.container);
            try {
                await this.missionBbs.show(this.input);
            } catch (error) {
                reportDialogFailure('mission BBS', error);
            } finally {
                this.setActiveDialog();
                this.controls.bind();
            }
        };
        const showBar = async () => {
            if (!this.data || !hasSpaceportService(this.data, "bar")) {
                return;
            }
            this.controls.unbind();
            this.setActiveDialog(this.bar.container);
            try {
                await this.bar.show(this.input);
            } catch (error) {
                reportDialogFailure('bar', error);
            } finally {
                this.setActiveDialog();
                this.controls.bind();
            }
        };
        const showTradeCenter = async () => {
            if (!this.data || !this.tradeCenterAvailable) {
                return;
            }
            this.controls.unbind();
            this.setActiveDialog(this.tradeCenter.container);
            try {
                await this.tradeCenter.show(this.input);
            } catch (error) {
                reportDialogFailure('trade center', error);
            } finally {
                this.setActiveDialog();
                this.controls.bind();
            }
        };
        buttons.missionBBS.click.subscribe(showMissionBbs);
        buttons.bar.click.subscribe(showBar);
        buttons.tradeCenter.click.subscribe(showTradeCenter);
        this.addButtons(buttons);

        this.shipInfo = new ShipInfo(gameData, controlEvents);
        this.dialogContainers.add(this.shipInfo.container);
        const showShipInfo = async () => {
            this.controls.unbind();
            this.setActiveDialog(this.shipInfo.container);
            try {
                this.shipInfo.setSystemName(this.data?.name);
                await this.shipInfo.show(this.input);
            } catch (error) {
                reportDialogFailure('ship info', error);
            } finally {
                this.setActiveDialog();
                this.controls.bind();
            }
        };

        this.controls = new MenuControls(controlEvents, {
            properties: showShipInfo,
            outfitter: showOutfitter,
            shipyard: showShipyard,
            missionBBS: showMissionBbs,
            bar: showBar,
            tradeCenter: showTradeCenter,
            missions: () => showMissionInfo(),
            depart: this.done.bind(this),
        });
    }

    get resolvedPlanetData(): PlanetData | undefined {
        return this.data;
    }

    /**
     * Retail omits unavailable services independently in each metal strip, so
     * a missing button only closes the gap in its own column.
     */
    private updateServiceButtons(data: PlanetData) {
        const buttons = this.serviceButtons;
        if (!buttons) {
            return;
        }
        const available = SPACEPORT_SERVICES.filter(service => {
            if (service === "tradeCenter") {
                return this.tradeCenterAvailable;
            }
            if (service === "recharge") {
                return refuelsOnLanding(data);
            }
            return hasSpaceportService(data, SERVICE_FLAG[service]);
        });
        const availableSet = new Set(available);
        const columns = {
            left: spaceportButtonColumn<SpaceportService>(
                SPACEPORT_SERVICE_COLUMNS.left.filter(
                    service => availableSet.has(service))),
            right: spaceportButtonColumn<SpaceportService>(
                SPACEPORT_SERVICE_COLUMNS.right.filter(
                    service => availableSet.has(service))),
        };
        this.updateRechargeState();
        for (const service of SPACEPORT_SERVICES) {
            const column = SERVICE_COLUMN[service];
            const y = columns[column].get(service);
            buttons[service].container.visible = y !== undefined;
            if (y !== undefined) {
                buttons[service].container.position.set(
                    SPACEPORT_LAYOUT.buttons[column].x, y);
            }
        }
    }

    /**
     * A pilot with a full tank, or without the price of a single jump, has
     * nothing to buy here. Greying the button is also the only confirmation
     * that a recharge succeeded while the status bar is hidden behind the
     * landing screen.
     */
    private updateRechargeState(ship?: Entity): void {
        const button = this.serviceButtons?.recharge;
        // build() runs before anyone has landed, so there is no ship to read.
        const landed = ship ?? this.input;
        if (!button || !landed) {
            return;
        }
        const state = landed.components.get(PlayerStateComponent);
        const capacity = landed.components
            .get(ShipDataComponent)?.fuelCapacity ?? 0;
        const affordable = (state?.credits ?? 0) >= FUEL_PRICE_PER_JUMP;
        const missing = capacity - (state?.fuel ?? 0) > 0;
        button.state = missing && affordable ? 'normal' : 'grey';
    }

    /**
     * The Auto-recharger buys the recharge for the pilot on landing.
     *
     * Retail prices it at 5,000 credits and the Bible lists it as ModType 19,
     * "auto-refueller", whose ModVal is "ignored". It saves the trip to the
     * button rather than making the fuel any cheaper.
     */
    private async autoRecharge(ship: Entity): Promise<void> {
        const outfits = ship.components.get(OutfitsStateComponent);
        if (!outfits?.size) {
            return;
        }
        for (const id of outfits.keys()) {
            try {
                const outfit = await this.gameData.data.Outfit.get(id);
                if (outfit.isAutoRecharger) {
                    this.recharge(ship, 'Auto-recharger');
                    return;
                }
            } catch {
                // An unknown outfit simply is not an auto-recharger.
            }
        }
    }

    /**
     * Buy fuel by the jump.
     *
     * The pilot leaves with as many whole jumps as their credits stretch to,
     * and a pilot who cannot afford one is simply left as they were.
     */
    private recharge(ship: Entity = this.input, buyer = 'Recharged'): void {
        const state = ship.components.get(PlayerStateComponent);
        const capacity = ship.components
            .get(ShipDataComponent)?.fuelCapacity ?? 0;
        if (!state || capacity <= 0 || !this.data
            || !refuelsOnLanding(this.data)) {
            return;
        }
        const spent = state.credits;
        const result = buyFuel(state.fuel ?? 0, capacity, state.credits);
        if (result.purchased <= 0) {
            return;
        }
        state.fuel = result.fuel;
        state.credits = result.credits;
        this.rechargeNotice.text = `${buyer} ${result.purchased} jump${
            result.purchased === 1 ? '' : 's'} for ${
            (spent - result.credits).toLocaleString()} cr.`;
        this.updateRechargeState();
    }

    private setActiveDialog(active?: PIXI.Container) {
        for (const child of this.container.children) {
            if (this.dialogContainers.has(child as PIXI.Container)) {
                child.visible = child === active;
            } else {
                child.visible = active === undefined;
            }
        }
    }

    override async build() {
        await super.build();
        await Promise.all([
            this.missionBbs.buildPromise,
            this.bar.buildPromise,
            this.tradeCenter.buildPromise,
            this.missionInfo.buildPromise,
            this.shipInfo.buildPromise,
            this.landingNoticeDialog.buildPromise,
        ]);
        const localData = await this.gameData.data.Planet.get(this.id);
        const data = resolveSpaceportPlanetData(
            localData, this.authoritativePlanet);
        this.data = data;
        this.outfitter.setPlanetData(data);
        this.shipyard.setPlanetData(data);
        // Eleven retail jünk routes run through stellars that never set the
        // commodity flag, so the exchange has to open for them too.
        this.tradeCenterAvailable =
            hasSpaceportService(data, "commodity")
            || await this.tradeCenter.hasJunkTradeLocation();
        this.updateServiceButtons(data);
        const title = new PIXI.Text(data.name, this.font.title);
        title.position.x = -24;
        title.position.y = 39;
        this.container.addChild(title);

        const desc = new PIXI.Text(data.landingDesc, this.font.desc);
        desc.position.x = -149;
        desc.position.y = 70;
        this.container.addChild(desc);

        let spaceportLandscape: PIXI.Container | PIXI.Sprite;
        if (data.hasCustomLandingPict) {
            spaceportLandscape = this.gameData.spriteFromPict(data.landingPict);
        }
        else {
            const standardLandscape = new PIXI.Container();
            const background = new PIXI.Graphics();
            background.beginFill(0x000000);
            background.drawRect(0, 0, LANDSCAPE_WIDTH, LANDSCAPE_HEIGHT);
            background.endFill();
            standardLandscape.addChild(background);

            const planetGraphic = new AnimationGraphic({
                gameData: this.gameData,
                animation: data.animation,
            });
            await planetGraphic.buildPromise;
            planetGraphic.progress = 0;
            const scale = Math.min(
                LANDSCAPE_WIDTH * 0.85 / planetGraphic.size.x,
                LANDSCAPE_HEIGHT * 0.85 / planetGraphic.size.y,
                3,
            );
            planetGraphic.container.position.set(
                LANDSCAPE_WIDTH / 2, LANDSCAPE_HEIGHT / 2);
            planetGraphic.container.scale.set(scale);
            standardLandscape.addChild(planetGraphic.container);
            spaceportLandscape = standardLandscape;
        }
        spaceportLandscape.position.x = LANDSCAPE_X;
        spaceportLandscape.position.y = LANDSCAPE_Y;
        // The landing landscape is an opaque 612x285 retail PICT. Keep it
        // immediately above the Spaceport frame and below every control.
        this.container.addChildAt(spaceportLandscape, 1);
        this.container.addChild(this.outfitter.container);
        this.container.addChild(this.shipyard.container);
        this.container.addChild(this.missionBbs.container);
        this.container.addChild(this.bar.container);
        this.container.addChild(this.tradeCenter.container);
        this.container.addChild(this.missionInfo.container);
        this.container.addChild(this.shipInfo.container);
        this.container.addChild(this.landingNoticeDialog.container);
        this.missionNotice.position.set(-210, 145);
        this.container.addChild(this.missionNotice);
        this.rechargeNotice.position.set(-210, 175);
        this.container.addChild(this.rechargeNotice);
    }

    override async show(
        input: Entity,
        landingNotices: readonly MissionNotice[] = [],
    ): Promise<Entity> {
        await this.buildPromise;
        this.rechargeNotice.text = '';
        // Retail's Auto-recharger buys the recharge on landing, so this
        // belongs to a landing and not to building the screen: build() runs
        // when the planet loads, when there is no ship to refuel.
        await this.autoRecharge(input);
        this.updateRechargeState(input);
        // A dialog left active by a previous landing would keep the landing
        // artwork and buttons hidden, which reads as a black screen on
        // reload. Start every landing on the landing screen itself.
        this.setActiveDialog();
        this.controls.bind();
        this.missionNotice.text = '';

        if (landingNotices.length > 0) {
            this.controls.unbind();
            for (const notice of landingNotices) {
                this.setActiveDialog(this.landingNoticeDialog.container);
                try {
                    await this.landingNoticeDialog.show(notice);
                } catch (error) {
                    reportDialogFailure('landing notice', error);
                }
            }
            this.setActiveDialog();
            this.controls.bind();
        }

        return super.show(input);
    }

    protected override done() {
        if (this.data) {
            const movement = this.input.components.get(MovementStateComponent);
            if (movement) {
                movement.position = new Position(...this.data.position);
                movement.velocity = new Vector(0, 0);
            }
            const shield = this.input.components.get(ShieldComponent);
            if (shield) {
                shield.current = shield.max;
            }
            const armor = this.input.components.get(ArmorComponent);
            if (armor) {
                armor.current = armor.max;
            }
            const ionization = this.input.components.get(IonizationComponent);
            if (ionization) {
                ionization.current = 0;
            }
        }
        super.done();
    }
}
