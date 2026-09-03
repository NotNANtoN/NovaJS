import { Entities, GetEntity, GetWorld, UUID, Emit } from 'nova_ecs/arg_types';
import { Optional } from 'nova_ecs/optional';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { AsyncSystem } from 'nova_ecs/async_system';
import { Plugin } from 'nova_ecs/plugin';
import { Resource } from 'nova_ecs/resource';
import { GameData } from '../client/gamedata/GameData';
import {
    ControlsSubject,
    EcsControlEvent,
} from '../nova_plugin/controls_plugin';
import { GameDataResource } from '../nova_plugin/game_data_resource';
import { PlayerShipSelector } from '../nova_plugin/player_ship_plugin';
import { SystemIdResource } from '../nova_plugin/system_id_resource';
import { MissionInfo } from '../spaceport/mission_bbs';
import { ShipInfo } from '../spaceport/ship_info';
import { Comms } from '../spaceport/comms_panel';
import { BoardingDialog, BoardingDialogResource } from '../spaceport/boarding_dialog';
import { BoardingRequestComponent, BoardingStateComponent, DisabledBoardingTargets, isBoardingTransferReady, heldCargo, BoardingNoticeComponent } from '../nova_plugin/boarding_plugin';
import { SoundEvent } from '../nova_plugin/sound_event';
import { PlayerChatDialog } from '../spaceport/player_chat_dialog';
import { TargetComponent } from '../nova_plugin/target_component';
import { GovtComponent } from '../nova_plugin/npc_components';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import {
    GovernmentRelationResource,
    GovernmentRelationStore,
    canHailGovernment,
    getGovernmentCommName,
} from '../nova_plugin/govt_relations';
import { describeHail } from '../nova_plugin/hail_target';
import { PlayerStateComponent } from '../nova_plugin/player_state';
import { ShipDataComponent } from '../nova_plugin/ship_plugin';
import { PlanetDataComponent } from '../nova_plugin/planet_plugin';
import { FleetMemberComponent } from '../nova_plugin/fleet_plugin';
import { ScreenSize } from './screen_size_plugin';
import { Stage } from './stage_resource';
import {
    handlePilotDialogEvent,
    isDialogStartEdge,
} from './pilot_dialogs_control';

export {
    handlePilotDialogEvent,
    isDialogStartEdge,
} from './pilot_dialogs_control';

export const ShipInfoResource = new Resource<ShipInfo>('ShipInfo');
export const MissionLogResource = new Resource<MissionInfo>('MissionLog');
export const CommsResource = new Resource<Comms>('Comms');
export const PlayerChatDialogResource = new Resource<PlayerChatDialog>('PlayerChatDialog');
export { BoardingDialogResource } from '../spaceport/boarding_dialog';

/** Retail's "P" pilot status, available in flight as well as when landed. */
export const ShipInfoSystem = new AsyncSystem({
    name: 'ShipInfoSystem',
    events: [EcsControlEvent] as const,
    exclusive: true,
    alwaysRunOnEvents: false,
    skipIfApplyingPatches: true,
    args: [EcsControlEvent, ShipInfoResource, ScreenSize, GetEntity,
        PlayerShipSelector] as const,
    async step(controlEvent, shipInfo, screenSize, entity) {
        return handlePilotDialogEvent(
            controlEvent, 'properties', shipInfo, screenSize, entity);
    },
});

/** Retail's "I" mission log. */
export const MissionLogSystem = new AsyncSystem({
    name: 'MissionLogSystem',
    events: [EcsControlEvent] as const,
    exclusive: true,
    alwaysRunOnEvents: false,
    skipIfApplyingPatches: true,
    args: [EcsControlEvent, MissionLogResource, ScreenSize, GetEntity,
        PlayerShipSelector] as const,
    async step(controlEvent, missionLog, screenSize, entity) {
        return handlePilotDialogEvent(
            controlEvent, 'missions', missionLog, screenSize, entity);
    },
});

/**
 * Retail's hail dialog, opened with the hail key while a ship is targeted.
 * Hailing nothing does nothing, which is also what retail does.
 */
