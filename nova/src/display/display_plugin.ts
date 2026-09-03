import { Optional } from "nova_ecs/optional";
import { Plugin } from "nova_ecs/plugin";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { System } from "nova_ecs/system";
import * as PIXI from "pixi.js";
import { PlayerShipSelector } from "../nova_plugin/player_ship_plugin";
import { ShipComponent } from "../nova_plugin/ship_plugin";
import { TargetComponent } from "../nova_plugin/target_component";
import { OwnerComponent, VulnerableToPD } from "../nova_plugin/fire_weapon_plugin";
import { ProjectileComponent, ProjectileDataComponent } from "../nova_plugin/projectile_data";
import { UUID } from "nova_ecs/arg_types";
import { Query } from "nova_ecs/query";
import { isInboundMissile } from "./sound_plugin";
import {
    PlayerDeathComponent,
    shouldShowDeathOverlay,
} from "../nova_plugin/death_plugin";
import { JumpStateComponent } from "../nova_plugin/jump_plugin";
import {
    AnimationGraphicComponent,
    AnimationGraphicPlugin,
} from "./animation_graphic_plugin";
import { BeamDisplayPlugin } from "./beam_display_plugin";
import { ExplosionPlugin } from "./explosion_plugin";
import { FullscreenPlugin } from "./fullscreen_plugin";
import { JumpEffectPlugin } from "./jump_effect_plugin";
import { ParticlesPlugin } from "./particles_plugin";
import { PilotDialogsPlugin } from "./pilot_dialogs_plugin";
import { PlanetCornersPlugin } from "./planet_corners_plugin";
import { ScreenSizePlugin } from "./screen_size_plugin";
import { ShipAnimationPlugin } from "./ship_animation_plugin";
import { SoundPlugin } from "./sound_plugin";
import { SpaceportPlugin } from "./spaceport_plugin";
import { Space } from "./space_resource";
import { Stage } from "./stage_resource";
import { starfield } from "./starfield_plugin";
import { StarmapPlugin } from "./starmap_plugin";
import { StatusBarResource, StatusBarPlugin } from "./status_bar";
import { TargetCornersPlugin } from "./target_corners_plugin";
import { ChatFeedPlugin } from "./chat_feed_plugin";
import { RadialMenuPlugin } from "./radial_menu_plugin";
import { SmallMapPlugin } from "./small_map_plugin";


const CenterShipSystem = new System({
    name: 'CenterShipPlugin',
    args: [Space, MovementStateComponent, Optional(StatusBarResource),
        PlayerShipSelector] as const,
    step(space, movementState, statusBar) {
        space.position.x = -movementState.position.x +
            (window.innerWidth - (statusBar?.width ?? 0)) / 2;
        space.position.y = -movementState.position.y + window.innerHeight / 2;
    }
});

const DeathOverlaySystem = new System({
    name: 'DeathOverlaySystem',
    args: [PlayerShipSelector, Optional(PlayerDeathComponent), Stage,
        TimeResource, Optional(AnimationGraphicComponent)] as const,
    step(_playerShip, death, stage, time, shipGraphic) {
        if (shipGraphic) {
            // Keep the controllable entity for respawn and replication, but
            // hide its intact sprite while the final explosion is visible.
            shipGraphic.container.visible = !death;
        }
        const existing = stage.getChildByName('PlayerDeathOverlay');
        const messageVisible = shouldShowDeathOverlay(death, time.time);
        if (messageVisible && !existing) {
            const overlay = new PIXI.Container();
            overlay.name = 'PlayerDeathOverlay';
            const background = new PIXI.Graphics();
            background.rect(0, 0, window.innerWidth, window.innerHeight).fill({ color: 0x000000, alpha: 0.65 });
            const text = new PIXI.Text(death?.message ?? 'You are destroyed', {
                fontFamily: 'Geneva',
                fontSize: 22,
                fill: 0xffffff,
                align: 'center',
                wordWrap: true,
                wordWrapWidth: Math.min(560, window.innerWidth - 80),
            });
            text.anchor.set(0.5);
            text.position.set(window.innerWidth / 2, window.innerHeight / 2);
            overlay.addChild(background, text);
            stage.addChild(overlay);
        } else if (!messageVisible && existing) {
            existing.destroy({ children: true });
        }
    },
});

const JumpTransitionOverlaySystem = new System({
    name: 'JumpTransitionOverlaySystem',
    args: [PlayerShipSelector, Optional(JumpStateComponent), Stage,
        TimeResource] as const,
    step(_playerShip, jump, stage, time) {
        const existing = stage.getChildByName(
            'PlayerJumpTransition') as PIXI.Graphics | null;
        if (!jump || jump.phase === 'braking'
            || jump.phase === 'spooling') {
            existing?.destroy();
            return;
        }
        const duration = Math.max(1, jump.transitionAt - jump.phaseStartedAt);
        const progress = Math.min(
            1,
            Math.max(0, (time.time - jump.phaseStartedAt) / duration),
        );
        const alpha = jump.phase === 'departing'
            ? 0.15 + progress * 0.85
            : 1 - progress;
        const flash = existing ?? new PIXI.Graphics();
        flash.name = 'PlayerJumpTransition';
        flash.clear();
        flash.rect(0, 0, window.innerWidth, window.innerHeight).fill({ color: 0xffffff, alpha });
        if (!existing) {
            stage.addChild(flash);
        }
    },
});

const IncomingMissileOverlayQuery = new Query([
    UUID,
    ProjectileComponent,
    ProjectileDataComponent,
    TargetComponent,
    OwnerComponent,
    MovementStateComponent,
    VulnerableToPD,
] as const);

const HOSTILE_LOCK_OVERLAY = 'HostileLockWarning';

