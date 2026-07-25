import { PlanetData } from 'novadatainterface/planet_data';
import { AsyncSystemResource } from 'nova_ecs/async_system';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { Random, RandomResource } from 'nova_ecs/plugins/random_plugin';
import { World } from 'nova_ecs/world';
import * as PIXI from 'pixi.js';
import { Observable } from 'rxjs';
import { DisplayAssetDataInterface } from '../client/gamedata/display_asset_data.js';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { ControlEvent } from '../nova_plugin/controls_plugin.js';
import { DisplayAssetDataResource, SimulationGameDataResource } from '../nova_plugin/game_data_resource.js';
import { ArmorComponent, FuelComponent, IonizationComponent, ShieldComponent } from '../nova_plugin/health_plugin.js';
import { IdFactory, IdFactoryResource } from '../nova_plugin/id_factory.js';
import { ShipPhysicsComponent } from '../nova_plugin/ship_plugin.js';
import { SystemIdResource } from '../nova_plugin/system_id_resource.js';
import { SystemPlugin } from '../nova_plugin/system_plugin.js';
import { WeaponsStateComponent } from '../nova_plugin/weapons_state.js';
import { formatDate } from '../nova_plugin/calendar.js';
import { LOCATION_MISSION_COMPUTER, MissionEvent } from '../nova_plugin/mission_logic.js';
import { missionDisplayName } from '../nova_plugin/mission_text.js';
import { CreditsComponent, GameDateComponent } from '../nova_plugin/player_state_plugin.js';
import { Bar } from './bar.js';
import { Button } from './button.js';
import { Menu } from './menu.js';
import { MenuControls } from './menu_controls.js';
import { MissionBoard } from './mission_board.js';
import { processEntityLanding } from './mission_session.js';
import { MissionUniverse } from './mission_universe.js';
import { Outfitter } from './outfitter.js';
import { Shipyard } from './shipyard.js';
import { OpenStarmapOptions } from './starmap.js';
import { TradeCenter } from './trade_center.js';

// The 618x517 spaceport frame (PICT 8500): the landing image fills the
// top, the stellar name and description sit in the center panel, and
// the venue buttons run down the left and right metal panels — Bar /
// Mission BBS / Trade Center on the left, Shipyard / Outfitter /
// Recharge / Leave on the right, per the original's arrangement.
const LEFT_BUTTON_X = -296;
const RIGHT_BUTTON_X = 162;
const BUTTON_TOP = 42;
const BUTTON_SPACING = 42;
const BUTTON_WIDTH = 120;

export class Spaceport extends Menu<Entity> {
    private outfitter: Outfitter;
    private shipyard: Shipyard;
    private missionComputer: MissionBoard;
    private bar: Bar;
    private tradeCenter: TradeCenter;
    private universe: MissionUniverse;
    private buttons: {
        bar: Button, missions: Button, tradeCenter: Button,
        shipyard: Button, outfitter: Button, recharge: Button,
        leave: Button,
    };
    private data?: PlanetData;
    private notices = new PIXI.Text('', {
        fontFamily: 'Geneva', fontSize: 10, fill: 0xffff88,
        align: 'left', wordWrap: true, wordWrapWidth: 301,
    });
    private statusLine = new PIXI.Text('', {
        fontFamily: 'Geneva', fontSize: 10, fill: 0xffffff,
        align: 'left', wordWrap: false,
    });

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

