import 'jasmine';
import type * as PIXI from 'pixi.js';
import { attachGraphic, createGraphicHandle } from './managed_graphic';

/**
 * Pixi's real renderer cannot be constructed under Node, so these specs use
 * the minimal display-object surface that managed_graphic actually touches.
 */
class FakeDisplayObject {
    parent: FakeContainer | null = null;
    destroyed = false;
    destroyCalls = 0;

    destroy() {
        this.destroyCalls++;
        this.destroyed = true;
    }
}

class FakeContainer extends FakeDisplayObject {
    readonly children: FakeDisplayObject[] = [];

    addChild(child: FakeDisplayObject) {
        child.parent?.removeChild(child);
        this.children.push(child);
        child.parent = this;
        return child;
    }

    removeChild(child: FakeDisplayObject) {
        const index = this.children.indexOf(child);
        if (index >= 0) {
            this.children.splice(index, 1);
            child.parent = null;
        }
        return child;
    }
}

const asContainer = (c: FakeContainer) => c as unknown as PIXI.Container;
const asDisplayObject = (o: FakeDisplayObject) =>
    o as unknown as PIXI.Container;

describe('managed graphic', () => {
    it('detaches without destroying so the object can be reused', () => {
        const parent = new FakeContainer();
        const child = new FakeDisplayObject();
        const handle = attachGraphic(
            asContainer(parent), asDisplayObject(child));

        expect(parent.children).toContain(child);

        handle.detach();
        expect(parent.children).not.toContain(child);
        expect(handle.disposed).toBeFalse();
        expect(child.destroyed).toBeFalse();

        // Pooled projectiles reuse the same entity, and therefore the same
        // graphic, for the next shot. Re-attaching must restore drawing.
        parent.addChild(child);
        expect(parent.children).toContain(child);
        expect(handle.disposed).toBeFalse();
    });

    it('dispose is permanent and idempotent', () => {
        const parent = new FakeContainer();
        const child = new FakeDisplayObject();
        const handle = attachGraphic(
            asContainer(parent), asDisplayObject(child));

        handle.dispose();
        expect(handle.disposed).toBeTrue();
        expect(parent.children).not.toContain(child);
        expect(child.destroyed).toBeTrue();
        expect(child.destroyCalls).toBe(1);

        handle.dispose();
        handle.detach();
        expect(child.destroyCalls).toBe(1);
        expect(handle.disposed).toBeTrue();
    });

    it('reports an externally destroyed root as disposed', () => {
        const child = new FakeDisplayObject();
        const handle = createGraphicHandle(asDisplayObject(child));
        expect(handle.disposed).toBeFalse();
        child.destroy();
        expect(handle.disposed).toBeTrue();
    });
});
