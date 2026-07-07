import { GettableData } from "./gettable.js";
import { NovaDataInterface } from "./nova_data_interface.js";
import { NovaIDs } from "./nova_ids.js";


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
