import { NovaIDNotFoundError } from "novadatainterface/nova_data_interface";


export function resourceIDNotFoundStrict(message: string): never {
    throw new NovaIDNotFoundError(message);
}

export function resourceIDNotFoundWarn(message: string): void {
    console.warn(message);
}
