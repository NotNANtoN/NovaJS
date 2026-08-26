import 'jasmine';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import {
    MovementState,
    MovementStateComponent,
} from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import {
    EscortRoster,
    HiredEscortComponent,
    availableEscortOffers,
    dismissEscort,
    escortPayroll,
    hireEscort,
    isEscortOfferAvailable,
    makeHiredEscort,
} from './escort_plugin';
import { NpcAIComponent } from './npc_plugin';

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
