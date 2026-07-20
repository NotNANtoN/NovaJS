import { PlanetData } from "novadatainterface/planet_data";
import { StatusBarData, StatusBarDataArea } from "novadatainterface/status_bar_data";
import { GetEntity, RunQuery, UUID } from "nova_ecs/arg_types";
import { Component } from "nova_ecs/component";
import { Position } from "nova_ecs/datatypes/position";
import { Vector } from "nova_ecs/datatypes/vector";
import { EcsEvent } from "nova_ecs/events";
import { Optional } from "nova_ecs/optional";
import { Plugin } from "nova_ecs/plugin";
import { MovementState, MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { Query } from "nova_ecs/query";
import { Resource } from "nova_ecs/resource";
import { System } from "nova_ecs/system";
import * as PIXI from "pixi.js";
import { Subject } from "rxjs";
import { DisplayAssetDataInterface } from "../client/gamedata/display_asset_data.js";
import { DisplayAssetDataResource, SimulationGameDataResource } from "../nova_plugin/game_data_resource.js";
import { CloakActiveComponent, CloakComponent, CloakScannerComponent } from "../nova_plugin/cloak_plugin.js";
import { GovtComponent } from "../nova_plugin/govt_component.js";
import { deriveIff, dispositionColor, shipDisposition } from "../nova_plugin/iff_plugin.js";
import { LegalRecordsComponent } from "../nova_plugin/reputation_plugin.js";
import { ArmorComponent, FuelComponent, FUEL_PER_JUMP, ShieldComponent } from "../nova_plugin/health_plugin.js";
import { OutfitsStateComponent, sumOutfitField } from "../nova_plugin/outfit_plugin.js";
import { PersComponent } from "../nova_plugin/pers_plugin.js";
import { PlanetDataComponent } from "../nova_plugin/planet_plugin.js";
import { PlayerShipSelector } from "../nova_plugin/player_ship_plugin.js";
import { ShipDataComponent } from "../nova_plugin/ship_plugin.js";
import { SystemIdResource } from "../nova_plugin/system_id_resource.js";
import { Stat } from "../nova_plugin/stat.js";
import { TargetComponent } from "../nova_plugin/target_component.js";
import { ActiveSecondaryWeapon, countAmmo } from "../nova_plugin/weapon_plugin.js";
import { Button } from "../spaceport/button.js";
import { AnimationGraphic } from "./animation_graphic.js";
import { AnimationGraphicComponent } from "./animation_graphic_plugin.js";
import { PixiAppResource } from "./pixi_app_resource.js";
import { ResizeEvent } from "./screen_size_plugin.js";
import { Stage } from "./stage_resource.js";


class StatusBar {
    readonly container = new PIXI.Container();
    readonly buildPromise: Promise<void>;
    built = false;
    width = 0;
    private radarScale = new Vector(6000, 6000);
    private radar = new PIXI.Graphics();
    radarPeriod = 200;
    private statsGraphics = new PIXI.Graphics();

    /**
     * The system's sensor interference (0-100), from the sÿst resource. Zero
     * is a clear radar; 100 is a complete sensor blackout. Static per system,
     * so it is read display-side and never affects the simulation.
     */
    systemInterference = 0;
    /**
     * Interference removed by outfits (the "Radar Interference" outfit
     * modifier, EVN Bible / ResForge outf case 24). A radar-interference
     * outfit hook can raise this to clear up the radar; the effective
     * interference is clamped so it never drops below zero.
     */
    interferenceReduction = 0;
    /**
     * The sensor-static pixel patterns (the ppat resources from Nova
     * Graphics 1). Each radar tick is replaced wholesale by one of these,
     * tiled, with probability interference / 100 — matching the original
     * engine's static, rather than per-blip noise.
     */
    staticTextures: PIXI.Texture[] = [];
    private staticSprite?: PIXI.TilingSprite;

    /** The effective interference after outfit reductions, clamped 0-100. */
    private get interference(): number {
        return Math.max(0, Math.min(100,
            this.systemInterference - this.interferenceReduction));
    }

    private targetContainer = new PIXI.Container();
    private noTargetContainer = new PIXI.Container();
    private targetSprite = new PIXI.Sprite();

    /**
     * A single RenderTexture reused across frames to draw the locked
     * target's ship graphic. Reallocated (destroying the old one and its
     * base texture) only when the required size changes, so a locked
     * target no longer leaks a fresh GPU texture every display frame.
     */
    private targetRenderTexture?: PIXI.RenderTexture;

    private text: { [index: string]: PIXI.Text } = {};
    private addEnemyButton: Button;
    readonly addEnemy: Subject<undefined>;

    constructor(private statusBarData: StatusBarData, private displayAssets: DisplayAssetDataInterface,
                private renderer: PIXI.Renderer | PIXI.IRenderer) {
        this.buildPromise = this.build();
        this.container.name = 'StatusBar';
        this.addEnemyButton = new Button(displayAssets, 'Add Enemy', 60);
        this.addEnemyButton.container.position.x = 65;
        this.addEnemyButton.container.position.y = 530;
        this.addEnemy = this.addEnemyButton.click;
    }

    private async build() {
        const background = await this.displayAssets.spriteFromPictAsync(this.statusBarData.image);
        this.container.addChild(background);
        this.width = background.width;
        const dataAreas = this.statusBarData.dataAreas;
        [this.radar.position.x, this.radar.position.y] = dataAreas.radar.position;
        this.container.addChild(this.radar);
        this.staticSprite = new PIXI.TilingSprite(PIXI.Texture.EMPTY,
            dataAreas.radar.size[0], dataAreas.radar.size[1]);
        [this.staticSprite.position.x, this.staticSprite.position.y] =
            dataAreas.radar.position;
        this.staticSprite.visible = false;
        this.container.addChild(this.staticSprite);
        this.container.addChild(this.statsGraphics);
        this.targetContainer.addChild(this.targetSprite);
        this.targetSprite.anchor.set(0.5, 0.5);
        this.targetSprite.position.x =
            this.statusBarData.dataAreas.targeting.size[0] / 2;
        this.targetSprite.position.y =
            this.statusBarData.dataAreas.targeting.size[1] / 2;

        this.makeText();
        this.container.addChild(this.addEnemyButton.container);
        this.built = true;
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

        this.text.noTarget = new PIXI.Text("No Target", dimFont);
        this.text.noTarget.anchor.x = 0.5;
        this.text.noTarget.anchor.y = 0.5;
        this.text.noTarget.position.x = middle[0];
        this.text.noTarget.position.y = middle[1] - 15;

        this.noTargetContainer.addChild(this.text.noTarget);

        this.text.targetName = new PIXI.Text("Name Placeholder", font);
        this.text.targetName.anchor.x = 0.5;
        this.text.targetName.anchor.y = 0.5;
        this.text.targetName.position.x = middle[0];
        this.text.targetName.position.y = 12;

        this.targetContainer.addChild(this.text.targetName);

        this.text.targetImagePlaceholder = new PIXI.Text("No target image", dimFont);
        this.text.targetImagePlaceholder.anchor.x = 0.5;
        this.text.targetImagePlaceholder.anchor.y = 0.5;
    }

    drawRadar(source: Position,
        ships: Iterable<readonly [string, MovementState, ...unknown[]]>,
        planets: Iterable<readonly [string, MovementState, PlanetData]>,
        /**
         * Per-ship blip colour by uuid, from IFF (ModType 14). When the map is
         * absent or a ship is missing, blips use the flat dimRadar colour;
         * when the player owns an IFF outfit the DrawRadar system fills this in
         * so hostile/friendly/neutral ships are coloured (EVN Bible: an IFF
         * outfit overrides the radar colours).
         */
        iffColors?: ReadonlyMap<string, number>) {
        this.radar.clear();

        // Interference (0-100) makes sensors unreliable: on each radar tick,
        // with probability interference / 100, the whole radar is replaced by
        // one of the ppat static patterns, tiled — the original engine's
        // behavior. At 100 the radar is pure static (a complete sensor
        // blackout); otherwise this tick draws normally.
        if (this.drawSensorStatic()) {
            return;
        }

        this.drawDot(source, this.statusBarData.colors.brightRadar, source);

        for (const [uuid, { position }] of ships) {
            const color = iffColors?.get(uuid)
                ?? this.statusBarData.colors.dimRadar;
            this.drawDot(position, color, source);
        }

        for (const [, { position }] of planets) {
            this.drawDot(position, 0xFFFF00, source, 2);
        }
    }

    /**
     * Probabilistically replaces this radar tick with static. Returns whether
     * it did, in which case no blips should be drawn.
     */
    private drawSensorStatic(): boolean {
        if (!this.staticSprite || this.staticTextures.length === 0 ||
            Math.random() * 100 >= this.interference) {
            if (this.staticSprite) {
                this.staticSprite.visible = false;
            }
            return false;
        }
        this.staticSprite.texture = this.staticTextures[
            Math.floor(Math.random() * this.staticTextures.length)];
        this.staticSprite.visible = true;
        return true;
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

    drawStats(shield: Stat, armor: Stat, fuel?: Stat) {
        this.statsGraphics.clear();

        const shieldFullness = Math.max(0, shield.current / shield.max);
        this.drawLine(this.statusBarData.dataAreas.shield,
            this.statusBarData.colors.shield, shieldFullness);

        const armorFullness = Math.max(0, armor.current / armor.max);
        this.drawLine(this.statusBarData.dataAreas.armor,
            this.statusBarData.colors.armor, armorFullness);

        if (fuel && fuel.max > 0) {
            // Partial-jump fuel in the dim color, with the whole jumps'
            // worth (100 units each) drawn over it in the full color.
            const fuelFullness = Math.max(0, fuel.current / fuel.max);
            this.drawLine(this.statusBarData.dataAreas.fuel,
                this.statusBarData.colors.fuelPartial, fuelFullness);
            const fullJumps = Math.max(0, Math.floor(
                fuel.current / FUEL_PER_JUMP) * FUEL_PER_JUMP / fuel.max);
            this.drawLine(this.statusBarData.dataAreas.fuel,
                this.statusBarData.colors.fuelFull, fullJumps);
        }
    }

    private lastSecondary: string | null | undefined;
    drawSecondary(name: string | null | undefined) {
        if (!this.built || name === this.lastSecondary) {
            return;
        }
        this.lastSecondary = name;
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
        shipGraphic?: AnimationGraphic) {
        this.targetContainer.visible = true;
        this.noTargetContainer.visible = false;
        this.text.targetName.text = name;

        if (shield && shield > 0) {
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
            const width = shipGraphic.size.x;
            const height = shipGraphic.size.y;

            // Reuse the cached RenderTexture across frames; only reallocate
            // (destroying the old one and its base texture) when the target's
            // size changes. Without this a fresh texture would leak every
            // display frame while a target is locked.
            let renderTexture = this.targetRenderTexture;
            if (!renderTexture ||
                renderTexture.width !== width ||
                renderTexture.height !== height) {
                renderTexture?.destroy(true);
                const baseRenderTexture = new PIXI.BaseRenderTexture({
                    width, height,
                });
                renderTexture = new PIXI.RenderTexture(baseRenderTexture);
                this.targetRenderTexture = renderTexture;
            }

            shipContainer.setTransform();
            shipContainer.position.x = shipGraphic.size.x / 2;
            shipContainer.position.y = shipGraphic.size.y / 2;
            this.renderer.render(shipContainer, { renderTexture });
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
    }

    /** Releases the cached target RenderTexture (and its base texture). */
    destroy() {
        this.targetRenderTexture?.destroy(true);
        this.targetRenderTexture = undefined;
    }
}

export const StatusBarResource = new Resource<StatusBar>('StatusBar');
export const AddEnemyEvent = new EcsEvent<{ shipId: string }>('AddEnemyEvent');

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
        Optional(CloakActiveComponent), Optional(CloakComponent),
        Optional(GovtComponent)] as const),
    new Query([UUID, MovementStateComponent, PlanetDataComponent] as const),
        SimulationGameDataResource, GetEntity, PlayerShipSelector] as const,
    step(radarTime, { time }, statusBar, { position }, ships, planets,
        gameData, entity) {
        if (!radarTime) {
            radarTime = { lastTime: 0 };
            entity.components.set(RadarTime, radarTime);
        }
        if (time - radarTime.lastTime > statusBar.radarPeriod) {
            // Hide ships that are actively cloaked with a radar-hiding
            // cloak (bit 0x0002 "visible on radar" clear), unless the
            // player has a cloak scanner that reveals cloaked ships on
            // radar (ModVal 0x0001). Builds on the merged interference/
            // static radar. The player's own ship is drawn separately
            // from `source`, so it always shows.
            const scanner = entity.components.get(CloakScannerComponent);
            const revealsCloaked = scanner?.revealsOnRadar === true;
            const visibleShips = revealsCloaked ? ships : ships.filter(
                ([, , , cloakActive, cloak]) =>
                    !(cloakActive?.active && (cloak?.hidesFromRadar ?? true)));

            // IFF (ModType 14): when the player owns an IFF outfit, colour
            // each ship's blip by its disposition toward the player. Without
            // IFF, or before govt data caches, blips stay the flat dim colour.
            // The capability is derived here from the player's (delta-synced)
            // outfits rather than read off a component: the radar runs in the
            // display world, and IffComponent lives only in the sim worker.
            const playerOutfits = entity.components.get(OutfitsStateComponent);
            const hasIff = playerOutfits
                ? deriveIff(playerOutfits, gameData)?.hasIff === true : false;
            let iffColors: Map<string, number> | undefined;
            if (hasIff) {
                const playerGovtId = entity.components.get(GovtComponent)?.id;
                const playerGovt = playerGovtId
                    ? gameData.data.Govt.getCached(playerGovtId) : undefined;
                // The player's legal records (delta-synced): a govt the
                // player is criminal with shows hostile blips.
                const playerRecords =
                    entity.components.get(LegalRecordsComponent);
                iffColors = new Map();
                for (const [uuid, , , , , shipGovt] of visibleShips) {
                    const govt = shipGovt
                        ? gameData.data.Govt.getCached(shipGovt.id) : undefined;
                    iffColors.set(uuid, dispositionColor(
                        shipDisposition(govt, playerGovt, playerRecords)));
                }
            }
            statusBar.drawRadar(position, visibleShips, planets, iffColors);
            radarTime.lastTime = time;
        }
    }
});

