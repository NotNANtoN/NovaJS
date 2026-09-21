import { NovaIDNotFoundError } from "novadatainterface/NovaDataInterface";


export function resourceIDNotFoundStrict(message: string): never {
    throw new NovaIDNotFoundError(message);
}

const seenWarnings = new Set<string>();

export function resourceIDNotFoundWarn(message: string): void {
    // Missing dësc on NPC/dude ship variants, outfits, and spöbs are expected in retail EV Nova assets
    if (/^No matching dësc for (shïp|oütf|spöb)/.test(message)) {
        return;
    }
    if (seenWarnings.has(message)) {
        return;
    }
    seenWarnings.add(message);
    console.warn(`[ASSET WARN] ${message}`);
}
