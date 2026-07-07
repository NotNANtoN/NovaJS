import { Emit } from 'nova_ecs/arg_types';
import { Plugin } from 'nova_ecs/plugin';
import { KeyboardPlugin } from 'nova_ecs/plugins/keyboard_plugin';
import { MovementPhysicsComponent, MovementStateComponent, MovementSystem, MovementType } from 'nova_ecs/plugins/movement_plugin';
import { passthroughType, SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { SingletonComponent } from 'nova_ecs/world';
import { EcsControlEvent } from './controls_plugin.js';
import { ControlledByComponent, ControlledByType, SetControlledShipSystem, ShipControlStateComponent } from './ship_control.js';
import { PlatformResource } from './platform_plugin.js';
import { PlayerShipPlugin, PlayerShipSelector } from './player_ship_plugin.js';
import { TargetComponent } from './target_component.js';


// Applies a ship's held-control state to its movement. Runs for every
// controlled ship, local or remote: per-peer input application updates
// each ship's ShipControlStateComponent from that peer's input records.
const ControlShipSystem = new System({
    name: 'ControlPlayerShip',
    args: [ShipControlStateComponent, MovementStateComponent,
        MovementPhysicsComponent, TargetComponent] as const,
    step(controlState, movementState, movementPhysics, { target }) {
        movementState.accelerating = controlState.get('accelerate') ? 1 : 0;
        movementState.turning =
            (controlState.get('turnLeft') ? -1 : 0) +
            (controlState.get('turnRight') ? 1 : 0);

        movementState.turnTo = null;
        if (controlState.get('pointTo') && target) {
            movementState.turnTo = target;
        }

        if (movementPhysics.movementType === MovementType.INERTIAL) {
            movementState.turnBack = Boolean(controlState.get('reverse'));
        } else if (movementPhysics.movementType === MovementType.INERTIALESS) {
            movementState.turnBack = false;
            if (controlState.get('reverse')) {
                movementState.accelerating += -1;
            }
        }
    },
    before: [MovementSystem]
});

export const ShipController: Plugin = {
    name: 'ShipController',
    async build(world) {
        // Every simulation runs the same control systems regardless of
        // platform: a server world stepping a ship must apply control
        // state exactly like a client's worker does, or the
        // simulations diverge. Only keyboard capture is browser-only.
        const platform = world.resources.get(PlatformResource);
        if (platform === 'browser') {
            await world.addPlugin(KeyboardPlugin);
        }
        await world.addPlugin(PlayerShipPlugin);
        world.resources.get(SerializerResource)?.addComponent(
            ControlledByComponent, ControlledByType);
        world.addSystem(ControlShipSystem);
        world.addSystem(SetControlledShipSystem);
    }
};
