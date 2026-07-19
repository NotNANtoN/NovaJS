import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { MovementPhysicsComponent, MovementStateComponent, MovementSystem } from 'nova_ecs/plugins/movement_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { System } from 'nova_ecs/system';
import { FuelComponent } from './health_plugin.js';
import { ION_FACTOR, IsIonizedComponent } from './ionization_plugin.js';
import { JumpComponent, JumpSequenceSystem, JUMP_BASE_SPEED, JUMP_DEPART_DELAY_MS } from './jump_plugin.js';
import { ShipControlStateComponent } from './ship_control.js';
import { ControlShipSystem } from './ship_controller_plugin.js';
import { getShipMovementPhysics, ShipPhysicsComponent } from './ship_plugin.js';

/**
 * How much an engaged afterburner multiplies a ship's top speed and
 * acceleration. The EVN Bible documents only the afterburner's fuel
 * burn (oütf ModType 15, units of fuel per second); the boost itself is
 * undocumented, so this matches the Nova engine's observed
 * roughly-double boost.
 */
export const AFTERBURNER_FACTOR = 2;

/**
 * The single per-tick writer of a ship's effective movement physics:
 * recomputes it from ShipPhysicsComponent and applies the transient
 * modifiers (ionization slowness, afterburner boost, hyperspace jump
 * burn). Modifiers that hold while a condition lasts belong here, so
 * they compose instead of clobbering each other's writes.
 *
 * While the afterburner control is held (and the ship has an
 * afterburner outfit), the ship thrusts forward, burning
 * ShipPhysics.afterburner units of fuel per second; it cuts out when
 * the fuel runs dry. The afterburner is unavailable during a jump
 * sequence — control of the ship is taken away.
 *
 * During the jump's departure burn the speed cap and acceleration are
 * replaced outright (not multiplied) so the ship reaches its full jump
 * speed exactly at departure. Ionization still slows turning, but the
 * hyperdrive burn itself is not ion-slowed.
 */
export const EffectiveMovementPhysicsSystem = new System({
    name: 'EffectiveMovementPhysics',
    args: [ShipPhysicsComponent, MovementPhysicsComponent,
        MovementStateComponent, TimeResource,
        Optional(ShipControlStateComponent), Optional(FuelComponent),
        Optional(IsIonizedComponent), Optional(JumpComponent)] as const,
    step(shipPhysics, movementPhysics, movementState, time,
        controlState, fuel, isIonized, jump) {
        let afterburning = false;
        if (!jump && controlState?.get('afterburner')
            && shipPhysics.afterburner > 0
            && fuel && fuel.current > 0) {
            afterburning = true;
            fuel.current = Math.max(fuel.min,
                fuel.current - shipPhysics.afterburner * time.delta_s);
            // The afterburner thrusts the ship forward while engaged.
            movementState.accelerating = 1;
        }

        const base = getShipMovementPhysics(shipPhysics);
        const slowness = isIonized ? ION_FACTOR : 1;
        const boost = afterburning ? AFTERBURNER_FACTOR : 1;
        movementPhysics.maxVelocity = base.maxVelocity * slowness * boost;
        movementPhysics.acceleration = base.acceleration * slowness * boost;
        movementPhysics.turnRate = base.turnRate * slowness;
        movementPhysics.movementType = base.movementType;

        // Hyperspace physics. JumpSequenceSystem (which runs first this
        // tick) owns the stage machine; this system owns the physics it
        // implies. Only the departure burn boosts physics: arriving
        // ships jump in already at their regular top speed.
        if (jump?.stage === 'accelerating') {
            const jumpSpeed = JUMP_BASE_SPEED * shipPhysics.jumpSpeedMult;
            movementPhysics.maxVelocity = jumpSpeed;
            movementPhysics.acceleration =
                jumpSpeed / (JUMP_DEPART_DELAY_MS / 1000);
        }
    },
    // Overrides the acceleration ControlShipSystem chose (and the jump
    // sequence's stage transitions must land first), and must take
    // effect before the ship moves.
    after: [ControlShipSystem, JumpSequenceSystem],
    before: [MovementSystem],
});

export const AfterburnerPlugin: Plugin = {
    name: 'AfterburnerPlugin',
    build(world) {
        world.addSystem(EffectiveMovementPhysicsSystem);
    },
    remove(world) {
        world.removeSystem(EffectiveMovementPhysicsSystem);
    },
}
