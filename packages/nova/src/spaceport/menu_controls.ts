import { Observable, Subscription } from "rxjs";
import { ControlAction } from "../nova_plugin/controls.js";
import { ControlEvent } from "../nova_plugin/controls_plugin.js";

/**
 * Key handling for one landed-UI surface (a menu or dialog).
 *
 * Bound instances form a global focus stack, and only the most
 * recently bound (topmost) instance receives control events. Menus are
 * modal: a key the focused surface doesn't handle does nothing rather
 * than falling through to the surface underneath, so e.g. 'b' over the
 * starmap can't open the bar behind it, and a quantity dialog
 * suppresses every navigation key of its parent. Global key handlers
 * outside the menu system (e.g. the in-flight starmap toggle) should
 * check `MenuControls.focused` and stand down while any menu is bound.
 */
/** Actions that repeat while their key is held by default: list/grid
 * navigation. Everything else (buy, hire, accept, depart...) fires once
 * per press, so holding a key can't e.g. hire a bar full of escorts. An
 * individual surface may opt extra actions in via `repeatableActions`
 * (the outfitter does this for buy/sell) — scoped to that surface only,
 * so global controls (jump, land, fire) never gain repeat behavior. */
const REPEATABLE = new Set<ControlAction>(['up', 'down', 'left', 'right']);

export class MenuControls {
    private static stack: MenuControls[] = [];

    /** The surface that currently owns the keyboard, if any. */
    static get focused(): MenuControls | undefined {
        return MenuControls.stack[MenuControls.stack.length - 1];
    }

    /**
     * The actions that repeat while their key is held on THIS surface.
     * Seeded with the navigation defaults; a surface may add its own
     * (e.g. the outfitter adds buy/sell) without affecting other menus.
     */
    readonly repeatableActions = new Set<ControlAction>(REPEATABLE);

    private controlsSubscription: Subscription | undefined;
    constructor(private controlEvents: Observable<ControlEvent>,
        public controls: { [index in ControlAction]?: () => void } = {}) { }

    bind() {
        this.unbind();
        MenuControls.stack.push(this);
        this.controlsSubscription =
            this.controlEvents.subscribe(({ action, state }) => {
                if (state === false
                    || (state === 'repeat'
                        && !this.repeatableActions.has(action))) {
                    return;
                }
                if (MenuControls.focused !== this) {
                    return;
                }
                this.controls[action]?.();
            });
    }

    unbind() {
        this.controlsSubscription?.unsubscribe();
        this.controlsSubscription = undefined;
        const index = MenuControls.stack.indexOf(this);
        if (index >= 0) {
            MenuControls.stack.splice(index, 1);
        }
    }
}
