import * as t from 'io-ts';
import { STANDARD_COMMODITIES } from 'novadatainterface/CommodityData';
import { EmitNow, Entities, GetEntity, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Angle } from 'nova_ecs/datatypes/angle';
import { EcsEvent } from 'nova_ecs/events';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import {
    MovementPhysicsComponent,
    MovementStateComponent,
} from 'nova_ecs/plugins/movement_plugin';
import {
    MultiplayerData,
    replicationPolicies,
} from 'nova_ecs/plugins/multiplayer_plugin';
import { ProvideAsync } from 'nova_ecs/provide_async';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { DisabledComponent } from './death_plugin';
import { DestructionStartedComponent } from './destruction_state';
import {
    approachTarget,
    hasArrived,
    inTransferRange,
} from './flight_controller';
import { GameDataResource } from './game_data_resource';
import { JumpStateComponent } from './jump_plugin';
import {
    GovernmentData,
    GovernmentRelationResource,
    GovernmentFlags,
} from './govt_relations';
import { ArmorComponent } from './health_plugin';
import {
    GovtComponent,
    NpcAIComponent,
} from './npc_components';
import {
    ChooseRandomTargetAI,
    FollowAI,
    ShootAllWeaponsAI,
} from './npc_plugin';
import { ControlStateEvent } from './control_state_event';
import {
    CargoHold,
    PlayerState,
    PlayerStateComponent,
    releaseCargo,
} from './player_state';
import { PlatformResource } from './platform_plugin';
import { PlayerShipSelector } from './player_ship_plugin';
import { ShipComponent, ShipDataComponent } from './ship_plugin';
import { TargetComponent } from './target_component';
import { WeaponsStateComponent } from './weapons_state';
import { DerelictComponent } from './derelict_plugin';

export const BOARDING_STANDOFF = 80;
export const BOARDING_TOLERANCE = 20;
export const BOARDING_TRANSFER_RANGE = 110;
export const BOARDING_MAX_RELATIVE_SPEED = 10;
export const BOARDING_CREDIT_FRACTION = 0.25;

export const DUDE_BOOTY_MONEY = 0x0040;

export const PlunderEvent = new EcsEvent<{ boarder: string }>('PlunderEvent');

const BoardingRequest = t.type({
    target: t.string,
    sequence: t.number,
});
export type BoardingRequest = t.TypeOf<typeof BoardingRequest>;
export const BoardingRequestComponent =
    new Component<BoardingRequest>('BoardingRequestComponent');

const BoardingOutcome = t.intersection([
    t.type({
        target: t.string,
        sequence: t.number,
        cargo: t.number,
        credits: t.number,
    }),
    t.partial({
        capturedShip: t.string,
        resisted: t.boolean,
    }),
]);
export type BoardingOutcome = t.TypeOf<typeof BoardingOutcome>;
export const BoardingOutcomeComponent =
    new Component<BoardingOutcome>('BoardingOutcomeComponent');
export const BoardingOutcomeEvent =
    new EcsEvent<BoardingOutcome & { boarder: string }>(
        'BoardingOutcomeEvent');

/**
 * Why a boarding attempt did nothing. Local to the pilot's own client: it is
 * feedback, not game state, and never crosses the network.
 */
export const BoardingNoticeComponent =
    new Component<{ text: string }>('BoardingNoticeComponent');

const DudeSource = t.type({ id: t.string });
export type DudeSource = t.TypeOf<typeof DudeSource>;
/**
 * Spawn provenance for ambient ships. `npc_spawn_plugin.ts` must attach this
 * only for a düde-backed entry; flët entries have different booty rules.
 */
export const DudeSourceComponent =
    new Component<DudeSource>('DudeSourceComponent');

const DudeBooty = t.type({ flags: t.number });
export type DudeBooty = t.TypeOf<typeof DudeBooty>;
export const DudeBootyComponent =
    new Component<DudeBooty>('DudeBootyComponent');

