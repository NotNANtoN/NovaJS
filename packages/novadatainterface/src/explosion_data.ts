import { Animation, getDefaultAnimation } from "./animation.js";
import { BaseData, getDefaultBaseData } from "./base_data.js";


export interface ExplosionData extends BaseData {
    animation: Animation,
    sound: string | null, // TODO: Implement sound
    rate: number // speed factor for animation
}


export function getDefaultExplosionData(): ExplosionData {
    return {
        ...getDefaultBaseData(),
        animation: getDefaultAnimation(),
        sound: null, // TODO: Make a sound interface
        rate: 1
    }
}
