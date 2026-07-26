import 'jasmine';
import { Entity } from 'nova_ecs/entity';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { MovementState, MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { PlanetComponent } from './nova_plugin/planet_plugin.js';
import { ShipComponent } from './nova_plugin/ship_plugin.js';
import { pickNearest } from './tap_targeting.js';

function makeMovement(x: number, y: number): MovementState {
    return {
        position: new Position(x, y),
        velocity: new Vector(0, 0),
        rotation: new Angle(0),
        turning: 0,
        turnBack: false,
        accelerating: 0,
        turnTo: null,
    };
}

function planetAt(x: number, y: number): Entity {
    return new Entity()
        .addComponent(MovementStateComponent, makeMovement(x, y))
        .addComponent(PlanetComponent, { id: 'test:planet' });
}

function shipAt(x: number, y: number): Entity {
    return new Entity()
        .addComponent(MovementStateComponent, makeMovement(x, y))
        .addComponent(ShipComponent, { id: 'test:ship' });
}

describe('pickNearest', () => {
    it('selects a planet within the pick radius', () => {
        const entities: [string, Entity][] = [['planet', planetAt(100, 100)]];
        const { bestPlanet } = pickNearest(entities, undefined, 130, 100);
        expect(bestPlanet?.uuid).toEqual('planet');
    });

    it('hit-tests against the toroidal-nearest copy across the seam', () => {
        // The planet sits at the -x edge; the tap lands just short of the +x
        // edge. Literal distance is nearly a whole world, but across the seam
        // they are 50 units apart — the tap must still select it.
        const entities: [string, Entity][] = [['worm', planetAt(-10000, 0)]];
        const { bestPlanet } = pickNearest(entities, undefined, 9950, 0);
        expect(bestPlanet?.uuid).toEqual('worm');
    });

    it('wraps ship hit-testing the same way', () => {
        const entities: [string, Entity][] = [['ship', shipAt(0, -10000)]];
        const { bestShip } = pickNearest(entities, undefined, 0, 9980);
        expect(bestShip?.uuid).toEqual('ship');
    });

    it('still misses objects genuinely out of range', () => {
        const entities: [string, Entity][] = [['planet', planetAt(-10000, 0)]];
        const { bestPlanet } = pickNearest(entities, undefined, 9000, 0);
        expect(bestPlanet).toBeUndefined();
    });
});
