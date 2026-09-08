import 'jasmine';
import { createDraft, finishDraft } from 'immer';
import { Entity } from 'nova_ecs/entity';
import { Comms } from '../spaceport/comms_panel';
import { AssistanceOutcomeComponent, AssistanceRequestComponent } from './assistance_plugin';
import { SurrenderRequestComponent, SurrenderOutcomeComponent } from './surrender_plugin';
import { getDefaultMissionData } from 'novadatainterface/MissionData';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { createInitialPlayerState, PlayerStateComponent } from './player_state';
import { ShipDataComponent } from './ship_plugin';
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

describe('comms assistance polling', () => {
    function panel() {
        // Exercise the lifecycle without constructing Pixi rendering resources.
        const comms = Object.create(Comms.prototype) as any;
        comms.input = new Entity()
            .addComponent(PlayerStateComponent, {
                ...createInitialPlayerState(), fuel: 0,
            })
            .addComponent(ShipDataComponent, {
                ...getDefaultShipData(), fuelCapacity: 300,
            });
        comms.target = { relation: 'ally' };
        comms.hailedUuid = 'helper';
        comms.assistanceHelper = 'helper';
        comms.assistanceSequence = 2;
        spyOn(comms, 'say');
        spyOn(comms, 'stopAssistanceOutcomePolling');
        return comms;
    }

    it('ignores older, newer, other-helper and approaching outcomes', () => {
        const comms = panel();
        for (const outcome of [
            { helper: 'helper', sequence: 1, phase: 'completed' },
            { helper: 'helper', sequence: 3, phase: 'completed' },
            { helper: 'other', sequence: 2, phase: 'completed' },
            { helper: 'helper', sequence: 2, phase: 'approaching' },
        ]) {
            comms.input.components.set(AssistanceOutcomeComponent, outcome);
            comms.updateAssistanceOutcome();
        }
        expect(comms.say).not.toHaveBeenCalled();
        expect(comms.stopAssistanceOutcomePolling).not.toHaveBeenCalled();
    });

    for (const phase of ['completed', 'failed'] as const) {
        it(`reports an exact matching ${phase} outcome`, () => {
            const comms = panel();
            comms.input.components.set(AssistanceOutcomeComponent, {
                helper: 'helper', sequence: 2, phase, reason: 'cannot-afford',
            });
            comms.updateAssistanceOutcome();
            expect(comms.say).toHaveBeenCalledWith(
                phase === 'completed' ? 'takeItAndGo' : 'cannotAfford');
            expect(comms.stopAssistanceOutcomePolling).toHaveBeenCalled();
        });
    }

    for (const [reason, explanation] of [
        ['helper-disabled', 'assisting ship is disabled'],
        ['government-unavailable', 'government information could not be verified'],
    ] as const) {
        it(`explains ${reason} and reports a server refund without changing credits`, () => {
            const comms = panel();
            comms.message = { text: '' };
            comms.input.components.set(PlayerStateComponent, {
                ...createInitialPlayerState(), credits: 12_345,
            });
            comms.input.components.set(AssistanceOutcomeComponent, {
                helper: 'helper', sequence: 2, phase: 'failed', reason,
                refundedCredits: 1_000,
            });
            comms.updateAssistanceOutcome();
            expect(comms.say).toHaveBeenCalledWith('cannotHelp');
            expect(comms.message.text).toContain(explanation);
            expect(comms.message.text).toContain('Server confirmed a refund of 1,000 credits');
            expect(comms.input.components.get(PlayerStateComponent).credits).toBe(12_345);
        });
    }

    it('does not invent refunds for absent, zero or invalid amounts', () => {
        for (const refundedCredits of [undefined, 0, -1, NaN, Infinity]) {
            const comms = panel();
            comms.message = { text: '' };
            comms.input.components.set(AssistanceOutcomeComponent, {
                helper: 'helper', sequence: 2, phase: 'failed',
                reason: 'helper-disabled', refundedCredits,
            });
            comms.updateAssistanceOutcome();
            expect(comms.message.text).not.toContain('refund');
            expect(comms.input.components.get(PlayerStateComponent).credits).toBe(10_000);
        }
    });

    it('does not report refund amounts from uncorrelated or approaching outcomes', () => {
        const comms = panel();
        comms.message = { text: '' };
        for (const outcome of [
            { helper: 'other', sequence: 2, phase: 'failed' },
            { helper: 'helper', sequence: 3, phase: 'failed' },
            { helper: 'helper', sequence: 2, phase: 'approaching' },
        ]) {
            comms.input.components.set(AssistanceOutcomeComponent, {
                ...outcome, reason: 'helper-disabled', refundedCredits: 1_000,
            });
            comms.updateAssistanceOutcome();
        }
        expect(comms.message.text).toBe('');
        expect(comms.input.components.get(PlayerStateComponent).credits).toBe(10_000);
    });

    it('does not submit again while already polling', () => {
        const comms = panel();
        comms.assistancePoll = 1;
        spyOn(comms, 'submitAssistance');
        comms.requestAssistance();
        expect(comms.submitAssistance).not.toHaveBeenCalled();
        expect(comms.say).not.toHaveBeenCalled();
    });

    it('resumes watching the authoritative pending rescue after reopening', () => {
        const comms = panel();
        comms.input.components.set(AssistanceOutcomeComponent, {
            helper: 'original', sequence: 1, phase: 'approaching',
        });
        spyOn(comms, 'startAssistanceOutcomePolling');
        spyOn(comms, 'submitAssistance');
        comms.requestAssistance();
        expect(comms.assistanceHelper).toBe('original');
        expect(comms.assistanceSequence).toBe(1);
        expect(comms.startAssistanceOutcomePolling).toHaveBeenCalled();
        expect(comms.submitAssistance).not.toHaveBeenCalled();
    });
});

