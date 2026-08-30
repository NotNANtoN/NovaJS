import 'jasmine';
import { MockGameData } from 'novadatainterface/MockGameData';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';
import {
    MovementState,
    MovementStateComponent,
} from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { World } from 'nova_ecs/world';
import { DeathEvent } from './death_plugin';
import { GameDataResource } from './game_data_resource';
import {
    EscortDefenseSystem,
    EscortPlugin,
    EscortRoster,
    EscortRosterComponent,
    HandleEscortDestruction,
    HiredEscortComponent,
    RemoveDismissedEscorts,
    SyncEscortRoster,
    availableEscortOffers,
    dismissEscort,
    escortPayroll,
    hireEscort,
    isEscortOfferAvailable,
    makeHiredEscort,
} from './escort_plugin';
import { NpcAIComponent } from './npc_plugin';
import { PlatformResource } from './platform_plugin';
import { PlayerStateComponent, createInitialPlayerState } from './player_state';
import { TargetComponent } from './target_component';

function movementAt(x: number, y: number): MovementState {
    return {
        accelerating: 0,
        position: new Position(x, y),
        rotation: new Angle(0),
        turnBack: false,
        turning: 0,
        velocity: new Vector(4, -2),
    };
}

async function escortTestWorld(name: string): Promise<World> {
    const world = new World(name);
    world.resources.set(PlatformResource, 'node');
    world.resources.set(GameDataResource, new MockGameData());
    world.resources.set(TimeResource, {
        time: 1000,
        delta_ms: 1000 / 60,
        delta_s: 1 / 60,
        frame: 1,
    });
    await world.addPlugin(DeltaPlugin);
    await world.addPlugin(EscortPlugin);
    return world;
}

describe('retail escort availability', () => {
    it('uses HireRandom as a percentage and rejects zero', () => {
        expect(isEscortOfferAvailable(0, 0)).toBeFalse();
        expect(isEscortOfferAvailable(40, 39)).toBeTrue();
        expect(isEscortOfferAvailable(40, 40)).toBeFalse();
        expect(isEscortOfferAvailable(140, 99)).toBeTrue();
    });

    it('is stable for one planet/day', () => {
        const ships = [
            { id: 'nova:128', hireRandom: 40 },
            { id: 'nova:130', hireRandom: 95 },
            { id: 'nova:134', hireRandom: 0 },
        ];
        const first = availableEscortOffers(ships, 'nova:128', 10);
        const again = availableEscortOffers(ships, 'nova:128', 10);
        expect(again).toEqual(first);
        expect(first).not.toContain(ships[2]!);
    });
});

describe('escort contracts', () => {
    const empty: EscortRoster = { contracts: [] };
    const terms = {
        id: 'contract-1',
        shipId: 'nova:128',
        hirePrice: 500,
        dailyPay: 25,
    };

    it('deducts the supplied authoritative hiring terms', () => {
        const result = hireEscort(1_000, empty, terms, 3);
        expect(result.hired).toBeTrue();
        expect(result.credits).toBe(500);
        expect(result.roster.contracts).toEqual([{
            id: 'contract-1',
            shipId: 'nova:128',
            dailyPay: 25,
        }]);
    });

    it('does not guess past insufficient funds or a supplied maximum', () => {
        expect(hireEscort(499, empty, terms, 3)).toEqual({
            hired: false,
            reason: 'insufficient-credits',
            credits: 499,
            roster: empty,
        });
        expect(hireEscort(1_000, empty, terms, 0)).toEqual({
            hired: false,
            reason: 'maximum-escorts',
            credits: 1_000,
            roster: empty,
        });
    });

    it('totals daily pay and removes a dismissed contract', () => {
        const roster = {
            contracts: [
                { id: 'one', shipId: 'nova:128', dailyPay: 25 },
                { id: 'two', shipId: 'nova:129', dailyPay: 40 },
            ],
        };
        expect(escortPayroll(roster)).toBe(65);
        expect(dismissEscort(roster, 'one').contracts).toEqual([
            { id: 'two', shipId: 'nova:129', dailyPay: 40 },
        ]);
    });
});

describe('hired escort entities', () => {
    it('uses makeNpc and spawns in formation around its owner', () => {
        const owner = movementAt(1_000, -500);
        const escort = makeHiredEscort(
            { ...getDefaultShipData(), id: 'nova:128', name: 'Shuttle' },
            'player',
            'contract-1',
            0,
            owner,
        );
        expect(escort.components.has(NpcAIComponent)).toBeTrue();
        expect(escort.components.get(HiredEscortComponent)).toEqual({
            ownerUuid: 'player',
            contractId: 'contract-1',
            slot: 0,
        });
        expect(escort.components.get(MultiplayerData)).toEqual({
            owner: 'server',
        });
        const movement = escort.components.get(MovementStateComponent)!;
        expect(movement.position).not.toEqual(owner.position);
        expect(movement.velocity).toEqual(owner.velocity);
    });
});

