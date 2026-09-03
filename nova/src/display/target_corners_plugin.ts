import { Entities, RunQuery, UUID } from "nova_ecs/arg_types";
import { Optional } from "nova_ecs/optional";
import { Plugin } from 'nova_ecs/plugin';
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { Resource } from "nova_ecs/resource";
import { System } from "nova_ecs/system";
import { Query } from "nova_ecs/query";
import * as PIXI from "pixi.js";
import { GameData } from "../client/gamedata/GameData";
import { GameDataResource } from "../nova_plugin/game_data_resource";
import { PlayerShipSelector } from "../nova_plugin/player_ship_plugin";
import { TargetComponent } from "../nova_plugin/target_component";
import { DisabledComponent } from "../nova_plugin/disabled_plugin";
import { GovtComponent } from "../nova_plugin/npc_components";
import { PlayerStateComponent } from "../nova_plugin/player_state";
import { HiredEscortComponent } from "../nova_plugin/escort_plugin";
import { GovernmentRelationResource, relation } from "../nova_plugin/govt_relations";
import { AnimationGraphicComponent, ObjectDrawSystem } from "./animation_graphic_plugin";
import { Space } from "./space_resource";
import { createGraphicHandle, ManagedGraphic } from './managed_graphic';

const NUM_CORNERS = 4;
const TIME_TO_TARGET = 100; // milliseconds

