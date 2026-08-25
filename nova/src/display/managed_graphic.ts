import * as PIXI from 'pixi.js';

export interface ManagedGraphic {
    readonly root: PIXI.DisplayObject;
    readonly disposed: boolean;
    dispose(): void;
}

/**
 * Own one display-object subtree. Removing a graphic from its parent is not
 * enough in Pixi: textures, child objects, and GPU-side resources can remain
 * reachable until the subtree is explicitly destroyed.
 */
export function attachGraphic(
    parent: PIXI.Container,
    root: PIXI.DisplayObject,
): ManagedGraphic {
    parent.addChild(root);
    return createGraphicHandle(root);
}

export function createGraphicHandle(
    root: PIXI.DisplayObject,
): ManagedGraphic {
    let isDisposed = false;
    return {
        root,
        get disposed() {
            return isDisposed || root.destroyed;
        },
        dispose() {
            if (isDisposed) {
                return;
            }
            isDisposed = true;
            root.parent?.removeChild(root);
            if (!root.destroyed) {
                root.destroy({ children: true });
            }
        },
    };
}