const BoardingInventory = t.type({
    cargoCapacity: t.number,
    credits: t.number,
    holds: t.array(CargoHold),
});
export type BoardingInventory = t.TypeOf<typeof BoardingInventory>;
export const BoardingInventoryComponent =
    new Component<BoardingInventory>('BoardingInventoryComponent');

const PirateBoarder = t.type({ enabled: t.boolean });
export type PirateBoarder = t.TypeOf<typeof PirateBoarder>;
export const PirateBoarderComponent =
    new Component<PirateBoarder>('PirateBoarderComponent');

const BoardingState = t.type({
    boarded: t.array(t.string),
});
export type BoardingState = t.TypeOf<typeof BoardingState>;
export const BoardingStateComponent =
    new Component<BoardingState>('BoardingStateComponent');

replicationPolicies.register(DudeSourceComponent, {
    codec: DudeSource,
    authority: 'server',
});
replicationPolicies.register(DudeBootyComponent, {
    codec: DudeBooty,
    authority: 'server',
});
// Input crosses multiplayer as an intent; validation and transfer stay server-authoritative.
replicationPolicies.register(BoardingRequestComponent, {
    codec: BoardingRequest,
    authority: 'owning-client',
});
replicationPolicies.register(BoardingOutcomeComponent, {
    codec: BoardingOutcome,
    authority: 'server',
});
replicationPolicies.register(BoardingInventoryComponent, {
    codec: BoardingInventory,
    authority: 'server',
});
replicationPolicies.register(PirateBoarderComponent, {
    codec: PirateBoarder,
    authority: 'server',
});
replicationPolicies.register(BoardingStateComponent, {
    codec: BoardingState,
    authority: 'server',
});

/**
 * Retail marks the governments that board rather than merely destroy with a
 * gövt flag, so plug-in factions and the raiders that are not named "pirate" —
 * Marauder, Houseless Warriors, Spanner, Family Moash — behave correctly.
 */
export function plundersDisabledShips(
    government: Pick<GovernmentData, 'flags'>,
): boolean {
    return ((government.flags ?? 0) & GovernmentFlags.warshipsPlunder) !== 0;
}

export function bootyCommodities(flags: number): string[] {
    // EV Nova Bible, düde/Flags: bits 0x0001 through 0x0020 respectively
    // mean food, industrial goods, medical supplies, luxury goods, metal and
    // equipment "when plundered".
    return STANDARD_COMMODITIES.filter(
        (_commodity, index) => (flags & (1 << index)) !== 0);
}

export function initialNpcInventory(
    ship: { cargoCapacity: number, cost: number },
    bootyFlags: number,
): BoardingInventory {
    const cargoCapacity = Math.max(0, Math.floor(ship.cargoCapacity));
    const commodities = bootyCommodities(bootyFlags);
    const cargoTons = Math.floor(cargoCapacity / 2);
    const baseTons = commodities.length > 0
        ? Math.floor(cargoTons / commodities.length) : 0;
    let remainder = commodities.length > 0
        ? cargoTons % commodities.length : 0;
    return {
        cargoCapacity,
        // The Bible specifies that the amount depends on purchase price but
        // does not publish retail's coefficient.
        credits: (bootyFlags & DUDE_BOOTY_MONEY) !== 0
            ? Math.max(0, Math.floor(ship.cost * 0.001)) : 0,
        holds: commodities.flatMap(commodity => {
            const tons = baseTons + (remainder-- > 0 ? 1 : 0);
            return tons > 0 ? [{
                commodity,
                tons,
                isMissionCargo: false,
            }] : [];
        }),
    };
}

export const DudeBootyProvider = ProvideAsync({
    name: 'DudeBootyProvider',
    provided: DudeBootyComponent,
    update: [DudeSourceComponent],
    args: [DudeSourceComponent, GameDataResource] as const,
    async factory(source, gameData) {
        const dudes = gameData.data.Dude;
        if (!dudes) {
            return { flags: 0 };
        }
        const dude = await dudes.get(source.id);
        return { flags: dude.flags };
    },
});