describe('comms async lifecycle and transactions', () => {
    function deferred<T>() {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>(done => { resolve = done; });
        return { promise, resolve };
    }

    function panel() {
        const comms = Object.create(Comms.prototype) as any;
        comms.lifecycle = 0;
        comms.backgroundGeneration = 0;
        comms.input = new Entity().addComponent(PlayerStateComponent, createInitialPlayerState());
        comms.target = { name: 'Helper', relation: 'ally', disabled: true };
        comms.hailedUuid = 'helper';
        comms.message = { text: '' };
        comms.buttons = { assistance: { setText: jasmine.createSpy('setText') } };
        comms.controls = { bind: jasmine.createSpy('bind'), unbind: jasmine.createSpy('unbind') };
        comms.container = { visible: false };
        comms.gameData = { data: {} };
        return comms;
    }

    it('discards an older background and destroys only its sprite', async () => {
        const comms = panel();
        const old = deferred<any>();
        const latest = deferred<any>();
        const sprite = () => ({ anchor: { set() {} }, destroy: jasmine.createSpy('destroy') });
        const previous = sprite();
        const stale = sprite();
        const fresh = sprite();
        comms.container = {
            children: [previous],
            removeChildAt: () => previous,
            addChildAt: jasmine.createSpy('addChildAt'),
        };
        comms.gameData.spriteFromPictAsync = (id: string) => id === 'old' ? old.promise : latest.promise;
        const a = comms.setBackgroundPict('old');
        const b = comms.setBackgroundPict('new');
        latest.resolve(fresh);
        await b;
        old.resolve(stale);
        await a;
        expect(comms.container.addChildAt).toHaveBeenCalledOnceWith(fresh, 0);
        expect(stale.destroy).toHaveBeenCalled();
        expect(fresh.destroy).not.toHaveBeenCalled();
    });

    it('keeps Menu’s initial sprite alive for its late texture callback', async () => {
        const comms = panel();
        const initial = { texture: 'empty', destroy: jasmine.createSpy('destroy') };
        const fresh = { anchor: { set() {} }, destroy: jasmine.createSpy('destroy') };
        comms.initialBackground = initial;
        comms.container = {
            children: [initial], removeChildAt: () => initial,
            addChildAt: jasmine.createSpy('addChildAt'),
        };
        comms.gameData.spriteFromPictAsync = async () => fresh;
        await comms.setBackgroundPict('new');
        initial.texture = 'late Menu texture';
        expect(initial.destroy).not.toHaveBeenCalled();
        expect(comms.container.addChildAt).toHaveBeenCalledOnceWith(fresh, 0);
    });

    it('discards a background that finishes after close', async () => {
        const comms = panel();
        const loading = deferred<any>();
        const sprite = { destroy: jasmine.createSpy('destroy') };
        comms.gameData.spriteFromPictAsync = () => loading.promise;
        const background = comms.setBackgroundPict('late');
        comms.done();
        loading.resolve(sprite);
        await background;
        expect(sprite.destroy).toHaveBeenCalled();
        expect(comms.container.visible).toBeFalse();
    });

    it('settles the original show when its context changes within the lifecycle', async () => {
        const comms = panel();
        comms.buildPromise = new Promise(() => {});
        spyOn(comms, 'setBackgroundPict').and.resolveTo();
        const original = comms.input;
        const showing = comms.show(original);
        const current = comms.contextGuard();
        comms.setInput(new Entity());
        expect(current()).toBeFalse();
        expect(await showing).toBe(original);
        expect(comms.finishShow).toBeUndefined();
        expect(comms.container.visible).toBeFalse();
    });

    it('does not let an old context guard close or resolve a newer show', async () => {
        const comms = panel();
        comms.buildPromise = new Promise(() => {});
        spyOn(comms, 'setBackgroundPict').and.resolveTo();
        const original = comms.input;
        const first = comms.show(original);
        const stale = comms.contextGuard();
        const replacement = new Entity();
        const second = comms.show(replacement);
        const finish = comms.finishShow;
        comms.container.visible = true;
        let settled = false;
        void second.then(() => { settled = true; });
        expect(stale()).toBeFalse();
        expect(await first).toBe(original);
        expect(settled).toBeFalse();
        expect(comms.finishShow).toBe(finish);
        expect(comms.container.visible).toBeTrue();
        comms.done();
        expect(await second).toBe(replacement);
    });

    it('settles a closed loading show and never reopens it', async () => {
        const comms = panel();
        const build = deferred<void>();
        comms.buildPromise = build.promise;
        spyOn(comms, 'setBackgroundPict').and.resolveTo();
        const showing = comms.show(comms.input);
        comms.done();
        expect(await showing).toBe(comms.input);
        build.resolve();
        await Promise.resolve();
        expect(comms.controls.bind).not.toHaveBeenCalled();
        expect(comms.container.visible).toBeFalse();
    });

    it('settles a superseded show without closing the newer lifecycle', async () => {
        const comms = panel();
        comms.buildPromise = new Promise(() => {});
        spyOn(comms, 'setBackgroundPict').and.resolveTo();
        const original = comms.input;
        const first = comms.show(original);
        const replacement = new Entity();
        const second = comms.show(replacement);
        expect(await first).toBe(original);
        expect(comms.input).toBe(replacement);
        comms.done();
        expect(await second).toBe(replacement);
    });

    it('does not open after close while channel strings are loading', async () => {
        const comms = panel();
        comms.buildPromise = Promise.resolve();
        const loading = deferred<void>();
        const entered = deferred<void>();
        spyOn(comms, 'setBackgroundPict').and.resolveTo();
        spyOn(comms, 'openChannel');
        spyOn(comms, 'loadLines').and.callFake(() => {
            entered.resolve();
            return loading.promise;
        });
        const showing = comms.show(comms.input);
        await entered.promise;
        comms.done();
        loading.resolve();
        await showing;
        await Promise.resolve();
        expect(comms.openChannel).not.toHaveBeenCalled();
        expect(comms.controls.bind).not.toHaveBeenCalled();
    });

    function offer(comms: any, onAccept = '') {
        comms.isOfferingContract = true;
        comms.pendingShipboardOffer = {
            mission: { ...getDefaultMissionData(), id: 'nova:200', onAccept },
            resolved: { travelDestination: 'nova:131', returnDestination: 'nova:131' },
        };
    }

    it('does not confirm or consume a rejected contract', async () => {
        const comms = panel();
        offer(comms);
        comms.pendingShipboardOffer.mission.cargoType = 2;
        comms.pendingShipboardOffer.mission.cargoQty = 999;
        await comms.acceptContract();
        expect(comms.input.components.get(PlayerStateComponent).activeMissions).toEqual([]);
        expect(comms.message.text).toContain('could not be accepted');
        expect(comms.pendingShipboardOffer).toBeDefined();
    });

    for (const change of ['credits', 'close', 'replace'] as const) {
        it(`does not commit stale chained missions after ${change}`, async () => {
            const comms = panel();
            offer(comms, 'S201');
            const load = deferred<any>();
            comms.gameData.data.Mission = { get: jasmine.createSpy('get').and.returnValue(load.promise) };
            const input = comms.input;
            const accepting = comms.acceptContract();
            await comms.acceptContract(); // repeat click cannot begin a second acceptance
            expect(comms.gameData.data.Mission.get).toHaveBeenCalledTimes(1);
            if (change === 'credits') input.components.get(PlayerStateComponent).credits += 10;
            if (change === 'close') comms.done();
            if (change === 'replace') input.components.set(PlayerStateComponent, {
                ...createInitialPlayerState(), currentSystem: 'nova:999',
            });
            load.resolve({ ...getDefaultMissionData(), id: 'nova:201' });
            await accepting;
            expect(input.components.get(PlayerStateComponent).activeMissions).toEqual([]);
            if (change === 'credits') expect(input.components.get(PlayerStateComponent).credits).toBe(10_010);
        });
    }

    it('does not retain a revocable player-state draft across chained loading', async () => {
        const comms = panel();
        const draft = createDraft(createInitialPlayerState());
        comms.input.components.set(PlayerStateComponent, draft);
        offer(comms, 'S201');
        const load = deferred<any>();
        comms.gameData.data.Mission = { get: () => load.promise };
        const accepting = comms.acceptContract();
        comms.input.components.set(PlayerStateComponent, finishDraft(draft));
        load.resolve({ ...getDefaultMissionData(), id: 'nova:201' });
        await accepting;
        expect(comms.input.components.get(PlayerStateComponent).activeMissions.length).toBe(2);
        expect(comms.message.text).toContain('confirmed');
    });

    it('commits acceptance and chained missions together after loading', async () => {
        const comms = panel();
        offer(comms, 'S201');
        const load = deferred<any>();
        comms.gameData.data.Mission = { get: () => load.promise };
        const accepting = comms.acceptContract();
        expect(comms.input.components.get(PlayerStateComponent).activeMissions).toEqual([]);
        load.resolve({ ...getDefaultMissionData(), id: 'nova:201' });
        await accepting;
        expect(comms.input.components.get(PlayerStateComponent).activeMissions.length).toBe(2);
        expect(comms.pendingShipboardOffer).toBeUndefined();
    });

    describe('bounded polling', () => {
        beforeEach(() => { jasmine.clock().install(); jasmine.clock().mockDate(new Date(0)); });
        afterEach(() => jasmine.clock().uninstall());

        it('resumes an external unacknowledged assistance request without resubmitting', () => {
            const comms = panel();
            comms.input.components.set(AssistanceRequestComponent, {
                helper: 'external', sequence: 7, action: 'accept',
            });
            comms.requestAssistance();
            expect(comms.assistanceHelper).toBe('external');
            expect(comms.assistanceSequence).toBe(7);
            jasmine.clock().tick(120_000);
            expect(comms.assistancePoll).toBeUndefined();
            expect(comms.message.text).toContain('unknown');
            comms.requestAssistance();
            expect(comms.input.components.get(AssistanceRequestComponent).sequence).toBe(7);
            comms.done();
        });

        for (const [start, field, update] of [
            ['startAssistanceOutcomePolling', 'assistancePoll', 'updateAssistanceOutcome'],
            ['demandSurrender', 'surrenderPoll', 'updateSurrenderOutcome'],
        ]) {
            it(`clears ${field} when its guard is stale instead of looping indefinitely`, () => {
                const comms = panel();
                const guard = jasmine.createSpy('guard').and.returnValue(false);
                spyOn(comms, 'contextGuard').and.returnValue(guard);
                spyOn(comms, update);
                comms[start]();
                jasmine.clock().tick(100);
                expect(comms[field]).toBeUndefined();
                jasmine.clock().tick(240_000);
                expect(comms[update]).not.toHaveBeenCalled();
                expect(guard).toHaveBeenCalledTimes(1);
            });

            it(`does not let a queued stale ${field} callback clear the replacement poll`, () => {
                const comms = panel();
                const setInterval = globalThis.setInterval;
                let oldCallback!: () => void;
                globalThis.setInterval = ((callback: () => void, delay: number) => {
                    oldCallback = callback;
                    return setInterval(callback, delay);
                }) as typeof setInterval;
                try {
                    comms[start]();
                } finally {
                    globalThis.setInterval = setInterval;
                }
                comms.done();
                comms[start]();
                const replacement = comms[field];
                oldCallback();
                expect(comms[field]).toBe(replacement);
                jasmine.clock().tick(120_000);
                expect(comms[field]).toBeUndefined();
                expect(comms.message.text).toContain('unknown');
            });
        }

        it('does not reset the assistance timeout during repeated reconciliation', () => {
            const comms = panel();
            comms.input.components.set(AssistanceOutcomeComponent, {
                helper: 'paid-helper', sequence: 8, phase: 'approaching',
            });
            comms.reconcileAssistance();
            const deadline = comms.assistanceDeadline;
            jasmine.clock().tick(119_900);
            comms.reconcileAssistance();
            expect(comms.assistanceDeadline).toBe(deadline);
            jasmine.clock().tick(100);
            expect(comms.assistancePoll).toBeUndefined();
            expect(comms.message.text).toContain('unknown');
        });

        it('does not reset surrender timeout or submit again on repeat demands', () => {
            const comms = panel();
            comms.demandSurrender();
            const deadline = comms.surrenderDeadline;
            jasmine.clock().tick(119_900);
            comms.demandSurrender();
            expect(comms.surrenderDeadline).toBe(deadline);
            expect(comms.input.components.get(SurrenderRequestComponent).sequence).toBe(1);
            jasmine.clock().tick(100);
            expect(comms.surrenderPoll).toBeUndefined();
        });

        it('does not treat an equal-sequence other-helper result as acknowledgement', () => {
            const comms = panel();
            comms.input.components.set(AssistanceRequestComponent, {
                helper: 'external', sequence: 7, action: 'accept',
            });
            comms.input.components.set(AssistanceOutcomeComponent, {
                helper: 'other', sequence: 7, phase: 'completed',
            });
            comms.requestAssistance();
            expect(comms.assistanceHelper).toBe('external');
            expect(comms.input.components.get(AssistanceRequestComponent).sequence).toBe(7);
            comms.done();
        });

        it('reconciles an authoritative rescue that supersedes the watched request', () => {
            const comms = panel();
            comms.assistanceHelper = 'new-helper';
            comms.assistanceSequence = 9;
            comms.startAssistanceOutcomePolling();
            comms.input.components.set(AssistanceOutcomeComponent, {
                helper: 'paid-helper', sequence: 8, phase: 'approaching',
            });
            jasmine.clock().tick(100);
            expect(comms.assistanceHelper).toBe('paid-helper');
            expect(comms.assistanceSequence).toBe(8);
            expect(comms.assistancePoll).toBeDefined();
            spyOn(comms, 'say');
            comms.input.components.set(AssistanceOutcomeComponent, {
                helper: 'paid-helper', sequence: 8, phase: 'completed',
            });
            jasmine.clock().tick(100);
            expect(comms.say).toHaveBeenCalledOnceWith('takeItAndGo');
            expect(comms.assistancePoll).toBeUndefined();
        });

        it('reports an exact surrender rejection without payment', () => {
            const comms = panel();
            comms.demandSurrender();
            comms.input.components.set(SurrenderOutcomeComponent, {
                target: 'helper', sequence: 1, status: 'rejected', reason: 'out-of-range', amount: 0,
            });
            jasmine.clock().tick(100);
            expect(comms.message.text).toContain('out-of-range');
            expect(comms.input.components.get(PlayerStateComponent).credits).toBe(10_000);
            expect(comms.surrenderPoll).toBeUndefined();
        });

        it('uses matching fresh surrender outcomes and never mutates credits', () => {
            const comms = panel();
            comms.demandSurrender();
            comms.demandSurrender();
            expect(comms.input.components.get(SurrenderRequestComponent)).toEqual({ target: 'helper', sequence: 1 });
            for (const outcome of [
                { target: 'other', sequence: 1 },
                { target: 'helper', sequence: 2 },
            ]) {
                comms.input.components.set(SurrenderOutcomeComponent, { ...outcome, status: 'paid', amount: 5000 });
                jasmine.clock().tick(100);
                expect(comms.message.text).not.toContain('confirmed');
            }
            // The server may find less than the 5,000-credit cap in the NPC's purse.
            comms.input.components.set(PlayerStateComponent, { ...createInitialPlayerState(), credits: 11_234 });
            comms.input.components.set(SurrenderOutcomeComponent, { target: 'helper', sequence: 1, status: 'paid', amount: 1234 });
            jasmine.clock().tick(100);
            expect(comms.message.text).toContain('1,234');
            expect(comms.input.components.get(PlayerStateComponent).credits).toBe(11_234);
            expect(comms.surrenderPoll).toBeUndefined();
        });

        it('times out surrender without retrying or inventing payment', () => {
            const comms = panel();
            comms.demandSurrender();
            jasmine.clock().tick(120_000);
            expect(comms.surrenderPoll).toBeUndefined();
            expect(comms.message.text).toContain('unknown');
            comms.demandSurrender();
            expect(comms.input.components.get(SurrenderRequestComponent).sequence).toBe(1);
            expect(comms.input.components.get(PlayerStateComponent).credits).toBe(10_000);
            comms.done();
        });

        it('closes polling when fresh player state changes system', () => {
            const comms = panel();
            comms.demandSurrender();
            comms.input.components.get(PlayerStateComponent).currentSystem = 'nova:999';
            jasmine.clock().tick(100);
            expect(comms.surrenderPoll).toBeUndefined();
            expect(comms.container.visible).toBeFalse();
        });
    });
});

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
