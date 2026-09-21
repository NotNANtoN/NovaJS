import 'jasmine';
import { Entity } from 'nova_ecs/entity';
import {
    ShipArchetypeComponents,
    EscortArchetypeComponents,
    isArchetype,
    assertShipArchetype,
    assertEscortArchetype,
} from './archetypes';
import { ShipComponent } from './ship_plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { TargetComponent } from './target_component';
import { HiredEscortComponent } from './escort_plugin';

describe('Archetypes', () => {
    it('verifies ship archetype correctly', () => {
        const entity = new Entity('test-ship')
            .addComponent(ShipComponent, { id: 'nova:128' })
            .addComponent(MovementStateComponent, {
                position: { x: 0, y: 0 },
                velocity: { x: 0, y: 0 },
                rotation: { angle: 0 },
                turnVelocity: 0,
            } as any)
            .addComponent(TargetComponent, { target: undefined });

        expect(isArchetype(entity, ShipArchetypeComponents)).toBeTrue();
        expect(() => assertShipArchetype(entity)).not.toThrow();
    });

    it('throws archetype violation when missing target component', () => {
        const incompleteEntity = new Entity('incomplete-ship')
            .addComponent(ShipComponent, { id: 'nova:128' });

        expect(isArchetype(incompleteEntity, ShipArchetypeComponents)).toBeFalse();
        expect(() => assertShipArchetype(incompleteEntity)).toThrowError(/missing required components: \[MovementState, TargetComponent\]/);
    });

    it('verifies escort archetype contracts', () => {
        const escort = new Entity('escort')
            .addComponent(ShipComponent, { id: 'nova:128' })
            .addComponent(MovementStateComponent, {
                position: { x: 0, y: 0 },
                velocity: { x: 0, y: 0 },
                rotation: { angle: 0 },
                turnVelocity: 0,
            } as any)
            .addComponent(TargetComponent, { target: undefined })
            .addComponent(HiredEscortComponent, {
                ownerUuid: 'player',
                contractId: 'contract-1',
                slot: 0,
            });

        expect(isArchetype(escort, EscortArchetypeComponents)).toBeTrue();
        expect(() => assertEscortArchetype(escort)).not.toThrow();
    });
});
