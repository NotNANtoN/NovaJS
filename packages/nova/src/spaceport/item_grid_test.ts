import 'jasmine';
import * as PIXI from 'pixi.js';
import { ItemGrid, raiseToTop } from './item_grid.js';

/**
 * The item grid's selection highlight has to paint above the other tiles.
 * ItemTile itself can't be built headlessly (PIXI.Text needs a DOM), but
 * the z-ordering rule is pure container bookkeeping, so it is pinned here
 * against real PIXI containers.
 */
describe('raiseToTop', () => {
    function containerWith(childCount: number) {
        const container = new PIXI.Container();
        const children = Array.from({ length: childCount },
            () => new PIXI.Container());
        for (const child of children) {
            container.addChild(child);
        }
        return { container, children };
    }

    const last = (container: PIXI.Container) =>
        container.children[container.children.length - 1];

    it('moves a child to the top of the stack', () => {
        const { container, children } = containerWith(4);
        raiseToTop(container, children[1]);
        expect(last(container)).toBe(children[1]);
    });

    it('keeps every child (it moves, it does not duplicate)', () => {
        const { container, children } = containerWith(4);
        raiseToTop(container, children[0]);
        expect(container.children.length).toBe(4);
        expect(new Set(container.children).size).toBe(4);
        for (const child of children) {
            expect(container.children).toContain(child);
        }
    });

    it('is a no-op for a child already on top', () => {
        const { container, children } = containerWith(3);
        raiseToTop(container, children[2]);
        expect(last(container)).toBe(children[2]);
        expect(container.children.length).toBe(3);
    });

    it('raises above POOLED children beyond the visible subset', () => {
        // The actual regression: the grid pools a tile per outfit (here
        // 242, the stock outfit count) but shows only a page of them. The
        // old code indexed by the visible count, which buried the
        // selection under the rest of the pool.
        const { container, children } = containerWith(242);
        const visiblePageSize = 20;
        raiseToTop(container, children[3]);
        expect(last(container)).toBe(children[3]);
        // Emphatically NOT at the old visible-count index.
        expect(container.children.indexOf(children[3]))
            .toBeGreaterThan(visiblePageSize);
    });

    it('keeps the most recently raised child on top', () => {
        const { container, children } = containerWith(10);
        raiseToTop(container, children[7]);
        raiseToTop(container, children[2]);
        expect(last(container)).toBe(children[2]);
    });
});

/**
 * Selling the last unit of an owned-only outfit empties the grid; the
 * detail pane subscribes to activeTile and must be told the selection is
 * gone rather than lingering on the last item (review round 6 finding).
 * An empty grid builds no ItemTiles (which need a DOM for PIXI.Text), so
 * the emission rule is pinned headlessly on a real, empty ItemGrid.
 */
describe('ItemGrid selection clearing', () => {
    it('emits undefined when a redraw leaves nothing selected', () => {
        const grid = new ItemGrid(undefined as any, []);
        // Simulate the lingering emission a prior selection left behind.
        grid.activeTile.next({ sentinel: true } as any);
        grid.setItems([]);
        expect(grid.activeTile.value).toBeUndefined();
    });

    it('does not churn the subject when already cleared', () => {
        const grid = new ItemGrid(undefined as any, []);
        let emissions = 0;
        grid.activeTile.subscribe(() => emissions++);
        const before = emissions;
        grid.setItems([]);
        grid.setItems([]);
        expect(emissions).toBe(before);
    });
});
