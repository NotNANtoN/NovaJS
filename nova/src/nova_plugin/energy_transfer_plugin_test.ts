import 'jasmine';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';
import {
    MovementStateComponent,
} from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { World } from 'nova_ecs/world';
import {
    EnergyTransferPlugin,
    EnergyTransferRequestComponent,
    ServerEnergyTransferSystem,
    PlayerEnergyTransferInputSystem,
} from './energy_transfer_plugin';
import {
    createInitialPlayerState,
    PlayerStateComponent,
} from './player_state';
import { PlatformResource } from './platform_plugin';
import { ShipDataComponent } from './ship_plugin';
import { TargetComponent } from './target_component';
import { ControlStateEvent } from './control_state_event';
import { BoardingNoticeComponent } from './boarding_plugin';

function movementAt(x: number, y: number) {
    return {
        accelerating: 0,
        position: new Position(x, y),
        rotation: new Angle(0),
        turnBack: false,
        turning: 0,
        velocity: new Vector(0, 0),
    };
}

describe('Energy transfer plugin', () => {
    let world: World;
    let source: Entity;
    let target: Entity;

    beforeEach(async () => {
        world = new World('energy-transfer-test');
        world.resources.set(TimeResource, {
            time: 0,
            delta_ms: 1_000 / 60,
            delta_s: 1 / 60,
            frame: 0,
        });
        world.resources.set(PlatformResource, 'node');
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(EnergyTransferPlugin);

        const sourceState = createInitialPlayerState();
        sourceState.fuel = 300;
        sourceState.pilotName = 'Alice';

        const targetState = createInitialPlayerState();
        targetState.fuel = 50;
        targetState.pilotName = 'Bob';

        source = new Entity('source')
            .addComponent(MovementStateComponent, movementAt(0, 0))
            .addComponent(PlayerStateComponent, sourceState)
            .addComponent(ShipDataComponent, { ...getDefaultShipData(), fuelCapacity: 500 })
            .addComponent(MultiplayerData, { owner: 'client-1' })
            .addComponent(TargetComponent, { target: 'target' });

        target = new Entity('target')
            .addComponent(MovementStateComponent, movementAt(100, 0))
            .addComponent(PlayerStateComponent, targetState)
            .addComponent(ShipDataComponent, { ...getDefaultShipData(), fuelCapacity: 500 })
            .addComponent(MultiplayerData, { owner: 'client-2' });

        world.entities.set('source', source);
        world.entities.set('target', target);
    });

    it('transfers energy between nearby player ships on the server', () => {
        source.components.set(EnergyTransferRequestComponent, {
            target: 'target',
            sequence: 1,
        });

        world.step();

        expect(source.components.get(PlayerStateComponent)?.fuel).toBe(200);
        expect(target.components.get(PlayerStateComponent)?.fuel).toBe(150);
        expect(source.components.get(BoardingNoticeComponent)?.text)
            .toContain('Transferred 100 energy to Bob');
        expect(target.components.get(BoardingNoticeComponent)?.text)
            .toContain('Received 100 energy from Alice');
    });

    it('rejects transfer if target is too far away', () => {
        target.components.get(MovementStateComponent)!.position = new Position(5_000, 0);
        source.components.set(EnergyTransferRequestComponent, {
            target: 'target',
            sequence: 1,
        });

        world.step();

        expect(source.components.get(PlayerStateComponent)?.fuel).toBe(300);
        expect(target.components.get(PlayerStateComponent)?.fuel).toBe(50);
    });
});
