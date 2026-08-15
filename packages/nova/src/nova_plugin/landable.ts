/**
 * Whether a stellar can be landed on / docked at, from its static spöb
 * data. ONE predicate, quoted by every consumer, so the player's land
 * gate (planet_plugin's AttemptLandingSystem), the NPC AI's choice of
 * destinations (npc_ai_plugin's landingDestinations), and the mission
 * generator's stellar candidates (mission_logic) can never disagree
 * about which stellars are ports.
 *
 * The rules, both from the spöb Flags field (EVN Bible, spöb section):
 *
 *  - 0x0001 "Can land/dock here" must be set. This is the flag that makes
 *    Jupiter (nova:159) and the other 41 stock scenery worlds unlandable,
 *    and it is also how the 16 DESTROYED hypergates of the collapsed
 *    network (HG-Aldebaran nova:130, HG-Vega nova:131, HG-Kon, HG-Murasaki,
 *    HG-Bloodstone, HG-Centauri, HG-Enlightenment, HG-Codehaven,
 *    HG-Rautherion, HG-Porto Rillia, HG-Outbound, HG-Mjolnir,
 *    HG-Nil'kemorya, HG-Ver'ashan, HG-Kel'ariy, HG-Tre'pirana) are marked
 *    dead: each has the bit clear and zero HyperLink destinations, while
 *    every working gate (HG-V01 and friends) has it set. "Destroyed" is
 *    not a runtime state in the data — it is this bit.
 *
 *  - 0x0080 "Can only land here if stellar is destroyed first" makes a
 *    stellar a port ONLY after it has been blown up. Stellar destruction
 *    is not modeled (nothing damages a spöb, and the NCB Yxxx destroy-
 *    stellar operation has no hook), so such a stellar is never landable
 *    today. No stock spöb sets it; it is honored so a plug-in that does
 *    cannot accidentally open a port that should be shut.
 *
 * NCB-gated landing denial (the mïsn/spöb bit tests behind the original's
 * "Landing request denied.") is a separate, unbuilt seam: this predicate
 * is the static one only.
 */
export interface LandableFlags {
    /** spöb Flags 0x0001. */
    canLand: boolean;
    /** spöb Flags 0x0080. */
    landOnlyIfDestroyed: boolean;
}

export function landable(stellar: { flags: LandableFlags }): boolean {
    return stellar.flags.canLand && !stellar.flags.landOnlyIfDestroyed;
}
