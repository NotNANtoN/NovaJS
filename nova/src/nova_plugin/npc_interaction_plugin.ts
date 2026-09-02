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
import { ChatMessageEvent, ChatMessageEntry } from 'nova_ecs/plugins/multiplayer_plugin';
import { PlayerShipSelector } from './player_ship_plugin';
import { PlayerStateComponent } from './player_state';
import { ShipDataComponent } from './ship_plugin';
import { GovtComponent } from './npc_plugin';
import { NpcCombatRoleComponent } from './npc_components';
import { NpcTrafficComponent } from './npc_traffic_plugin';
import { MiningShipComponent } from './miner_ai';
import { PlanetComponent } from './planet_plugin';
import { ArmorComponent, ShieldComponent } from './health_plugin';
import { TargetComponent } from './target_component';
import { SystemIdResource } from './system_id_resource';
import { DisabledComponent, PlayerDeathComponent } from './death_plugin';
import { DestructionStartedComponent } from './destruction_state';
import { JumpStateComponent } from './jump_plugin';
import { v4 } from 'uuid';
import type { ShipData } from 'novadatainterface/ShipData';
import type { NpcTrafficState } from './npc_traffic';
import type { EntityMap } from 'nova_ecs/entity_map';
import type { Entity } from 'nova_ecs/entity';

const SCAN_DISTANCE = 480;
const SCAN_COOLDOWN_MS = 90_000;
const CHATTER_INTERVAL_MIN_MS = 22_000;
const CHATTER_INTERVAL_MAX_MS = 40_000;

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

function isShipOperational(
    disabled?: unknown,
    destructionStarted?: unknown,
    armor?: { current: number },
    jump?: unknown,
    playerDeath?: unknown,
): boolean {
    if (disabled !== undefined || destructionStarted !== undefined || jump !== undefined || playerDeath !== undefined) {
        return false;
    }
    if (armor && armor.current <= 0) {
        return false;
    }
    return true;
}

const PlayerQuery = new Query([
    UUID,
    MovementStateComponent,
    PlayerShipSelector,
    PlayerStateComponent,
    Optional(ShipDataComponent),
    Optional(DisabledComponent),
    Optional(DestructionStartedComponent),
    Optional(ArmorComponent),
    Optional(JumpStateComponent),
    Optional(PlayerDeathComponent),
] as const, 'PlayerQuery');

const PatrolQuery = new Query([
    UUID,
    MovementStateComponent,
    GovtComponent,
    NpcCombatRoleComponent,
    GetEntity,
    Optional(DisabledComponent),
    Optional(DestructionStartedComponent),
    Optional(ArmorComponent),
    Optional(JumpStateComponent),
] as const, 'PatrolQuery');

const PlanetQuery = new Query([
    UUID,
    PlanetComponent,
] as const, 'PlanetQuery');

const NpcShipQuery = new Query([
    UUID,
    MovementStateComponent,
    ShipDataComponent,
    Optional(GovtComponent),
    Optional(NpcCombatRoleComponent),
    Optional(NpcTrafficComponent),
    Optional(MiningShipComponent),
    Optional(ShieldComponent),
    Optional(TargetComponent),
    GetEntity,
    Optional(DisabledComponent),
    Optional(DestructionStartedComponent),
    Optional(ArmorComponent),
    Optional(JumpStateComponent),
] as const, 'NpcShipQuery');

function pickRandom<T>(items: readonly T[]): T {
    return items[Math.floor(Math.random() * items.length)];
}

