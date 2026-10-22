import 'jasmine';
import { Entity } from 'nova_ecs/entity';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { MockGameData } from 'novadatainterface/MockGameData';
import { getDefaultSystemData } from 'novadatainterface/SystemData';
import {
    createInitialPlayerState,
    createMissionGoalProgress,
    PlayerStateComponent,
} from './player_state';
import {
    areWingmates,
    calculateWingCombatShare,
    deriveWingId,
    findCoopMissionGoalRecipients,
    isCombatSharedMissionGoal,
    resolveWingJumpTarget,
} from './wing';

describe('Co-op Wing & Shared Combat Goals', () => {
    it('identifies wingmates only when both share a non-empty wingId', () => {
        const a = createInitialPlayerState();
        const b = createInitialPlayerState();
        expect(areWingmates(a, b)).toBeFalse();

        const wingId = deriveWingId(undefined, 'peer-b', 'peer-a');
        expect(wingId).toBe('wing:peer-a:peer-b');
        a.wingId = wingId;
        expect(areWingmates(a, b)).toBeFalse();
        b.wingId = wingId;
        expect(areWingmates(a, b)).toBeTrue();
    });

    it('shares combat ship goals across wingmates in the same system while excluding non-wingmates and non-combat goals', () => {
        const leader = createInitialPlayerState();
        const wingmate = createInitialPlayerState();
        const stranger = createInitialPlayerState();
        leader.wingId = 'wing:alpha';
        wingmate.wingId = 'wing:alpha';

        leader.activeMissions = [{
            missionId: 'nova:200',
            missionUuid: 'leader-m200',
            state: 'active',
            shipSystem: 'nova:128',
            shipGoalProgress: createMissionGoalProgress(0 /* Destroy */, 2),
        }];
        wingmate.activeMissions = [{
            missionId: 'nova:200',
            missionUuid: 'wingmate-m200',
            state: 'active',
            shipSystem: 'nova:128',
            shipGoalProgress: createMissionGoalProgress(0 /* Destroy */, 2),
        }, {
            missionId: 'nova:205',
            missionUuid: 'wingmate-observe',
            state: 'active',
            shipSystem: 'nova:128',
            shipGoalProgress: createMissionGoalProgress(4 /* Observe */, 1),
        }];
        stranger.activeMissions = [{
            missionId: 'nova:200',
            missionUuid: 'stranger-m200',
            state: 'active',
            shipSystem: 'nova:128',
            shipGoalProgress: createMissionGoalProgress(0 /* Destroy */, 2),
        }];

        const players = [
            ['uuid-leader', { owner: 'token-leader' }, leader],
            ['uuid-wingmate', { owner: 'token-wingmate' }, wingmate],
            ['uuid-stranger', { owner: 'token-stranger' }, stranger],
        ] as const;

        const recipients = findCoopMissionGoalRecipients(
            players,
            'token-leader',
            'leader-m200',
            undefined,
            'nova:128',
        );

        expect(recipients).toEqual([
            { playerUuid: 'uuid-leader', missionUuid: 'leader-m200' },
            { playerUuid: 'uuid-wingmate', missionUuid: 'wingmate-m200' },
        ]);
        expect(isCombatSharedMissionGoal(0)).toBeTrue();
        expect(isCombatSharedMissionGoal(1)).toBeTrue();
        expect(isCombatSharedMissionGoal(6)).toBeTrue();
        expect(isCombatSharedMissionGoal(4)).toBeFalse();
        expect(calculateWingCombatShare(40_000)).toBe(10_000);
        expect(calculateWingCombatShare(0)).toBe(2_500);
    });

    it('routes a jumping pilot into their wingmate’s system variant when jumping to the same system while allowing independent jumps elsewhere', () => {
        const gameData = new MockGameData();
        gameData.data.System.map.set('nova:128', {
            ...getDefaultSystemData(),
            id: 'nova:128',
            name: 'Sol',
            position: [0, 0],
            links: ['nova:129'],
            visibility: '!b10',
        });
        gameData.data.System.map.set('nova:371', {
            ...getDefaultSystemData(),
            id: 'nova:371',
            name: 'Sol',
            position: [0, 0],
            links: ['nova:129'],
            visibility: 'b10',
        });
        gameData.data.System.map.set('nova:129', {
            ...getDefaultSystemData(),
            id: 'nova:129',
            name: 'Alpha Centauri',
            position: [40, 0],
            links: ['nova:128', 'nova:130'],
        });
        gameData.data.System.map.set('nova:130', {
            ...getDefaultSystemData(),
            id: 'nova:130',
            name: 'Wolf 359',
            position: [-40, 0],
            links: ['nova:129'],
        });

        const pilotA = createInitialPlayerState();
        const pilotB = createInitialPlayerState();
        pilotA.wingId = 'wing:coop';
        pilotB.wingId = 'wing:coop';
        // Pilot B has bit 10 set and an active combat mission in Sol (nova:371)
        pilotB.missionBits[10] = true;
        pilotB.activeMissions = [{
            missionId: 'nova:500',
            missionUuid: 'm500',
            state: 'active',
            shipSystem: 'nova:371',
            shipGoalProgress: createMissionGoalProgress(0, 1),
        }];

        const entities = new Map<string, Entity>([
            ['ship-a', new Entity()
                .addComponent(MultiplayerData, { owner: 'peer-a' })
                .addComponent(PlayerStateComponent, pilotA)],
            ['ship-b', new Entity()
                .addComponent(MultiplayerData, { owner: 'peer-b' })
                .addComponent(PlayerStateComponent, pilotB)],
        ]);

        // Pilot A does NOT have bit 10 set, but when jumping to Sol ('nova:128')
        // while in a Wing with Pilot B, Pilot A routes into 'nova:371' so they
        // land in the same fight room!
        const solTarget = resolveWingJumpTarget(
            'nova:128',
            ['nova:128', 'nova:130'],
            pilotA,
            entities,
            gameData.data.System,
        );
        expect(solTarget).toBe('nova:371');

        // Pilot A can still independently jump to Wolf 359 ('nova:130')
        const wolfTarget = resolveWingJumpTarget(
            'nova:130',
            ['nova:128', 'nova:130'],
            pilotA,
            entities,
            gameData.data.System,
        );
        expect(wolfTarget).toBe('nova:130');
    });
});
