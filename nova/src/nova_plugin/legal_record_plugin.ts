import { Entities, UUID } from 'nova_ecs/arg_types';
import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { GovtData } from 'novadatainterface/GovtData';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { Query } from 'nova_ecs/query';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';

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
import { resolveDamageSource } from './npc_hostility';

/**
 * Turns the player's shots into a lasting legal record.
 *
 * A crime is charged once per victim per kind, so a long firefight with one
 * freighter is one shooting offence and, if it ends badly for the freighter,
 * one killing offence. The ledger is server state: only the authoritative
 * world may move a player's record.
 */

interface VictimLedger {
    /** Player entity that last hit this victim. */
    attacker: string;
    at: number;
    chargedShooting: boolean;
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
        const ledger: VictimLedger = { attacker, at, chargedShooting: false };
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
        const entry = ledger.record(victimUuid, attacker, time.time);
        if (entry.chargedShooting) {
            return;
        }
        entry.chargedShooting = true;
        const govt = fullGovernment(relations, victimGovernment.id);
        if (govt) {
            chargeCrime(player[1], ledger, govt, 'shooting');
        }
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

/**
 * Forget victims that left the world without dying, so a long session does
 * not accumulate ledger entries for ships that jumped out.
 */
const LedgerSweepSystem = new System({
    name: 'LegalLedgerSweep',
    args: [LegalLedgerResource, Entities, TimeResource, PlatformResource] as const,
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
        world.addSystem(PlayerCrimeDeathSystem);
        world.addSystem(LedgerSweepSystem);

        const gameData = world.resources.get(GameDataResource);
        if (gameData) {
            void loadGovernments(gameData, ledger);
        }
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