const DrawStatusBarStats = new System({
    name: 'DrawStatusBarStats',
    args: [StatusBarResource, ShieldComponent, ArmorComponent,
        Optional(FuelComponent), PlayerShipSelector] as const,
    step(statusBar, shield, armor, fuel) {
        statusBar.drawStats(shield, armor, fuel);
    }
})

// Runs every step (not just on ChangeSecondaryEvent) so the ammo count
// updates as the weapon fires. drawSecondary ignores unchanged text.
const DrawStatusBarSecondaryWeapon = new System({
    name: 'DrawStatusBarSecondaryWeapon',
    args: [StatusBarResource, ActiveSecondaryWeapon,
        Optional(OutfitsStateComponent), SimulationGameDataResource,
        PlayerShipSelector] as const,
    step(statusBar, activeSecondary, outfits, gameData) {
        if (!activeSecondary.secondary) {
            statusBar.drawSecondary(null);
            return;
        }
        const weapon = gameData.data.Weapon.getCached(activeSecondary.secondary);
        if (!weapon) {
            // Not cached yet; getCached kicked off the load.
            return;
        }
        const { ammoType } = weapon;
        if (outfits && ammoType instanceof Array && ammoType[0] === 'weapon') {
            // "Weapon Name - 37"; weapons without ammo show the bare name.
            statusBar.drawSecondary(
                `${weapon.name} - ${countAmmo(ammoType[1], outfits, gameData)}`);
        } else {
            statusBar.drawSecondary(weapon.name);
        }
    }
});

