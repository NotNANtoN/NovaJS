import { Animation, getDefaultAnimation } from "./Animation";
import { BaseData, getDefaultBaseData } from "./BaseData";

/**
 * What an asteroid drops when it is destroyed. `commodity` is a standard
 * commodity name or a jünk id; `undefined` means the asteroid is worthless,
 * as retail's dust types are.
 */
export interface AsteroidYield {
    commodity?: string;
    quantity: number;
}

export interface AsteroidData extends BaseData {
    /** Hit points. */
    strength: number;
    /** Relative likelihood of appearing when a belt is populated. */
    prevalence: number;
    yield: AsteroidYield;
    /** Asteroid ids this breaks into when destroyed. */
    fragments: string[];
    fragmentCount: number;
    /** 0 for small through 2 for huge. */
    sizeClass: number;
    mass: number;
    color: number;
    animation: Animation;
    /** Artwork for the floating ore this leaves behind. */
    yieldAnimation: Animation;
}

export function getDefaultAsteroidData(): AsteroidData {
    return {
        ...getDefaultBaseData(),
        strength: 100,
        prevalence: 1,
        yield: { quantity: 0 },
        fragments: [],
        fragmentCount: 0,
        sizeClass: 0,
        mass: 100,
        color: 0xffffff,
        animation: getDefaultAnimation(),
        yieldAnimation: getDefaultAnimation(),
    };
}