function drawHostileLockCorners(
    graphics: PIXI.Graphics,
    width: number,
    height: number,
    timeMs: number,
) {
    const pulse = 0.4 + 0.45 * Math.abs(Math.sin(timeMs / 160));
    const inset = 12;
    const arm = Math.min(56, Math.max(28, Math.min(width, height) * 0.08));
    graphics.clear();
    graphics.moveTo(inset, inset + arm);
    graphics.lineTo(inset, inset);
    graphics.lineTo(inset + arm, inset);
    graphics.moveTo(width - inset - arm, inset);
    graphics.lineTo(width - inset, inset);
    graphics.lineTo(width - inset, inset + arm);
    graphics.moveTo(width - inset, height - inset - arm);
    graphics.lineTo(width - inset, height - inset);
    graphics.lineTo(width - inset - arm, height - inset);
    graphics.moveTo(inset + arm, height - inset);
    graphics.lineTo(inset, height - inset);
    graphics.lineTo(inset, height - inset - arm);
    graphics.stroke({ width: 4, color: 0xff2020, alpha: pulse });
}

const MissileWarningOverlaySystem = new System({
    name: 'MissileWarningOverlaySystem',
    args: [
        UUID,
        PlayerShipSelector,
        MovementStateComponent,
        Stage,
        TimeResource,
        Optional(PlayerDeathComponent),
        Optional(StatusBarResource),
        IncomingMissileOverlayQuery,
    ] as const,
    step(playerUuid, _player, playerMovement, stage, time, death, statusBar, missiles) {
        const hasInboundMissile = !death && missiles.some(([uuid, _proj, data, target, owner, movement]) =>
            isInboundMissile({
                target: target.target,
                owner: owner.owner,
                guidance: data.guidance,
                vulnerableToPointDefense: true,
                position: movement.position,
                velocity: movement.velocity,
            }, playerUuid, playerMovement)
        );
        const existing = stage.getChildByName(
            HOSTILE_LOCK_OVERLAY) as PIXI.Graphics | null;
        if (!hasInboundMissile) {
            existing?.destroy();
            return;
        }
        const width = Math.max(1, window.innerWidth - (statusBar?.width ?? 0));
        const height = window.innerHeight;
        const overlay = existing ?? new PIXI.Graphics();
        overlay.name = HOSTILE_LOCK_OVERLAY;
        drawHostileLockCorners(overlay, width, height, time.time);
        if (!existing) {
            stage.addChild(overlay);
        }
    },
});

const starfieldPlugin = starfield();

export const Display: Plugin = {
    name: 'Display',
    async build(world) {
        const stage = new PIXI.Container();
        stage.name = 'Stage';
        const space = new PIXI.Container();
        space.name = 'Space';
        space.sortableChildren = true;
        stage.addChild(space);
        world.resources.set(Stage, stage);
        world.resources.set(Space, space);
        await world.addPlugin(ScreenSizePlugin);
        await world.addPlugin(starfieldPlugin);
        await world.addPlugin(StatusBarPlugin);
        await world.addPlugin(AnimationGraphicPlugin);
        await world.addPlugin(JumpEffectPlugin);
        world.addSystem(CenterShipSystem);
        world.addSystem(DeathOverlaySystem);
        world.addSystem(JumpTransitionOverlaySystem);
        world.addSystem(MissileWarningOverlaySystem);
        await world.addPlugin(TargetCornersPlugin);
        await world.addPlugin(ChatFeedPlugin);
        await world.addPlugin(RadialMenuPlugin);
        await world.addPlugin(SmallMapPlugin);
        await world.addPlugin(ParticlesPlugin);
        await world.addPlugin(FullscreenPlugin);
        await world.addPlugin(ExplosionPlugin);
        await world.addPlugin(BeamDisplayPlugin);
        await world.addPlugin(PlanetCornersPlugin);
        await world.addPlugin(SpaceportPlugin);
        await world.addPlugin(StarmapPlugin);
        await world.addPlugin(PilotDialogsPlugin);
        await world.addPlugin(SoundPlugin);
        await world.addPlugin(ShipAnimationPlugin);
    },
    async remove(world) {
        await world.removePlugin(ShipAnimationPlugin);
        await world.removePlugin(SoundPlugin);
        await world.removePlugin(PilotDialogsPlugin);
        await world.removePlugin(StarmapPlugin);
        await world.removePlugin(SpaceportPlugin);
        await world.removePlugin(PlanetCornersPlugin);
        await world.removePlugin(BeamDisplayPlugin);
        await world.removePlugin(ExplosionPlugin);
        await world.removePlugin(FullscreenPlugin);
        await world.removePlugin(ParticlesPlugin);
        await world.removePlugin(SmallMapPlugin);
        await world.removePlugin(RadialMenuPlugin);
        await world.removePlugin(ChatFeedPlugin);
        await world.removePlugin(TargetCornersPlugin);

        world.removeSystem(CenterShipSystem);
        world.removeSystem(DeathOverlaySystem);
        world.removeSystem(JumpTransitionOverlaySystem);
        world.removeSystem(MissileWarningOverlaySystem);

        await world.removePlugin(JumpEffectPlugin);
        await world.removePlugin(AnimationGraphicPlugin);
        await world.removePlugin(StatusBarPlugin);
        await world.removePlugin(starfieldPlugin);
        await world.removePlugin(ScreenSizePlugin);

        const stage = world.resources.get(Stage);
        const space = world.resources.get(Space);
        if (stage && space) {
            stage.removeChild(space);
        }
        if (stage && !stage.destroyed) {
            stage.destroy({ children: true });
        }

        world.resources.delete(Stage);
        world.resources.delete(Space);
    }
};
