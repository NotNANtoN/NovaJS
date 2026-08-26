import { ShipData } from 'novadatainterface/ShipData';
import {
    Emit,
    EmitFunction,
    Entities,
    GetEntity,
    UUID,
} from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Plugin } from 'nova_ecs/plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import {
    MovementPhysicsComponent,
    MovementState,
    MovementStateComponent,
} from 'nova_ecs/plugins/movement_plugin';
import { approachTarget } from './flight_controller';
import { Optional } from 'nova_ecs/optional';
import { Query } from 'nova_ecs/query';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { SingletonComponent } from 'nova_ecs/world';
import { v4 as uuid } from 'uuid';
import {
    FinishJumpEvent,
    InitiateJumpEvent,
    JumpStateComponent,
} from './jump_plugin';
import { ArmorComponent } from './health_plugin';
import { DisabledComponent } from './death_plugin';
import { GameDataResource } from './game_data_resource';
import {
    FollowAI,
    GovtComponent,
    NpcFleeComponent,
    NpcAIComponent,
    makeNpc,
} from './npc_plugin';
import {
    NpcCombatRoleComponent,
} from './npc_components';
import type { NpcCombatRole } from './npc_components';
import { getShipAIProfile } from './ship_ai_profile';
import { MiningShipComponent } from './miner_ai';
import { landingCapabilities, PlanetComponent } from './planet_plugin';
import { PlatformResource } from './platform_plugin';
import {
    chooseTrafficDeparture,
    chooseTrafficDestination,
    decideTrafficLanding,
    shouldYieldToCombat,
    shouldTrafficDepart,
    trafficDwellDuration,
    TRAFFIC_APPROACH_STANDOFF,
} from './npc_traffic';
import type {
    NpcTrafficState,
    TrafficDestination,
    TrafficRandom,
} from './npc_traffic';
import {
    getShipMovementPhysics,
    ShipDataComponent,
} from './ship_plugin';
import { SystemIdResource } from './system_id_resource';
import { TargetComponent } from './target_component';
import { EntityBudgetResource, reserveEntity } from './entity_budget';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import type { PlanetType } from './planet_plugin';
import type { GameDataInterface } from 'novadatainterface/GameDataInterface';

/**
 * This is deliberately a server-only component. It is not registered with
 * DeltaPlugin, because browsers only need the resulting ship movement and
 * deletion, not the server's traffic scheduler.
 */
export const NpcTrafficComponent =
    new Component<NpcTrafficState>('NpcTrafficComponent');

export const NpcTrafficRandomResource =
    new Resource<TrafficRandom>('NpcTrafficRandomResource');

export interface DockedNpcTraffic {
    shipData: ShipData;
    government: number;
    combatRole: NpcCombatRole;
    stellarUuid: string;
    stellarId: string;
    position: [number, number];
    launchAt: number;
}

export interface NpcTrafficRuntime {
    docked: Map<string, DockedNpcTraffic>;
}

export const NpcTrafficResource =
    new Resource<NpcTrafficRuntime>('NpcTrafficResource');

/**
 * A bounded docked manifest prevents repeated NPC replacement by the ordinary
 * population system from becoming an unbounded server-side queue.
 */
export const MAX_DOCKED_TRAFFIC = 32;
export const TRAFFIC_LAUNCH_OFFSET = 600;

type TrafficPlanet = readonly [
    string,
    MovementState,
    PlanetType,
];

const TrafficPlanetsQuery = new Query([
    UUID,
    MovementStateComponent,
    PlanetComponent,
] as const, 'NpcTrafficPlanets');

function destinationFor(
    [uuid, movement, planet]: TrafficPlanet,
    origin: { position: Position },
): TrafficDestination {
    const capabilities = landingCapabilities(planet);
    return {
        uuid,
        id: planet.id,
        distanceSquared: movement.position
            .subtract(origin.position).lengthSquared,
        ...capabilities,
    };
}

function destinationPlanet(
    planets: readonly TrafficPlanet[],
    destination: string | undefined,
): TrafficPlanet | undefined {
    return destination === undefined
        ? undefined
        : planets.find(([uuid]) => uuid === destination);
}

function startDeparture(
    traffic: NpcTrafficState,
    movement: MovementState,
    uuid: string,
    gameData: GameDataInterface,
    systemId: string | undefined,
    random: TrafficRandom,
    emit: EmitFunction,
): void {
    traffic.phase = 'departing';
    delete traffic.destination;
    movement.turnTo = null;
    movement.accelerating = 0;

    const system = systemId === undefined
        ? undefined
        : gameData.data.System.getCached(systemId);
    const available = new Set(
        (system?.links ?? []).filter(link =>
            gameData.data.System.getCached(link) !== undefined),
    );
    const destination = chooseTrafficDeparture(
        system?.links ?? [],
        available,
        random,
    );
    if (destination) {
        emit(InitiateJumpEvent, { to: destination }, [uuid]);
    }
}