export const CommsSystem = new AsyncSystem({
    name: 'CommsSystem',
    events: [EcsControlEvent] as const,
    exclusive: true,
    alwaysRunOnEvents: false,
    skipIfApplyingPatches: true,
    args: [EcsControlEvent, CommsResource, PlayerChatDialogResource, ScreenSize, GetEntity, UUID,
        TargetComponent, Entities, GovernmentRelationResource,
        PlayerShipSelector, GetWorld] as const,
    async step(controlEvent, comms, playerChatDialog, screenSize, entity, uuid, target, entities,
        governments, _playerSelector, world) {
        if (!isDialogStartEdge(controlEvent, 'hail', comms.container.visible || playerChatDialog.container.visible)) {
            return;
        }
        const hailed = target.target
            ? entities.get(target.target) : undefined;
        if (!hailed) {
            return;
        }

        const planetData = hailed.components.get(PlanetDataComponent);
        if (planetData) {
            comms.setTarget({
                name: planetData.name,
                relation: 'neutral',
                record: 0,
                hostile: false,
                isPlanet: true,
            });
            comms.container.position.set(screenSize.x / 2, screenSize.y / 2);
            await comms.show(entity);
            return;
        }

        const shipData = hailed.components.get(ShipDataComponent);
        if (!shipData) {
            return;
        }
        const multiplayer = hailed.components.get(MultiplayerData);
        if (multiplayer && multiplayer.owner !== 'server' && multiplayer.owner !== uuid) {
            const hailedPlayerState = hailed.components.get(PlayerStateComponent);
            const pilotName = hailedPlayerState?.pilotName || 'Captain';
            playerChatDialog.setTarget({
                peerUuid: multiplayer.owner,
                pilotName,
                shipName: shipData.name,
            }, world);
            playerChatDialog.container.position.set(screenSize.x / 2, screenSize.y / 2);
            await playerChatDialog.show(entity);
            return;
        }
        const govtId = hailed.components.get(GovtComponent)?.id;
        const government = govtId === undefined
            ? undefined : governments.getCached(govtId);
        if (government && !canHailGovernment(government)) {
            return;
        }
        const playerState = entity.components.get(PlayerStateComponent);
        const fleetMember = hailed.components.get(FleetMemberComponent);
        const isEscort = fleetMember?.role === 'escort';
        comms.setTarget(describeHail({
            name: government
                ? `${getGovernmentCommName(government)} ${shipData.name}`
                : shipData.name,
            government,
            targetingPlayer:
                hailed.components.get(TargetComponent)?.target === uuid,
            isEscort,
        }, playerState?.legalRecords));
        comms.container.position.set(screenSize.x / 2, screenSize.y / 2);
        await comms.show(entity);
    },
});


/**
 * In-flight Boarding modal, opened with the board key when matching speed
 * alongside a disabled ship. Offers Plunder, Capture, and Leave actions.
 */
export const BoardingSystem = new AsyncSystem({
    name: 'BoardingSystem',
    events: [EcsControlEvent] as const,
    exclusive: true,
    alwaysRunOnEvents: false,
    skipIfApplyingPatches: true,
    args: [
        EcsControlEvent,
        BoardingDialogResource,
        ScreenSize,
        GetEntity,
        TargetComponent,
        MovementStateComponent,
        Optional(BoardingRequestComponent),
        Optional(BoardingStateComponent),
        DisabledBoardingTargets,
        PlayerShipSelector,
        Emit,
    ] as const,
    async step(controlEvent, boardingDialog, screenSize, entity, target,
        movement, request, boarding, disabledTargets, _player, emit) {
        if (!isDialogStartEdge(controlEvent, 'board', (boardingDialog as any).container.visible)) {
            return;
        }
        const targetUuid = target.target;
        if (!targetUuid || boarding?.boarded.includes(targetUuid)) {
            entity.components.set(BoardingNoticeComponent,
                { text: 'That ship cannot be boarded.' });
            return;
        }
        const victim = disabledTargets.find((candidate: any) =>
            candidate[0] === targetUuid && candidate[1] && !candidate[5]);
        if (!victim) {
            entity.components.set(BoardingNoticeComponent,
                { text: 'That ship cannot be boarded.' });
            return;
        }
        if (!isBoardingTransferReady(movement, victim[2])) {
            entity.components.set(BoardingNoticeComponent,
                { text: 'Too far away to board.' });
            return;
        }

        emit(SoundEvent, { id: 'nova:390' });

        const isDerelict = Boolean(victim[9]);
        const victimShipData = victim[7];
        const victimShip = victim[8];
        const victimInventory = victim[4];

        const shipType = victimShipData?.name ?? victimShip?.id ?? 'Unknown Vessel';
        const shipName = isDerelict ? `Derelict ${shipType}` : shipType;
        const credits = victimInventory?.credits ?? Math.max(500, Math.floor((victimShipData?.cost ?? 50000) * 0.001));
        const cargoTons = victimInventory ? heldCargo(victimInventory) : Math.floor((victimShipData?.cargoCapacity ?? 20) / 2);
        const crew = isDerelict ? 0 : (victimShipData?.crew ?? 5);

        boardingDialog.container.position.set(screenSize.x / 2, screenSize.y / 2);
        await boardingDialog.show({
            uuid: targetUuid,
            shipName,
            shipType,
            credits,
            cargoTons,
            crew,
            isDerelict,
        });

        const action = boardingDialog.getSelectedAction();
        if (action === 'leave') {
            return;
        }

        entity.components.set(BoardingRequestComponent, {
            target: targetUuid,
            sequence: (request?.sequence ?? 0) + 1,
            action,
        });
    },
});

