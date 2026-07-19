import { Plugin } from "nova_ecs/plugin";
import { DeltaPlugin } from "nova_ecs/plugins/delta_plugin";
import { MovementPlugin } from "nova_ecs/plugins/movement_plugin";
import { TimePlugin } from "nova_ecs/plugins/time_plugin";
import { AfterburnerPlugin } from "./afterburner_plugin.js";
import { AnimationPlugin } from "./animation_plugin.js";
import { AsteroidPlugin } from "./asteroid_plugin.js";
import { BayPlugin } from "./bay_plugin.js";
import { CargoPlugin } from "./cargo_plugin.js";
import { BeamPlugin } from "./beam_plugin.js";
import { BlastPlugin } from "./blast_plugin.js";
import { CloakPlugin } from "./cloak_plugin.js";
import { CollisionsPlugin } from './collisions_plugin.js';
import { ControlsPlugin } from "./controls_plugin.js";
import { CreateTimePlugin } from "./create_time.js";
import { DeathPlugin } from "./death_plugin.js";
import { FireWeaponPlugin } from "./fire_weapon_plugin.js";
import { HealthPlugin } from "./health_plugin.js";
import { IonizedPlugin } from "./ionization_plugin.js";
import { JammingPlugin } from "./jamming_plugin.js";
import { JumpPlugin } from "./jump_plugin.js";
import { NCBPlugin } from "./ncb_plugin.js";
import { NpcPlugin } from "./npc_plugin.js";
import { OutfitPlugin } from "./outfit_plugin.js";
import { PlanetPlugin } from "./planet_plugin.js";
import { PlatformPlugin } from "./platform_plugin.js";
import { PlayerStatePlugin } from "./player_state_plugin.js";
import { ProjectilePlugin } from "./projectile_plugin.js";
import { ReturnToQueuePlugin } from "./return_to_queue_plugin.js";
import { ShipController } from "./ship_controller_plugin.js";
import { ShipPlugin } from "./ship_plugin.js";
import { SoundEventPlugin } from "./sound_plugin.js";
import { TargetPlugin } from "./target_plugin.js";
import { WeaponPlugin } from "./weapon_plugin.js";

// Users must add the multiplayer plugin and a display plugin.
// Users must also add the NovaData resource.
export const SystemPlugin: Plugin = {
    name: 'SystemPlugin',
    build(world) {
        world.addPlugin(TimePlugin);
        world.addPlugin(CreateTimePlugin);
        world.addPlugin(ReturnToQueuePlugin);
        world.addPlugin(PlatformPlugin);
        world.addPlugin(DeltaPlugin);
        world.addPlugin(ShipPlugin);
        world.addPlugin(AnimationPlugin);
        world.addPlugin(ControlsPlugin);
        world.addPlugin(ShipController);
        world.addPlugin(PlanetPlugin);
        world.addPlugin(MovementPlugin);
        world.addPlugin(DeathPlugin);
        world.addPlugin(FireWeaponPlugin);
        world.addPlugin(ProjectilePlugin);
        world.addPlugin(WeaponPlugin);
        world.addPlugin(OutfitPlugin);
        world.addPlugin(NCBPlugin);
        world.addPlugin(PlayerStatePlugin);
        world.addPlugin(JammingPlugin);
        world.addPlugin(CollisionsPlugin);
        world.addPlugin(HealthPlugin);
        world.addPlugin(CloakPlugin);
        world.addPlugin(TargetPlugin);
        world.addPlugin(SoundEventPlugin);
        world.addPlugin(BeamPlugin);
        world.addPlugin(BayPlugin);
        world.addPlugin(JumpPlugin);
        world.addPlugin(NpcPlugin);
        world.addPlugin(IonizedPlugin);
        world.addPlugin(AfterburnerPlugin);
        world.addPlugin(BlastPlugin);
        world.addPlugin(CargoPlugin);
        world.addPlugin(AsteroidPlugin);
    }
};
