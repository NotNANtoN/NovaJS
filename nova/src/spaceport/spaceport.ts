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
import type { PlanetType } from '../nova_plugin/planet_plugin';
import { PlayerStateComponent } from '../nova_plugin/player_state';
import {
    ShipDataComponent,
    ShipPhysicsComponent,
} from '../nova_plugin/ship_plugin';
import { SystemIdResource } from '../nova_plugin/system_id_resource';
import { SystemPlugin } from '../nova_plugin/system_plugin';
import { WeaponsStateComponent } from '../nova_plugin/weapons_state';
import { Button } from './button';
import {
    SERVICE_FLAG,
    SPACEPORT_LAYOUT,
    SPACEPORT_SERVICES,
    spaceportButtonColumn,
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
import {
    hasSpaceportService,
    resolveSpaceportPlanetData,
} from './availability';

/** Initial slot for a service button before the column is laid out. */
function buttonSlot(index: number) {
    const { x, firstY, pitch } = SPACEPORT_LAYOUT.buttons;
    return { x, y: firstY + index * pitch };
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
    private readonly dialogContainers = new Set<PIXI.Container>();
    private data?: PlanetData;
    private readonly id: string;
    private serviceButtons?: Record<SpaceportService, Button>;
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
            outfitter: new Button(gameData, "Outfitter", 120, buttonSlot(1)),
            shipyard: new Button(gameData, "Shipyard", 120, buttonSlot(0)),
            missionBBS: new Button(
                gameData, "Mission BBS", 120, buttonSlot(4)),
            bar: new Button(gameData, "Bar", 120, buttonSlot(3)),
            tradeCenter: new Button(
                gameData, "Trade Center", 120, buttonSlot(2)),
            leave: new Button(gameData, "Leave", 120, {
                x: SPACEPORT_LAYOUT.buttons.x,
                y: SPACEPORT_LAYOUT.buttons.leaveY,
            })
        };
        this.serviceButtons = {
            shipyard: buttons.shipyard,
            outfitter: buttons.outfitter,
            tradeCenter: buttons.tradeCenter,
            bar: buttons.bar,
            missionBBS: buttons.missionBBS,
        };

        buttons.leave.click.subscribe(this.done.bind(this));

        this.outfitter = new Outfitter(gameData, controlEvents);
        const showOutfitter = async () => {
            if (!this.data || !hasSpaceportService(this.data, "outfitter")) {
                return;
            }
            this.controls.unbind();
            this.setActiveDialog(this.outfitter.container);
            const outfits = this.input.components.get(OutfitsStateComponent) ?? new Map();
            try {
                this.outfitter.setPlayerState(
                    this.input.components.get(PlayerStateComponent));
                this.outfitter.setShipData(
                    this.input.components.get(ShipDataComponent));
                const newOutfits = await this.outfitter.show(outfits);
                this.input.components.set(OutfitsStateComponent, newOutfits);
                // Delete these so they are re-created with the new outfits.
                // TODO: Find a better way to do this.
                this.input.components.delete(WeaponsStateComponent);
                this.input.components.delete(ShipPhysicsComponent);
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
            } finally {
                this.setActiveDialog();
                this.controls.bind();
            }
        };
        buttons.shipyard.click.subscribe(showShipyard);

        this.missionInfo = new MissionInfo(gameData, controlEvents);
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

        const showMissionBbs = async () => {
            this.controls.unbind();
            this.setActiveDialog(this.missionBbs.container);
            try {
                await this.missionBbs.show(this.input);
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
     * Retail lists the services a stellar offers top to bottom and omits the
     * rest, so the remaining buttons move up instead of leaving a hole.
     */
    private updateServiceButtons(data: PlanetData) {
        const buttons = this.serviceButtons;
        if (!buttons) {
            return;
        }
        const available = SPACEPORT_SERVICES.filter(service =>
            service === "tradeCenter"
                ? this.tradeCenterAvailable
                : hasSpaceportService(data, SERVICE_FLAG[service]));
        const column = spaceportButtonColumn(available);
        for (const service of SPACEPORT_SERVICES) {
            const y = column.get(service);
            buttons[service].container.visible = y !== undefined;
            if (y !== undefined) {
                buttons[service].container.position.set(
                    SPACEPORT_LAYOUT.buttons.x, y);
            }
        }
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

        const spaceportPict = this.gameData.spriteFromPict(data.landingPict)
        spaceportPict.position.x = -306;
        spaceportPict.position.y = -256;
        // The landing landscape is an opaque 612x285 retail PICT. Keep it
        // immediately above the Spaceport frame and below every control.
        this.container.addChildAt(spaceportPict, 1);
        this.container.addChild(this.outfitter.container);
        this.container.addChild(this.shipyard.container);
        this.container.addChild(this.missionBbs.container);
        this.container.addChild(this.bar.container);
        this.container.addChild(this.tradeCenter.container);
        this.container.addChild(this.missionInfo.container);
        this.container.addChild(this.shipInfo.container);
        this.missionNotice.position.set(-210, 145);
        this.container.addChild(this.missionNotice);
    }

    override async show(
        input: Entity,
        landingNotices: readonly MissionNotice[] = [],
    ): Promise<Entity> {
        await this.buildPromise;
        // A dialog left active by a previous landing would keep the landing
        // artwork and buttons hidden, which reads as a black screen on
        // reload. Start every landing on the landing screen itself.
        this.setActiveDialog();
        this.controls.bind();
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
