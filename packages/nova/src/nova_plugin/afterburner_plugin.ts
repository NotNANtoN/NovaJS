import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { MovementPhysicsComponent, MovementStateComponent, MovementSystem } from 'nova_ecs/plugins/movement_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { System } from 'nova_ecs/system';
import { FuelComponent } from './health_plugin.js';
import { ION_FACTOR, IsIonizedComponent } from './ionization_plugin.js';
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
 * modifiers (ionization slowness, afterburner boost) multiplicatively.
 * Modifiers that hold while a condition lasts belong here, so they
 * compose instead of clobbering each other's writes.
 *
 * While the afterburner control is held (and the ship has an
 * afterburner outfit), the ship thrusts forward, burning
 * ShipPhysics.afterburner units of fuel per second; it cuts out when
 * the fuel runs dry.
 */
const EffectiveMovementPhysicsSystem = new System({
    name: 'EffectiveMovementPhysics',
    args: [ShipPhysicsComponent, MovementPhysicsComponent,
        MovementStateComponent, TimeResource,
        Optional(ShipControlStateComponent), Optional(FuelComponent),
        Optional(IsIonizedComponent)] as const,
    step(shipPhysics, movementPhysics, movementState, time,
        controlState, fuel, isIonized) {
        let afterburning = false;
        if (controlState?.get('afterburner') && shipPhysics.afterburner > 0
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
    },
    // Overrides the acceleration ControlShipSystem chose, and must take
    // effect before the ship moves.
    after: [ControlShipSystem],
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
