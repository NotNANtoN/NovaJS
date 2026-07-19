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
import { ArmorComponent, IonizationComponent, ShieldComponent } from '../nova_plugin/health_plugin.js';
import { IdFactory, IdFactoryResource } from '../nova_plugin/id_factory.js';
import { OutfitsStateComponent } from '../nova_plugin/outfit_plugin.js';
import { ShipPhysicsComponent } from '../nova_plugin/ship_plugin.js';
import { SystemIdResource } from '../nova_plugin/system_id_resource.js';
import { SystemPlugin } from '../nova_plugin/system_plugin.js';
import { WeaponsStateComponent } from '../nova_plugin/weapons_state.js';
import { formatDate } from '../nova_plugin/calendar.js';
import { LOCATION_BAR, LOCATION_MISSION_COMPUTER, MissionEvent } from '../nova_plugin/mission_logic.js';
import { CreditsComponent, GameDateComponent } from '../nova_plugin/player_state_plugin.js';
import { Button } from './button.js';
import { Menu } from './menu.js';
import { MenuControls } from './menu_controls.js';
import { MissionBoard } from './mission_board.js';
import { processEntityLanding } from './mission_session.js';
import { MissionUniverse } from './mission_universe.js';
import { Outfitter } from './outfitter.js';
import { Shipyard } from './shipyard.js';

export class Spaceport extends Menu<Entity> {
    private outfitter: Outfitter;
    private shipyard: Shipyard;
    private missionComputer: MissionBoard;
    private bar: MissionBoard;
    private universe: MissionUniverse;
    private barButton?: Button;
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
        controlEvents: Observable<ControlEvent>) {
        super(displayAssets, simulationData, "nova:8500", controlEvents);
        this.container.name = 'Spaceport';

        const buttons = {
            bar: new Button(displayAssets, "Bar", 120, { x: 160, y: 32 }),
            shipyard: new Button(displayAssets, "Shipyard", 120, { x: 160, y: 74 }),
            outfitter: new Button(displayAssets, "Outfitter", 120, { x: 160, y: 116 }),
            missions: new Button(displayAssets, "Missions", 120, { x: 160, y: 158 }),
            leave: new Button(displayAssets, "Leave", 120, { x: 160, y: 200 })
        };
        this.barButton = buttons.bar;

        buttons.leave.click.subscribe(this.done.bind(this));

        this.outfitter = new Outfitter(displayAssets, simulationData, controlEvents);
        const showOutfitter = async () => {
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
            "nova:8505", "Mission Computer");
        this.bar = new MissionBoard(displayAssets, simulationData,
            controlEvents, this.universe, id, LOCATION_BAR,
            "nova:8503", "Bar");
        const showMissionBoard = (board: MissionBoard) => async () => {
            this.controls.unbind();
            // The board mutates missions, cargo, credits, control
            // bits, and (through Gxxx grants) outfits.
            this.input = await board.show(this.input);
            this.refreshStatusLine();
            this.controls.bind();
        };
        const showMissionComputer = showMissionBoard(this.missionComputer);
        const showBar = showMissionBoard(this.bar);
        buttons.missions.click.subscribe(showMissionComputer);
        buttons.bar.click.subscribe(showBar);

        this.shipyard = new Shipyard(displayAssets, simulationData, controlEvents);

        const showShipyard = async () => {
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
        return super.show(input);
    }

    private setNotices(events: MissionEvent[]) {
        const lines: string[] = [];
        for (const event of events) {
            switch (event.type) {
                case 'completed':
                    lines.push(`Mission complete: ${event.missionName}`
                        + (event.payment
                            ? ` (+${event.payment.toLocaleString()} cr)`
                            : ''));
                    break;
                case 'failed':
                    lines.push(`Mission failed: ${event.missionName}`);
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

    override async build() {
        await super.build();
        const data = await this.simulationData.data.Planet.get(this.id);
        this.data = data;
        const title = new PIXI.Text(data.name, this.font.title);
        title.position.x = -24;
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

        if (this.barButton && !data.flags.hasBar) {
            this.barButton.container.visible = false;
        }

        const spaceportPict = this.displayAssets.spriteFromPict(data.landingPict)
        spaceportPict.position.x = -306;
        spaceportPict.position.y = -256;
        this.container.addChild(spaceportPict)
        this.container.addChild(this.outfitter.container);
        this.container.addChild(this.shipyard.container);
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
