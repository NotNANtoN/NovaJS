import { Emit, Entities, GetEntity, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { Query } from 'nova_ecs/query';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { SingletonComponent } from 'nova_ecs/world';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { ChatMessageEvent, ChatMessageEntry, MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { PlayerShipSelector } from './player_ship_plugin';
import { PlayerStateComponent } from './player_state';
import { ShipDataComponent } from './ship_plugin';
import { GovtComponent } from './npc_plugin';
import { NpcCombatRoleComponent } from './npc_components';
import { NpcTrafficComponent } from './npc_traffic_plugin';
import { ShieldComponent } from './health_plugin';
import { TargetComponent } from './target_component';
import { SystemIdResource } from './system_id_resource';
import { v4 } from 'uuid';

const SCAN_DISTANCE = 480;
const SCAN_COOLDOWN_MS = 90_000;
const CHATTER_INTERVAL_MIN_MS = 25_000;
const CHATTER_INTERVAL_MAX_MS = 45_000;

interface SecurityScanState {
    lastScanByPatrol: Map<string /* patrolUuid */, number /* time */>;
}

export const SecurityScanResource =
    new Resource<SecurityScanState>('SecurityScanResource');

interface AmbientChatterState {
    nextChatterAt: number;
    lastDistressByShip: Map<string, number>;
}

export const AmbientChatterStateResource =
    new Resource<AmbientChatterState>('AmbientChatterStateResource');

const PlayerQuery = new Query([
    UUID,
    MovementStateComponent,
    PlayerShipSelector,
    PlayerStateComponent,
    Optional(ShipDataComponent),
] as const, 'PlayerQuery');

const PatrolQuery = new Query([
    UUID,
    MovementStateComponent,
    GovtComponent,
    NpcCombatRoleComponent,
    GetEntity,
] as const, 'PatrolQuery');

const NpcShipQuery = new Query([
    UUID,
    MovementStateComponent,
    ShipDataComponent,
    Optional(GovtComponent),
    Optional(NpcTrafficComponent),
    Optional(ShieldComponent),
    Optional(TargetComponent),
    GetEntity,
] as const, 'NpcShipQuery');

const FEDERATION_SCAN_CLEAN = [
    'Vessel scanned. No contraband or illegal weapons detected. You may proceed, Captain.',
    'Security scan complete. All systems within Federation regulations. Safe travels.',
    'Customs scan clean. Maintain sublight velocity until clear of the orbital lanes.',
];

const FEDERATION_SCAN_BOUNTY = [
    'Alert: Wanted fugitive detected on sensors! Power down weapons and surrender!',
    'Security breach! Known offender identified. Stand down immediately!',
];

const AURORAN_PATROL_LINES = [
    'Warrior\'s Pride: Maintain your course and keep your weapons cold, outsider.',
    'Auroran Patrol: Honor the clan laws in this space and you will not be harmed.',
    'Patrol Vessel: State your clan and purpose in our territory.',
];

const POLARIS_PATROL_LINES = [
    'Polaris Vessel: Telemetric resonance verified. Harmony preserved.',
    'Patrol Scout: Bio-signatures cataloged. Safe transit through our space.',
];

const REBEL_PATROL_LINES = [
    'Rebel Patrol: Transponder verified. Fly free, friend.',
    'Freedom Scout: Space is clear ahead. Watch for Federation battlefleets.',
];

const TRADER_CHATTER = [
    'Heavy Freighter: Approaching planetary orbit with a bulk shipment of industrial parts.',
    'Merchant: Clear lanes along the hypergate route today. Good flying.',
    'Cargo Hauler: Just topped off fuel at the orbital spaceport. Moving out.',
    'Transport: Watch out for raiders near the outer jump points.',
    'Civilian Courier: En route to destination. All systems nominal.',
];

const MINER_CHATTER = [
    'Mining Vessel: High-yield metal asteroid located in the outer belt.',
    'Prospector: Excavation beam active on rich ore deposit.',
    'Ore Freighter: Full cargo hold of titanium ore, returning to spaceport.',
];

const PIRATE_CHATTER = [
    'Marauder: Unmarked merchant vessels on radar... closing in.',
    'Raider: Keep eyes open for stragglers near the asteroid field.',
];

const DISTRESS_CALLS = [
    'Under heavy fire! Requesting urgent assistance in this sector!',
    'Mayday, mayday! Hostiles closing in, shields critical!',
    'Taking direct hull hits! Any available vessels, please assist!',
];

function pickRandom<T>(items: readonly T[]): T {
    return items[Math.floor(Math.random() * items.length)];
}

export const NpcSecurityScanSystem = new System({
    name: 'NpcSecurityScanSystem',
    args: [
        PlayerQuery,
        PatrolQuery,
        SecurityScanResource,
        TimeResource,
        Emit,
        Optional(SystemIdResource),
        SingletonComponent,
    ] as const,
    step(players, patrols, scanState, time, emit, systemId) {
        if (players.length === 0 || patrols.length === 0) {
            return;
        }

        const now = time.time;
        for (const [playerUuid, playerMovement, _selector, playerState] of players) {
            for (const [patrolUuid, patrolMovement, govt, role, patrolEntity] of patrols) {
                if (role !== 'military') {
                    continue;
                }

                const lastScan = scanState.lastScanByPatrol.get(patrolUuid) ?? 0;
                if (now - lastScan < SCAN_COOLDOWN_MS) {
                    continue;
                }

                const dist2 = patrolMovement.position
                    .subtract(playerMovement.position).lengthSquared;
                if (dist2 <= SCAN_DISTANCE * SCAN_DISTANCE) {
                    scanState.lastScanByPatrol.set(patrolUuid, now);

                    const patrolName = patrolEntity.name || 'Patrol';
                    let text = '';
                    const govtId = String(govt.id);

                    if (govtId === 'nova:128' || govtId === '128') {
                        // Federation
                        const record = playerState.legalRecord ?? 0;
                        text = record < 0
                            ? pickRandom(FEDERATION_SCAN_BOUNTY)
                            : pickRandom(FEDERATION_SCAN_CLEAN);
                    } else if (govtId === 'nova:132' || govtId === '132') {
                        // Auroran
                        text = pickRandom(AURORAN_PATROL_LINES);
                    } else if (govtId === 'nova:133' || govtId === '133') {
                        // Polaris
                        text = pickRandom(POLARIS_PATROL_LINES);
                    } else if (govtId === 'nova:129' || govtId === '129') {
                        // Rebel
                        text = pickRandom(REBEL_PATROL_LINES);
                    } else {
                        text = 'Security scan complete. All clear.';
                    }

                    const entry: ChatMessageEntry = {
                        id: v4(),
                        from: patrolUuid,
                        fromName: patrolName,
                        to: playerUuid,
                        text,
                        time: now,
                        kind: 'security',
                        system: systemId,
                    };
                    emit(ChatMessageEvent, entry);
                }
            }
        }
    },
});

export const NpcAmbientChatterSystem = new System({
    name: 'NpcAmbientChatterSystem',
    args: [
        NpcShipQuery,
        AmbientChatterStateResource,
        TimeResource,
        Emit,
        Optional(SystemIdResource),
        SingletonComponent,
    ] as const,
    step(npcs, chatterState, time, emit, systemId) {
        const now = time.time;
        if (now < chatterState.nextChatterAt) {
            return;
        }

        chatterState.nextChatterAt = now + CHATTER_INTERVAL_MIN_MS +
            Math.random() * (CHATTER_INTERVAL_MAX_MS - CHATTER_INTERVAL_MIN_MS);

        if (npcs.length === 0) {
            return;
        }

        // Filter out non-player NPCs that are intact
        const candidates = npcs.filter(([, , , , , , , entity]) =>
            !entity.components.has(PlayerShipSelector));
        if (candidates.length === 0) {
            return;
        }

        const [uuid, _pos, shipData, govt, _traffic, _shield, _target, entity] =
            pickRandom(candidates);

        let lines = TRADER_CHATTER;
        const nameLower = (shipData.name || '').toLowerCase();
        const govtId = String(govt?.id ?? '');

        if (nameLower.includes('miner') || nameLower.includes('excavator')) {
            lines = MINER_CHATTER;
        } else if (govtId === 'nova:130' || govtId === '130' || nameLower.includes('pirate') || nameLower.includes('raider')) {
            lines = PIRATE_CHATTER;
        }

        const text = pickRandom(lines);
        const senderName = entity.name || shipData.name || 'Merchant';

        const entry: ChatMessageEntry = {
            id: v4(),
            from: uuid,
            fromName: senderName,
            to: 'all',
            text,
            time: now,
            kind: 'chatter',
            system: systemId,
        };
        emit(ChatMessageEvent, entry);
    },
});

export const NpcDistressSystem = new System({
    name: 'NpcDistressSystem',
    args: [
        NpcShipQuery,
        AmbientChatterStateResource,
        TimeResource,
        Emit,
        Optional(SystemIdResource),
        SingletonComponent,
    ] as const,
    step(npcs, chatterState, time, emit, systemId) {
        const now = time.time;
        for (const [uuid, _pos, shipData, _govt, traffic, shield, target, entity] of npcs) {
            if (entity.components.has(PlayerShipSelector)) {
                continue;
            }

            // Only civilian / trader ships that are attacked and low on shields
            if (!traffic || !shield || !target?.target) {
                continue;
            }

            const shieldPct = shield.max > 0 ? shield.current / shield.max : 1;
            if (shieldPct > 0.5) {
                continue;
            }

            const lastDistress = chatterState.lastDistressByShip.get(uuid) ?? 0;
            if (now - lastDistress < 60_000) {
                continue;
            }
            chatterState.lastDistressByShip.set(uuid, now);

            const text = pickRandom(DISTRESS_CALLS);
            const senderName = entity.name || shipData.name || 'Merchant';

            const entry: ChatMessageEntry = {
                id: v4(),
                from: uuid,
                fromName: senderName,
                to: 'all',
                text,
                time: now,
                kind: 'sos',
                system: systemId,
            };
            emit(ChatMessageEvent, entry);
        }
    },
});

export const NpcInteractionPlugin: Plugin = {
    name: 'NpcInteractionPlugin',
    build(world) {
        if (!world.resources.has(SecurityScanResource)) {
            world.resources.set(SecurityScanResource, {
                lastScanByPatrol: new Map(),
            });
        }
        if (!world.resources.has(AmbientChatterStateResource)) {
            world.resources.set(AmbientChatterStateResource, {
                nextChatterAt: 10_000,
                lastDistressByShip: new Map(),
            });
        }
        if (!world.resources.has(SystemIdResource)) {
            world.resources.set(SystemIdResource, 'nova:128');
        }

        world.addSystem(NpcSecurityScanSystem);
        world.addSystem(NpcAmbientChatterSystem);
        world.addSystem(NpcDistressSystem);
    },
    remove(world) {
        world.removeSystem(NpcSecurityScanSystem);
        world.removeSystem(NpcAmbientChatterSystem);
        world.removeSystem(NpcDistressSystem);
    },
};
