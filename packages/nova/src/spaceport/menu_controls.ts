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
/** Actions that repeat while their key is held: list/grid navigation.
 * Everything else (buy, hire, accept, depart...) fires once per
 * press, so holding a key can't e.g. hire a bar full of escorts. */
const REPEATABLE = new Set<ControlAction>(['up', 'down', 'left', 'right']);

export class MenuControls {
    private static stack: MenuControls[] = [];

    /** The surface that currently owns the keyboard, if any. */
    static get focused(): MenuControls | undefined {
        return MenuControls.stack[MenuControls.stack.length - 1];
    }

    private controlsSubscription: Subscription | undefined;
    constructor(private controlEvents: Observable<ControlEvent>,
        public controls: { [index in ControlAction]?: () => void } = {}) { }

    bind() {
        this.unbind();
        MenuControls.stack.push(this);
        this.controlsSubscription =
            this.controlEvents.subscribe(({ action, state }) => {
                if (state === false
                    || (state === 'repeat' && !REPEATABLE.has(action))) {
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