export const BoardingSetupSystem = new System({
    name: 'BoardingSetupSystem',
    args: [
        UUID,
        NpcAIComponent,
        GovtComponent,
        ShipDataComponent,
        GetEntity,
        Optional(BoardingInventoryComponent),
        Optional(PirateBoarderComponent),
        Optional(BoardingStateComponent),
        Optional(DudeSourceComponent),
        Optional(DudeBootyComponent),
        GovernmentRelationResource,
        MultiplayerData,
        PlatformResource,
    ] as const,
    step(_uuid, _npc, governmentRef, ship, entity, inventory, pirate, boarding,
        dudeSource, dudeBooty, governments, multiplayer, platform) {
        if (platform !== 'node' || multiplayer.owner !== 'server') {
            return;
        }
        if (!inventory) {
            if (dudeSource && !dudeBooty) {
                return;
            }
            entity.components.set(
                BoardingInventoryComponent,
                initialNpcInventory(ship, dudeBooty?.flags ?? 0));
        }
        if (pirate && boarding) {
            return;
        }

        const government = governments.getCached(governmentRef.id);
        if (!government) {
            return;
        }
        entity.components.set(PirateBoarderComponent, {
            enabled: plundersDisabledShips(government),
        });
        entity.components.set(BoardingStateComponent, { boarded: [] });
    },
});

function heldCargo(inventory: Pick<BoardingInventory, 'holds'>): number {
    return inventory.holds.reduce((total, hold) =>
        total + Math.max(0, Math.floor(hold.tons)), 0);
}

function addCargo(
    inventory: BoardingInventory,
    commodity: string,
    tons: number,
): void {
    const existing = inventory.holds.find(hold =>
        !hold.isMissionCargo && hold.commodity === commodity);
    if (existing) {
        existing.tons += tons;
    } else {
        inventory.holds.push({
            commodity,
            tons,
            isMissionCargo: false,
        });
    }
}

function releaseNpcCargo(
    inventory: BoardingInventory,
    commodity: string,
    tons: number,
): number {
    let remaining = tons;
    let removed = 0;
    for (let index = inventory.holds.length - 1;
        index >= 0 && remaining > 0; index--) {
        const hold = inventory.holds[index];
        if (hold.isMissionCargo || hold.commodity !== commodity) {
            continue;
        }
        const amount = Math.min(remaining, hold.tons);
        hold.tons -= amount;
        remaining -= amount;
        removed += amount;
        if (hold.tons <= 0) {
            inventory.holds.splice(index, 1);
        }
    }
    return removed;
}

export interface PlunderResult {
    cargo: number;
    credits: number;
}

export function plunderShip(
    boarder: BoardingInventory,
    victimPlayer: PlayerState | undefined,
    victimNpc: BoardingInventory | undefined,
): PlunderResult {
    const victim = victimPlayer ?? victimNpc;
    if (!victim) {
        return { cargo: 0, credits: 0 };
    }

    let freeSpace = Math.max(
        0, Math.floor(boarder.cargoCapacity - heldCargo(boarder)));
    let cargo = 0;
    const cargoSnapshot = victim.holds
        .filter(hold => !hold.isMissionCargo && hold.tons > 0)
        .map(hold => ({ commodity: hold.commodity, tons: hold.tons }));
    for (const hold of cargoSnapshot) {
        const requested = Math.min(freeSpace, Math.floor(hold.tons));
        if (requested <= 0) {
            break;
        }
        const removed = victimPlayer
            ? releaseCargo(victimPlayer, hold.commodity, requested)
            : releaseNpcCargo(victimNpc!, hold.commodity, requested);
        addCargo(boarder, hold.commodity, removed);
        freeSpace -= removed;
        cargo += removed;
    }

    const credits = Math.min(
        Math.max(0, Math.floor(victim.credits)),
        Math.max(0, Math.floor(
            victim.credits * BOARDING_CREDIT_FRACTION)),
    );
    victim.credits -= credits;
    boarder.credits += credits;
    return { cargo, credits };
}