function launchDirection(
    source: Position,
    destination: Position | undefined,
): Vector {
    const delta = destination
        ? destination.subtract(source)
        : new Vector(-source.x, -source.y);
    return delta.lengthSquared > 0
        ? delta.normalize()
        : new Vector(0, -1);
}

const NpcTrafficFlightSystem = new System({
    name: 'NpcTrafficFlight',
    after: [FollowAI],
    args: [
        NpcTrafficComponent,
        NpcAIComponent,
        ShipDataComponent,
        GovtComponent,
        Optional(NpcCombatRoleComponent),
        MovementStateComponent,
        MovementPhysicsComponent,
        TargetComponent,
        TrafficPlanetsQuery,
        Entities,
        UUID,
        MultiplayerData,
        PlatformResource,
        TimeResource,
        Optional(NpcFleeComponent),
        Optional(JumpStateComponent),
        Optional(DisabledComponent),
        Optional(ArmorComponent),
        Optional(MiningShipComponent),
        GameDataResource,
        // A world with no system id has nowhere to depart to; that must not
        // stop the plugin from loading, as it did for NpcPurposeAI.
        Optional(SystemIdResource),
        Emit,
        NpcTrafficResource,
        NpcTrafficRandomResource,
        GetEntity,
    ] as const,
    step(
        traffic,
        _npc,
        shipData,
        government,
        combatRole,
        movement,
        physics,
        target,
        planets,
        entities,
        uuid,
        multiplayer,
        platform,
        time,
        fleeing,
        jumpState,
        disabled,
        armor,
        miner,
        gameData,
        systemId,
        emit,
        runtime,
        random,
        entity,
    ) {
        if (platform !== 'node' || multiplayer.owner !== 'server') {
            return;
        }

        const profile = getShipAIProfile(shipData).role;
        if (profile !== 'wimpy-trader' && profile !== 'brave-trader'
            || miner?.mining) {
            entity.components.delete(NpcTrafficComponent);
            return;
        }

        const liveTarget = target.target !== undefined
            && entities.has(target.target);
        const destroyed = Boolean(
            disabled
            || jumpState
            || armor && armor.current <= 0,
        );
        if (shouldYieldToCombat(
            liveTarget,
            fleeing !== undefined,
            Boolean(jumpState),
            destroyed,
        )) {
            return;
        }

        if (traffic.phase === 'departing') {
            startDeparture(
                traffic,
                movement,
                uuid,
                gameData,
                systemId,
                random,
                emit,
            );
            return;
        }

        if (traffic.phase === 'arriving') {
            if (time.time < traffic.readyAt) {
                movement.turnTo = null;
                movement.accelerating = 0;
                return;
            }
            const selected = chooseTrafficDestination(
                planets.map(planet => destinationFor(planet, movement)),
                random,
            );
            if (!selected) {
                startDeparture(
                    traffic,
                    movement,
                    uuid,
                    gameData,
                    systemId,
                    random,
                    emit,
                );
                return;
            }
            traffic.phase = 'travelling';
            traffic.destination = selected.uuid;
        }

        let planet = destinationPlanet(planets, traffic.destination);
        if (!planet || !landingCapabilities(planet[2]).canLand
            || !landingCapabilities(planet[2]).inhabited) {
            const selected = chooseTrafficDestination(
                planets.map(candidate => destinationFor(candidate, movement)),
                random,
                traffic.destination,
            );
            if (!selected) {
                startDeparture(
                    traffic,
                    movement,
                    uuid,
                    gameData,
                    systemId,
                    random,
                    emit,
                );
                return;
            }
            traffic.destination = selected.uuid;
            planet = destinationPlanet(planets, selected.uuid);
        }
        if (!planet) {
            startDeparture(
                traffic,
                movement,
                uuid,
                gameData,
                systemId,
                random,
                emit,
            );
            return;
        }

        const candidate = destinationFor(planet, movement);
        const landing = decideTrafficLanding(
            traffic.destination,
            candidate,
            candidate.distanceSquared,
            movement.velocity.lengthSquared,
        );
        if (landing === 'depart') {
            startDeparture(
                traffic,
                movement,
                uuid,
                gameData,
                systemId,
                random,
                emit,
            );
            return;
        }
        if (landing === 'select') {
            traffic.destination = candidate.uuid;
        }
        if (landing === 'land') {
            if (runtime.docked.size >= MAX_DOCKED_TRAFFIC) {
                startDeparture(
                    traffic,
                    movement,
                    uuid,
                    gameData,
                    systemId,
                    random,
                    emit,
                );
                return;
            }
            runtime.docked.set(uuid, {
                shipData,
                government: government.id,
                combatRole: combatRole ?? 'personal',
                stellarUuid: planet[0],
                stellarId: candidate.id,
                position: [planet[1].position.x, planet[1].position.y],
                launchAt: time.time + trafficDwellDuration(random),
            });
            entities.delete(uuid);
            return;
        }

        const command = approachTargetForTraffic(
            movement,
            planet[1],
            physics,
        );
        movement.turnTo = command.turnTo;
        movement.accelerating = command.accelerating;
        movement.turnBack = command.turnBack;
    },
});

