import 'jasmine';
import {
    ASSISTANCE_FUEL,
    ASSISTANCE_PRICE,
    assistanceDecision,
    assistanceGenerosity,
    AssistanceRequest,
    COMMS_BLOCK_SIZE,
    CommsBlock,
    commsLineIndex,
    hailPromptBlock,
    payForAssistance,
    receiveAssistanceFuel,
    receiveAssistanceRepair,
} from './comms';
import { FUEL_PER_JUMP } from './fuel';

describe('comms lines', () => {
    it('picks a phrasing from inside the block', () => {
        expect(commsLineIndex('willHelp', 0)).toBe(CommsBlock.willHelp);
        expect(commsLineIndex('willHelp', 0.99))
            .toBe(CommsBlock.willHelp + COMMS_BLOCK_SIZE - 1);
    });

    it('never runs past the end of its block', () => {
        for (const sample of [0, 0.5, 0.999999, 1, 1.5, -1]) {
            const index = commsLineIndex('farewell', sample);
            expect(index).toBeGreaterThanOrEqual(CommsBlock.farewell);
            expect(index).toBeLessThan(CommsBlock.farewell + COMMS_BLOCK_SIZE);
        }
    });
});

describe('being hailed', () => {
    it('sneers when already fighting the pilot', () => {
        expect(hailPromptBlock({
            relation: 'ally', hostile: true, record: 100,
        })).toBe('promptHostile');
    });

    it('welcomes a well-regarded ally', () => {
        expect(hailPromptBlock({
            relation: 'ally', hostile: false, record: 20,
        })).toBe('promptWelcome');
    });

    it('is merely correct with an unknown ally', () => {
        expect(hailPromptBlock({
            relation: 'ally', hostile: false, record: 0,
        })).toBe('promptAllied');
    });

    it('calls a well-known stranger sir', () => {
        expect(hailPromptBlock({
            relation: 'neutral', hostile: false, record: 5,
        })).toBe('promptRespectful');
    });

    it('is plainly helpful to an unknown stranger', () => {
        expect(hailPromptBlock({
            relation: 'neutral', hostile: false, record: 0,
        })).toBe('promptFriendly');
    });
});

function stranded(over: Partial<AssistanceRequest> = {}): AssistanceRequest {
    return {
        relation: 'neutral',
        hostile: false,
        record: 0,
        fuel: 0,
        fuelCapacity: 300,
        generosity: 0.5,
        ...over,
    };
}

describe('requesting assistance', () => {
    it('keeps a helper\'s mood stable across request worlds', () => {
        const first = assistanceGenerosity('pilot', 'helper');
        expect(assistanceGenerosity('pilot', 'helper')).toBe(first);
        expect(first).toBeGreaterThanOrEqual(0);
        expect(first).toBeLessThan(1);
    });

    it('tells a pilot who can still jump that nothing is wrong', () => {
        const decision = assistanceDecision(stranded({ fuel: FUEL_PER_JUMP }));
        expect(decision.outcome).toBe('notInTrouble');
    });

    it('treats a hull without a tank as never stranded', () => {
        const decision = assistanceDecision(
            stranded({ fuel: 0, fuelCapacity: 0 }));
        expect(decision.outcome).toBe('notInTrouble');
    });

    it('is mocked by an enemy', () => {
        expect(assistanceDecision(stranded({ relation: 'enemy' })).outcome)
            .toBe('mocked');
        expect(assistanceDecision(stranded({ hostile: true })).outcome)
            .toBe('mocked');
    });

    it('is always answered by an ally', () => {
        const decision = assistanceDecision(stranded({ relation: 'ally' }));
        expect(decision.outcome).toBe('granted');
        expect(decision.price).toBe(0);
    });

    it('is answered as a favour to a well-regarded pilot', () => {
        const decision = assistanceDecision(
            stranded({ record: 10, generosity: 0.99 }));
        expect(decision.outcome).toBe('granted');
        expect(decision.block).toBe('becauseILikeYou');
    });

    it('lets a stranger be generous, mercenary or busy', () => {
        expect(assistanceDecision(stranded({ generosity: 0.1 })).outcome)
            .toBe('granted');
        const paid = assistanceDecision(stranded({ generosity: 0.5 }));
        expect(paid.outcome).toBe('wantsPayment');
        expect(paid.price).toBe(ASSISTANCE_PRICE);
        expect(assistanceDecision(stranded({ generosity: 0.9 })).outcome)
            .toBe('refused');
    });

    it('has nothing to give from one of the pilot\'s own escorts', () => {
        const decision = assistanceDecision(stranded({ isEscort: true }));
        expect(decision.outcome).toBe('refused');
        expect(decision.block).toBe('cannotHelp');
    });

    it('recognises a disabled pilot as needing repair', () => {
        const decision = assistanceDecision(stranded({
            disabled: true,
            fuel: FUEL_PER_JUMP,
        }));
        expect(decision.outcome).toBe('wantsPayment');
    });

    it('always grants free roadside assistance', () => {
        const decision = assistanceDecision(stranded({
            disabled: true,
            hostile: true,
            relation: 'enemy',
            roadsideAssistance: true,
        }));
        expect(decision.outcome).toBe('granted');
        expect(decision.price).toBe(0);
    });
});

describe('paying for a rescue', () => {
    it('takes the fee when the pilot can cover it', () => {
        const payment = payForAssistance(1000, ASSISTANCE_PRICE);
        expect(payment.paid).toBeTrue();
        expect(payment.credits).toBe(1000 - ASSISTANCE_PRICE);
        expect(payment.block).toBe('onMyWay');
    });

    it('calls out a pilot who cannot pay', () => {
        const payment = payForAssistance(10, ASSISTANCE_PRICE);
        expect(payment.paid).toBeFalse();
        expect(payment.credits).toBe(10);
        expect(payment.block).toBe('cannotAfford');
    });
});

describe('receiving fuel', () => {
    it('hands over exactly one jump', () => {
        expect(receiveAssistanceFuel(0, 300)).toBe(ASSISTANCE_FUEL);
    });

    it('never overfills the tank', () => {
        expect(receiveAssistanceFuel(250, 300)).toBe(300);
    });
});

describe('receiving repairs', () => {
    it('restores the hull to its maximum armour', () => {
        expect(receiveAssistanceRepair(450)).toBe(450);
    });
});
