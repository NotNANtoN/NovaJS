import { GetEntity } from 'nova_ecs/arg_types';
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

        world.addSystem(ShipInfoSystem);
        world.addSystem(MissionLogSystem);
    },
    remove(world) {
        world.removeSystem(ShipInfoSystem);
        world.removeSystem(MissionLogSystem);
        const shipInfo = world.resources.get(ShipInfoResource);
        shipInfo?.container.parent?.removeChild(shipInfo.container);
        world.resources.delete(ShipInfoResource);
        const missionLog = world.resources.get(MissionLogResource);
        missionLog?.container.parent?.removeChild(missionLog.container);
        world.resources.delete(MissionLogResource);
    },
};
