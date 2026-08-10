import { Emit, GetEntity, UUID } from 'nova_ecs/arg_types';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { MovementStateComponent, MovementSystem } from 'nova_ecs/plugins/movement_plugin';
import { RandomResource } from 'nova_ecs/plugins/random_plugin';
import { SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { TimeResource, TimeSystem } from 'nova_ecs/plugins/time_plugin';
import { System } from 'nova_ecs/system';
import { EffectiveMovementPhysicsSystem } from './afterburner_plugin.js';
import { ReturnAI } from './bay_plugin.js';
import { CloakActiveComponent, CLOAK_OFF_SOUND } from './cloak_plugin.js';
import { ZeroArmorEvent } from './death_plugin.js';
import { EscortCommandBehaviorSystem } from './escort_command_plugin.js';
import { EscortLandingSystem } from './player_escort_plugin.js';
import { FollowAI } from './npc_plugin.js';
import { deriveRepair, DisabledComponent, DisabledState, DISABLED_DECELERATION, isBelowDisableThreshold, repairedArmor, RepairComponent, rollRepairTime } from './disabled_component.js';
import { registerEntityDeriver } from './entity_factory.js';
import { SimulationGameDataResource } from './game_data_resource.js';
import { ArmorComponent, ShieldComponent } from './health_plugin.js';
import { FormationSystem, NpcSteeringSystem } from './npc_ai_plugin.js';
import { OutfitsStateComponent } from './outfit_plugin.js';
import { ProvideFromCache } from './provide_from_cache.js';
import { ControlledByComponent, ShipControlEvent, ShipControlStateComponent } from './ship_control.js';
import { ControlShipSystem } from './ship_controller_plugin.js';
import { ShipDataComponent } from './ship_plugin.js';
import { JumpSequenceSystem } from './jump_plugin.js';
import { PlayerSoundEvent } from './sound_plugin.js';

/**
 * Ship disabling — see disabled_component.ts for the overview, the
 * component, the tuning constants, and the pure transition helpers. This
 * module owns the systems:
 *
 *  - RepairProvider/RepairDeriver: the ModType 49 repair-system
 *    capability, derived from outfits like CloakComponent.
 *  - ShipDisableSystem: the enter/leave transitions (threshold entry,
 *    forced decloak, repair-time roll; self-repair and outside-repair
 *    exit).
 *  - DisabledMovementSystem: erases all steering/thrust the control, AI,
 *    formation, jump, and afterburner systems wrote this tick and slows
 *    the hulk to rest.
 *  - SelfDestructSystem: the player's escape hatch — destroys the ship
 *    through the normal zero-armor death path whether or not disabled.
 *
 * What is deliberately NOT gated here: escort commands (a disabled ship
 * can still direct its escorts, per the Bible) and target cycling.
 * The other suspended capabilities live with their owners: weapon fire
 * (weapon_plugin), cloak toggling (cloak_plugin), shield/armor/fuel
 * recharge (health_plugin), hyperspace jump initiation (jump_plugin),
 * NPC target validity (npc_ai_plugin), running lights and target corners
 * (display).
 */

const RepairProvider = ProvideFromCache({
    name: 'RepairProvider',
    provided: RepairComponent,
    update: [OutfitsStateComponent],
    args: [OutfitsStateComponent, SimulationGameDataResource] as const,
    factory: deriveRepair,
});

/**
 * Enter/leave transitions for the disabled state.
 *
 * Entry (armor at or below the ship's disable threshold): attaches
 * DisabledComponent with the rolled self-repair time and force-decloaks
 * through the same state+sound transition the existing decloak paths use
 * (CloakDrainSystem / CloakDecloakOnHitSystem), exactly once.
 *
 * Exit: self-repair at the rolled time (armor restored to slightly above
 * the threshold — repairedArmor), or any outside cause that lifts armor
 * back above the threshold. Removing the component resumes every gated
 * system at once. A player death/respawn (armor restored to max) exits
 * the same way.
 */
export const ShipDisableSystem = new System({
    name: 'ShipDisableSystem',
    args: [ArmorComponent, ShipDataComponent, RepairComponent, TimeResource,
        RandomResource, Optional(ControlledByComponent),
        Optional(CloakActiveComponent), GetEntity, UUID, Emit] as const,
    step(armor, shipData, repair, time, random, controlledBy, cloakActive,
        entity, uuid, emit) {
        const disabled = entity.components.get(DisabledComponent);
        const fraction = shipData.disableArmorFraction;

        if (!disabled) {
            if (!isBelowDisableThreshold(armor, fraction)) {
                return;
            }
            entity.components.set(DisabledComponent, {
                repairAt: rollRepairTime(time.time, repair.hasRepairSystem,
                    controlledBy !== undefined, () => random.next()),
            });
            // Disabling drops the cloak through the existing decloak
            // transition (state flip + one cloak-off sound).
            if (cloakActive?.active) {
                cloakActive.active = false;
                emit(PlayerSoundEvent, { id: CLOAK_OFF_SOUND }, [uuid]);
            }
            return;
        }

        // Outside repair (boarding, death-respawn refill, plug effects):
        // armor back above the threshold re-enables the ship.
        if (!isBelowDisableThreshold(armor, fraction)) {
            entity.components.delete(DisabledComponent);
            return;
        }

        // Self-repair (ModType 49 outfit, or the player's inherent
        // repair droid): at the rolled time, restore armor to slightly
        // above the threshold and bring all systems back online.
        if (disabled.repairAt !== null && time.time >= disabled.repairAt) {
            armor.current = repairedArmor(armor.max, fraction);
            entity.components.delete(DisabledComponent);
        }
    },
    after: [TimeSystem],
});

/**
 * A disabled ship is dead in space: no thrust, no turning. Runs after
 * every system that writes movement intent (player controls, NPC
 * steering, formation keeping, the jump sequence, the afterburner) and
 * erases whatever they wrote, then brakes the hulk toward rest at
 * DISABLED_DECELERATION ("slow to rest" — a disabled ship gradually
 * decelerates to zero velocity relative to the system).
 */
export const DisabledMovementSystem = new System({
    name: 'DisabledMovementSystem',
    args: [DisabledComponent, MovementStateComponent, TimeResource] as const,
    step(_disabled, movement, time) {
        movement.accelerating = 0;
        movement.turning = 0;
        movement.turnBack = false;
        movement.turnTo = null;

        const speed = movement.velocity.length;
        if (speed > 0) {
            const next = Math.max(0,
                speed - DISABLED_DECELERATION * time.delta_s);
            // Replace (never mutate in place) the velocity vector.
            movement.velocity = next <= 0
                ? new Vector(0, 0)
                : movement.velocity.scale(next / speed);
        }
    },
    after: [TimeSystem, ShipDisableSystem, ControlShipSystem,
        JumpSequenceSystem, EffectiveMovementPhysicsSystem,
        NpcSteeringSystem, FormationSystem, EscortCommandBehaviorSystem,
        EscortLandingSystem, ReturnAI, FollowAI],
    before: [MovementSystem],
});

/**
 * The self-destruct keybind (Alt+Shift+Minus): destroys the pilot's own
 * ship through the normal zero-armor death path (ZeroArmorEvent ->
 * exploding -> DeathEvent -> respawn for players). Works whether or not
 * the ship is disabled — it exists as the escape hatch for a disabled
 * ship with no repair coming. Deliberately not gated on
 * DisabledComponent.
 */
export const SelfDestructSystem = new System({
    name: 'SelfDestructSystem',
    events: [ShipControlEvent],
    args: [ShipControlStateComponent, ArmorComponent,
        Optional(ShieldComponent), TimeResource, UUID, Emit] as const,
    step(controlState, armor, shield, time, uuid, emit) {
        if (controlState.get('selfDestruct') !== 'start') {
            return;
        }
        if (shield) {
            shield.current = shield.min;
        }
        armor.current = 0;
        // The same event DamageSystem emits when damage zeroes armor.
        emit(ZeroArmorEvent, time, [uuid]);
    },
});

export const DisabledPlugin: Plugin = {
    name: 'DisabledPlugin',
    build(world) {
        world.addComponent(DisabledComponent);
        world.addComponent(RepairComponent);

        // Real simulation state: rollback snapshots and wire baselines
        // carry it through the default codec path (like NpcComponent).
        world.resources.get(SerializerResource)
            ?.addComponent(DisabledComponent, DisabledState);

        // The repair capability is derived from owned outfits and
        // re-derived wherever a full entity is built (staged insertion,
        // snapshot restore) — the CloakComponent model. It is skipped
        // from snapshots (snapshot_policies.ts).
        registerEntityDeriver(world, {
            name: 'RepairDeriver',
            provided: RepairComponent,
            requires: [OutfitsStateComponent],
            derive: (entity, gameData) => deriveRepair(
                entity.components.get(OutfitsStateComponent)!, gameData),
        });

        world.addSystem(RepairProvider);
        world.addSystem(ShipDisableSystem);
        world.addSystem(DisabledMovementSystem);
        world.addSystem(SelfDestructSystem);
    },
};