function generateContextualChatter(
    _uuid: string,
    entity: Entity,
    shipData: ShipData,
    traffic: NpcTrafficState | undefined,
    miner: { mining: boolean } | undefined,
    govtId: string,
    role: string | undefined,
    targetUuid: string | undefined,
    entities: EntityMap,
    planetNames: Map<string, string>,
): { text: string; sender: string; kind: 'chatter' | 'security' } {
    const sender = entity.name || shipData.name || 'Merchant';
    const shipName = shipData.name || 'Vessel';

    // 1. Combat engagement / hunting chatter
    if (targetUuid && entities.has(targetUuid)) {
        const targetEntity = entities.get(targetUuid);
        const targetArmor = targetEntity?.components.get(ArmorComponent);
        const targetDisabled = targetEntity?.components.has(DisabledComponent);
        const targetDestroyed = targetEntity?.components.has(DestructionStartedComponent)
            || (targetArmor && targetArmor.current <= 0);

        if (targetEntity && !targetDestroyed) {
            const targetName = targetEntity.name || 'target';

            if (targetDisabled) {
                const plunderLines = [
                    `Target ${targetName} disabled! Prepare boarding party for cargo extraction!`,
                    `${targetName} is dead in the water. Commencing salvage lock.`,
                ];
                return { text: pickRandom(plunderLines), sender, kind: 'chatter' };
            }

            if (govtId === 'nova:130' || govtId === '130' || role === 'pirate' || sender.toLowerCase().includes('pirate') || sender.toLowerCase().includes('raider')) {
                const pirateLines = [
                    `Radar lock on that ${targetName}. Power down shields and eject your cargo!`,
                    `Easy mark spotted: ${targetName}. Surrender your cargo hold or be blasted to scrap!`,
                    `Closing in on ${targetName}. Cut your sublight engines immediately!`,
                ];
                return { text: pickRandom(pirateLines), sender, kind: 'chatter' };
            }
            if (role === 'military') {
                const militaryLines = [
                    `Engaging hostile contact ${targetName}! Weapons free!`,
                    `Target acquired: ${targetName}. Commencing tactical interception!`,
                    `Hostile ${targetName} under active engagement. Maintain battle formation!`,
                ];
                return { text: pickRandom(militaryLines), sender, kind: 'security' };
            }
        }
    }

    // 2. Mining ship operations
    if (miner?.mining) {
        if (targetUuid && entities.has(targetUuid)) {
            const asteroidName = entities.get(targetUuid)?.name || 'asteroid';
            const miningLines = [
                `Excavation beam locked on ${asteroidName}. Harvesting high-grade metallic ore.`,
                `Excavating mineral veins on ${asteroidName}. Core integrity stable.`,
                `Drill laser active on ${asteroidName}. Extracting industrial minerals.`,
            ];
            return { text: pickRandom(miningLines), sender, kind: 'chatter' };
        }
        return {
            text: 'Mining laser engaged on dense asteroid core. Commencing excavation.',
            sender,
            kind: 'chatter',
        };
    }
    if (miner) {
        const prospectingLines = [
            'Prospecting sensor sweep active. Scanning local belt for high-density deposits.',
            'Surveying asteroid belt. Looking for rich titanium and iron clusters.',
        ];
        return { text: pickRandom(prospectingLines), sender, kind: 'chatter' };
    }

    // 3. Traffic / Trader flight phases
    if (traffic) {
        if (traffic.phase === 'travelling' && traffic.destination) {
            const destinationName = planetNames.get(traffic.destination) || 'orbital destination';
            const travellingLines = [
                `Inbound approach vector to ${destinationName} established. Sublight cruise nominal.`,
                `En route to ${destinationName} with trade cargo. Flight corridor is clear.`,
                `On final descent approach to ${destinationName}. Docking transponder active.`,
                `Navigational lock on ${destinationName}. Speed within orbital approach limits.`,
            ];
            return { text: pickRandom(travellingLines), sender, kind: 'chatter' };
        }
        if (traffic.phase === 'docked') {
            const planetName = traffic.destination
                ? (planetNames.get(traffic.destination) || 'orbital station')
                : 'orbital station';
            const dockedLines = [
                `Docked in orbital transfer at ${planetName}. Commencing cargo discharge and refueling.`,
                `Customs cleared at ${planetName}. Trade manifest submitted to port authority.`,
                `Turnaround in progress at ${planetName}. Loading outbound shipment.`,
            ];
            return { text: pickRandom(dockedLines), sender, kind: 'chatter' };
        }
        if (traffic.phase === 'arriving') {
            return {
                text: 'Hyperspace jump complete. Synchronizing local navigation beacons.',
                sender,
                kind: 'chatter',
            };
        }
        if (traffic.phase === 'departing') {
            return {
                text: 'Cleared for departure from orbital grid. Spooling hyperdrive.',
                sender,
                kind: 'chatter',
            };
        }
    }

    // 4. Military patrol ambient radio
    if (role === 'military') {
        const patrolLines = [
            'System patrol sweep active. All orbital corridors remain secure.',
            'Maintaining standard patrol vector. No hostile contacts on scanner.',
            'Sector scan nominal. Navigational lanes clear of pirate activity.',
        ];
        return { text: pickRandom(patrolLines), sender, kind: 'security' };
    }

    // 5. Default commercial traffic
    const defaultLines = [
        `Clear skies on the shipping lanes today. All systems green on ${shipName}.`,
        'Sublight cruise nominal. Maintaining standard commercial flight vector.',
        'Long-range sensors clear. Safe flying to all captains in sector.',
    ];
    return { text: pickRandom(defaultLines), sender, kind: 'chatter' };
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
        for (const [
            playerUuid,
            playerMovement,
            _selector,
            playerState,
            playerShipData,
            playerDisabled,
            playerDestructionStarted,
            playerArmor,
            playerJump,
            playerDeath,
        ] of players) {
            if (!isShipOperational(
                playerDisabled,
                playerDestructionStarted,
                playerArmor,
                playerJump,
                playerDeath,
            )) {
                continue;
            }

            for (const [
                patrolUuid,
                patrolMovement,
                govt,
                role,
                patrolEntity,
                patrolDisabled,
                patrolDestructionStarted,
                patrolArmor,
                patrolJump,
            ] of patrols) {
                if (role !== 'military') {
                    continue;
                }
                if (!isShipOperational(
                    patrolDisabled,
                    patrolDestructionStarted,
                    patrolArmor,
                    patrolJump,
                )) {
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
                    const playerShipName = playerShipData?.name || 'vessel';

                    if (govtId === 'nova:128' || govtId === '128') {
                        // Federation
                        const record = (playerState.legalRecords && (playerState.legalRecords as Record<string, number>)['nova:128']) ?? 0;
                        if (record < 0) {
                            text = `Alert: Wanted fugitive on ${playerShipName}! Power down engines and surrender immediately!`;
                        } else {
                            const cleanLines = [
                                `Customs scan of ${playerShipName}: No contraband or illegal weapons detected. You may proceed, Captain.`,
                                `Security scan complete on ${playerShipName}. All systems within Federation regulations. Safe travels.`,
                                `Vessel registry for ${playerShipName} verified. Flight corridor clearance granted.`,
                            ];
                            text = pickRandom(cleanLines);
                        }
                    } else if (govtId === 'nova:132' || govtId === '132') {
                        // Auroran
                        const auroranLines = [
                            `Warrior's Pride: Maintain your course on ${playerShipName} and keep your weapons cold, outsider.`,
                            `Auroran Patrol: Honor the clan laws in this space and you will not be harmed.`,
                            `Patrol Scout: Transponder for ${playerShipName} logged. Do not provoke our clan ships.`,
                        ];
                        text = pickRandom(auroranLines);
                    } else if (govtId === 'nova:133' || govtId === '133') {
                        // Polaris
                        text = `Polaris Vessel: Bio-signatures on ${playerShipName} cataloged. Telemetric harmony preserved.`;
                    } else if (govtId === 'nova:129' || govtId === '129') {
                        // Rebel
                        text = `Rebel Patrol: Transponder for ${playerShipName} verified. Fly free, friend.`;
                    } else {
                        text = `Security scan of ${playerShipName} complete. All clear.`;
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
        PlanetQuery,
        Entities,
        AmbientChatterStateResource,
        TimeResource,
        Emit,
        Optional(SystemIdResource),
        SingletonComponent,
    ] as const,
    step(npcs, planets, entities, chatterState, time, emit, systemId) {
        const now = time.time;
        if (now < chatterState.nextChatterAt) {
            return;
        }

        chatterState.nextChatterAt = now + CHATTER_INTERVAL_MIN_MS +
            Math.random() * (CHATTER_INTERVAL_MAX_MS - CHATTER_INTERVAL_MIN_MS);

        if (npcs.length === 0) {
            return;
        }

        const candidates = npcs.filter(([
            , , , , , , , , , entity,
            disabled, destructionStarted, armor, jump,
        ]) =>
            !entity.components.has(PlayerShipSelector)
            && isShipOperational(disabled, destructionStarted, armor, jump));

        if (candidates.length === 0) {
            return;
        }

        const planetNames = new Map<string, string>();
        for (const [planetUuid, planet] of planets) {
            planetNames.set(planetUuid, planet.name || planet.id);
        }

        const [uuid, _pos, shipData, govt, role, traffic, miner, _shield, target, entity] =
            pickRandom(candidates);

        const govtId = String(govt?.id ?? '');
        const message = generateContextualChatter(
            uuid,
            entity,
            shipData,
            traffic,
            miner,
            govtId,
            role,
            target?.target,
            entities,
            planetNames,
        );

        if (!message) {
            return;
        }

        const entry: ChatMessageEntry = {
            id: v4(),
            from: uuid,
            fromName: message.sender,
            to: 'all',
            text: message.text,
            time: now,
            kind: message.kind,
            system: systemId,
        };
        emit(ChatMessageEvent, entry);
    },
});

export const NpcDistressSystem = new System({
    name: 'NpcDistressSystem',
    args: [
        NpcShipQuery,
        Entities,
        AmbientChatterStateResource,
        TimeResource,
        Emit,
        Optional(SystemIdResource),
        SingletonComponent,
    ] as const,
    step(npcs, entities, chatterState, time, emit, systemId) {
        const now = time.time;
        for (const [
            uuid,
            pos,
            shipData,
            _govt,
            _role,
            _traffic,
            _miner,
            shield,
            target,
            entity,
            disabled,
            destructionStarted,
            armor,
            jump,
        ] of npcs) {
            if (entity.components.has(PlayerShipSelector)) {
                continue;
            }

            if (!isShipOperational(disabled, destructionStarted, armor, jump)) {
                continue;
            }

            if (!shield || !target?.target || !entities.has(target.target)) {
                continue;
            }

            const attacker = entities.get(target.target);
            if (!attacker || attacker.components.has(DestructionStartedComponent)) {
                continue;
            }

            const shieldPct = shield.max > 0 ? shield.current / shield.max : 1;
            if (shieldPct > 0.5) {
                continue;
            }

            const lastDistress = chatterState.lastDistressByShip.get(uuid) ?? 0;
            if (now - lastDistress < 45_000) {
                continue;
            }
            chatterState.lastDistressByShip.set(uuid, now);

            const attackerName = attacker.name || 'hostiles';
            const senderName = entity.name || shipData.name || 'Merchant';
            const pct = Math.max(0, Math.round(shieldPct * 100));

            const distressLines = [
                `Mayday! Taking heavy fire from ${attackerName}! Shields down to ${pct}%! Requesting immediate backup!`,
                `Under direct attack by ${attackerName}! Shields at ${pct}% near (${Math.round(pos.position.x)}, ${Math.round(pos.position.y)})!`,
                `Hostile engagement: ${attackerName} is firing on our vessel! Shields at ${pct}%, please assist!`,
            ];

            const text = pickRandom(distressLines);

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
                nextChatterAt: 12_000,
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
