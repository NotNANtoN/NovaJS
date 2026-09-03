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
import { ControlStateEvent } from './control_state_event';
import { PlayerShipSelector } from './player_ship_plugin';
import {
    EscortDefenseSystem,
    EscortOrderComponent,
    EscortOrderNoticeComponent,
    EscortPlugin,
    EscortRoster,
    EscortRosterComponent,
    HandleEscortDestruction,
    HiredEscortComponent,
    PlayerEscortCommandInputSystem,
    RemoveDismissedEscorts,
    SyncEscortRoster,
    availableEscortOffers,
    dismissEscort,
    escortPayroll,
    hireEscort,
    isEscortOfferAvailable,
    makeHiredEscort,
    formationSlotOffset,
    tacticalFormationSlot,
    worldFormationPosition,
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

    it('clears escort target when owner is in hold mode', async () => {
        const world = await escortTestWorld('escort-hold-mode-test');

        const player = new Entity('player')
            .addComponent(TargetComponent, { target: 'enemy-ship' })
            .addComponent(EscortOrderComponent, { mode: 'hold', sequence: 1 })
            .addComponent(MultiplayerData, { owner: 'client-1' });

        const escort = new Entity('escort-1')
            .addComponent(HiredEscortComponent, {
                ownerUuid: 'player',
                contractId: 'contract-1',
                slot: 0,
            })
            .addComponent(TargetComponent, { target: 'enemy-ship' })
            .addComponent(MultiplayerData, { owner: 'server' });

        world.entities.set('player', player);
        world.entities.set('escort-1', escort);
        world.entities.set('enemy-ship', new Entity('enemy-ship'));

        world.step();

        expect(escort.components.get(TargetComponent)?.target).toBeUndefined();
    });

    it('prioritizes enemies actively attacking the owner in defend mode', async () => {
        const world = await escortTestWorld('escort-defend-attacker-test');

        const player = new Entity('player')
            .addComponent(TargetComponent, { target: undefined })
            .addComponent(EscortOrderComponent, { mode: 'defend', sequence: 1 })
            .addComponent(MultiplayerData, { owner: 'client-1' });

        const escort = new Entity('escort-1')
            .addComponent(HiredEscortComponent, {
                ownerUuid: 'player',
                contractId: 'contract-1',
                slot: 0,
            })
            .addComponent(TargetComponent, { target: undefined })
            .addComponent(MultiplayerData, { owner: 'server' });

        const attacker = new Entity('attacker')
            .addComponent(TargetComponent, { target: 'player' })
            .addComponent(MultiplayerData, { owner: 'server' });

        world.entities.set('player', player);
        world.entities.set('escort-1', escort);
        world.entities.set('attacker', attacker);

        world.step();

        expect(escort.components.get(TargetComponent)?.target).toBe('attacker');
    });
});

