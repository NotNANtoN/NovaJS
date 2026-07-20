import * as t from 'io-ts';
import { GovtData } from 'novadatainterface/govt_data';
import { Component } from 'nova_ecs/component';
import { Plugin } from 'nova_ecs/plugin';
import { ProvideFromCache } from './provide_from_cache.js';
import { registerEntityDeriver } from './entity_factory.js';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { SimulationGameDataResource } from './game_data_resource.js';
import { OutfitsState, OutfitsStateComponent } from './outfit_plugin.js';

/**
 * A ship's IFF (Identify Friend or Foe) capability, derived from its owned
 * IFF-decoder outfits (oütf ModType 14, "IFF / colorized radar"). When the
 * player owns one, radar blips are coloured by each ship's disposition toward
 * the player instead of the flat dim colour (EVN Bible: "having an IFF outfit
 * will override [the radar] colors"; the outfit "colorizes" the radar).
 *
 * This is derived from outfits and re-derived on snapshot restore (like
 * CloakComponent), so it is NOT snapshotted. `hasIff` is true iff at least one
 * IFF outfit is present. The capability itself carries no configuration — the
 * ModVal is ignored per the Bible — so this is just a presence flag, but it is
 * modelled as a component for symmetry with the cloak / cloak-scanner
 * capabilities and so display systems can query it per ship.
 */
export const IffCapabilityType = t.type({ hasIff: t.boolean });
export type IffCapability = t.TypeOf<typeof IffCapabilityType>;

export const IffComponent = new Component<IffCapability>('IffComponent');

/**
 * True iff the ship owns at least one IFF outfit. Returns undefined only when
 * outfit game data is not yet cached (retry next step), matching the
 * ProvideFromCache contract.
 */
export function deriveIff(outfits: OutfitsState,
    gameData: SimulationGameDataInterface): IffCapability | undefined {
    for (const [id, state] of outfits) {
        if (state.count <= 0) {
            continue;
        }
        const outfit = gameData.data.Outfit.getCached(id);
        if (!outfit) {
            return undefined;
        }
        if (outfit.iff) {
            return { hasIff: true };
        }
    }
    return { hasIff: false };
}

/**
 * A ship's disposition toward the player, used to colour its IFF radar blip.
 *  - 'hostile': the ship's government attacks the player (its enemies include
 *    one of the player's govt classes, or a govt flag makes it hostile).
 *  - 'friendly': the ship's government is allied with the player's.
 *  - 'neutral': neither — the default for a govt-less ship or one with no
 *    relationship to the player.
 */
export type Disposition = 'hostile' | 'friendly' | 'neutral';

/** Whether two class-number lists share any value. */
function intersects(a: readonly number[], b: readonly number[]): boolean {
    return a.some(x => b.includes(x));
}

/**
 * Computes a ship's disposition toward the player from the ship's government
 * and the player's government (both optional GovtData; undefined = no
 * government). Pure and total.
 *
 * Hostility, in priority order:
 *  1. The ship's govt flags mark it hostile to the player
 *     (alwaysAttacksPlayer, or xenophobic which "attacks everyone except
 *     allies"). neverAttacksPlayer overrides these to non-hostile.
 *  2. The ship's govt `enemies` classes intersect the player's govt classes.
 * Friendliness (only if not hostile): the ship's govt `allies` classes
 * intersect the player's govt classes, or ship and player share a government.
 * Everything else is neutral.
 *
 * NOTE: reputation / legal-record-driven hostility (attacksPlayerIfCriminal)
 * is not modelled — there is no legal record in the sim yet — so a "nosy" govt
 * reads as neutral until the player provokes it, which matches a clean record.
 */