export function isBoardingTransferReady(
    boarder: Parameters<typeof hasArrived>[0],
    target: Parameters<typeof hasArrived>[1],
): boolean {
    return hasArrived(boarder, target, {
        standoff: BOARDING_STANDOFF,
        tolerance: BOARDING_TOLERANCE,
        maxSpeed: BOARDING_MAX_RELATIVE_SPEED,
    }) && inTransferRange(boarder, target, BOARDING_TRANSFER_RANGE);
}

const DisabledBoardingTargets = new Query([
    UUID,
    DisabledComponent,
    MovementStateComponent,
    Optional(PlayerStateComponent),
    Optional(BoardingInventoryComponent),
    Optional(DestructionStartedComponent),
    Optional(ArmorComponent),
    Optional(ShipDataComponent),
    Optional(ShipComponent),
    Optional(DerelictComponent),
] as const, 'DisabledBoardingTargets');

export const PlayerBoardingInputSystem = new System({
    name: 'PlayerBoardingInput',
    events: [ControlStateEvent],
    args: [
        ControlStateEvent,
        TargetComponent,
        MovementStateComponent,
        Optional(BoardingRequestComponent),
        Optional(BoardingStateComponent),
        DisabledBoardingTargets,
        PlatformResource,
        GetEntity,
        PlayerShipSelector,
    ] as const,
    step(controlState, target, movement, request, boarding, disabledTargets,
        platform, entity) {
        if (platform !== 'browser' || controlState.get('board') !== 'start') {
            return;
        }
        const targetUuid = target.target;
        if (!targetUuid || boarding?.boarded.includes(targetUuid)) {
            return;
        }
        const victim = disabledTargets.find(candidate =>
            candidate[0] === targetUuid && candidate[1] && !candidate[5]);
        if (!victim) {
            entity.components.set(BoardingNoticeComponent,
                { text: 'That ship cannot be boarded.' });
            return;
        }
        // Retail expects the pilot to fly alongside themselves, so the intent
        // is only raised from boarding range. Sending it from anywhere would
        // leave a standing request that fires whenever the pilot happened to
        // drift close again, possibly long after they had lost interest.
        if (!isBoardingTransferReady(movement, victim[2])) {
            entity.components.set(BoardingNoticeComponent,
                { text: 'Too far away to board.' });
            return;
        }
        entity.components.set(BoardingRequestComponent, {
            target: targetUuid,
            sequence: (request?.sequence ?? 0) + 1,
        });
    },
});

