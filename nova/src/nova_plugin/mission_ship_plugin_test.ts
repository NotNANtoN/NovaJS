import 'jasmine';
import { createDraft, finishDraft } from 'immer';
import { Entity } from 'nova_ecs/entity';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { MissionShipComponent, MissionShipBoardedSystem } from './mission_ship_plugin';
import {
    collectMissionSpawnCandidates,
    missionShipAppearsInSystem,
} from './mission_ship_plugin';
import { PlayerState, PlayerStateComponent } from './player_state';
import { createInitialPlayerState } from './player_state';

describe('mission ship system matching', () => {
    it('matches a mission ship system against the current system', () => {
        expect(missionShipAppearsInSystem('nova:130', 'nova:130')).toBeTrue();
        expect(missionShipAppearsInSystem('nova:130', 'nova:131')).toBeFalse();
    });
});

describe('mission ship spawn candidates', () => {
    function playerEntity(missions: PlayerState['activeMissions']): Entity {
        const state = createInitialPlayerState();
        state.activeMissions = missions;
        return new Entity()
            .addComponent(MultiplayerData, { owner: 'client-1' })
            .addComponent(PlayerStateComponent, createDraft(state));
    }

    const mission = {
        missionId: 'nova:150',
        state: 'active' as const,
        shipSystem: 'nova:130',
        acceptedDate: 7,
    };

    it('detaches mission entries from the drafts they came from', () => {
        // The spawn loop awaits mission and ship data, and each await lets the
        // world step, which revokes these drafts. Reading one afterwards threw
        // and took the server process down.
        const entity = playerEntity([mission]);
        const candidates = collectMissionSpawnCandidates(
            [['player', entity]], undefined, 'nova:130');
        finishDraft(entity.components.get(PlayerStateComponent));

        expect(candidates.length).toBe(1);
        expect(candidates[0].token).toBe('client-1');
        expect(candidates[0].missions.length).toBe(1);
        expect(candidates[0].missions[0].missionId).toBe('nova:150');
        expect(candidates[0].missions[0].acceptedDate).toBe(7);
    });

    it('keeps only active missions due in this system', () => {
        const entity = playerEntity([
            mission,
            { ...mission, missionId: 'nova:151', shipSystem: 'nova:999' },
            { ...mission, missionId: 'nova:152', state: 'failed' as const },
            { ...mission, missionId: 'nova:153', shipSystem: undefined },
        ]);

        const candidates = collectMissionSpawnCandidates(
            [['player', entity]], undefined, 'nova:130');

        expect(candidates[0].missions.map(entry => entry.missionId))
            .toEqual(['nova:150']);
    });

    it('uses the store token for the owning peer when there is one', () => {
        const candidates = collectMissionSpawnCandidates(
            [['player', playerEntity([mission])]],
            { getTokenForPeer: (peer: string) => `token-${peer}` } as never,
            'nova:130');

        expect(candidates[0].token).toBe('token-client-1');
    });

    it('skips entities that are not players', () => {
        expect(collectMissionSpawnCandidates(
            [['npc', new Entity()
                .addComponent(MultiplayerData, { owner: 'server' })]],
            undefined,
            'nova:130',
        )).toEqual([]);
    });
});

describe('MissionShipBoardedSystem', () => {
    it('records boarded event when a mission ship is boarded', () => {
        const playerState = createInitialPlayerState();
        playerState.activeMissions = [{
            missionId: 'nova:200',
            missionUuid: 'uuid-mission-1',
            state: 'active',
        }];

        const playerEntity = new Entity('player-1')
            .addComponent(MultiplayerData, { owner: 'client-1' })
            .addComponent(PlayerStateComponent, playerState);

        const targetEntity = new Entity('target-ship')
            .addComponent(MissionShipComponent, {
                missionUuid: 'uuid-mission-1',
                playerToken: 'client-1',
            });

        const entities = new Map<string, Entity>([
            ['player-1', playerEntity],
            ['target-ship', targetEntity],
        ]);

        const recorded: { state: PlayerState; uuid: string; event: string }[] = [];
        const mockRuntime = {
            recordShipGoal(state: PlayerState, uuid: string, event: string) {
                recorded.push({ state, uuid, event });
                return Promise.resolve(true);
            },
        };

        const outcome = {
            target: 'target-ship',
            sequence: 1,
            cargo: 0,
            credits: 0,
            boarder: 'player-1',
        };

        const players = [['player-1', { owner: 'client-1' }, playerState]] as const;

        MissionShipBoardedSystem.step(
            outcome,
            entities,
            players as never,
            undefined,
            mockRuntime as never,
            'node',
        );

        expect(recorded.length).toBe(1);
        expect(recorded[0].uuid).toBe('uuid-mission-1');
        expect(recorded[0].event).toBe('boarded');
    });
});
