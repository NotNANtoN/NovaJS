import { GettableData } from "./Gettable.js";
import { NovaDataInterface } from "./NovaDataInterface.js";
import { NovaIDs } from "./NovaIDs.js";


export type PreloadData = {
    [K in keyof NovaDataInterface]?: {
        [index: string]: GettableData<NovaDataInterface[K]>
    }
}

interface GameDataInterface {
    readonly data: NovaDataInterface;
    readonly ids: Promise<NovaIDs>;
    readonly preloadData?: Promise<PreloadData>;
}

export { GameDataInterface };
