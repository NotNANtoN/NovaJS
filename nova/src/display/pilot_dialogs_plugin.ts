import { Entities, GetEntity, UUID } from 'nova_ecs/arg_types';
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
import { TargetComponent } from '../nova_plugin/target_component';
import { GovtComponent } from '../nova_plugin/npc_components';
import {
    GovernmentRelationResource,
    GovernmentRelationStore,
    canHailGovernment,
    getGovernmentCommName,
} from '../nova_plugin/govt_relations';
import { describeHail } from '../nova_plugin/hail_target';
import { PlayerStateComponent } from '../nova_plugin/player_state';
import { ShipDataComponent } from '../nova_plugin/ship_plugin';
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
    args: [EcsControlEvent, CommsResource, ScreenSize, GetEntity, UUID,
        TargetComponent, Entities, GovernmentRelationResource,
        PlayerShipSelector] as const,
    async step(controlEvent, comms, screenSize, entity, uuid, target, entities,
        governments) {
        if (!isDialogStartEdge(controlEvent, 'hail', comms.container.visible)) {
            return;
        }
        const hailed = target.target
            ? entities.get(target.target) : undefined;
        const shipData = hailed?.components.get(ShipDataComponent);
        if (!hailed || !shipData) {
            return;
        }
        const govtId = hailed.components.get(GovtComponent)?.id;
        const government = govtId === undefined
            ? undefined : governments.getCached(govtId);
        if (government && !canHailGovernment(government)) {
            return;
        }
        const playerState = entity.components.get(PlayerStateComponent);
        comms.setTarget(describeHail({
            name: government
                ? `${getGovernmentCommName(government)} ${shipData.name}`
                : shipData.name,
            government,
            targetingPlayer:
                hailed.components.get(TargetComponent)?.target === uuid,
        }, playerState?.legalRecords));
        comms.container.position.set(screenSize.x / 2, screenSize.y / 2);
        await comms.show(entity);
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
    },
    remove(world) {
        world.removeSystem(ShipInfoSystem);
        world.removeSystem(MissionLogSystem);
        world.removeSystem(CommsSystem);
        const comms = world.resources.get(CommsResource);
        comms?.container.parent?.removeChild(comms.container);
        world.resources.delete(CommsResource);
        const shipInfo = world.resources.get(ShipInfoResource);
        shipInfo?.container.parent?.removeChild(shipInfo.container);
        world.resources.delete(ShipInfoResource);
        const missionLog = world.resources.get(MissionLogResource);
        missionLog?.container.parent?.removeChild(missionLog.container);
        world.resources.delete(MissionLogResource);
    },
};
