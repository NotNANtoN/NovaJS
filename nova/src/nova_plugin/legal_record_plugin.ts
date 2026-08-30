import { Entities, UUID } from 'nova_ecs/arg_types';
import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { GovtData } from 'novadatainterface/GovtData';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { Query } from 'nova_ecs/query';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { SingletonComponent } from 'nova_ecs/world';

import { AppliedDamageEvent, DeathEvent } from './death_plugin';
import { GameDataResource } from './game_data_resource';
import {
    GovernmentRelationResource,
    GovernmentRelationStore,
} from './govt_relations';
import { GovtComponent } from './npc_components';
import { PlatformResource } from './platform_plugin';
import { PlayerStateComponent } from './player_state';
import { applyCrime, Crime } from './legal_record';
import { PlunderEvent } from './boarding_plugin';
import { ShipDisabledEvent } from './disabled_plugin';
import { resolveDamageSource } from './npc_hostility';

/**
 * Turns the player's kills into a lasting legal record.
 *
 * Damage only records who is shooting whom, so that a death can be blamed on
 * the pilot who caused it; retail ignores the penalty for the shot itself.
 * The ledger is server state: only the authoritative world may move a
 * player's record.
 */

interface VictimLedger {
    /** Player entity that last hit this victim. */
    attacker: string;
    at: number;
}

export class LegalLedger {
    readonly victims = new Map<string, VictimLedger>();
    /** Every government, for spreading a penalty to allies and enemies. */
    governments = new Map<string, GovtData>();

    record(victim: string, attacker: string, at: number): VictimLedger {
        const existing = this.victims.get(victim);
        if (existing && existing.attacker === attacker) {
            existing.at = at;
            return existing;
        }
        const ledger: VictimLedger = { attacker, at };
        this.victims.set(victim, ledger);
        return ledger;
    }
}

export const LegalLedgerResource = new Resource<LegalLedger>('LegalLedger');

/**
 * Entities carry only a numeric government id, so the full resource with its
 * penalties has to be looked up. The relation store already caches it.
 */
function fullGovernment(
    relations: GovernmentRelationStore,
    government: number,
): GovtData | undefined {
    return relations.getCached(government);
}

/**
 * How long a hit still counts as the cause of death. A victim that limps away
 * and dies to something else a minute later is not the player's kill.
 */
export const KILL_ATTRIBUTION_MS = 20_000;

const PlayersQuery = new Query([UUID, PlayerStateComponent] as const,
    'LegalRecordPlayers');

function chargeCrime(
    state: { legalRecords?: Record<string, number> },
    ledger: LegalLedger,
    victimGovernment: GovtData,
    crime: Crime,
): void {
    // Fall back to the victim's own government when the full table has not
    // finished loading, so an early kill still counts against the victim.
    const governments = ledger.governments.size > 0
        ? ledger.governments
        : new Map([[victimGovernment.id, victimGovernment]]);
    state.legalRecords = applyCrime(state.legalRecords, crime, {
        victim: victimGovernment.id,
        governments,
    });
}

const DERELICT_GOVERNMENT_FLAG = 0x0800;

function chargePlayerCrime(
    attacker: string,
    victimGovernment: { id: number },
    players: readonly (readonly [
        string,
        { legalRecords?: Record<string, number> },
    ])[],
    ledger: LegalLedger,
    relations: GovernmentRelationStore,
    crime: Crime,
): void {
    const player = players.find(([uuid]) => uuid === attacker);
    const govt = fullGovernment(relations, victimGovernment.id);
    if (!player || !govt) {
        return;
    }
    // Bible, gövt Flags 0x0800: ships of other governments "don't care if
    // you attack or board derelict govt ships".
    if ((govt.flags ?? 0) & DERELICT_GOVERNMENT_FLAG) {
        return;
    }
    chargeCrime(player[1], ledger, govt, crime);
}

const PlayerCrimeDamageSystem = new System({
    name: 'PlayerCrimeDamage',
    events: [AppliedDamageEvent],
    args: [
        AppliedDamageEvent,
        UUID,
        GovtComponent,
        Entities,
        PlayersQuery,
        LegalLedgerResource,
        GovernmentRelationResource,
        TimeResource,
        PlatformResource,
    ] as const,
    step({ shield, armor, damager }, victimUuid, victimGovernment, entities,
        players, ledger, relations, time, platform) {
        if (platform !== 'node' || shield + armor <= 0) {
            return;
        }
        const attacker = resolveDamageSource(damager, entities)?.attacker;
        if (!attacker || attacker === victimUuid) {
            return;
        }
        const player = players.find(([uuid]) => uuid === attacker);
        if (!player) {
            return;
        }
        // Note who is shooting whom so a kill can be attributed, but do not
        // charge for the shot itself: the Bible says of gövt/ShootPenalty
        // "Evilness from shooting one of this govt's ships (currently
        // ignored)". Charging it made a single exchange of fire with the
        // Federation, whose ShootPenalty of 5 all but exhausts its CrimeTol
        // of 6, turn the pilot into a permanent fugitive.
        ledger.record(victimUuid, attacker, time.time);
    },
});

