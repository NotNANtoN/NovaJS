import 'jasmine';
import { Entity } from 'nova_ecs/entity';
import {
    AGGRESSION_DAMAGE_THRESHOLD, AGGRESSION_WINDOW_MS, AggressionComponent,
    AggressionState, applyAggression, isRecentAggressor, recordAggression,
    sweepAggression,
} from './aggression.js';
import { provokeGuidedLock } from './flock.js';
import { FormationComponent, NpcComponent } from './npc_ai_plugin.js';
import { ControlledByComponent } from './ship_control.js';

function emptyState(): AggressionState {
    return new Map();
}

const DELIBERATE = { damage: 0, deliberate: true };
const stray = (damage: number) => ({ damage, deliberate: false });

describe('aggression state', () => {
    it('reports nobody hostile with no record at all', () => {
        expect(isRecentAggressor(undefined, 'someone', 0)).toBeFalse();
        expect(isRecentAggressor(emptyState(), 'someone', 0)).toBeFalse();
    });

    it('a deliberate act makes the aggressor hostile at once', () => {
        const state = emptyState();
        recordAggression(state, 'shooter', 1000, DELIBERATE);
        expect(isRecentAggressor(state, 'shooter', 1000)).toBeTrue();
    });

    it('marks only the ship that did it', () => {
        const state = emptyState();
        recordAggression(state, 'shooter', 1000, DELIBERATE);
        expect(isRecentAggressor(state, 'bystander', 1000)).toBeFalse();
    });

    it('a brawl marks every aggressor independently', () => {
        const state = emptyState();
        recordAggression(state, 'a', 1000, DELIBERATE);
        recordAggression(state, 'b', 2000, DELIBERATE);
        expect(isRecentAggressor(state, 'a', 2000)).toBeTrue();
        expect(isRecentAggressor(state, 'b', 2000)).toBeTrue();
    });

    describe('the 30-second window', () => {
        it('stays hostile right up to the boundary', () => {
            const state = emptyState();
            recordAggression(state, 'shooter', 0, DELIBERATE);
            expect(isRecentAggressor(state, 'shooter',
                AGGRESSION_WINDOW_MS - 1)).toBeTrue();
        });

        it('goes neutral at EXACTLY the boundary', () => {
            const state = emptyState();
            recordAggression(state, 'shooter', 0, DELIBERATE);
            expect(isRecentAggressor(state, 'shooter', AGGRESSION_WINDOW_MS))
                .toBeFalse();
        });

        it('the sweep drops the entry at exactly the same instant the ' +
            'predicate goes neutral', () => {
                const state = emptyState();
                recordAggression(state, 'shooter', 0, DELIBERATE);
                expect(sweepAggression(state, AGGRESSION_WINDOW_MS - 1))
                    .toBeTrue();
                expect(state.has('shooter')).toBeTrue();
                expect(sweepAggression(state, AGGRESSION_WINDOW_MS))
                    .toBeFalse();
                expect(state.has('shooter')).toBeFalse();
            });

        it('a fresh act restarts the clock', () => {
            const state = emptyState();
            recordAggression(state, 'shooter', 0, DELIBERATE);
            recordAggression(state, 'shooter', 20_000, DELIBERATE);
            // 30s after the FIRST act, but only 10s after the second.
            expect(isRecentAggressor(state, 'shooter', AGGRESSION_WINDOW_MS))
                .toBeTrue();
            expect(isRecentAggressor(state, 'shooter',
                20_000 + AGGRESSION_WINDOW_MS)).toBeFalse();
        });

        it('sweeps one lapsed aggressor without touching a live one', () => {
            const state = emptyState();
            recordAggression(state, 'old', 0, DELIBERATE);
            recordAggression(state, 'new', 20_000, DELIBERATE);
            expect(sweepAggression(state, AGGRESSION_WINDOW_MS)).toBeTrue();
            expect(state.has('old')).toBeFalse();
            expect(state.has('new')).toBeTrue();
        });
    });

    describe('stray damage (trigger c)', () => {
        it('below the threshold is forgiven', () => {
            const state = emptyState();
            recordAggression(state, 'clumsy', 0,
                stray(AGGRESSION_DAMAGE_THRESHOLD - 1));
            expect(isRecentAggressor(state, 'clumsy', 0)).toBeFalse();
        });

        it('accumulates across hits and flips hostile at the threshold',
            () => {
                const state = emptyState();
                const half = AGGRESSION_DAMAGE_THRESHOLD / 2;
                recordAggression(state, 'sprayer', 0, stray(half));
                expect(isRecentAggressor(state, 'sprayer', 0)).toBeFalse();
                recordAggression(state, 'sprayer', 100, stray(half));
                expect(isRecentAggressor(state, 'sprayer', 100)).toBeTrue();
            });

        it('LAPSING RESETS THE ACCUMULATOR, so an ancient near-miss ' +
            'cannot be topped up years later', () => {
                const state = emptyState();
                recordAggression(state, 'clumsy', 0,
                    stray(AGGRESSION_DAMAGE_THRESHOLD - 1));
                sweepAggression(state, AGGRESSION_WINDOW_MS);
                // One more stray point: with the old total still around
                // this would flip hostile instantly. It must not.
                recordAggression(state, 'clumsy', AGGRESSION_WINDOW_MS,
                    stray(1));
                expect(isRecentAggressor(state, 'clumsy',
                    AGGRESSION_WINDOW_MS)).toBeFalse();
            });

        it('keeps an already-hostile ship hostile and refreshes its clock',
            () => {
                const state = emptyState();
                recordAggression(state, 'shooter', 0, DELIBERATE);
                recordAggression(state, 'shooter', 1000, stray(1));
                expect(isRecentAggressor(state, 'shooter',
                    1000 + AGGRESSION_WINDOW_MS - 1)).toBeTrue();
            });

        it('mutates the existing entry in place (the delta-safe ' +
            'accumulator pattern)', () => {
                const state = emptyState();
                recordAggression(state, 'sprayer', 0, stray(1));
                const entry = state.get('sprayer')!;
                recordAggression(state, 'sprayer', 100, stray(1));
                expect(state.get('sprayer')).toBe(entry);
                expect(entry.damage).toBe(2);
            });
    });

    describe('applyAggression (entity level)', () => {
        it('records against a player-controlled ship', () => {
            const victim = new Entity('victim')
                .addComponent(ControlledByComponent, { peerId: 'peer' });
            expect(applyAggression(victim, 'shooter', 0, DELIBERATE))
                .toBeTrue();
            expect(isRecentAggressor(
                victim.components.get(AggressionComponent), 'shooter', 0))
                .toBeTrue();
        });

        it('ignores ships nobody is flying (NPCs keep npc.aggressor)', () => {
            const npc = new Entity('npc')
                .addComponent(NpcComponent, { aiType: 1 });
            expect(applyAggression(npc, 'shooter', 0, DELIBERATE)).toBeFalse();
            expect(npc.components.has(AggressionComponent)).toBeFalse();
        });

        it('ignores self-harm', () => {
            const victim = new Entity('victim')
                .addComponent(ControlledByComponent, { peerId: 'peer' });
            (victim as { uuid: string }).uuid = 'victim uuid';
            expect(applyAggression(victim, 'victim uuid', 0, DELIBERATE))
                .toBeFalse();
        });
    });
});

