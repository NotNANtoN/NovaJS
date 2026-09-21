import 'jasmine';
import { assertArchetype } from './archetype';
import { Component } from './component';
import { Entity } from './entity';

describe('assertArchetype', () => {
    const PositionComponent = new Component<{ x: number; y: number }>('PositionComponent');
    const VelocityComponent = new Component<{ vx: number; vy: number }>('VelocityComponent');
    const HealthComponent = new Component<{ hp: number }>('HealthComponent');

    it('passes when all required components exist on the entity', () => {
        const entity = new Entity('ship')
            .addComponent(PositionComponent, { x: 0, y: 0 })
            .addComponent(VelocityComponent, { vx: 1, vy: 0 });

        expect(() => {
            assertArchetype(entity, [PositionComponent, VelocityComponent], 'ShipArchetype');
        }).not.toThrow();
    });

    it('throws a descriptive archetype violation error when a component is missing', () => {
        const entity = new Entity('ship')
            .addComponent(PositionComponent, { x: 0, y: 0 });

        expect(() => {
            assertArchetype(entity, [PositionComponent, VelocityComponent, HealthComponent], 'ShipArchetype');
        }).toThrowError(/\[ARCHETYPE VIOLATION\] ShipArchetype 'ship' is missing required components: \[VelocityComponent, HealthComponent\]/);
    });
});