    constructor(displayAssets: DisplayAssetDataInterface,
        simulationData: SimulationGameDataInterface, private id: string,
        controlEvents: Observable<ControlEvent>,
        /** Opens the starmap over the spaceport (the 'm' key), so the
         * player can check mission destinations while docked. */
        private openStarmap?: (options?: OpenStarmapOptions)
            => Promise<unknown>) {
        super(displayAssets, simulationData, "nova:8500", controlEvents);
        this.container.name = 'Spaceport';

        const buttonY = (slot: number) =>
            BUTTON_TOP + slot * BUTTON_SPACING;
        this.buttons = {
            bar: new Button(displayAssets, "Bar", BUTTON_WIDTH,
                { x: LEFT_BUTTON_X, y: buttonY(0) }),
            missions: new Button(displayAssets, "Mission BBS", BUTTON_WIDTH,
                { x: LEFT_BUTTON_X, y: buttonY(1) }),
            tradeCenter: new Button(displayAssets, "Trade Center", BUTTON_WIDTH,
                { x: LEFT_BUTTON_X, y: buttonY(2) }),
            shipyard: new Button(displayAssets, "Shipyard", BUTTON_WIDTH,
                { x: RIGHT_BUTTON_X, y: buttonY(0) }),
            outfitter: new Button(displayAssets, "Outfitter", BUTTON_WIDTH,
                { x: RIGHT_BUTTON_X, y: buttonY(1) }),
            recharge: new Button(displayAssets, "Recharge", BUTTON_WIDTH,
                { x: RIGHT_BUTTON_X, y: buttonY(2) }),
            leave: new Button(displayAssets, "Leave", BUTTON_WIDTH,
                { x: RIGHT_BUTTON_X, y: buttonY(3) }),
        };
        const buttons = this.buttons;

        buttons.leave.click.subscribe(this.done.bind(this));
        buttons.recharge.click.subscribe(this.recharge.bind(this));

        this.outfitter = new Outfitter(displayAssets, simulationData, controlEvents);
        const showOutfitter = async () => {
            if (this.data && !this.data.flags.hasOutfitter) {
                return;
            }
            this.controls.unbind();
            // The outfitter mutates the ship's outfits and the
            // player's control bits.
            this.input = await this.outfitter.show(this.input);
            // Delete these so they are re-created with the new outfits.
            // TODO: Find a better way to do this.
            this.input.components.delete(WeaponsStateComponent);
            this.input.components.delete(ShipPhysicsComponent);
            this.controls.bind();
        };
        buttons.outfitter.click.subscribe(showOutfitter);

        this.universe = MissionUniverse.shared(simulationData);
        this.missionComputer = new MissionBoard(displayAssets, simulationData,
            controlEvents, this.universe, id, LOCATION_MISSION_COMPUTER,
            "nova:8505", "Mission BBS", this.openStarmap);
        const showMissionComputer = async () => {
            this.controls.unbind();
            // The board mutates missions, cargo, credits, control
            // bits, and (through Gxxx grants) outfits.
            this.input = await this.missionComputer.show(this.input);
            this.refreshStatusLine();
            this.controls.bind();
        };
        buttons.missions.click.subscribe(showMissionComputer);

        this.bar = new Bar(displayAssets, simulationData, controlEvents,
            this.universe, id);
        const showBar = async () => {
            if (this.data && !this.data.flags.hasBar) {
                return;
            }
            this.controls.unbind();
            // The bar mutates missions, credits (gambling, hire fees),
            // cargo, bits, and records hired escorts.
            this.input = await this.bar.show(this.input);
            this.refreshStatusLine();
            this.controls.bind();
        };
        buttons.bar.click.subscribe(showBar);

        this.tradeCenter = new TradeCenter(displayAssets, simulationData,
            controlEvents, id);
        const showTradeCenter = async () => {
            if (this.data && !this.data.flags.hasCommodityExchange) {
                return;
            }
            this.controls.unbind();
            // The trade center mutates cargo and credits.
            this.input = await this.tradeCenter.show(this.input);
            this.refreshStatusLine();
            this.controls.bind();
        };
        buttons.tradeCenter.click.subscribe(showTradeCenter);

        this.shipyard = new Shipyard(displayAssets, simulationData, controlEvents);

        const showShipyard = async () => {
            if (this.data && !this.data.flags.hasShipyard) {
                return;
            }
            this.controls.unbind();
            const newInput = await this.shipyard.show(this.input);
            if (newInput !== this.input) {
                // Construct a fake system and run providers so that outfits of the new
                // ship are provided.
                const shipBuildWorld = new World('outfit builder');
                shipBuildWorld.resources.set(SimulationGameDataResource, simulationData);
                shipBuildWorld.resources.set(DisplayAssetDataResource, displayAssets);
                shipBuildWorld.resources.set(SystemIdResource, 'nova:128');
                // Sim systems require the determinism resources since
                // the rollback work; this scratch world only computes
                // ship stats, so any seed will do.
                shipBuildWorld.resources.set(RandomResource, new Random(0));
                shipBuildWorld.resources.set(IdFactoryResource, new IdFactory());
                await shipBuildWorld.addPlugin(SystemPlugin);
                shipBuildWorld.entities.set('ship', newInput);
                shipBuildWorld.step();
                await shipBuildWorld.resources.get(AsyncSystemResource)?.done;
                shipBuildWorld.step();
                shipBuildWorld.entities.delete('ship');
            }
            this.input = newInput;

            this.controls.bind();
        };
        buttons.shipyard.click.subscribe(showShipyard);
        this.addButtons(buttons);

        this.controls = new MenuControls(controlEvents, {
            outfitter: showOutfitter,
            shipyard: showShipyard,
            missionBBS: showMissionComputer,
            bar: showBar,
            tradeCenter: showTradeCenter,
            recharge: this.recharge.bind(this),
            // The starmap binds its own controls on top of the focus
            // stack while open, so the spaceport keys stay quiet under
            // it and 'd' backs out of just the map. The docked entity is
            // out of the display world, so its date rides along.
            map: () => void this.openStarmap?.({
                date: this.input?.components.get(GameDateComponent),
            }),
            depart: this.done.bind(this),
        });
    }