const PlayerCrimeDeathSystem = new System({
    name: 'PlayerCrimeDeath',
    events: [DeathEvent],
    args: [
        UUID,
        Optional(GovtComponent),
        PlayersQuery,
        LegalLedgerResource,
        GovernmentRelationResource,
        TimeResource,
        PlatformResource,
    ] as const,
    step(victimUuid, victimGovernment, players, ledger, relations, time,
        platform) {
        const entry = ledger.victims.get(victimUuid);
        ledger.victims.delete(victimUuid);
        if (platform !== 'node' || !entry) {
            return;
        }
        if (time.time - entry.at > KILL_ATTRIBUTION_MS) {
            return;
        }
        const player = players.find(([uuid]) => uuid === entry.attacker);
        if (!player) {
            return;
        }
        const state = player[1];
        state.kills = (state.kills ?? 0) + 1;
        const govt = victimGovernment
            && fullGovernment(relations, victimGovernment.id);
        if (govt) {
            chargeCrime(state, ledger, govt, 'killing');
        }
    },
});

export const PlayerCrimeDisableSystem = new System({
    name: 'PlayerCrimeDisable',
    events: [ShipDisabledEvent],
    args: [
        ShipDisabledEvent,
        GovtComponent,
        Entities,
        PlayersQuery,
        LegalLedgerResource,
        GovernmentRelationResource,
        PlatformResource,
    ] as const,
    step({ damager }, victimGovernment, entities, players, ledger, relations,
        platform) {
        if (platform !== 'node') {
            return;
        }
        const attacker = resolveDamageSource(damager, entities)?.attacker;
        if (!attacker) {
            return;
        }
        chargePlayerCrime(attacker, victimGovernment, players, ledger,
            relations, 'disabling');
    },
});

export const PlayerCrimeBoardingSystem = new System({
    name: 'PlayerCrimeBoarding',
    events: [PlunderEvent],
    args: [
        PlunderEvent,
        GovtComponent,
        PlayersQuery,
        LegalLedgerResource,
        GovernmentRelationResource,
        PlatformResource,
    ] as const,
    step({ boarder }, victimGovernment, players, ledger, relations, platform) {
        if (platform !== 'node') {
            return;
        }
        chargePlayerCrime(boarder, victimGovernment, players, ledger,
            relations, 'boarding');
    },
});

/**
 * Forget victims that left the world without dying, so a long session does
 * not accumulate ledger entries for ships that jumped out.
 */
const LedgerSweepSystem = new System({
    name: 'LegalLedgerSweep',
    args: [LegalLedgerResource, Entities, TimeResource, PlatformResource, SingletonComponent] as const,
    step(ledger, entities, time, platform) {
        if (platform !== 'node') {
            return;
        }
        for (const [victim, entry] of ledger.victims) {
            if (time.time - entry.at > KILL_ATTRIBUTION_MS
                && !entities.has(victim)) {
                ledger.victims.delete(victim);
            }
        }
    },
});

export const LegalRecordPlugin: Plugin = {
    name: 'LegalRecordPlugin',
    build(world) {
        const ledger = new LegalLedger();
        world.resources.set(LegalLedgerResource, ledger);
        world.addSystem(PlayerCrimeDamageSystem);
        world.addSystem(PlayerCrimeDisableSystem);
        world.addSystem(PlayerCrimeBoardingSystem);
        world.addSystem(PlayerCrimeDeathSystem);
        world.addSystem(LedgerSweepSystem);

        const gameData = world.resources.get(GameDataResource);
        if (gameData) {
            void loadGovernments(gameData, ledger);
        }
    },
    // Without this the crime systems outlived the plugin, and tearing a system
    // down threw as soon as NpcPlugin dropped the government relations these
    // still claimed to use.
    remove(world) {
        world.removeSystem(PlayerCrimeDamageSystem);
        world.removeSystem(PlayerCrimeDisableSystem);
        world.removeSystem(PlayerCrimeBoardingSystem);
        world.removeSystem(PlayerCrimeDeathSystem);
        world.removeSystem(LedgerSweepSystem);
        world.resources.delete(LegalLedgerResource);
    },
};

async function loadGovernments(
    gameData: GameDataInterface,
    ledger: LegalLedger,
): Promise<void> {
    const gettable = gameData.data.Govt;
    if (!gettable) {
        return;
    }
    const ids = (await gameData.ids).Govt ?? [];
    for (const id of ids) {
        try {
            ledger.governments.set(id, await gettable.get(id));
        } catch (_error) {
            // A government that fails to load simply cannot hold a record.
        }
    }
}