function createFallbackCornerTexture(color: number): PIXI.Texture {
    if (typeof document === 'undefined') {
        return PIXI.Texture.EMPTY;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d');
    if (ctx) {
        const hex = '#' + color.toString(16).padStart(6, '0');
        ctx.fillStyle = hex;
        // Top horizontal arm (14px long, 2px thick)
        ctx.fillRect(0, 0, 14, 2);
        // Left vertical arm (14px long, 2px thick)
        ctx.fillRect(0, 0, 2, 14);
    }
    return PIXI.Texture.from(canvas);
}

export class TargetCorners {
    private targetTime = 0;
    targetUuid?: string;
    container = new PIXI.Container();
    readonly managed: ManagedGraphic = createGraphicHandle(this.container);
    private sprites: PIXI.Sprite[] = [];
    private textures = new Map<string, PIXI.Texture>();
    private currentStyle = 'neutral';
    private callsignText = new PIXI.Text({
        text: '',
        style: {
            fontFamily: 'Geneva, Monaco, Chicago, Arial, sans-serif',
            fontSize: 9,
            fill: 0x00f0ff,
            align: 'center',
        },
    });
    built: Promise<void>;

    constructor(gameData: GameData, id = 'targetCorners') {
        this.visible = false;
        this.container.zIndex = 1000;

        const cornerRotations = [
            0,
            Math.PI / 2,
            Math.PI,
            (3 * Math.PI) / 2,
        ];

        for (let i = 0; i < NUM_CORNERS; i++) {
            const sprite = new PIXI.Sprite();
            sprite.anchor.set(0, 0);
            sprite.rotation = cornerRotations[i];
            this.container.addChild(sprite);
            this.sprites.push(sprite);
        }

        this.callsignText.anchor.set(0.5, 1);
        this.callsignText.visible = false;
        this.container.addChild(this.callsignText);

        this.built = this.build(gameData, id);
    }

    private async build(gameData: GameData, id: string) {
        const isPlanet = id === 'planetCorners';
        this.textures.set('neutral', createFallbackCornerTexture(isPlanet ? 0x00c8ff : 0xffea00));
        this.textures.set('hostile', createFallbackCornerTexture(0xff2828));
        this.textures.set('friendly', createFallbackCornerTexture(0x28ff28));
        this.textures.set('disabled', createFallbackCornerTexture(0x888888));
        this.textures.set('player', createFallbackCornerTexture(0x00f0ff));
        this.textures.set('escort', createFallbackCornerTexture(0x38ff75));
        this.setStyle(this.currentStyle);

        try {
            const targetCornersData = await gameData.data.TargetCorners.get(id);
            if (targetCornersData?.images) {
                for (const [cornerName, imageId] of Object.entries(targetCornersData.images)) {
                    try {
                        const texture = await gameData.textureFromCicn(imageId);
                        if (texture && texture !== PIXI.Texture.EMPTY) {
                            this.textures.set(cornerName, texture);
                        }
                    } catch (e) {
                        console.warn(`Failed to load corner texture ${imageId}`, e);
                    }
                }
            }
        } catch (e) {
            console.warn(`Failed to load target corners data ${id}`, e);
        }
        this.setStyle(this.currentStyle);
    }

    setPosition({ x, y }: { x: number, y: number }) {
        this.container.position.x = x;
        this.container.position.y = y;
    }

    get visible() {
        return this.container.visible;
    }

    set visible(v: boolean) {
        this.container.visible = v;
    }

    setStyle(style: string) {
        this.currentStyle = style;
        const texture = this.textures.get(style);
        if (texture) {
            for (const sprite of this.sprites) {
                sprite.texture = texture;
            }
        }
    }

    attachTo(parent: PIXI.Container): void {
        if (!this.managed.disposed && this.container.parent !== parent) {
            parent.addChild(this.container);
        }
    }

    dispose(): void {
        this.managed.dispose();
    }

    step(time: number, targetUuid: string | undefined,
        targetSize: { x: number, y: number }, callsign?: string) {

        if (targetUuid !== this.targetUuid) {
            this.targetUuid = targetUuid;
            this.targetTime = time;
        }

        const timeSinceStart = time - this.targetTime;
        const timeLeft = Math.max(0, TIME_TO_TARGET - timeSinceStart);
        const scale = 1 + timeLeft / 40;

        const padding = 2;
        const halfW = (targetSize.x / 2 + padding) * scale;
        const halfH = (targetSize.y / 2 + padding) * scale;

        const cornerPositions = [
            { x: -halfW, y: -halfH },
            { x:  halfW, y: -halfH },
            { x:  halfW, y:  halfH },
            { x: -halfW, y:  halfH },
        ];

        for (let i = 0; i < NUM_CORNERS; i++) {
            const sprite = this.sprites[i];
            sprite.position.x = cornerPositions[i].x;
            sprite.position.y = cornerPositions[i].y;
        }

        if (callsign) {
            this.callsignText.text = callsign;
            this.callsignText.position.set(0, -halfH - 4);
            this.callsignText.visible = true;
        } else {
            this.callsignText.visible = false;
        }
    }
}

const TargetCornersResource = new Resource<TargetCorners>('TargetCornersResource');

const TargetEntityQuery = new Query([
    Optional(DisabledComponent),
    Optional(GovtComponent),
    Optional(TargetComponent),
    Optional(PlayerStateComponent),
    Optional(HiredEscortComponent),
] as const);

const DrawTargetCornersSystem = new System({
    name: "DrawTargetCornersSystem",
    args: [
        TargetComponent,
        TimeResource,
        TargetCornersResource,
        Entities,
        PlayerShipSelector,
        UUID,
        RunQuery,
        Optional(GovernmentRelationResource),
        Optional(GovtComponent),
    ] as const,
    step({ target }, time, targetCorners, entities, _playerShip, playerUuid, runQuery, govts, playerGovt) {
        if (!target) {
            targetCorners.visible = false;
            targetCorners.targetUuid = undefined;
            return;
        }

        const targetEntity = entities.get(target);
        const targetGraphic = targetEntity?.components.get(AnimationGraphicComponent);
        if (!targetGraphic) {
            targetCorners.visible = false;
            targetCorners.targetUuid = undefined;
            return;
        }

        let callsign: string | undefined;
        const targetComponents = runQuery(TargetEntityQuery, target)[0];
        if (targetComponents) {
            const [disabled, targetGovt, targetLock, targetPlayer, targetEscort] = targetComponents;
            if (disabled) {
                targetCorners.setStyle("disabled");
            } else if (targetLock?.target === playerUuid) {
                targetCorners.setStyle("hostile");
                if (targetPlayer?.pilotName) {
                    callsign = `HOSTILE CMDR ${targetPlayer.pilotName}`;
                }
            } else if (targetEscort && targetEscort.ownerUuid === playerUuid) {
                targetCorners.setStyle("escort");
                callsign = `ESCORT`;
            } else if (targetPlayer) {
                targetCorners.setStyle("player");
                callsign = targetPlayer.pilotName ? `CMDR ${targetPlayer.pilotName}` : `TRANSPONDER: ONLINE`;
            } else if (targetGovt && playerGovt && govts) {
                const targetGovtData = govts.getCached(targetGovt.id);
                const playerGovtData = govts.getCached(playerGovt.id);
                if (targetGovtData && playerGovtData) {
                    const rel = relation(playerGovtData, targetGovtData);
                    if (rel === 'enemy') {
                        targetCorners.setStyle("hostile");
                    } else if (rel === 'ally') {
                        targetCorners.setStyle("friendly");
                    } else {
                        targetCorners.setStyle("neutral");
                    }
                } else {
                    targetCorners.setStyle("neutral");
                }
            } else {
                targetCorners.setStyle("neutral");
            }
        } else {
            targetCorners.setStyle("neutral");
        }

        targetCorners.step(time.time, target, targetGraphic.size, callsign);
        targetCorners.setPosition(targetGraphic.container.position);
        targetCorners.visible = true;
    },
    after: [ObjectDrawSystem],
});

export const TargetCornersPlugin: Plugin = {
    name: 'TargetCornersPlugin',
    build(world) {
        const gameData = world.resources.get(GameDataResource);
        if (!gameData) {
            throw new Error('Expected world to have gameData');
        }

        const space = world.resources.get(Space);
        if (!space) {
            throw new Error('Expected world to have Space resource');
        }

        const targetCorners = new TargetCorners(gameData as GameData);
        targetCorners.attachTo(space);
        world.resources.set(TargetCornersResource, targetCorners);
        world.addSystem(DrawTargetCornersSystem);
    },
    remove(world) {
        world.removeSystem(DrawTargetCornersSystem);
        const targetCorners = world.resources.get(TargetCornersResource);
        if (targetCorners) {
            targetCorners.dispose();
        }
        world.resources.delete(TargetCornersResource);
    }
}
