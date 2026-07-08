import { BaseData, getDefaultBaseData } from "./base_data.js";
import { getDefaultShipData } from "./ship_data.js";
import { getDefaultSpaceObjectData, SpaceObjectData } from "./space_object_data.js";

export type DamageType = "normal" | "pointDefense" | "planetBuster";


export type ProjectileGuidanceType =
    "unguided" |
    "turret" |
    "guided" |
    "rocket" |
    "freefallBomb" |
    "frontQuadrant" |
    "rearQuadrant" |
    "pointDefense";

// I would use an enum but you can't union those
export const ProjectileGuidanceSet: Set<string> = new Set(<Array<ProjectileGuidanceType>>[
    "unguided",
    "turret",
    "guided",
    "rocket",
    "freefallBomb",
    "frontQuadrant",
    "rearQuadrant",
    "pointDefense"
]);

export type BeamGuidanceType =
    "beam" |
    "beamTurret" |
    "pointDefenseBeam";

export const BeamGuidanceSet: Set<any> = new Set(<Array<BeamGuidanceType>>[
    "beam",
    "beamTurret",
    "pointDefenseBeam"
]);


export type BayGuidanceType = "bay";

export const BayGuidanceSet: Set<any> = new Set(<Array<BayGuidanceType>>["bay"]);

export type GuidanceType =
    ProjectileGuidanceType |
    BeamGuidanceType |
    BayGuidanceType;


export type ExitType =
    "center" |
    "gun" |
    "turret" |
    "guided" |
    "beam";


export interface BeamAnimation {
    length: number;
    width: number;
    beamColor: number;
    coronaColor: number;
    coronaFalloff: number; // Pixels of corona on each side
    lightningDensity: number;
    lightningAmplitude: number;
}

export function getDefaultBeamAnimation(): BeamAnimation {
    return {
        length: 100,
        width: 6,
        beamColor: 0xffffff,
        coronaColor: 0x8888ff,
        coronaFalloff: 4,
        lightningDensity: 0,
        lightningAmplitude: 0,
    }
}


export type AmmoType = "unlimited" | ["energy", number] | ["outfit", string];

export interface SubmunitionType {
    id: string;
    count: number;
    theta: number; // Conical angle they fly out at
    limit: number; // Recursion limit for recursive submunitions
    fireAtNearest: boolean; // Set target to nearest ship
    subIfExpire: boolean; // Sub if the shot expires before the prox fuse is triggered
}


export interface WeaponDamage {
    [index: string]: number;
    shield: number;
    armor: number;
    ionization: number;
    ionizationColor: number;
    passThroughShield: number; // Factor of damage that passes through shield. 1 means all
    knockback: number;
}

export type FireGroup = "primary" | "secondary" | "pointDefense";

export interface BaseWeaponData extends BaseData {
    reload: number;
    shotSpeed: number;
    fireGroup: FireGroup;
    exitType: ExitType;
    accuracy: number;
    burstCount: number;
    burstReload: number;
    ammoType: AmmoType;
    useFiringAnimation: boolean;
    fireSimultaneously: boolean;
    destroyShipWhenFiring: boolean;
    sound?: string;
    loopSound: boolean;
}

export function getDefaultBaseWeaponData(): BaseWeaponData {
    return {
        ...getDefaultBaseData(),
        reload: 1000,
        shotSpeed: 50,
        fireGroup: "primary",
        exitType: "gun",
        accuracy: 0,
        burstCount: 0,
        burstReload: 1000,
        ammoType: "unlimited",
        useFiringAnimation: true,
        fireSimultaneously: false,
        destroyShipWhenFiring: false,
        loopSound: false,
    };
}

export interface NotBayWeaponData extends BaseWeaponData {
    damage: WeaponDamage;
    submunitions: Array<SubmunitionType>,
    oneAmmoPerBurst: boolean;
    shotDuration: number;
    primaryExplosion: string | null;
    secondaryExplosion: string | null;
    blastRadius: number;
    blastHurtsFiringShip: boolean,
    detonateWhenShotExpires: boolean,
    damageType: DamageType; // Should this be a set?
}

export function getDefaultNotBayWeaponData(): NotBayWeaponData {
    return {
        ...getDefaultBaseWeaponData(),
        damage: {
            shield: 1,
            armor: 1,
            ionization: 0,
            ionizationColor: 0xffffff,
            passThroughShield: 0,
            knockback: 0,
        },
        submunitions: [],
        oneAmmoPerBurst: false,
        shotDuration: 7,
        primaryExplosion: null,
        secondaryExplosion: null,
        blastRadius: 0,
        blastHurtsFiringShip: false,
        detonateWhenShotExpires: false,
        damageType: "normal",
    }
}


export interface ParticleConfig {
    count: number;
    velocity: number;
    lifeMin: number;
    lifeMax: number;
    color: number;
}

