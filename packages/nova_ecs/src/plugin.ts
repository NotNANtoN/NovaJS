import { World } from "./world.js";

export interface Plugin {
    name?: string;
    build: (world: World) => void | Promise<void>;
    remove?: (world: World) => void;
}