    /**
     * Landing bookkeeping happens before the spaceport is shown: the
     * player's date advances one day, and every active mission is
     * checked against this stellar (completion + payment, deadline
     * failures, travel-leg cargo transfer). The entity is out of the
     * simulation while docked, so mutating its components here is the
     * standard spaceport commit pattern.
     */
    override async show(input: Entity): Promise<Entity> {
        try {
            const events = await processEntityLanding(input,
                this.simulationData, this.universe, this.id);
            this.setNotices(events);
        } catch (e) {
            console.warn('Mission landing processing failed:', e);
        }
        this.refreshStatusLine(input);
        this.refreshRecharge(input);
        return super.show(input);
    }

    private setNotices(events: MissionEvent[]) {
        const lines: string[] = [];
        for (const event of events) {
            const name = missionDisplayName(event.missionName);
            switch (event.type) {
                case 'completed':
                    lines.push(`Mission complete: ${name}`
                        + (event.payment
                            ? ` (+${event.payment.toLocaleString()} cr)`
                            : ''));
                    break;
                case 'failed':
                    lines.push(`Mission failed: ${name}`);
                    break;
                default:
                    break;
            }
            if (event.text) {
                lines.push(event.text);
            }
        }
        this.notices.text = lines.join('\n\n');
    }

    private refreshStatusLine(input?: Entity) {
        const entity = input ?? this.input;
        if (!entity) {
            return;
        }
        const date = entity.components.get(GameDateComponent);
        const credits = entity.components.get(CreditsComponent);
        const parts: string[] = [];
        if (date) {
            parts.push(formatDate(date));
        }
        if (credits) {
            parts.push(`${credits.credits.toLocaleString()} cr`);
        }
        this.statusLine.text = parts.join('    ');
    }

    /** Refills hyperspace fuel (free, as at the original's ports). */
    private recharge() {
        const fuel = this.input?.components.get(FuelComponent);
        if (fuel) {
            fuel.current = fuel.max;
        }
        this.refreshRecharge(this.input);
    }

    private refreshRecharge(input?: Entity) {
        const fuel = (input ?? this.input)?.components.get(FuelComponent);
        this.buttons.recharge.state =
            fuel && fuel.current < fuel.max ? 'normal' : 'grey';
    }

    override async build() {
        await super.build();
        const data = await this.simulationData.data.Planet.get(this.id);
        this.data = data;
        const title = new PIXI.Text(data.name, this.font.title);
        title.anchor.x = 0.5;
        title.position.x = -2;
        title.position.y = 39;
        this.container.addChild(title);

        const desc = new PIXI.Text(data.landingDesc, this.font.desc);
        desc.position.x = -149;
        desc.position.y = 70;
        this.container.addChild(desc);

        // Mission completion / failure notices, over the landing desc.
        this.notices.position.set(-149, 180);
        this.container.addChild(this.notices);
        // The player's date and credits.
        this.statusLine.position.set(-149, 250);
        this.container.addChild(this.statusLine);

        // Venue buttons only appear where the stellar offers the
        // service (spöb flags).
        if (!data.flags.hasBar) {
            this.buttons.bar.container.visible = false;
        }
        if (!data.flags.hasCommodityExchange) {
            this.buttons.tradeCenter.container.visible = false;
        }
        if (!data.flags.hasOutfitter) {
            this.buttons.outfitter.container.visible = false;
        }
        if (!data.flags.hasShipyard) {
            this.buttons.shipyard.container.visible = false;
        }

        const spaceportPict = this.displayAssets.spriteFromPict(data.landingPict)
        spaceportPict.position.x = -306;
        spaceportPict.position.y = -256;
        this.container.addChild(spaceportPict)
        this.container.addChild(this.outfitter.container);
        this.container.addChild(this.shipyard.container);
        this.container.addChild(this.tradeCenter.container);
        this.container.addChild(this.missionComputer.container);
        this.container.addChild(this.bar.container);
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