export const PilotDialogsPlugin: Plugin = {
    name: 'PilotDialogsPlugin',
    build(world) {
        const gameData = world.resources.get(GameDataResource);
        if (!gameData) {
            throw new Error('Expected GameDataResource to exist');
        }
        const controls = world.resources.get(ControlsSubject);
        if (!controls) {
            throw new Error('Expected ControlsSubject to exist');
        }
        const stage = world.resources.get(Stage);
        if (!stage) {
            throw new Error('Expected Stage to exist');
        }

        const shipInfo = new ShipInfo(gameData as GameData, controls);
        stage.addChild(shipInfo.container);
        world.resources.set(ShipInfoResource, shipInfo);

        const missionLog = new MissionInfo(gameData as GameData, controls);
        stage.addChild(missionLog.container);
        world.resources.set(MissionLogResource, missionLog);

        // Pilot status names the system the pilot is flying in, which the
        // cockpit knows but the dialog does not.
        const systemId = world.resources.get(SystemIdResource);
        if (systemId) {
            void (gameData as GameData).data.System.get(systemId)
                .then(system => shipInfo.setSystemName(system.name))
                .catch(() => shipInfo.setSystemName(undefined));
        }

        const comms = new Comms(gameData as GameData, controls);
        stage.addChild(comms.container);
        world.resources.set(CommsResource, comms);

        const playerChatDialog = new PlayerChatDialog(gameData as GameData, controls);
        stage.addChild(playerChatDialog.container);

        const boardingDialog = new BoardingDialog(gameData as GameData, controls);
        stage.addChild(boardingDialog.container);
        world.resources.set(BoardingDialogResource, boardingDialog);
        world.resources.set(PlayerChatDialogResource, playerChatDialog);

        // Hailing needs the government cache. Plugin build order is not
        // guaranteed, so seed it here rather than skipping the dialog when the
        // NPC plugin has not been built yet.
        if (!world.resources.get(GovernmentRelationResource)) {
            world.resources.set(
                GovernmentRelationResource,
                new GovernmentRelationStore(gameData));
        }

        world.addSystem(ShipInfoSystem);
        world.addSystem(MissionLogSystem);
        world.addSystem(CommsSystem);
        world.addSystem(BoardingSystem);
    },
    remove(world) {
        world.removeSystem(ShipInfoSystem);
        world.removeSystem(MissionLogSystem);
        world.removeSystem(CommsSystem);
        world.removeSystem(BoardingSystem);
        const comms = world.resources.get(CommsResource);
        comms?.container.parent?.removeChild(comms.container);
        world.resources.delete(CommsResource);
        const playerChatDialog = world.resources.get(PlayerChatDialogResource);
        playerChatDialog?.container.parent?.removeChild(playerChatDialog.container);
        world.resources.delete(PlayerChatDialogResource);
        const boardingDialog = world.resources.get(BoardingDialogResource);
        (boardingDialog as any)?.container.parent?.removeChild(boardingDialog.container);
        world.resources.delete(BoardingDialogResource);
        const shipInfo = world.resources.get(ShipInfoResource);
        shipInfo?.container.parent?.removeChild(shipInfo.container);
        world.resources.delete(ShipInfoResource);
        const missionLog = world.resources.get(MissionLogResource);
        missionLog?.container.parent?.removeChild(missionLog.container);
        world.resources.delete(MissionLogResource);
    },
};