export const PlayerBoardingSystem = new System({
    name: 'PlayerBoarding',
    args: [
        BoardingRequestComponent,
        PlayerStateComponent,
        MovementStateComponent,
        MultiplayerData,
        DisabledBoardingTargets,
        PlatformResource,
        Optional(BoardingStateComponent),
        Optional(DestructionStartedComponent),
        Optional(ArmorComponent),
        UUID,
        GetEntity,
        EmitNow,
        Entities,
    ] as const,
    step(request, player, movement, multiplayer, disabledTargets, platform,
        boarding, destructionStarted, armor, uuid, entity, emitNow, entities) {
        if (platform !== 'node' || multiplayer.owner === 'server'
            || destructionStarted || armor && armor.current <= 0
            || boarding?.boarded.includes(request.target)) {
            return;
        }
        const victim = disabledTargets.find(candidate =>
            candidate[0] === request.target && candidate[0] !== uuid
            && candidate[1] && !candidate[5]
            && (!candidate[6] || candidate[6]!.current > 0));
        if (!victim || !isBoardingTransferReady(movement, victim[2])) {
            return;
        }

        const result = plunderShip(player, victim[3], victim[4]);
        const isNpc = !victim[3];
        const victimShipData = victim[7];
        const victimShip = victim[8];

        let capturedShip: string | undefined;
        let resisted: boolean | undefined;

        const isDerelict = Boolean(victim[9]);
        if (isNpc && (victimShip || victimShipData)) {
            const victimShipId = victimShip?.id ?? victimShipData?.id ?? 'nova:128';
            const rawName = victimShipData?.name ?? 'Ship';
            const shipName = isDerelict ? `Derelict ${rawName}` : rawName;
            const currentEscorts = player.escorts ?? [];
            const maxEscorts = 6;
            if (currentEscorts.length < maxEscorts) {
                const playerCrew = (player.kills ?? 0) > 10 ? 25 : 15;
                const victimCrew = isDerelict ? 0 : (victimShipData?.crew ?? 5);
                const captureChance = isDerelict
                    ? 0.85
                    : Math.min(0.9, Math.max(0.35, (playerCrew + 10) / (playerCrew + victimCrew + 10)));
                if (Math.random() < captureChance) {
                    const dailyPay = Math.max(10, Math.floor((victimShipData?.cost ?? 50000) * 0.001));
                    const newContract = {
                        id: `capture-${uuid}-${Date.now()}`,
                        shipId: victimShipId,
                        dailyPay,
                    };
                    player.escorts = [...currentEscorts, newContract];
                    entity.components.set(PlayerStateComponent, player);
                    capturedShip = shipName;
                    entities.delete(request.target);
                } else {
                    resisted = true;
                }
            }
        }

        entity.components.set(BoardingStateComponent, {
            boarded: [...(boarding?.boarded ?? []), request.target],
        });
        const outcome = {
            target: request.target,
            sequence: request.sequence,
            cargo: result.cargo,
            credits: result.credits,
            ...(capturedShip ? { capturedShip } : {}),
            ...(resisted ? { resisted } : {}),
        };
        entity.components.set(BoardingOutcomeComponent, outcome);
        emitNow(BoardingOutcomeEvent, { ...outcome, boarder: uuid }, [uuid]);
        if (result.cargo > 0 || result.credits > 0) {
            emitNow(PlunderEvent, { boarder: uuid }, [request.target]);
        }
    },
});

function ceaseFire(
    weapons: Map<string, {
        count: number,
        firing: boolean,
        target?: string,
    }> | undefined,
): void {
    for (const weapon of weapons?.values() ?? []) {
        weapon.firing = false;
        weapon.target = undefined;
    }
}

function departFrom(
    movement: {
        accelerating: number,
        position: { x: number, y: number },
        turnBack: boolean,
        turning: number,
        turnTo?: string | Angle | null,
    },
    victim: { position: { x: number, y: number } },
): void {
    const awayX = movement.position.x - victim.position.x;
    const awayY = movement.position.y - victim.position.y;
    movement.turnTo = new Angle(Math.atan2(awayX, -awayY));
    movement.accelerating = 1;
    movement.turning = 0;
    movement.turnBack = false;
}