export function shipDisposition(shipGovt: GovtData | undefined,
    playerGovt: GovtData | undefined): Disposition {
    if (!shipGovt) {
        return 'neutral';
    }
    const flags = shipGovt.flags;
    if (!flags.neverAttacksPlayer) {
        if (flags.alwaysAttacksPlayer || flags.xenophobic) {
            return 'hostile';
        }
        if (playerGovt && intersects(shipGovt.enemies, playerGovt.classes)) {
            return 'hostile';
        }
    }
    if (playerGovt) {
        if (shipGovt.id === playerGovt.id
            || intersects(shipGovt.allies, playerGovt.classes)) {
            return 'friendly';
        }
    }
    return 'neutral';
}

/**
 * Radar blip colours for each disposition when the player has IFF. Nova's IFF
 * uses red for hostile, green for friendly, and yellow for neutral ships; the
 * exact palette is a display choice (the Bible only says IFF "colorizes" and
 * "overrides" the default radar colours).
 */
export const IFF_HOSTILE_COLOR = 0xff2222;
export const IFF_FRIENDLY_COLOR = 0x22ff22;
export const IFF_NEUTRAL_COLOR = 0xffff44;

/** The IFF radar colour for a disposition. */
export function dispositionColor(disposition: Disposition): number {
    switch (disposition) {
        case 'hostile': return IFF_HOSTILE_COLOR;
        case 'friendly': return IFF_FRIENDLY_COLOR;
        case 'neutral': return IFF_NEUTRAL_COLOR;
    }
}

/**
 * Which corner-bracket set (TargetCornersData.images key) a targeted SHIP
 * gets. THE HOSTILITY RULE, in priority order:
 *
 *  1. DISABLED: a disabled ship (DisabledComponent) shows the gray
 *     'disabled' corner set (cicn 10020-10023) regardless of iff or
 *     politics — dead in space trumps every allegiance.
 *  2. Behavioral: a ship that is *currently attacking the player* shows
 *     hostile corners regardless of politics — a brave trader fighting the
 *     player back, or a neutral-govt warship the player provoked, is hostile
 *     in every sense that matters to the pilot. "Currently attacking" is
 *     derived display-side from synced state: the target's own
 *     TargetComponent points at the player AND its AI is in an attacking
 *     posture (NpcComponent mode 'attack', or the legacy dev-enemy
 *     ShootAllWeapons marker). A ship merely *fleeing* the player keeps its
 *     political corners.
 *  3. Political: shipDisposition(target govt, player govt) — hostile and
 *     friendly map to their corner sets.
 *  4. Everything else: neutral.
 *
 * Planets use their own corner instance (planet_corners_plugin) and are
 * unaffected.
 */
export function targetCornerStyle(disposition: Disposition,
    attackingPlayer: boolean, disabled = false): Disposition | 'disabled' {
    if (disabled) {
        return 'disabled';
    }
    return attackingPlayer ? 'hostile' : disposition;
}

const IffProvider = ProvideFromCache({
    name: 'IffProvider',
    provided: IffComponent,
    update: [OutfitsStateComponent],
    args: [OutfitsStateComponent, SimulationGameDataResource] as const,
    factory: deriveIff,
});

export const IffPlugin: Plugin = {
    name: 'IffPlugin',
    build(world) {
        world.addComponent(IffComponent);

        // NOTE: IffComponent is NOT delta-registered. The radar runs in the
        // display world (not the sim worker), and delta-syncing a
        // snapshot-skipped derived component would break wire-snapshot
        // fidelity (the rollback snapshot skips it, so a wire snapshot taken
        // from a rollback snapshot would omit it while a direct wire snapshot
        // would include it). Instead the display's DrawRadar derives the
        // player's IFF locally from the delta-synced OutfitsStateComponent via
        // deriveIff — the same source of truth, no cross-world component.

        // Re-derive the capability wherever a full entity is built (staged
        // insertion, snapshot restore), like the cloak capability.
        registerEntityDeriver(world, {
            name: 'IffDeriver',
            provided: IffComponent,
            requires: [OutfitsStateComponent],
            derive: (entity, gameData) => deriveIff(
                entity.components.get(OutfitsStateComponent)!, gameData),
        });

        world.addSystem(IffProvider);
    },
};