const TargetQuery = new Query([ShipDataComponent, Optional(ShieldComponent),
    Optional(ArmorComponent), Optional(AnimationGraphicComponent),
    Optional(PersComponent)] as const);
const DrawStatusBarTarget = new System({
    name: 'DrawStatusBarTarget',
    args: [StatusBarResource, TargetComponent, RunQuery, PlayerShipSelector] as const,
    step(statusBar, { target }, runQuery) {
        if (!target) {
            statusBar.clearTarget();
            return;
        }
        const result = runQuery(TargetQuery, target)[0];
        if (result) {
            const [shipData, shield, armor, shipGraphic, pers] = result;
            // A përs person's name replaces the ship class name on the
            // target display (EVN Bible, përs section).
            statusBar.drawTarget(pers?.name ?? shipData.name,
                shield?.percent, armor?.percent, shipGraphic);
        }
    }
})

/**
 * Feeds the interference-mod outfits (oütf ModType 24) into the radar: sums
 * the player ship's owned outfits' interferenceReduction and writes it to the
 * status bar. The Bible: "Subtracts the value in ModVal from the current star
 * system's Interference value when calculating how fuzzy to make the radar."
 * Display-only (interference never affects the simulation), so this reads the
 * player's outfits directly. A stock Sensor Boost (nova:203) clears 20
 * interference; several stack. Runs every step so buying/selling updates it.
 */
