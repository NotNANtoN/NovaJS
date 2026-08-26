import { PlanetData } from "novadatainterface/PlanetData";
import { ShipData } from "novadatainterface/ShipData";
import { StatusBarData, StatusBarDataArea } from "novadatainterface/StatusBarData";
import { GetEntity, RunQuery, UUID } from "nova_ecs/arg_types";
import { Component } from "nova_ecs/component";
import { Position } from "nova_ecs/datatypes/position";
import { Vector } from "nova_ecs/datatypes/vector";
import { Optional } from "nova_ecs/optional";
import { Plugin } from "nova_ecs/plugin";
import { MovementState, MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { CommunicatorResource, MultiplayerData } from "nova_ecs/plugins/multiplayer_plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { Query } from "nova_ecs/query";
import { Resource } from "nova_ecs/resource";
import { System } from "nova_ecs/system";
import * as PIXI from "pixi.js";
import { Subject } from "rxjs";
import { v4 } from "uuid";
import { GameData } from "../client/gamedata/GameData";
import { GameDataResource } from "../nova_plugin/game_data_resource";
import { GovernmentRelationResource } from "../nova_plugin/govt_relations";
import { ArmorComponent, ShieldComponent } from "../nova_plugin/health_plugin";
import { GovtComponent } from "../nova_plugin/npc_components";
import { makeNpc } from "../nova_plugin/npc_plugin";
import {
    LandingResultEvent,
    PlanetDataComponent,
    landingResultMessage,
} from "../nova_plugin/planet_plugin";
import { PlayerShipSelector } from "../nova_plugin/player_ship_plugin";
import { ShipDataComponent } from "../nova_plugin/ship_plugin";
import {
    PlayerState,
    PlayerStateComponent,
} from "../nova_plugin/player_state";
import {
    FuelGauge,
    fuelJumpBlocks,
    INSUFFICIENT_FUEL_MESSAGE,
} from "../nova_plugin/fuel";
import { JumpRefusedEvent } from "../nova_plugin/jump_plugin";
import { Stat } from "../nova_plugin/stat";
import { TargetComponent } from "../nova_plugin/target_component";
import { ChangeSecondaryEvent } from "../nova_plugin/weapon_plugin";
import { Button } from "../spaceport/button";
import { AnimationGraphic } from "./animation_graphic";
import { AnimationGraphicComponent } from "./animation_graphic_plugin";
import { DisabledComponent } from "../nova_plugin/death_plugin";
import { PixiAppResource } from "./pixi_app_resource";
import { ResizeEvent } from "./screen_size_plugin";
import { Stage } from "./stage_resource";
import {
    boardingOutcomeText,
    statusBarCargoText,
    statusBarTargetStatus,
} from "./status_bar_content";
import {
    BoardingNoticeComponent,
    BoardingOutcomeComponent,
} from "../nova_plugin/boarding_plugin";
import { targetLabel } from "./target_label";


class StatusBar {
    readonly container = new PIXI.Container();
    readonly buildPromise: Promise<void>;
    built = false;
    width = 0;
    private radarScale = new Vector(6000, 6000);
    private radar = new PIXI.Graphics();
    radarPeriod = 200;
    private statsGraphics = new PIXI.Graphics();
    private cargoContainer = new PIXI.Container();
    private landingMessageContainer = new PIXI.Container();
    private landingMessage = new PIXI.Text();
    private landingMessageClearAt = 0;

    private targetContainer = new PIXI.Container();
    private noTargetContainer = new PIXI.Container();
    private targetSprite = new PIXI.Sprite();
    private targetRenderTexture?: PIXI.RenderTexture;
    private targetRenderTextureSize = { width: 0, height: 0 };

    private text: { [index: string]: PIXI.Text } = {};
    private addEnemyButton: Button;
    readonly addEnemy: Subject<undefined>;

    constructor(private statusBarData: StatusBarData, private gameData: GameData,
                private renderer: PIXI.Renderer | PIXI.IRenderer) {
        this.buildPromise = this.build();
        this.container.name = 'StatusBar';
        this.addEnemyButton = new Button(gameData, 'Add Enemy', 60);
        this.addEnemyButton.container.position.x = 65;
        this.addEnemyButton.container.position.y = 530;
        this.addEnemy = this.addEnemyButton.click;
    }

    private async build() {
        const background = await this.gameData.spriteFromPictAsync(this.statusBarData.image);
        this.container.addChild(background);
        this.width = background.width;
        const dataAreas = this.statusBarData.dataAreas;
        [this.radar.position.x, this.radar.position.y] = dataAreas.radar.position;
        this.container.addChild(this.radar);
        this.container.addChild(this.statsGraphics);
        this.targetContainer.addChild(this.targetSprite);
        this.targetSprite.anchor.set(0.5, 0.5);
        this.targetSprite.position.x =
            this.statusBarData.dataAreas.targeting.size[0] / 2;
        this.targetSprite.position.y =
            this.statusBarData.dataAreas.targeting.size[1] / 2;

        this.makeText();
        this.makeLandingMessage();
        this.container.addChild(this.addEnemyButton.container);
        this.built = true;
    }

    private makeLandingMessage() {
        this.landingMessageContainer.name = 'LandingMessage';
        this.landingMessageContainer.visible = false;
        this.landingMessageContainer.position.set(7, 405);
        const background = new PIXI.Graphics();
        background.name = 'LandingMessageBackground';
        background.beginFill(0x080808, 0.82);
        background.lineStyle(1, this.statusBarData.colors.dimText, 0.8);
        background.drawRoundedRect(0, 0, Math.max(80, this.width - 14), 76, 4);
        background.endFill();
        this.landingMessage = new PIXI.Text('', {
            fontFamily: 'Geneva',
            fontSize: 11,
            fill: this.statusBarData.colors.brightText,
            wordWrap: true,
            wordWrapWidth: Math.max(68, this.width - 26),
            align: 'center',
        });
        this.landingMessage.name = 'LandingMessageText';
        this.landingMessage.anchor.x = 0.5;
        this.landingMessage.position.set(
            Math.max(40, (this.width - 14) / 2),
            8,
        );
        this.landingMessageContainer.addChild(background, this.landingMessage);
        this.container.addChild(this.landingMessageContainer);
    }

    private makeText() {
        const font = new PIXI.TextStyle({
            fontFamily: 'Geneva',
            fontSize: 12,
            align: 'center',
            fill: this.statusBarData.colors.brightText,
        });
        const dimFont = new PIXI.TextStyle({
            fontFamily: 'Geneva',
            fontSize: 12,
            align: 'center',
            fill: this.statusBarData.colors.dimText,
        });

        // The Bible specifies CargoArea's bounds but not its contents; use it
        // for the pilot's credits and used-versus-total cargo summary.
        const cargoArea = this.statusBarData.dataAreas.cargo;
        this.cargoContainer.position.x = cargoArea.position[0];
        this.cargoContainer.position.y = cargoArea.position[1];
        this.container.addChild(this.cargoContainer);

        const cargoRows = [
            ['Credits:', 'cargoCredits'],
            ['Cargo:', 'cargoSpace'],
        ] as const;
        cargoRows.forEach(([label, valueKey], index) => {
            const labelText = new PIXI.Text(label, dimFont);
            labelText.anchor.y = 0.5;
            labelText.position.x = 6;
            labelText.position.y = 24 + index * 36;
            this.cargoContainer.addChild(labelText);

            const valueText = new PIXI.Text('', font);
            valueText.anchor.x = 1;
            valueText.anchor.y = 0.5;
            valueText.position.x = cargoArea.size[0] - 6;
            valueText.position.y = labelText.position.y;
            this.cargoContainer.addChild(valueText);
            this.text[valueKey] = valueText;
        });

        const secondaryWeaponContainer = new PIXI.Container();
        this.container.addChild(secondaryWeaponContainer);
        secondaryWeaponContainer.position.x =
            this.statusBarData.dataAreas.weapons.position[0];
        secondaryWeaponContainer.position.y =
            this.statusBarData.dataAreas.weapons.position[1];

        this.text.noWeapon = new PIXI.Text("No Secondary Weapon", dimFont);
        this.text.noWeapon.anchor.x = 0.5;
        this.text.noWeapon.anchor.y = 0.5;
        this.text.noWeapon.position.x = this.statusBarData.dataAreas.weapons.size[0] / 2;
        this.text.noWeapon.position.y = this.statusBarData.dataAreas.weapons.size[1] / 2;;
        secondaryWeaponContainer.addChild(this.text.noWeapon);

        this.text.weapon = new PIXI.Text("", font);
        this.text.weapon.anchor.x = 0.5;
        this.text.weapon.anchor.y = 0.5;
        this.text.weapon.position.x = this.statusBarData.dataAreas.weapons.size[0] / 2;
        this.text.weapon.position.y = this.statusBarData.dataAreas.weapons.size[1] / 2;;
        secondaryWeaponContainer.addChild(this.text.weapon);

        this.targetContainer.visible = false;
        this.container.addChild(this.targetContainer);
        this.container.addChild(this.noTargetContainer);

        this.targetContainer.position.x = this.statusBarData.dataAreas.targeting.position[0];
        this.targetContainer.position.y = this.statusBarData.dataAreas.targeting.position[1];
        this.noTargetContainer.position.x = this.statusBarData.dataAreas.targeting.position[0];
        this.noTargetContainer.position.y = this.statusBarData.dataAreas.targeting.position[1];

        var size = [this.statusBarData.dataAreas.targeting.size[0],
        this.statusBarData.dataAreas.targeting.size[1]];

        this.text.shield = new PIXI.Text('Shield:', dimFont);
        this.text.shield.anchor.y = 1;
        this.text.shield.position.x = 6;
        this.text.shield.position.y = size[1] - 3;

        this.targetContainer.addChild(this.text.shield);

        this.text.armor = new PIXI.Text('Armor:', dimFont);
        this.text.armor.anchor.y = 1;
        this.text.armor.position.x = 6;
        this.text.armor.position.y = size[1] - 3;
        this.text.armor.visible = false;
        this.targetContainer.addChild(this.text.armor);


        this.text.percent = new PIXI.Text("100%", font);
        this.text.percent.anchor.y = 1;
        this.text.percent.position.x = 49;
        this.text.percent.position.y = size[1] - 3;

        this.targetContainer.addChild(this.text.percent);

        const middle = [this.statusBarData.dataAreas.targeting.size[0] / 2,
        this.statusBarData.dataAreas.targeting.size[1] / 2 - 15];

        this.text.disabled = new PIXI.Text("Disabled", font);
        this.text.disabled.anchor.x = 0.5;
        this.text.disabled.anchor.y = 1;
        this.text.disabled.position.x = middle[0];
        this.text.disabled.position.y = size[1] - 3;
        this.text.disabled.visible = false;

        this.targetContainer.addChild(this.text.disabled);

        this.text.noTarget = new PIXI.Text("No Target", dimFont);
        this.text.noTarget.anchor.x = 0.5;
        this.text.noTarget.anchor.y = 0.5;
        this.text.noTarget.position.x = middle[0];
        this.text.noTarget.position.y = middle[1] - 15;

        this.noTargetContainer.addChild(this.text.noTarget);

        const targetFont = font.clone();
        targetFont.wordWrap = true;
        targetFont.wordWrapWidth = Math.max(1, size[0] - 12);
        targetFont.breakWords = false;
        targetFont.lineHeight = 13;
        this.text.targetName = new PIXI.Text("Name Placeholder", targetFont);
        this.text.targetName.anchor.x = 0.5;
        this.text.targetName.anchor.y = 0.5;
        this.text.targetName.position.x = middle[0];
        this.text.targetName.position.y = 12;

        this.targetContainer.addChild(this.text.targetName);

        this.text.targetImagePlaceholder = new PIXI.Text("No target image", dimFont);
        this.text.targetImagePlaceholder.anchor.x = 0.5;
        this.text.targetImagePlaceholder.anchor.y = 0.5;
    }

    drawRadar(source: Position, ships: Iterable<readonly [string, MovementState, ShipData]>,
        planets: Iterable<readonly [string, MovementState, PlanetData]>) {
        this.radar.clear();
        this.drawDot(source, this.statusBarData.colors.brightRadar, source);

        for (const [, { position }] of ships) {
            const color = this.statusBarData.colors.dimRadar;
            this.drawDot(position, color, source);
        }

        for (const [, { position }] of planets) {
            this.drawDot(position, 0xFFFF00, source, 2);
        }
    }

    private drawDot(dotPos: Position, color: number, source = new Position(0, 0), size = 1) {
        // draws a dot from nova position
        const radarSize = new Vector(...this.statusBarData.dataAreas.radar.size);
        const pixiPos = new Vector(dotPos.x, dotPos.y).subtract(source)
            .times(radarSize).div(this.radarScale).add(radarSize.scale(0.5));

        if (pixiPos.x <= radarSize.x && pixiPos.x >= 0 &&
            pixiPos.y <= radarSize.y && pixiPos.y >= 0) {
            // TODO: Make this work with any sizes
            this.radar.moveTo(pixiPos.x, pixiPos.y);
            this.radar.beginFill(color);
            this.radar.lineTo(pixiPos.x + size, pixiPos.y);
            this.radar.lineTo(pixiPos.x + size, pixiPos.y + size);
            this.radar.lineTo(pixiPos.x, pixiPos.y + size);
            this.radar.endFill()
        }
    }

    private drawLine(dataArea: StatusBarDataArea, color: number, fullness: number) {
        var pos = [dataArea.position[0], dataArea.position[1]];
        var size = [dataArea.size[0], dataArea.size[1]];
        pos[1] += size[1] / 2;

        this.statsGraphics.lineStyle(size[1], color);
        this.statsGraphics.moveTo(pos[0], pos[1]);
        this.statsGraphics.lineTo(pos[0] + size[0] * fullness, pos[1]);
    }

    drawStats(shield: Stat, armor: Stat, fuel?: FuelGauge,
        playerState?: PlayerState) {
        this.statsGraphics.clear();

        const shieldFullness = Math.max(0, shield.current / shield.max);
        this.drawLine(this.statusBarData.dataAreas.shield,
            this.statusBarData.colors.shield, shieldFullness);

        const armorFullness = Math.max(0, armor.current / armor.max);
        this.drawLine(this.statusBarData.dataAreas.armor,
            this.statusBarData.colors.armor, armorFullness);

        if (fuel) {
            this.drawFuel(fuel);
        }
        this.drawCargo(playerState);
    }

    /**
     * Retail draws fuel as one block per jump, which is why the interface
     * resource carries two colours: whole jumps are bright, and the fuel left
     * over from a partly spent jump is dim.
     */
    private drawFuel(fuel: FuelGauge) {
        const area = this.statusBarData.dataAreas.fuel;
        const jumps = fuelJumpBlocks(fuel);
        if (jumps.total <= 0) {
            return;
        }
        const gap = jumps.total > 1 ? 2 : 0;
        const width = (area.size[0] - gap * (jumps.total - 1)) / jumps.total;
        const y = area.position[1] + area.size[1] / 2;
        for (let index = 0; index < jumps.total; index++) {
            const filled = index < jumps.full;
            const partial = index === jumps.full && jumps.partial > 0;
            if (!filled && !partial) {
                continue;
            }
            const color = filled
                ? this.statusBarData.colors.fuelFull
                : this.statusBarData.colors.fuelPartial;
            const x = area.position[0] + index * (width + gap);
            const length = filled ? width : width * jumps.partial;
            this.statsGraphics.lineStyle(area.size[1], color);
            this.statsGraphics.moveTo(x, y);
            this.statsGraphics.lineTo(x + length, y);
        }
    }

    private drawCargo(playerState?: PlayerState) {
        if (!playerState) {
            this.cargoContainer.visible = false;
            return;
        }
        const cargo = statusBarCargoText(playerState);
        this.text.cargoCredits.text = cargo.credits;
        this.text.cargoSpace.text = cargo.cargo;
        this.cargoContainer.visible = true;
    }

    drawSecondary(name: string | null | undefined) {
        if (!this.built) {
            return;
        }
        if (name) {
            this.text.weapon.text = name;
            this.text.weapon.visible = true;
            this.text.noWeapon.visible = false;
        } else {
            this.text.weapon.visible = false;
            this.text.noWeapon.visible = true;
        }
    }

    drawTarget(name: string, shield?: number, armor?: number,
        shipGraphic?: AnimationGraphic, disabled = false) {
        this.targetContainer.visible = true;
        this.noTargetContainer.visible = false;
        this.text.targetName.text = name;
        this.text.targetName.position.y = name.includes('\n') ? 15 : 12;

        const targetStatus = statusBarTargetStatus(disabled);
        this.text.disabled.visible = targetStatus !== undefined;
        this.text.percent.visible = targetStatus === undefined;
        if (targetStatus !== undefined) {
            this.text.disabled.text = targetStatus;
            this.text.shield.visible = false;
            this.text.armor.visible = false;
        } else if (shield && shield > 0) {
            this.text.shield.visible = true;
            this.text.armor.visible = false;
            this.text.percent.text = `${String(shield)}%`;
        } else if (typeof armor === 'number') {
            this.text.shield.visible = false;
            this.text.armor.visible = true;
            this.text.percent.text = `${String(armor)}%`;
        } else {
            this.text.shield.visible = false;
            this.text.armor.visible = false;
        }

        if (shipGraphic) {
            const shipContainer = shipGraphic?.container;
            const { x: width, y: height } = shipGraphic.size;
            if (!this.targetRenderTexture) {
                const baseRenderTexture = new PIXI.BaseRenderTexture({ width, height });
                this.targetRenderTexture = new PIXI.RenderTexture(baseRenderTexture);
                this.targetRenderTextureSize = { width, height };
            } else if (this.targetRenderTextureSize.width !== width
                || this.targetRenderTextureSize.height !== height) {
                this.targetRenderTexture.resize(width, height);
                this.targetRenderTextureSize = { width, height };
            }

            shipContainer.setTransform();
            shipContainer.position.x = width / 2;
            shipContainer.position.y = height / 2;
            const renderTexture = this.targetRenderTexture!;
            this.renderer.render(shipContainer, {
                renderTexture,
            });
            this.targetSprite.texture = renderTexture;
            let scale = 1;
            const maxSize = 110;
            const targetMaxDim = Math.max(shipGraphic.size.x, shipGraphic.size.y);
            if (targetMaxDim > maxSize) {
                scale = maxSize / targetMaxDim;
            }
            this.targetSprite.scale.set(scale, scale);
            this.targetSprite.visible = true;
        } else {
            this.targetSprite.visible = false;
        }

    }
    clearTarget() {
        this.targetContainer.visible = false;
        this.noTargetContainer.visible = true;
        this.targetSprite.visible = false;
        this.targetSprite.texture = PIXI.Texture.EMPTY;
        this.targetRenderTexture?.destroy(true);
        this.targetRenderTexture = undefined;
        this.targetRenderTextureSize = { width: 0, height: 0 };
    }
    showLandingMessage(message: string, now: number, durationMs = 3_500) {
        this.landingMessage.text = message;
        this.landingMessageContainer.visible = Boolean(message);
        this.landingMessageClearAt = message ? now + durationMs : 0;
    }
    updateLandingMessage(now: number) {
        if (this.landingMessageContainer.visible
            && now >= this.landingMessageClearAt) {
            this.showLandingMessage('', now);
        }
    }
    destroy() {
        this.clearTarget();
        this.showLandingMessage('', 0);
    }
}

export const StatusBarResource = new Resource<StatusBar>('StatusBar');

const StatusBarResize = new System({
    name: 'StatusBarResize',
    events: [ResizeEvent],
    args: [StatusBarResource, ResizeEvent] as const,
    step({ container }, { x }) {
        container.position.x = x - container.width + 1;
        container.position.y = 0;
    }
});

const RadarTime = new Component<{ lastTime: number }>('RadarTime');
const DrawRadar = new System({
    name: 'DrawRadar',
    args: [Optional(RadarTime), TimeResource, StatusBarResource, MovementStateComponent,
    new Query([UUID, MovementStateComponent, ShipDataComponent] as const),
    new Query([UUID, MovementStateComponent, PlanetDataComponent] as const),
        GetEntity, PlayerShipSelector] as const,
    step(radarTime, { time }, statusBar, { position }, ships, planets, entity) {
        if (!radarTime) {
            radarTime = { lastTime: 0 };
            entity.components.set(RadarTime, radarTime);
        }
        if (time - radarTime.lastTime > statusBar.radarPeriod) {
            statusBar.drawRadar(position, ships, planets);
            radarTime.lastTime = time;
        }
    }
});

const DrawStatusBarStats = new System({
    name: 'DrawStatusBarStats',
    args: [StatusBarResource, ShieldComponent, ArmorComponent,
        Optional(PlayerStateComponent), Optional(ShipDataComponent),
        PlayerShipSelector] as const,
    step(statusBar, shield, armor, playerState, shipData) {
        const capacity = shipData?.fuelCapacity ?? 0;
        statusBar.drawStats(shield, armor, capacity > 0 && playerState
            ? { fuel: playerState.fuel ?? 0, capacity }
            : undefined, playerState);
    }
})

const DrawStatusBarSecondaryWeapon = new System({
    name: 'DrawStatusBarSecondaryWeapon',
    events: [ChangeSecondaryEvent],
    args: [StatusBarResource, ChangeSecondaryEvent, GameDataResource,
        PlayerShipSelector] as const,
    step(statusBar, activeSecondary, gameData) {
        if (activeSecondary.secondary) {
            const secondaryName = gameData.data.Weapon
                .getCached(activeSecondary.secondary);
            statusBar.drawSecondary(secondaryName?.name);
        } else {
            statusBar.drawSecondary(null);
        }
    }
});

const TargetQuery = new Query([ShipDataComponent, Optional(ShieldComponent),
    Optional(ArmorComponent), Optional(AnimationGraphicComponent),
    Optional(GovtComponent), Optional(DisabledComponent)] as const);
const DrawStatusBarTarget = new System({
    name: 'DrawStatusBarTarget',
    args: [StatusBarResource, TargetComponent, RunQuery,
        GovernmentRelationResource, PlayerShipSelector] as const,
    step(statusBar, { target }, runQuery, governments) {
        if (!target) {
            statusBar.clearTarget();
            return;
        }
        const result = runQuery(TargetQuery, target)[0];
        if (result) {
            const [shipData, shield, armor, shipGraphic, government, disabled] = result;
            const governmentData = government
                ? governments.getCached(government.id)
                : undefined;
            statusBar.drawTarget(
                targetLabel(shipData.name, governmentData),
                shield?.percent,
                armor?.percent,
                shipGraphic,
                disabled,
            );
        }
    }
})

const DrawLandingMessage = new System({
    name: 'DrawLandingMessage',
    events: [LandingResultEvent],
    args: [LandingResultEvent, StatusBarResource, TimeResource] as const,
    step(result, statusBar, time) {
        statusBar.showLandingMessage(landingResultMessage(result), time.time);
    },
});

const ShowJumpRefusal = new System({
    name: 'ShowJumpRefusal',
    events: [JumpRefusedEvent],
    args: [JumpRefusedEvent, StatusBarResource, TimeResource,
        PlayerShipSelector] as const,
    step(refusal, statusBar, time) {
        if (refusal.reason === 'fuel') {
            statusBar.showLandingMessage(INSUFFICIENT_FUEL_MESSAGE, time.time);
        }
    },
});

const ExpireLandingMessage = new System({
    name: 'ExpireLandingMessage',
    args: [StatusBarResource, TimeResource] as const,
    step(statusBar, time) {
        statusBar.updateLandingMessage(time.time);
    },
});


/**
 * Say what a boarding attempt did. Without this the pilot presses the key,
 * the ship is plundered or refused in silence, and the game looks broken.
 */
const ShowBoardingNotice = new System({
    name: 'ShowBoardingNotice',
    args: [StatusBarResource, BoardingNoticeComponent, TimeResource, GetEntity,
        PlayerShipSelector] as const,
    step(statusBar, notice, time, entity) {
        statusBar.showLandingMessage(notice.text, time.time);
        entity.components.delete(BoardingNoticeComponent);
    },
});

/**
 * The outcome is replicated state rather than an event, because the server
 * decides it and events do not cross the network. A new sequence number is
 * therefore the only signal that another boarding has completed.
 */
const ShownBoardingOutcome = new Component<{ sequence: number }>(
    'ShownBoardingOutcome');
const ShowBoardingOutcome = new System({
    name: 'ShowBoardingOutcome',
    args: [StatusBarResource, BoardingOutcomeComponent,
        Optional(ShownBoardingOutcome), TimeResource, GetEntity,
        PlayerShipSelector] as const,
    step(statusBar, outcome, shown, time, entity) {
        if (shown && shown.sequence >= outcome.sequence) {
            return;
        }
        entity.components.set(ShownBoardingOutcome,
            { sequence: outcome.sequence });
        statusBar.showLandingMessage(
            boardingOutcomeText(outcome.cargo, outcome.credits), time.time);
    },
});

export const StatusBarPlugin: Plugin = {
    name: 'StatusBar',
    async build(world) {
        const gameData = world.resources.get(GameDataResource);
        if (!gameData) {
            throw new Error('Expected gameData resource to exist');
        }

        const stage = world.resources.get(Stage);
        if (!stage) {
            throw new Error('Expected Stage resource to exist');
        }

        const app = world.resources.get(PixiAppResource);
        if (!app) {
            throw new Error('Expected PIXI App resource to exist');
        }

        const statusBar = new StatusBar(await gameData.data.StatusBar.get("nova:128"),
            gameData as GameData, app.renderer);
        await statusBar.buildPromise;
        stage.addChild(statusBar.container);
        statusBar.container.position.x = window.innerWidth - statusBar.container.width;
        statusBar.container.position.y = 0;
        statusBar.addEnemy.subscribe(async () => {
            const randomIndex = Math.floor(Math.random() * (await gameData.ids).Ship.length);
            const randomShipId = (await gameData.ids).Ship[randomIndex];
            const shipData = await gameData.data.Ship.get(randomShipId);

            const npc = makeNpc(shipData);
            const uuid = world.resources.get(CommunicatorResource)?.uuid;
            if (uuid) {
                npc.components.set(MultiplayerData, { owner: uuid });
                world.entities.set(v4(), npc);
            }
        });

        world.resources.set(StatusBarResource, statusBar);

        world.addSystem(DrawRadar);
        world.addSystem(StatusBarResize);
        world.addSystem(DrawStatusBarStats);
        world.addSystem(DrawStatusBarSecondaryWeapon);
        world.addComponent(ShownBoardingOutcome);
        world.addSystem(ShowBoardingNotice);
        world.addSystem(ShowBoardingOutcome);
        world.addSystem(DrawStatusBarTarget);
        world.addSystem(DrawLandingMessage);
        world.addSystem(ShowJumpRefusal);
        world.addSystem(ExpireLandingMessage);
    },
    remove(world) {
        world.removeSystem(DrawRadar);
        world.removeSystem(StatusBarResize);
        world.removeSystem(DrawStatusBarStats);
        world.removeSystem(DrawStatusBarSecondaryWeapon);
        world.removeSystem(DrawStatusBarTarget);
        world.removeSystem(DrawLandingMessage);
        world.removeSystem(ShowJumpRefusal);
        world.removeSystem(ExpireLandingMessage);

        const stage = world.resources.get(Stage);
        const statusBar = world.resources.get(StatusBarResource);
        if (stage && statusBar) {
            stage.removeChild(statusBar.container);
        }
        statusBar?.destroy();
        world.resources.delete(StatusBarResource);
    }
}
