import { World } from "nova_ecs/world";
import { ConvexHullDisplayPlugin } from "./display/convex_hull_display_plugin";


export class DebugSettings {
    private wrappedShowCollisionShapes = false;
    public debugCombat = false;

    constructor(public world: World, settings?: DebugSettings) {
        if (settings) {
            this.showCollisionShapes = settings.showCollisionShapes;
            this.debugCombat = settings.debugCombat;
        }
    }

    set showCollisionShapes(val: boolean) {
        this.wrappedShowCollisionShapes = val;
        if (val) {
            this.world.addPlugin(ConvexHullDisplayPlugin);
        } else {
            this.world.removePlugin(ConvexHullDisplayPlugin);
        }
    }

    get showCollisionShapes() {
        return this.wrappedShowCollisionShapes;
    }
}
