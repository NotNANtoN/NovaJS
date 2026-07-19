import { SpaceObjectData, getDefaultSpaceObjectData } from "./space_object_data.js";
import { DamageType } from "./weapon_data.js";

/**
 * A hypergate/wormhole transit endpoint, if this stellar is one.
 *
 * Populated from the spöb flags2 hypergate (0x1000) / wormhole (0x2000) bits
 * and the HyperLink1-8 fields (EVN Bible p. 61). See jump_gate_plugin.ts for
 * how transit resolves a destination from this.
 */
export interface GateData {
    kind: "hypergate" | "wormhole";

    /**
     * Global ids of the spöb resources this gate/wormhole connects to (its
     * defined HyperLink1-8 destinations, resolved to global ids; unset -1/0
     * links dropped). For a hypergate these are the choices the player is
     * offered. For a wormhole these are its exit(s); an empty list means the
     * wormhole has no defined links and connects to a random other link-less
     * wormhole (Bible p. 61 "random wormhole" behavior).
     */
    destinations: string[];

    /**
     * The angle (degrees, 0-359) at which ships emerge from the destination
     * gate/wormhole, from the spöb's CustSndID field (which serves this
     * purpose for hypergates/wormholes — Bible p. 60). null means "a random
     * direction" (any CustSndID outside 0-359); callers pick a seeded-random
     * angle so it stays deterministic.
     */
    emergenceAngle: number | null;
}

export interface PlanetData extends SpaceObjectData {
    landingPict: string;
    landingDesc: string;
    position: [number, number];

    /**
     * Transit endpoint metadata if this stellar is a hypergate or wormhole,
     * else null. A normal planet/station has no gate.
     */
    gate: GateData | null;

    /**
     * Fee deducted from the player's credits on landing (spöb Fee field,
     * Bible p. 61). Hook only: credits are not yet modeled, so nothing charges
     * this today. Hypergates in stock EV Nova charge no fee (all observed
     * gate/wormhole Fee = 0); kept so a future credits system can honor it.
     */
    landingFee: number;
}

export function getDefaultPlanetData(): PlanetData {
    return {
        ...getDefaultSpaceObjectData(),
        vulnerableTo: <Array<DamageType>>["planetBuster"],
        landingPict: "default",
        landingDesc: "default",
        position: [0, 0],
        gate: null,
        landingFee: 0,
    };
}