describe('guided-missile lock (trigger a)', () => {
    const lookup = (entities: { [uuid: string]: Entity }) =>
        (uuid: string) => entities[uuid];

    it("makes the shooter hostile to the missile's player target", () => {
        const player = new Entity('player')
            .addComponent(ControlledByComponent, { peerId: 'peer' });
        const shooter = new Entity('shooter');
        provokeGuidedLock('player', 'shooter', 'shooter',
            lookup({ player, shooter }), 5000);
        expect(isRecentAggressor(
            player.components.get(AggressionComponent), 'shooter', 5000))
            .toBeTrue();
    });

    it('needs no damage at all — the lock IS the provocation', () => {
        const player = new Entity('player')
            .addComponent(ControlledByComponent, { peerId: 'peer' });
        const shooter = new Entity('shooter');
        provokeGuidedLock('player', 'shooter', 'shooter',
            lookup({ player, shooter }), 0);
        const entry = player.components.get(AggressionComponent)!
            .get('shooter')!;
        expect(entry.damage).toBe(0);
        expect(entry.hostile).toBeTrue();
    });

    it("spares the shooter's own flock", () => {
        // A stray lock on your own wing is not a betrayal — even when
        // that wingman is another player flying escort for you.
        const wingman = new Entity('wingman')
            .addComponent(ControlledByComponent, { peerId: 'other peer' })
            .addComponent(FormationComponent, { leader: 'shooter', slot: 0 });
        const shooter = new Entity('shooter');
        provokeGuidedLock('wingman', 'shooter', 'shooter',
            lookup({ wingman, shooter }), 0);
        expect(wingman.components.has(AggressionComponent)).toBeFalse();
    });

    it('still provokes the NPC channel for NPC victims', () => {
        const trader = new Entity('trader')
            .addComponent(NpcComponent, { aiType: 2, nextDecision: 99999 });
        const shooter = new Entity('shooter');
        provokeGuidedLock('trader', 'shooter', 'shooter',
            lookup({ trader, shooter }), 0);
        expect(trader.components.get(NpcComponent)!.aggressor).toBe('shooter');
    });
});