function approachTargetForTraffic(
    movement: MovementState,
    target: MovementState,
    physics: import('nova_ecs/plugins/movement_plugin').MovementPhysics,
) {
    return approachTarget(
        movement,
        target,
        physics,
        {
            standoff: TRAFFIC_APPROACH_STANDOFF,
            tolerance: 20,
            caution: 0.85,
        },
    );
}

const NpcTrafficLaunchSystem = new System({
    name: 'NpcTrafficLaunch',
    before: [NpcTrafficFlightSystem],
    args: [
        SingletonComponent,
        NpcTrafficResource,
        TimeResource,
        PlatformResource,
        TrafficPlanetsQuery,
        Entities,
        EntityBudgetResource,
        NpcTrafficRandomResource,
    ] as const,
    step(_singleton, runtime, time, platform, planets, entities, budget, random) {
        if (platform !== 'node') {
            return;
        }

        const due = [...runtime.docked.entries()]
            .filter(([, record]) => record.launchAt <= time.time)
            .sort(([a], [b]) => a.localeCompare(b));
        for (const [recordId, record] of due) {
            const source = record.position;
            const sourcePosition = new Position(source[0], source[1]);
            const candidates = planets.map(planet =>
                destinationFor(planet, { position: sourcePosition }));
            const destination = shouldTrafficDepart(random)
                ? undefined
                : chooseTrafficDestination(
                    candidates,
                    random,
                    record.stellarUuid,
                );
            const destinationPlanetEntity = destinationPlanet(
                planets,
                destination?.uuid,
            );
            const direction = launchDirection(
                sourcePosition,
                destinationPlanetEntity?.[1].position,
            );
            const ship = makeNpc(record.shipData);
            if (!reserveEntity(budget, ship, 'ship')) {
                break;
            }

            const movement = ship.components.get(MovementStateComponent)!;
            movement.position = new Position(
                sourcePosition.x + direction.x * TRAFFIC_LAUNCH_OFFSET,
                sourcePosition.y + direction.y * TRAFFIC_LAUNCH_OFFSET,
            );
            movement.rotation = direction.angle;
            movement.velocity = new Vector(0, 0);
            ship.components
                .set(ShipDataComponent, record.shipData)
                .set(MovementPhysicsComponent,
                    getShipMovementPhysics(record.shipData.physics))
                .set(GovtComponent, { id: record.government })
                .set(NpcCombatRoleComponent, record.combatRole)
                .set(MultiplayerData, { owner: 'server' })
                .set(NpcTrafficComponent, destination
                    ? {
                        phase: 'travelling',
                        destination: destination.uuid,
                        readyAt: time.time,
                    }
                    : {
                        phase: 'departing',
                        readyAt: time.time,
                    });
            entities.set(uuid(), ship);
            runtime.docked.delete(recordId);
        }
    },
});

/**
 * JumpPlugin removes an entity from its source world before publishing this
 * event. Keep this system singleton-scoped and mutate the event's entity
 * directly, so arrival state survives the world transfer.
 */
const NpcTrafficArrivalSystem = new System({
    name: 'NpcTrafficArrival',
    events: [FinishJumpEvent],
    args: [
        FinishJumpEvent,
        SingletonComponent,
        PlatformResource,
    ] as const,
    step(jump, _singleton, platform) {
        if (platform !== 'node'
            || jump.entity.components.get(MultiplayerData)?.owner
                !== 'server') {
            return;
        }
        const traffic = jump.entity.components.get(NpcTrafficComponent);
        if (!traffic) {
            return;
        }
        traffic.phase = 'arriving';
        delete traffic.destination;
        traffic.readyAt = 0;
    },
});

export const NpcTrafficPlugin: Plugin = {
    name: 'NpcTrafficPlugin',
    build(world) {
        if (!world.resources.has(NpcTrafficRandomResource)) {
            world.resources.set(NpcTrafficRandomResource, Math.random);
        }
        world.resources.set(NpcTrafficResource, { docked: new Map() });
        world.addComponent(NpcTrafficComponent);
        world.addSystem(NpcTrafficLaunchSystem);
        world.addSystem(NpcTrafficFlightSystem);
        world.addSystem(NpcTrafficArrivalSystem);
    },
    remove(world) {
        world.removeSystem(NpcTrafficLaunchSystem);
        world.removeSystem(NpcTrafficFlightSystem);
        world.removeSystem(NpcTrafficArrivalSystem);
        world.resources.delete(NpcTrafficResource);
        world.resources.delete(NpcTrafficRandomResource);
    },
};