describe('SyncEscortRoster', () => {
    it('syncs player state escorts to EscortRosterComponent on node for client-owned player entities', async () => {
        const world = await escortTestWorld('sync-escort-roster-test');

        const state = createInitialPlayerState();
        state.escorts = [{ id: 'contract-1', shipId: 'nova:128', dailyPay: 50 }];

        const player = new Entity('player')
            .addComponent(PlayerStateComponent, state)
            .addComponent(MultiplayerData, { owner: 'client-1' });

        world.entities.set('player', player);
        world.step();

        const roster = player.components.get(EscortRosterComponent);
        expect(roster).toBeDefined();
        expect(roster?.contracts).toEqual([{ id: 'contract-1', shipId: 'nova:128', dailyPay: 50 }]);
    });
});

describe('HandleEscortDestruction', () => {
    it('removes the destroyed escort contract from playerState and roster upon DeathEvent', async () => {
        const world = await escortTestWorld('escort-destruction-test');

        const state = createInitialPlayerState();
        state.escorts = [
            { id: 'contract-1', shipId: 'nova:128', dailyPay: 50 },
            { id: 'contract-2', shipId: 'nova:130', dailyPay: 100 },
        ];

        const player = new Entity('player')
            .addComponent(PlayerStateComponent, state)
            .addComponent(EscortRosterComponent, { contracts: [...state.escorts] })
            .addComponent(MultiplayerData, { owner: 'client-1' });

        const escort = new Entity('escort-1')
            .addComponent(HiredEscortComponent, {
                ownerUuid: 'player',
                contractId: 'contract-1',
                slot: 0,
            })
            .addComponent(MultiplayerData, { owner: 'server' });

        world.entities.set('player', player);
        world.entities.set('escort-1', escort);

        world.emitNow(DeathEvent, { time: 1000, delta_ms: 16, delta_s: 0.016, frame: 1 }, ['escort-1']);

        expect(player.components.get(PlayerStateComponent)?.escorts).toEqual([
            { id: 'contract-2', shipId: 'nova:130', dailyPay: 100 },
        ]);
        expect(player.components.get(EscortRosterComponent)?.contracts).toEqual([
            { id: 'contract-2', shipId: 'nova:130', dailyPay: 100 },
        ]);
    });
});

describe('EscortDefenseSystem', () => {
    it('copies owner target to escort when owner acquires an enemy target', async () => {
        const world = await escortTestWorld('escort-defense-test');

        const player = new Entity('player')
            .addComponent(TargetComponent, { target: 'enemy-ship' })
            .addComponent(MultiplayerData, { owner: 'client-1' });

        const escort = new Entity('escort-1')
            .addComponent(HiredEscortComponent, {
                ownerUuid: 'player',
                contractId: 'contract-1',
                slot: 0,
            })
            .addComponent(TargetComponent, { target: undefined })
            .addComponent(MultiplayerData, { owner: 'server' });

        world.entities.set('player', player);
        world.entities.set('escort-1', escort);
        world.entities.set('enemy-ship', new Entity('enemy-ship'));

        world.step();

        expect(escort.components.get(TargetComponent)?.target).toBe('enemy-ship');
    });

    it('does not target the owner or other escorts of the same fleet', async () => {
        const world = await escortTestWorld('escort-no-friendly-fire-test');

        const player = new Entity('player')
            .addComponent(TargetComponent, { target: 'escort-2' })
            .addComponent(MultiplayerData, { owner: 'client-1' });

        const escort1 = new Entity('escort-1')
            .addComponent(HiredEscortComponent, {
                ownerUuid: 'player',
                contractId: 'contract-1',
                slot: 0,
            })
            .addComponent(TargetComponent, { target: undefined })
            .addComponent(MultiplayerData, { owner: 'server' });

        const escort2 = new Entity('escort-2')
            .addComponent(HiredEscortComponent, {
                ownerUuid: 'player',
                contractId: 'contract-2',
                slot: 1,
            })
            .addComponent(MultiplayerData, { owner: 'server' });

        world.entities.set('player', player);
        world.entities.set('escort-1', escort1);
        world.entities.set('escort-2', escort2);

        world.step();

        expect(escort1.components.get(TargetComponent)?.target).toBeUndefined();
    });
});
