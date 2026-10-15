import { ALL_NOVA_DATA_TYPES, NovaDataType } from "./NovaDataInterface";

export type NovaIDs = {
    [index in Exclude<NovaDataType, NovaDataType.Mission | NovaDataType.Govt
    | NovaDataType.Asteroid | NovaDataType.Nebula
    | NovaDataType.StringList | NovaDataType.Junk | NovaDataType.Pers>]: Array<string>
} & {
    // Kept optional so legacy FilesystemData providers remain source
    // compatible while they do not serve mission JSON yet.
    Mission?: Array<string>
    Govt?: Array<string>
    Asteroid?: Array<string>
    Nebula?: Array<string>
    StringList?: Array<string>
    Junk?: Array<string>
    Pers?: Array<string>
}

export function getDefaultNovaIDs(): NovaIDs {
    const ids = {} as Record<NovaDataType, Array<string>>;
    for (const type of ALL_NOVA_DATA_TYPES) {
        ids[type] = [];
    }
    return ids;
}
