import 'jasmine';
import { createDraft, finishDraft } from 'immer';
import { Entity } from 'nova_ecs/entity';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { MissionShipComponent, MissionShipBoardedSystem, applyGoalRecordingDelta,
    recordShipGoalDetached } from './mission_ship_plugin';
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

    it('matches target systems across storyline system clones and falls back to missionData.shipSyst', () => {
        const systems = new Map([
            ['nova:204', { name: 'Outbound', position: [275, -51] as [number, number] }],
            ['nova:542', { name: 'Outbound', position: [275, -51] as [number, number] }],
        ]);

        const bountyWithoutShipSystem = {
            ...mission,
            missionId: 'proc:bounty:1',
            shipSystem: undefined,
            missionData: {
                shipSyst: 542,
                shipGoal: 1,
                shipCount: 1,
            },
        };

        const entity = playerEntity([bountyWithoutShipSystem]);

        // Player is in Outbound active clone nova:204, bounty targets clone nova:542
        const candidates = collectMissionSpawnCandidates(
            [['player', entity]], undefined, 'nova:204', systems);

        expect(candidates[0].missions.length).toBe(1);
        expect(candidates[0].missions[0].missionId).toBe('proc:bounty:1');
        expect(candidates[0].missions[0].shipSystem).toBe('nova:542');
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

describe('detached special-ship goal recording', () => {
    it('writes only the recorded changes onto the current state', () => {
        const before = createInitialPlayerState();
        before.activeMissions = [{ missionId: 'nova:1', missionUuid: 'a', state: 'active' }];
        const after = createInitialPlayerState();
        after.activeMissions = [{ missionId: 'nova:1', missionUuid: 'a', state: 'active',
            shipGoalProgress: { goal: 0, total: 1, destroyed: 1, disabled: 0, boarded: 0,
                observed: 0, lost: 0, completed: true, shipDoneApplied: true } }];
        after.missionBits[5] = true;
        after.credits += 500;
        const current = createInitialPlayerState();
        current.activeMissions = [...before.activeMissions,
            { missionId: 'nova:2', missionUuid: 'b', state: 'active' }];
        current.credits = 3;
        current.missionBits[9] = true;
        const merged = applyGoalRecordingDelta(current, before, after);
        expect(merged.missionBits[5]).toBeTrue();
        expect(merged.missionBits[9]).toBeTrue();
        expect(merged.credits).toBe(503);
        expect(merged.activeMissions.map(entry => entry.missionUuid)).toEqual(['a', 'b']);
        expect(merged.activeMissions[0].shipGoalProgress?.destroyed).toBe(1);
        expect(merged.freeSpace).toBe(current.freeSpace);
    });

    it('does not touch a draft after it has been revoked', async () => {
        const state = createInitialPlayerState();
        const draft = createDraft(state);
        const entity = new Entity('p').addComponent(PlayerStateComponent, draft);
        const runtime = {
            async recordShipGoal(working: PlayerState) {
                await Promise.resolve();
                working.missionBits[3] = true;
                return true;
            },
        };
        const pending = recordShipGoalDetached(runtime as never,
            new Map([['p', entity]]), 'p', 'm', 'destroyed');
        // The step ends: the draft is finished and replaced.
        entity.components.set(PlayerStateComponent, finishDraft(draft));
        await pending;
        expect(entity.components.get(PlayerStateComponent)!.missionBits[3]).toBeTrue();
    });
});

describe('MissionShipBoardedSystem', () => {
    it('records boarded event when a mission ship is boarded', async () => {
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
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(recorded.length).toBe(1);
        expect(recorded[0].uuid).toBe('uuid-mission-1');
        expect(recorded[0].event).toBe('boarded');
    });
});