describe('PlayerEscortCommandInputSystem', () => {
    it('sets attack order when player has a target and presses attack (KeyF)', async () => {
        const world = new World('escort-command-input-test');
        world.resources.set(PlatformResource, 'browser');

        const player = new Entity('player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(TargetComponent, { target: 'enemy-1' });

        world.entities.set('player', player);
        world.addSystem(PlayerEscortCommandInputSystem);

        world.emitNow(ControlStateEvent, new Map([['attack', 'start']]), ['player']);

        const order = player.components.get(EscortOrderComponent);
        expect(order).toEqual({
            mode: 'attack',
            sequence: 1,
            targetUuid: 'enemy-1',
        });
        expect(player.components.get(EscortOrderNoticeComponent)?.text).toBe('Escorts: Focus fire on target');
    });

    it('gives notice when player presses attack (KeyF) without a target', async () => {
        const world = new World('escort-command-no-target-test');
        world.resources.set(PlatformResource, 'browser');

        const player = new Entity('player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(TargetComponent, { target: undefined });

        world.entities.set('player', player);
        world.addSystem(PlayerEscortCommandInputSystem);

        world.emitNow(ControlStateEvent, new Map([['attack', 'start']]), ['player']);

        expect(player.components.has(EscortOrderComponent)).toBeFalse();
        expect(player.components.get(EscortOrderNoticeComponent)?.text).toBe('Escorts: No target selected');
    });

    it('sets hold, defend, and formation orders upon control inputs', async () => {
        const world = new World('escort-commands-all-test');
        world.resources.set(PlatformResource, 'browser');

        const player = new Entity('player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(TargetComponent, { target: undefined });

        world.entities.set('player', player);
        world.addSystem(PlayerEscortCommandInputSystem);

        world.emitNow(ControlStateEvent, new Map([['defend', 'start']]), ['player']);
        expect(player.components.get(EscortOrderComponent)?.mode).toBe('defend');

        world.emitNow(ControlStateEvent, new Map([['holdPosition', 'start']]), ['player']);
        expect(player.components.get(EscortOrderComponent)?.mode).toBe('hold');

        world.emitNow(ControlStateEvent, new Map([['formation', 'start']]), ['player']);
        expect(player.components.get(EscortOrderComponent)?.mode).toBe('formation');
    });
});

describe('tactical escort formations', () => {
    it('cycles through formation shapes on repeated formation key inputs', async () => {
        const world = new World('escort-cycle-formations-test');
        world.resources.set(PlatformResource, 'browser');

        const player = new Entity('player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(TargetComponent, { target: undefined });

        world.entities.set('player', player);
        world.addSystem(PlayerEscortCommandInputSystem);

        // First press: enters formation mode in wedge
        world.emitNow(ControlStateEvent, new Map([['formation', 'start']]), ['player']);
        expect(player.components.get(EscortOrderComponent)?.mode).toBe('formation');
        expect(player.components.get(EscortOrderComponent)?.formationShape).toBe('wedge');
        expect(player.components.get(EscortOrderNoticeComponent)?.text).toBe('Escorts: Wedge (V) formation');

        // Second press: cycles to line
        world.emitNow(ControlStateEvent, new Map([['formation', 'start']]), ['player']);
        expect(player.components.get(EscortOrderComponent)?.formationShape).toBe('line');
        expect(player.components.get(EscortOrderNoticeComponent)?.text).toBe('Escorts: Line Abreast (Wall) formation');

        // Third press: cycles to column
        world.emitNow(ControlStateEvent, new Map([['formation', 'start']]), ['player']);
        expect(player.components.get(EscortOrderComponent)?.formationShape).toBe('column');
        expect(player.components.get(EscortOrderNoticeComponent)?.text).toBe('Escorts: Column (Trail) formation');

        // Fourth press: cycles to diamond
        world.emitNow(ControlStateEvent, new Map([['formation', 'start']]), ['player']);
        expect(player.components.get(EscortOrderComponent)?.formationShape).toBe('diamond');
        expect(player.components.get(EscortOrderNoticeComponent)?.text).toBe('Escorts: Diamond (Box) formation');

        // Fifth press: wraps to wedge
        world.emitNow(ControlStateEvent, new Map([['formation', 'start']]), ['player']);
        expect(player.components.get(EscortOrderComponent)?.formationShape).toBe('wedge');
        expect(player.components.get(EscortOrderNoticeComponent)?.text).toBe('Escorts: Wedge (V) formation');
    });

    it('computes distinct slot offsets for line, column, and diamond formations', () => {
        // Line abreast: broad lateral span, minimal longitudinal offset
        const line0 = formationSlotOffset(0, 'line');
        const line1 = formationSlotOffset(1, 'line');
        expect(line0.lateral).toBeLessThan(-100);
        expect(line1.lateral).toBeGreaterThan(100);
        expect(line0.longitudinal).toBe(line1.longitudinal);

        // Column: strictly in-line (0 lateral), progressive trailing
        const col0 = formationSlotOffset(0, 'column');
        const col1 = formationSlotOffset(1, 'column');
        expect(col0.lateral).toBe(0);
        expect(col1.lateral).toBe(0);
        expect(col1.longitudinal).toBeLessThan(col0.longitudinal);

        // Diamond: 360-degree coverage
        const d0 = formationSlotOffset(0, 'diamond'); // Port
        const d1 = formationSlotOffset(1, 'diamond'); // Starboard
        const d2 = formationSlotOffset(2, 'diamond'); // Ahead
        const d3 = formationSlotOffset(3, 'diamond'); // Astern
        expect(d0.lateral).toBeLessThan(0);
        expect(d1.lateral).toBeGreaterThan(0);
        expect(d2.longitudinal).toBeGreaterThan(0); // Forward of flagship
        expect(d3.longitudinal).toBeLessThan(0);    // Aft of flagship
    });

    it('places slots in alternating port/starboard trailing V-formation', () => {
        const slot0 = tacticalFormationSlot(0);
        expect(slot0.lateral).toBeLessThan(0); // Port / Left
        expect(slot0.longitudinal).toBeLessThan(0); // Trailing

        const slot1 = tacticalFormationSlot(1);
        expect(slot1.lateral).toBeGreaterThan(0); // Starboard / Right
        expect(slot1.longitudinal).toBeLessThan(0); // Trailing
        expect(Math.abs(slot1.lateral)).toEqual(Math.abs(slot0.lateral));
        expect(slot1.longitudinal).toEqual(slot0.longitudinal);

        const slot2 = tacticalFormationSlot(2);
        expect(Math.abs(slot2.lateral)).toBeGreaterThan(Math.abs(slot0.lateral));
        expect(slot2.longitudinal).toBeLessThan(slot0.longitudinal);
    });

    it('transforms world formation coordinates according to flagship rotation', () => {
        const flagshipPos = new Position(1000, 2000);
        // Heading 0: pointing up (0, -1). Port is left (-x), Starboard is right (+x), Trailing is down (+y).
        const posUp = worldFormationPosition(flagshipPos, new Angle(0), 1);
        expect(posUp.x).toBeGreaterThan(flagshipPos.x); // Starboard (+x)
        expect(posUp.y).toBeGreaterThan(flagshipPos.y); // Trailing (+y in screen space)

        // Heading pi/2 (pointing right +x): Starboard is down (+y), Trailing is left (-x).
        const posRight = worldFormationPosition(flagshipPos, new Angle(Math.PI / 2), 1);
        expect(posRight.x).toBeLessThan(flagshipPos.x); // Trailing behind facing direction
        expect(posRight.y).toBeGreaterThan(flagshipPos.y); // Starboard
    });
});