export function getDefaultParticles(): ParticleConfig {
    return {
        count: 0,
        velocity: 0,
        lifeMin: 0,
        lifeMax: 0,
        color: 0
    };
}

/**
 * A guided weapon's vulnerability to each of the four jamming types, from the
 * wëap resource's JamVuln1-4 fields. Each value is a percentage (0-100) read
 * straight from the resource; a ship's jamming strength of the matching type is
 * compared against it to decide whether a missile loses lock. The four types
 * mirror EV Nova's jamming taxonomy (EVN Bible, oütf ModTypes 33-36 and the
 * govt InhJam1-4 fields): infrared, radar, etheric wake, gravimetric.
 *
 * Ordered [type1, type2, type3, type4]. Nova's stock data assigns semantic
 * meaning to the slots by convention (1=IR, 2=radar, ...), but the engine only
 * cares about matching indices, so we keep them as a fixed-length array indexed
 * by jamming-type number.
 */
export type JammingVulnerabilities = readonly [number, number, number, number];

export function getDefaultJammingVulnerabilities(): JammingVulnerabilities {
    return [0, 0, 0, 0];
}

/**
 * The wëap "Seeker" flags that matter for jamming/guidance behaviour, decoded
 * from the guided-weapon flags word. See EVN Bible pp. 67 (Seeker field):
 *
 * - `passOverAsteroids` (0x0001): the missile flies over asteroids instead of
 *   colliding with them.
 * - `decoyedByAsteroids` (0x0002): the missile can be distracted onto asteroids
 *   (and, in our generalization, any decoy target). See the decoy hook.
 * - `confusedByInterference` (0x0008): the missile is additionally degraded by
 *   the current system's sensor interference (radar-type jamming).
 * - `turnsAwayIfJammed` (0x0010): when the missile loses lock to jamming, it
 *   veers away from its target rather than merely flying straight.
 * - `attackParentIfJammed` (0x8000): when jammed, the missile may retarget the
 *   ship that fired it.
 */
export interface SeekerFlags {
    passOverAsteroids: boolean;
    decoyedByAsteroids: boolean;
    confusedByInterference: boolean;
    turnsAwayIfJammed: boolean;
    attackParentIfJammed: boolean;
}

export function getDefaultSeekerFlags(): SeekerFlags {
    return {
        passOverAsteroids: false,
        decoyedByAsteroids: false,
        confusedByInterference: false,
        turnsAwayIfJammed: false,
        attackParentIfJammed: false,
    };
}

export interface ProjectileWeaponData extends SpaceObjectData, NotBayWeaponData {
    type: "ProjectileWeaponData",
    guidance: ProjectileGuidanceType,
    proxRadius: number, // Proximity to something before it explodes
    proxSafety: number // Number of seconds after firing that the weapon won't explode
    trailParticles: ParticleConfig,
    hitParticles: ParticleConfig,
    /**
     * Vulnerability to each of the four jamming types (0-100%). Only meaningful
     * for guided weapons; ignored otherwise (matching the Bible: "Ignored if
     * the weapon is not a guided weapon").
     */
    jamVulnerabilities: JammingVulnerabilities,
    /** Decoded Seeker flags affecting jamming/guidance behaviour. */
    seeker: SeekerFlags,
}

// This extends SpaceObjectData since projectiles use sprites
export function getDefaultProjectileWeaponData(): ProjectileWeaponData {
    return {
        ...getDefaultNotBayWeaponData(),
        ...getDefaultSpaceObjectData(),
        type: "ProjectileWeaponData",
        guidance: "unguided",
        proxRadius: 1,
        proxSafety: 0,
        trailParticles: getDefaultParticles(),
        hitParticles: getDefaultParticles(),
        jamVulnerabilities: getDefaultJammingVulnerabilities(),
        seeker: getDefaultSeekerFlags(),
    };
}

export interface BeamWeaponData extends NotBayWeaponData {
    type: "BeamWeaponData",
    guidance: BeamGuidanceType,
    beamAnimation: BeamAnimation,
}

export function getDefaultBeamWeaponData(): BeamWeaponData {
    return {
        ...getDefaultNotBayWeaponData(),
        type: "BeamWeaponData",
        guidance: "beam",
        beamAnimation: getDefaultBeamAnimation()
    };
}

export interface BayWeaponData extends BaseWeaponData {
    type: "BayWeaponData",
    guidance: BayGuidanceType,
    shipID: string,
}

export function getDefaultBayWeaponData(): BayWeaponData {
    return {
        ...getDefaultBaseWeaponData(),
        type: "BayWeaponData",
        guidance: "bay",
        shipID: getDefaultShipData().id
    };
}

export type WeaponData = ProjectileWeaponData | BeamWeaponData | BayWeaponData;
