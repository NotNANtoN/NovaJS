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
import {
    JumpRefusedEvent,
    JumpRouteComponent,
} from "../nova_plugin/jump_plugin";
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
    statusBarNavigationText,
    statusBarTargetHealth,
} from "./status_bar_content";
import {
    BoardingNoticeComponent,
    BoardingOutcomeComponent,
} from "../nova_plugin/boarding_plugin";
import { targetLabel, TargetLabelPieces } from "./target_label";


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
    private navigationContainer = new PIXI.Container();
    private landingMessageContainer = new PIXI.Container();
    private landingMessage = new PIXI.Text();
    private landingMessageClearAt = 0;

    private targetContainer = new PIXI.Container();
    private noTargetContainer = new PIXI.Container();
    private targetSprite = new PIXI.Sprite();
    private targetRenderTexture?: PIXI.RenderTexture;
    private targetRenderTextureSize = { width: 0, height: 0 };
    private requestedTargetPict?: string;
    private readyTargetPict?: string;
    private targetPictRequest = 0;
    private navigationHop?: string;
    private navigationRequest = 0;
    private cargoNames: readonly string[] = [];

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
        void this.loadCargoNames();
        this.makeLandingMessage();
        this.container.addChild(this.addEnemyButton.container);
        this.built = true;
    }

    private async loadCargoNames() {
        try {
            const cargoNames = await this.gameData.data.StringList
                .get('nova:4000');
            this.cargoNames = cargoNames.strings;
        } catch {
            this.cargoNames = [];
        }
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

        const navigationArea = this.statusBarData.dataAreas.navigation;
        this.navigationContainer.position.set(
            navigationArea.position[0], navigationArea.position[1]);
        this.navigationContainer.visible = false;
        this.container.addChild(this.navigationContainer);

        this.text.navigationHeading = new PIXI.Text('Hyperspace', dimFont);
        this.text.navigationHeading.anchor.set(0.5, 0.5);
        this.text.navigationHeading.position.set(
            navigationArea.size[0] / 2, 8);
        this.navigationContainer.addChild(this.text.navigationHeading);

        this.text.navigationDestination = new PIXI.Text('', font);
        this.text.navigationDestination.anchor.set(0.5, 0.5);
        this.text.navigationDestination.position.set(
            navigationArea.size[0] / 2, 23);
        this.navigationContainer.addChild(this.text.navigationDestination);

        const cargoArea = this.statusBarData.dataAreas.cargo;
        this.cargoContainer.position.x = cargoArea.position[0];
        this.cargoContainer.position.y = cargoArea.position[1];
        this.container.addChild(this.cargoContainer);

        const cargoRows = [
            ['Free:', 'cargoFree'],
            ['Special:', 'cargoSpecial'],
            ['Credits:', 'cargoCredits'],
        ] as const;
        cargoRows.forEach(([label, valueKey], index) => {
            const labelText = new PIXI.Text(label, dimFont);
            labelText.anchor.y = 0.5;
            labelText.position.x = 6;
            labelText.position.y = (index + 0.5) * cargoArea.size[1] / 3;
            this.cargoContainer.addChild(labelText);
            this.text[`${valueKey}Label`] = labelText;

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
        this.text.targetName.position.y = 9;

        this.targetContainer.addChild(this.text.targetName);

        const subtitleFont = font.clone();
        subtitleFont.fontSize = 10;
        subtitleFont.wordWrap = true;
        subtitleFont.wordWrapWidth = Math.max(1, size[0] - 12);
        this.text.targetSubtitle = new PIXI.Text('', subtitleFont);
        this.text.targetSubtitle.anchor.set(0.5, 0.5);
        this.text.targetSubtitle.position.set(middle[0], 22);
        this.targetContainer.addChild(this.text.targetSubtitle);

        this.text.targetGovernment = new PIXI.Text('', dimFont);
        this.text.targetGovernment.anchor.set(1, 1);
        this.text.targetGovernment.position.set(size[0] - 6, size[1] - 3);
        this.targetContainer.addChild(this.text.targetGovernment);
    }

    drawRadar(source: Position, playerUuid: string,
        ships: Iterable<readonly [string, MovementState, ShipData, string | undefined]>,
        planets: Iterable<readonly [string, MovementState, PlanetData]>,
        now = 0) {
        this.radar.clear();
        this.drawDot(source, this.statusBarData.colors.brightRadar, source);

        const alert = 0.45 + 0.55 * Math.abs(Math.sin(now / 160));
        for (const [uuid, { position }, , locking] of ships) {
            if (uuid === playerUuid) {
                continue;
            }
            const lockingPlayer = locking === playerUuid;
            const color = lockingPlayer
                ? 0xff2020
                : this.statusBarData.colors.dimRadar;
            this.drawDot(position, color, source, lockingPlayer
                ? (alert > 0.7 ? 3 : 2) : 1);
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
        const cargo = statusBarCargoText(playerState, this.cargoNames);
        this.text.cargoFree.text = cargo.free;
        this.text.cargoSpecial.text = cargo.special ?? '';
        this.text.cargoSpecial.visible = cargo.special !== undefined;
        this.text.cargoSpecialLabel.visible = cargo.special !== undefined;
        this.text.cargoCredits.text = cargo.credits;
        this.cargoContainer.visible = true;
    }

    drawNavigation(route: readonly string[]) {
        const firstHop = route[0];
        if (firstHop === this.navigationHop) {
            return;
        }

        this.navigationHop = firstHop;
        const request = ++this.navigationRequest;
        this.navigationContainer.visible = false;
        if (!firstHop) {
            return;
        }

        void this.gameData.data.System.get(firstHop)
            .then(system => {
                if (request !== this.navigationRequest
                    || firstHop !== this.navigationHop) {
                    return;
                }
                const navigation = statusBarNavigationText(
                    [firstHop], system.name);
                if (!navigation) {
                    return;
                }
                this.text.navigationHeading.text = navigation.heading;
                this.text.navigationDestination.text = navigation.destination;
                this.navigationContainer.visible = true;
            })
            .catch(() => {
                if (request === this.navigationRequest) {
                    this.navigationContainer.visible = false;
                }
            });
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

    drawTarget(label: TargetLabelPieces, shield?: number, armor?: number,
        targetPict?: string, shipGraphic?: AnimationGraphic,
        disabled = false) {
        this.targetContainer.visible = true;
        this.noTargetContainer.visible = false;
        this.text.targetName.text = label.name;
        this.text.targetSubtitle.text = label.subtitle ?? '';
        this.text.targetSubtitle.visible = label.subtitle !== undefined;
        this.text.targetGovernment.text = label.government ?? '';
        this.text.targetGovernment.visible = label.government !== undefined;

        const health = statusBarTargetHealth(disabled, shield, armor);
        this.text.disabled.visible = health.status !== undefined;
        this.text.disabled.text = health.status ?? '';
        this.text.shield.visible = health.label === 'Shield:';
        this.text.armor.visible = health.label === 'Armor:';
        this.text.percent.visible = health.percent !== undefined;
        this.text.percent.text = health.percent ?? '';

        this.drawTargetImage(
            targetPict, shipGraphic, label.subtitle !== undefined);
    }

    private drawTargetImage(
        targetPict: string | undefined,
        shipGraphic: AnimationGraphic | undefined,
        hasSubtitle: boolean,
    ) {
        if (targetPict && targetPict !== this.requestedTargetPict) {
            this.requestedTargetPict = targetPict;
            this.readyTargetPict = undefined;
            const request = ++this.targetPictRequest;
            void this.gameData.textureFromPictAsync(targetPict)
                .then(texture => {
                    if (request !== this.targetPictRequest
                        || targetPict !== this.requestedTargetPict) {
                        return;
                    }
                    this.targetSprite.texture = texture;
                    this.readyTargetPict = targetPict;
                    this.layoutTargetSprite(
                        texture.width, texture.height, hasSubtitle);
                    this.targetSprite.visible = true;
                })
                .catch(() => {
                    // Keep using the live animation snapshot for this target.
                });
        } else if (!targetPict && this.requestedTargetPict) {
            this.requestedTargetPict = undefined;
            this.readyTargetPict = undefined;
            this.targetPictRequest++;
        }

        if (targetPict && this.readyTargetPict === targetPict) {
            this.layoutTargetSprite(
                this.targetSprite.texture.width,
                this.targetSprite.texture.height,
                hasSubtitle);
            this.targetSprite.visible = true;
            return;
        }

        this.drawLiveTarget(shipGraphic, hasSubtitle);
    }

    private drawLiveTarget(
        shipGraphic: AnimationGraphic | undefined,
        hasSubtitle: boolean,
    ) {
        if (!shipGraphic) {
            this.targetSprite.visible = false;
            return;
        }

        const shipContainer = shipGraphic.container;
        const { x: width, y: height } = shipGraphic.size;
        if (!this.targetRenderTexture) {
            const baseRenderTexture = new PIXI.BaseRenderTexture({
                width, height,
            });
            this.targetRenderTexture = new PIXI.RenderTexture(
                baseRenderTexture);
            this.targetRenderTextureSize = { width, height };
        } else if (this.targetRenderTextureSize.width !== width
            || this.targetRenderTextureSize.height !== height) {
            this.targetRenderTexture.resize(width, height);
            this.targetRenderTextureSize = { width, height };
        }

        shipContainer.setTransform();
        shipContainer.position.set(width / 2, height / 2);
        const renderTexture = this.targetRenderTexture;
        this.renderer.render(shipContainer, { renderTexture });
        this.targetSprite.texture = renderTexture;
        this.layoutTargetSprite(width, height, hasSubtitle);
        this.targetSprite.visible = true;
    }

    private layoutTargetSprite(
        width: number,
        height: number,
        hasSubtitle: boolean,
    ) {
        const area = this.statusBarData.dataAreas.targeting;
        const top = hasSubtitle ? 29 : 18;
        const bottom = area.size[1] - 18;
        const availableHeight = Math.max(1, bottom - top);
        const availableWidth = Math.max(1, area.size[0] - 12);
        const scale = width > 0 && height > 0
            ? Math.min(1, availableWidth / width, availableHeight / height)
            : 1;
        this.targetSprite.scale.set(scale);
        this.targetSprite.position.set(
            area.size[0] / 2, top + availableHeight / 2);
    }

    clearTarget() {
        this.targetContainer.visible = false;
        this.noTargetContainer.visible = true;
        this.targetSprite.visible = false;
        this.targetSprite.texture = PIXI.Texture.EMPTY;
        this.requestedTargetPict = undefined;
        this.readyTargetPict = undefined;
        this.targetPictRequest++;
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
    new Query([UUID, MovementStateComponent, ShipDataComponent,
        Optional(TargetComponent)] as const),
    new Query([UUID, MovementStateComponent, PlanetDataComponent] as const),
        GetEntity, UUID, PlayerShipSelector] as const,
    step(radarTime, { time }, statusBar, { position }, ships, planets, entity,
        playerUuid) {
        if (!radarTime) {
            radarTime = { lastTime: 0 };
            entity.components.set(RadarTime, radarTime);
        }
        const contacts: Array<readonly [
            string, MovementState, ShipData, string | undefined,
        ]> = [];
        let lockingPlayer = false;
        for (const [uuid, movement, shipData, target] of ships) {
            contacts.push([uuid, movement, shipData, target?.target]);
            if (uuid !== playerUuid && target?.target === playerUuid) {
                lockingPlayer = true;
            }
        }
        if (lockingPlayer
            || time - radarTime.lastTime > statusBar.radarPeriod) {
            statusBar.drawRadar(position, playerUuid, contacts, planets, time);
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
    Optional(GovtComponent), Optional(DisabledComponent),
    Optional(PlayerStateComponent)] as const);
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
            const [shipData, shield, armor, shipGraphic, government, disabled, playerState] = result;
            const governmentData = government
                ? governments.getCached(government.id)
                : undefined;
            const subtitle = playerState?.pilotName
                ? `Capt. ${playerState.pilotName}`
                : shipData.subtitle;
            statusBar.drawTarget(
                targetLabel(
                    shipData.name, subtitle, governmentData),
                shield?.percent,
                armor?.percent,
                shipData.targetPict,
                shipGraphic,
                disabled,
            );
        }
    }
})

const DrawStatusBarNavigation = new System({
    name: 'DrawStatusBarNavigation',
    args: [StatusBarResource, JumpRouteComponent,
        PlayerShipSelector] as const,
    step(statusBar, jumpRoute) {
        statusBar.drawNavigation(jumpRoute.route);
    },
});

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
        world.addSystem(DrawStatusBarNavigation);
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
        world.removeSystem(DrawStatusBarNavigation);
        world.removeSystem(DrawStatusBarTarget);
        world.removeSystem(DrawLandingMessage);
        world.removeSystem(ShowJumpRefusal);
        world.removeSystem(ExpireLandingMessage);
        // A system left behind keeps StatusBarResource in use, and removing
        // that resource then throws. A hyperjump rebuilds every plugin, so
        // forgetting one of these aborted the jump and dropped the client.
        world.removeSystem(ShowBoardingNotice);
        world.removeSystem(ShowBoardingOutcome);

        const stage = world.resources.get(Stage);
        const statusBar = world.resources.get(StatusBarResource);
        if (stage && statusBar) {
            stage.removeChild(statusBar.container);
        }
        statusBar?.destroy();
        world.resources.delete(StatusBarResource);
    }
}
