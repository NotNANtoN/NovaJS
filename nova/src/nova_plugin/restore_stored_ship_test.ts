import 'jasmine';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { MockGameData } from 'novadatainterface/MockGameData';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import {
    MockCommunicator,
} from 'nova_ecs/plugins/mock_communicator';
import {
    multiplayer,
    MultiplayerData,
} from 'nova_ecs/plugins/multiplayer_plugin';
import {
    EncodedEntity,
    Serializer,
    SerializerResource,
} from 'nova_ecs/plugins/serializer_plugin';
import { JumpStateComponent } from './jump_plugin';
import { makeShip } from './make_ship';
import { makeSystem } from './make_system';
import { OutfitsStateComponent } from './outfit_plugin';
import {
    createInitialPlayerState,
    PlayerStateComponent,
} from './player_state';
import {
    placeShipAtLanding,
    restoreStoredShip,
} from './restore_stored_ship';

describe('stored ship restoration', () => {
    let serializer: Serializer;
    const shipData = {
        ...getDefaultShipData(),
        id: 'nova:128',
        name: 'Shuttle',
    };

    beforeEach(async () => {
        const world = makeSystem('nova:130', new MockGameData());
        await world.addPlugin(multiplayer(new MockCommunicator('client')));
        serializer = world.resources.get(SerializerResource)!;
    });

    it('round trips ship, cargo, outfits, missions, date and position', () => {
        const state = createInitialPlayerState();
        state.gameDate = 47;
        state.holds = [{
            commodity: 'Food',
            tons: 3,
            isMissionCargo: false,
        }];
        state.activeMissions = [{
            missionId: 'nova:700',
            state: 'active',
            destination: 'nova:131',
        }];
        state.lastLandedPosition = [700, -250];
        const original = makeShip(shipData)
            .addComponent(OutfitsStateComponent, new Map([
                ['nova:151', { count: 2 }],
                ['nova:162', { count: 1 }],
            ]))
            .addComponent(PlayerStateComponent, state);
        original.components.set(MovementStateComponent, {
            accelerating: 1,
            position: new Position(12, 34),
            rotation: new Angle(0.75),
            turnBack: true,
            turning: -1,
            velocity: new Vector(5, -3),
        });

        const encoded = JSON.parse(JSON.stringify(
            serializer.encode(original))) as EncodedEntity;
        const result = restoreStoredShip(
            serializer, encoded, makeShip(shipData), shipData.id);
        placeShipAtLanding(result.entity, state.lastLandedPosition);

        expect(result.restored).toBeTrue();
        expect(result.entity.components.get(OutfitsStateComponent))
            .toEqual(new Map([
                ['nova:151', { count: 2 }],
                ['nova:162', { count: 1 }],
            ]));
        const restoredState = result.entity.components.get(
            PlayerStateComponent)!;
        expect(restoredState.holds).toEqual(state.holds);
        expect(restoredState.activeMissions).toEqual(state.activeMissions);
        expect(restoredState.gameDate).toBe(47);
        const movement = result.entity.components.get(
            MovementStateComponent)!;
        expect(movement.position).toEqual(new Position(700, -250));
        expect(movement.velocity).toEqual(new Vector(5, -3));
        expect(movement.rotation).toEqual(new Angle(0.75));
        expect(movement.accelerating).toBe(1);
        expect(movement.turnBack).toBeTrue();
        expect(movement.turning).toBe(-1);
    });

    it('skips one undecodable component and restores the others', () => {
        const original = makeShip(shipData)
            .addComponent(OutfitsStateComponent, new Map([
                ['nova:151', { count: 2 }],
            ]));
        const encoded = serializer.encode(original);
        const outfits = encoded.components.find(
            ([name]) => name === OutfitsStateComponent.name)!;
        outfits[1] = [['nova:151', { count: 'invalid' }]];

        const result = restoreStoredShip(
            serializer, encoded, makeShip(shipData), shipData.id);

        expect(result.restored).toBeTrue();
        expect(result.skippedComponents).toEqual([
            OutfitsStateComponent.name,
        ]);
        expect(result.entity.components.has(OutfitsStateComponent)).toBeFalse();
        expect(result.entity.components.has(MovementStateComponent)).toBeTrue();
    });

    it('does not reapply excluded session components', () => {
        const original = makeShip(shipData)
            .addComponent(MultiplayerData, { owner: 'old-session' })
            .addComponent(JumpStateComponent, {
                from: 'nova:130',
                to: 'nova:131',
                phase: 'departing',
                phaseStartedAt: 1,
                transitionAt: 2,
                requiresAdjacency: true,
                arrivalSoundPending: false,
            });

        const result = restoreStoredShip(
            serializer,
            serializer.encode(original),
            makeShip(shipData),
            shipData.id,
        );

        expect(result.restored).toBeTrue();
        expect(result.entity.components.has(MultiplayerData)).toBeFalse();
        expect(result.entity.components.has(JumpStateComponent)).toBeFalse();
    });

    it('uses the fresh ship when no stored ship exists', () => {
        const fallback = makeShip(shipData);

        const result = restoreStoredShip(
            serializer, undefined, fallback, shipData.id);

        expect(result.restored).toBeFalse();
        expect(result.entity).toBe(fallback);
        expect(result.fallbackReason).toBeUndefined();
    });

    it('uses the fresh ship when the stored hull does not match', () => {
        const fallback = makeShip(shipData);
        const wrongHull = makeShip({ ...shipData, id: 'nova:999' });

        const result = restoreStoredShip(
            serializer, serializer.encode(wrongHull), fallback, shipData.id);

        expect(result.restored).toBeFalse();
        expect(result.entity).toBe(fallback);
        expect(result.fallbackReason).toBe('invalid-hull');
    });
});
