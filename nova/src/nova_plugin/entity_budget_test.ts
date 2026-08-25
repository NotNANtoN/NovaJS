import {
    CLASSIC_ENTITY_LIMITS,
    PLAYER_PROJECTILE_RESERVE,
    createEntityBudget,
    reserveEntity,
} from './entity_budget';

describe('entity budgets', () => {
    it('enforces classic limits for ordinary and critical ships', () => {
        const budget = createEntityBudget('classic');
        const entities = Array.from(
            { length: CLASSIC_ENTITY_LIMITS.ship },
            () => ({ components: { set: () => undefined } }),
        );

        for (const entity of entities) {
            expect(reserveEntity(budget, entity, 'ship')).toBe(true);
        }
        expect(reserveEntity(budget, entities[0], 'ship')).toBe(false);
        expect(reserveEntity(budget, entities[0], 'ship', true)).toBe(false);
        expect(budget.active('ship')).toBe(CLASSIC_ENTITY_LIMITS.ship);
    });

    it('keeps projectile headroom for player-owned fire', () => {
        const budget = createEntityBudget('classic');
        const ordinaryProjectiles = Array.from(
            { length: CLASSIC_ENTITY_LIMITS.projectile - PLAYER_PROJECTILE_RESERVE },
            () => ({ components: { set: () => undefined } }),
        );

        for (const projectile of ordinaryProjectiles) {
            expect(reserveEntity(budget, projectile, 'projectile')).toBe(true);
        }
        expect(reserveEntity(budget, ordinaryProjectiles[0], 'projectile'))
            .toBe(false);
        expect(reserveEntity(
            budget, ordinaryProjectiles[0], 'projectile', true,
        )).toBe(true);
    });

    it('keeps modern cosmetic effects bounded without capping ships', () => {
        const budget = createEntityBudget('modern');
        const entity = { components: { set: () => undefined } };

        for (let i = 0; i < 64; i++) {
            expect(reserveEntity(budget, entity, 'explosion')).toBe(true);
        }
        expect(reserveEntity(budget, entity, 'explosion')).toBe(false);
        expect(reserveEntity(budget, entity, 'ship')).toBe(true);
    });
});