const DrawStatusBarInterference = new System({
    name: 'DrawStatusBarInterference',
    args: [StatusBarResource, OutfitsStateComponent,
        SimulationGameDataResource, PlayerShipSelector] as const,
    step(statusBar, outfits, gameData) {
        const reduction = sumOutfitField(
            outfits, gameData, o => o.interferenceReduction);
        if (reduction !== undefined) {
            statusBar.interferenceReduction = reduction;
        }
    },
});

export const StatusBarPlugin: Plugin = {
    name: 'StatusBar',
    async build(world) {
        const simulationData = world.resources.get(SimulationGameDataResource);
        if (!simulationData) {
            throw new Error('Expected simulation game data resource to exist');
        }
        const displayAssets = world.resources.get(DisplayAssetDataResource);
        if (!displayAssets) {
            throw new Error('Expected display asset data resource to exist');
        }

        const stage = world.resources.get(Stage);
        if (!stage) {
            throw new Error('Expected Stage resource to exist');
        }

        const app = world.resources.get(PixiAppResource);
        if (!app) {
            throw new Error('Expected PIXI App resource to exist');
        }

        const statusBar = new StatusBar(await displayAssets.data.StatusBar.get("nova:128"),
            displayAssets, app.renderer);

        // Seed the radar's sensor interference from the current system. This is
        // static per-system data (from the sÿst resource), read display-side so
        // it never affects the deterministic simulation. Outfits can later clear
        // it up via statusBar.interferenceReduction.
        const systemId = world.resources.get(SystemIdResource);
        if (systemId) {
            const systemData = await simulationData.data.System.get(systemId);
            statusBar.systemInterference = systemData.interference;
            if (systemData.interference > 0) {
                // The ppat pixel patterns the radar shows as sensor static.
                // Only needed in systems that actually have interference.
                const ppatIds = (await simulationData.ids).PpatImage;
                statusBar.staticTextures = await Promise.all(ppatIds.map(
                    id => displayAssets.textureFromPpat(id)));
            }
        }

        await statusBar.buildPromise;
        stage.addChild(statusBar.container);
        statusBar.container.position.x = window.innerWidth - statusBar.container.width;
        statusBar.container.position.y = 0;
        statusBar.addEnemy.subscribe(async () => {
            const randomIndex = Math.floor(Math.random() * (await simulationData.ids).Ship.length);
            const randomShipId = (await simulationData.ids).Ship[randomIndex];
            world.emit(AddEnemyEvent, { shipId: randomShipId });
        });

        world.resources.set(StatusBarResource, statusBar);

        world.addSystem(DrawRadar);
        world.addSystem(StatusBarResize);
        world.addSystem(DrawStatusBarStats);
        world.addSystem(DrawStatusBarSecondaryWeapon);
        world.addSystem(DrawStatusBarTarget);
        world.addSystem(DrawStatusBarInterference);
    },
    remove(world) {
        world.removeSystem(DrawRadar);
        world.removeSystem(StatusBarResize);
        world.removeSystem(DrawStatusBarStats);
        world.removeSystem(DrawStatusBarSecondaryWeapon);
        world.removeSystem(DrawStatusBarTarget);
        world.removeSystem(DrawStatusBarInterference);

        const stage = world.resources.get(Stage);
        const statusBar = world.resources.get(StatusBarResource);
        if (statusBar) {
            if (stage) {
                stage.removeChild(statusBar.container);
            }
            statusBar.destroy();
        }
        world.resources.delete(StatusBarResource);
    }
}
