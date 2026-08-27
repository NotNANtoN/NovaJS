import 'jasmine';
import { createDraft, finishDraft } from 'immer';
import { Entity } from 'nova_ecs/entity';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
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