export const PirateBoardingSystem = new System({
    name: 'PirateBoardingSystem',
    after: [ChooseRandomTargetAI, FollowAI, ShootAllWeaponsAI],
    args: [
        PirateBoarderComponent,
        BoardingStateComponent,
        BoardingInventoryComponent,
        TargetComponent,
        MovementStateComponent,
        MovementPhysicsComponent,
        Optional(WeaponsStateComponent),
        DisabledBoardingTargets,
        Entities,
        MultiplayerData,
        PlatformResource,
        NpcAIComponent,
        Optional(DisabledComponent),
        Optional(DestructionStartedComponent),
        Optional(ArmorComponent),
        Optional(JumpStateComponent),
        UUID,
        EmitNow,
    ] as const,
    step(pirate, boarding, inventory, target, movement, physics, weapons,
        disabledTargets, entities, multiplayer, platform, _npc,
        disabled, destructionStarted, armor, jumpState, uuid, emitNow) {
        if (!pirate.enabled || platform !== 'node'
            || multiplayer.owner !== 'server' || disabled
            || destructionStarted
            || armor && armor.current <= 0
            || jumpState) {
            return;
        }

        const targetUuid = target.target;
        if (!targetUuid) {
            return;
        }
        if (boarding.boarded.includes(targetUuid)) {
            const boarded = disabledTargets.find(candidate =>
                candidate[0] === targetUuid);
            if (boarded?.[3]) {
                // Mission data proves the player can be boarded by pirates.
                // Unlike NPC plunder, gövt 0x1000 does not say to destroy the
                // player afterwards, so disengage instead of parking on them.
                target.target = undefined;
                departFrom(movement, boarded[2]);
                ceaseFire(weapons);
            }
            return;
        }

        const victim = disabledTargets.find(candidate =>
            candidate[0] === targetUuid && candidate[1]
            && !candidate[5] && (!candidate[6] || candidate[6]!.current > 0));
        if (!victim || !entities.has(targetUuid)) {
            return;
        }

        ceaseFire(weapons);
        const victimMovement = victim[2];
        if (isBoardingTransferReady(movement, victimMovement)) {
            const result = plunderShip(inventory, victim[3], victim[4]);
            boarding.boarded.push(targetUuid);
            if (result.cargo > 0 || result.credits > 0) {
                emitNow(PlunderEvent, { boarder: uuid }, [targetUuid]);
            }
            if (victim[3]) {
                target.target = undefined;
                departFrom(movement, victimMovement);
            }
            return;
        }

        const command = approachTarget(movement, victimMovement, {
            acceleration: physics.acceleration,
            maxVelocity: physics.maxVelocity,
            turnRate: physics.turnRate,
        }, {
            standoff: BOARDING_STANDOFF,
            tolerance: BOARDING_TOLERANCE,
        });
        movement.turnTo = command.turnTo;
        movement.accelerating = command.accelerating;
        movement.turnBack = command.turnBack;
    },
});

export const BoardingPlugin: Plugin = {
    name: 'BoardingPlugin',
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }
        world.addComponent(BoardingInventoryComponent);
        deltaMaker.addComponent(BoardingInventoryComponent, {
            componentType: BoardingInventory,
        });
        world.addComponent(BoardingNoticeComponent);
        world.addComponent(BoardingRequestComponent);
        deltaMaker.addComponent(BoardingRequestComponent, {
            componentType: BoardingRequest,
        });
        world.addComponent(BoardingOutcomeComponent);
        deltaMaker.addComponent(BoardingOutcomeComponent, {
            componentType: BoardingOutcome,
        });
        world.addComponent(PirateBoarderComponent);
        deltaMaker.addComponent(PirateBoarderComponent, {
            componentType: PirateBoarder,
        });
        world.addComponent(BoardingStateComponent);
        deltaMaker.addComponent(BoardingStateComponent, {
            componentType: BoardingState,
        });
        // Provenance and booty stay on the server: what a ship is carrying
        // should not be readable by the client before it is boarded.
        world.addComponent(DudeSourceComponent);
        world.addComponent(DudeBootyComponent);
        if (world.resources.get(GameDataResource)) {
            world.addSystem(DudeBootyProvider);
        }
        world.addSystem(BoardingSetupSystem);
        world.addSystem(PlayerBoardingInputSystem);
        world.addSystem(PlayerBoardingSystem);
        world.addSystem(PirateBoardingSystem);
    },
    remove(world) {
        world.removeSystem(DudeBootyProvider);
        world.removeSystem(BoardingSetupSystem);
        world.removeSystem(PlayerBoardingInputSystem);
        world.removeSystem(PlayerBoardingSystem);
        world.removeSystem(PirateBoardingSystem);
    },
};
