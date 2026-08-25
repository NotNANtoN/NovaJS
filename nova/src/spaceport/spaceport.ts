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
import { ControlEvent } from '../nova_plugin/controls_plugin';
import { GameDataResource } from '../nova_plugin/game_data_resource';
import { ArmorComponent, IonizationComponent, ShieldComponent } from '../nova_plugin/health_plugin';
import { MissionNotice } from '../nova_plugin/mission_plugin';
import { OutfitsStateComponent } from '../nova_plugin/outfit_plugin';
import { PlayerStateComponent } from '../nova_plugin/player_state';
import { ShipPhysicsComponent } from '../nova_plugin/ship_plugin';
import { SystemIdResource } from '../nova_plugin/system_id_resource';
import { SystemPlugin } from '../nova_plugin/system_plugin';
import { WeaponsStateComponent } from '../nova_plugin/weapons_state';
import { Button } from './button';
import { Bar } from './bar';
import { Menu } from './menu';
import { MenuControls } from './menu_controls';
import { MissionBbs, MissionInfo } from './mission_bbs';
import { Outfitter } from './outfitter';
import { Shipyard } from './shipyard';
import { TradeCenter } from './trade';
import { hasSpaceportService } from './availability';

export class Spaceport extends Menu<Entity> {
    private outfitter: Outfitter;
    private shipyard: Shipyard;
    private missionBbs: MissionBbs;
    private bar: Bar;
    private tradeCenter: TradeCenter;
    private missionInfo: MissionInfo;
    private data?: PlanetData;
    private serviceButtons?: {
        outfitter: Button;
        shipyard: Button;
        tradeCenter: Button;
        bar: Button;
    };
    private missionNotice = new PIXI.Text("", {
        fontFamily: "Geneva", fontSize: 10, fill: 0xffff00,
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

    constructor(gameData: GameData, private id: string,
        controlEvents: Observable<ControlEvent>) {
        super(gameData, "nova:8500", controlEvents);
        this.container.name = 'Spaceport';

        const buttons = {
            outfitter: new Button(gameData, "Outfitter", 120, { x: 160, y: 116 }),
            shipyard: new Button(gameData, "Shipyard", 120, { x: 160, y: 74 }),
            missionBBS: new Button(gameData, "Mission BBS", 120, { x: 160, y: 32 }),
            bar: new Button(gameData, "Bar", 120, { x: 160, y: -10 }),
            tradeCenter: new Button(gameData, "Trade Center", 120, { x: 160, y: -52 }),
            missionLog: new Button(gameData, "Mission Log", 120, { x: 160, y: -94 }),
            leave: new Button(gameData, "Leave", 120, { x: 160, y: 200 })
        };
        this.serviceButtons = buttons;

        buttons.leave.click.subscribe(this.done.bind(this));

        this.outfitter = new Outfitter(gameData, controlEvents);
        const showOutfitter = async () => {
            if (!this.data || !hasSpaceportService(this.data, "outfitter")) {
                return;
            }
            this.controls.unbind();
            const outfits = this.input.components.get(OutfitsStateComponent) ?? new Map();
            this.outfitter.setPlayerState(
                this.input.components.get(PlayerStateComponent));
            const newOutfits = await this.outfitter.show(outfits);
            this.input.components.set(OutfitsStateComponent, newOutfits);
            // Delete these so they are re-created with the new outfits.
            // TODO: Find a better way to do this.
            this.input.components.delete(WeaponsStateComponent);
            this.input.components.delete(ShipPhysicsComponent);
            this.controls.bind();
        };
        buttons.outfitter.click.subscribe(showOutfitter);

        this.shipyard = new Shipyard(gameData, controlEvents);

        const showShipyard = async () => {
            if (!this.data || !hasSpaceportService(this.data, "shipyard")) {
                return;
            }
            this.controls.unbind();
            this.shipyard.setPlayerState(
                this.input.components.get(PlayerStateComponent));
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

            this.controls.bind();
        };
        buttons.shipyard.click.subscribe(showShipyard);

        this.missionInfo = new MissionInfo(gameData, controlEvents);
        const showMissionInfo = async () => {
            this.controls.unbind();
            try {
                await this.missionInfo.show(this.input);
            } finally {
                this.controls.bind();
            }
        };
        this.missionBbs = new MissionBbs(
            gameData, this.id, controlEvents, showMissionInfo);
        this.bar = new Bar(gameData, this.id, controlEvents, showMissionInfo);
        this.tradeCenter = new TradeCenter(gameData, this.id, controlEvents);

        const showMissionBbs = async () => {
            this.controls.unbind();
            try {
                await this.missionBbs.show(this.input);
            } finally {
                this.controls.bind();
            }
        };
        const showBar = async () => {
            if (!this.data || !hasSpaceportService(this.data, "bar")) {
                return;
            }
            this.controls.unbind();
            try {
                await this.bar.show(this.input);
            } finally {
                this.controls.bind();
            }
        };
        const showTradeCenter = async () => {
            if (!this.data || !hasSpaceportService(this.data, "commodity")) {
                return;
            }
            this.controls.unbind();
            try {
                await this.tradeCenter.show(this.input);
            } finally {
                this.controls.bind();
            }
        };
        buttons.missionBBS.click.subscribe(showMissionBbs);
        buttons.missionLog.click.subscribe(showMissionInfo);
        buttons.bar.click.subscribe(showBar);
        buttons.tradeCenter.click.subscribe(showTradeCenter);
        this.addButtons(buttons);

        this.controls = new MenuControls(controlEvents, {
            outfitter: showOutfitter,
            shipyard: showShipyard,
            missionBBS: showMissionBbs,
            bar: showBar,
            tradeCenter: showTradeCenter,
            missions: showMissionInfo,
            depart: this.done.bind(this),
        });
    }

    override async build() {
        await super.build();
        await Promise.all([
            this.missionBbs.buildPromise,
            this.bar.buildPromise,
            this.tradeCenter.buildPromise,
            this.missionInfo.buildPromise,
        ]);
        const data = await this.gameData.data.Planet.get(this.id);
        this.data = data;
        this.outfitter.setPlanetData(data);
        this.shipyard.setPlanetData(data);
        if (this.serviceButtons) {
            this.serviceButtons.outfitter.container.visible =
                hasSpaceportService(data, "outfitter");
            this.serviceButtons.shipyard.container.visible =
                hasSpaceportService(data, "shipyard");
            this.serviceButtons.tradeCenter.container.visible =
                hasSpaceportService(data, "commodity");
            this.serviceButtons.bar.container.visible =
                hasSpaceportService(data, "bar");
        }
        const title = new PIXI.Text(data.name, this.font.title);
        title.position.x = -24;
        title.position.y = 39;
        this.container.addChild(title);

        const desc = new PIXI.Text(data.landingDesc, this.font.desc);
        desc.position.x = -149;
        desc.position.y = 70;
        this.container.addChild(desc);

        const spaceportPict = this.gameData.spriteFromPict(data.landingPict)
        spaceportPict.position.x = -306;
        spaceportPict.position.y = -256;
        this.container.addChild(spaceportPict)
        this.container.addChild(this.outfitter.container);
        this.container.addChild(this.shipyard.container);
        this.container.addChild(this.missionBbs.container);
        this.container.addChild(this.bar.container);
        this.container.addChild(this.tradeCenter.container);
        this.container.addChild(this.missionInfo.container);
        this.missionNotice.position.set(-210, 145);
        this.container.addChild(this.missionNotice);
    }

    override async show(
        input: Entity,
        landingNotices: readonly MissionNotice[] = [],
    ): Promise<Entity> {
        await this.buildPromise;
        this.missionNotice.text = landingNotices.length > 0
            ? landingNotices.map(notice =>
                `${notice.kind === 'success' ? 'Mission complete' : 'Mission failed'}: `
                + notice.text).join('\n\n')
            : '';
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
