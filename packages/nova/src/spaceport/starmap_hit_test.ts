import "jasmine";
import {
    clickRadiusWorld, DragTracker, DRAG_THRESHOLD, isDragGesture,
    nearestTargetIndex, screenToWorld,
} from "./starmap_hit.js";

describe('isDragGesture (click vs drag deadzone)', () => {
    it('treats a perfectly still press as a click', () => {
        expect(isDragGesture(0, 0)).toBeFalse();
    });

    it('treats the pixel-or-two of jitter a physical click makes as a click', () => {
        // The regression: PIXI delivers a pointertap for down -> up on the
        // same target even with an intervening 1px move, so if this counted
        // as a drag the click was swallowed. It must NOT.
        expect(isDragGesture(1, 0)).toBeFalse();
        expect(isDragGesture(0, 1)).toBeFalse();
        expect(isDragGesture(2, 2)).toBeFalse();
    });

    it('treats movement past the threshold as a drag', () => {
        expect(isDragGesture(DRAG_THRESHOLD + 1, 0)).toBeTrue();
        expect(isDragGesture(0, DRAG_THRESHOLD + 1)).toBeTrue();
        // A real pan of tens of pixels is unambiguously a drag.
        expect(isDragGesture(40, 0)).toBeTrue();
    });

    it('measures distance radially, not per-axis', () => {
        // Just past the threshold on the diagonal still counts as a drag.
        const d = DRAG_THRESHOLD; // (d, d) has length d*sqrt(2) > d.
        expect(isDragGesture(d, d)).toBeTrue();
    });
});

describe('screenToWorld', () => {
    it('is the inverse of pan + zoom', () => {
        const [wx, wy] = screenToWorld(120, 80, 20, 10, 2);
        expect(wx).toBe((120 - 20) / 2);
        expect(wy).toBe((80 - 10) / 2);
    });

    it('round-trips a world point back through the same transform', () => {
        const panX = -30, panY = 15, zoom = 1.5;
        const worldX = 42, worldY = -7;
        const viewX = worldX * zoom + panX;
        const viewY = worldY * zoom + panY;
        const [rx, ry] = screenToWorld(viewX, viewY, panX, panY, zoom);
        expect(rx).toBeCloseTo(worldX, 6);
        expect(ry).toBeCloseTo(worldY, 6);
    });
});

describe('clickRadiusWorld', () => {
    it('uses the screen click radius scaled into world units when zoomed out', () => {
        // At zoom 1 the world radius equals the screen click radius.
        expect(clickRadiusWorld(1, 5.4, 12)).toBe(12);
        // Zoomed out (zoom < 1), the world radius grows so the on-screen
        // target stays the same size.
        expect(clickRadiusWorld(0.5, 5.4, 12)).toBe(24);
    });

    it('never shrinks the target below the drawn circle when zoomed in', () => {
        // At high zoom, 12px / zoom would be tiny, so the drawn-circle
        // radius (world units) is used instead.
        expect(clickRadiusWorld(4, 5.4, 12)).toBe(5.4);
    });
});

describe('nearestTargetIndex', () => {
    const targets = [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
    ];

    it('returns the nearest target within radius', () => {
        expect(nearestTargetIndex(targets, 3, 4, 12)).toBe(0);
        expect(nearestTargetIndex(targets, 98, 1, 12)).toBe(1);
    });

    it('returns -1 when nothing is within radius', () => {
        expect(nearestTargetIndex(targets, 50, 50, 12)).toBe(-1);
    });

    it('accepts a target exactly on the radius boundary', () => {
        expect(nearestTargetIndex(targets, 12, 0, 12)).toBe(0);
    });

    it('breaks ties toward the later target', () => {
        // Two coincident targets: the later one wins (matches the original
        // <= sweep, letting a system drawn over another on the same spot
        // take the click).
        const stacked = [{ x: 5, y: 5 }, { x: 5, y: 5 }];
        expect(nearestTargetIndex(stacked, 5, 5, 12)).toBe(1);
    });
});

describe('DragTracker', () => {
    const PID = 1;

    it('does not treat a perfectly still press/release as a drag', () => {
        const t = new DragTracker();
        t.down(PID, 100, 100);
        t.up(PID);
        expect(t.dragged).toBeFalse();
    });

    it('does not treat a click with a pixel of jitter as a drag', () => {
        // THE REGRESSION. PIXI fires a pointertap for down -> up even with a
        // 1px move between them, so this gesture must stay a click or the tap
        // is swallowed (click once, nothing; click again, it registers).
        const t = new DragTracker();
        t.down(PID, 100, 100);
        expect(t.move(PID, 101, 100)).toBeNull();  // no pan below deadzone
        t.up(PID);
        expect(t.dragged).toBeFalse();
    });

    it('promotes to a drag once the pointer leaves the deadzone', () => {
        const t = new DragTracker();
        t.down(PID, 100, 100);
        expect(t.move(PID, 100 + DRAG_THRESHOLD, 100)).toBeNull();  // still in
        const delta = t.move(PID, 140, 100);  // now out
        expect(t.dragged).toBeTrue();
        expect(delta).not.toBeNull();
    });

    it('pans by the full distance from the press point on the first drag step', () => {
        // No jump: the first pan after crossing the deadzone spans press->here.
        const t = new DragTracker();
        t.down(PID, 100, 100);
        const delta = t.move(PID, 140, 100);
        expect(delta).toEqual({ dx: 40, dy: 0 });
    });

    it('pans incrementally after the drag has started', () => {
        const t = new DragTracker();
        t.down(PID, 100, 100);
        t.move(PID, 140, 100);         // starts the drag (delta 40)
        expect(t.move(PID, 150, 100)).toEqual({ dx: 10, dy: 0 });
        expect(t.move(PID, 150, 130)).toEqual({ dx: 0, dy: 30 });
    });

    it('keeps dragged set after release until the next press', () => {
        // onTap fires right after pointerup, so the flag must survive up().
        const t = new DragTracker();
        t.down(PID, 100, 100);
        t.move(PID, 200, 100);
        t.up(PID);
        expect(t.dragged).toBeTrue();  // tap after this up must be ignored
        t.down(PID, 300, 300);
        expect(t.dragged).toBeFalse(); // fresh gesture is a click again
    });

    it('back-and-forth jitter within the deadzone never becomes a drag', () => {
        const t = new DragTracker();
        t.down(PID, 100, 100);
        expect(t.move(PID, 102, 100)).toBeNull();
        expect(t.move(PID, 98, 100)).toBeNull();
        expect(t.move(PID, 101, 101)).toBeNull();
        t.up(PID);
        expect(t.dragged).toBeFalse();
    });

    it('ignores moves and releases from a different pointer', () => {
        const t = new DragTracker();
        t.down(PID, 100, 100);
        expect(t.move(2, 300, 100)).toBeNull();  // other finger: no pan
        t.up(2);                                  // other finger up: ignored
        // The original gesture is still live and still a click.
        expect(t.move(PID, 101, 100)).toBeNull();
        t.up(PID);
        expect(t.dragged).toBeFalse();
    });
});
