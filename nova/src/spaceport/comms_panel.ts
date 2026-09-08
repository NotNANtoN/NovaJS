import {
    ConcourseMissionOffer,
    getShipboardMissionOffers,
} from './mission_bbs';
import {
    acceptMission,
    startPendingNcbMissions,
} from '../nova_plugin/mission_plugin';
import { Entity } from 'nova_ecs/entity';
import { plainSnapshot } from 'nova_ecs/draft_snapshot';
import { Observable } from 'rxjs';
import * as PIXI from 'pixi.js';
import { GameData } from '../client/gamedata/GameData';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import {
    ASSISTANCE_PRICE,
    assistanceDecision,
    assistanceGenerosity,
    AssistanceOutcome,
    COMMS_CHANNEL_STRING_LIST,
    COMMS_STRING_LIST,
    CommsBlockName,
    commsLineIndex,
    hailPromptBlock,
} from '../nova_plugin/comms';
import { DisabledComponent, PlayerDeathComponent } from '../nova_plugin/death_plugin';
import {
    GovernmentRelation,
    canHailGovernment,
    getGovernmentCommName,
} from '../nova_plugin/govt_relations';
import { PlayerStateComponent } from '../nova_plugin/player_state';
import { ShipDataComponent } from '../nova_plugin/ship_plugin';
import { EscortOrderComponent } from '../nova_plugin/escort_plugin';
import { TargetComponent } from '../nova_plugin/target_component';
import {
    AssistanceFailureReason,
    AssistanceOutcomeComponent,
    AssistanceRequestComponent,
} from '../nova_plugin/assistance_plugin';
import {
    SurrenderRequestComponent,
    SurrenderOutcomeComponent,
} from '../nova_plugin/surrender_plugin';
import { Button } from './button';
import {
    COMMS_LAYOUT,
    COMMS_SHIP_BACKGROUND,
    COMMS_PLANET_BACKGROUND,
    COMMS_ESCORT_BACKGROUND,
    commsButtonSlots,
} from './comms_panel_layout';
import { Menu } from './menu';
import { MenuControls } from './menu_controls';

const COMMS_FONT = {
    fontFamily: 'Geneva',
    fontSize: 12,
    fill: 0xe0e0e0,
    align: 'left',
    wordWrap: true,
} as const;

/** What the panel needs to know about the ship on the other end. */
export interface HailTarget {
    name: string;
    /** How this ship's government regards the pilot. */
    relation: GovernmentRelation;
    /** The pilot's legal record with that government. */
    record: number;
    /** True when this ship is currently fighting the pilot. */
    hostile: boolean;
    isEscort?: boolean;
    isPlanet?: boolean;
    roadsideAssistance?: boolean;
    disabled?: boolean;
}

/**
 * Retail's hail dialog, opened with the hail key while a ship is targeted.
 *
 * Every line spoken here is looked up in `STR#` 3000 so the ships use the
 * game's own words. Offering a bribe and begging for mercy are retail buttons
 * too, but they need bribery and surrender mechanics that do not exist yet, so
 * this panel carries the three that work.
 */
export class Comms extends Menu<Entity> {
    private readonly message: PIXI.Text;
    private readonly buttons: {
        assistance: Button,
        greetings: Button,
        close: Button,
    };
    private target?: HailTarget;
    private lines?: readonly string[];
    private channelLines?: readonly string[];
    /** Set while a rescuer is waiting to be paid. */
    private pendingPrice = 0;
    private hailedUuid?: string;
    private assistanceHelper?: string;
    private assistanceSequence?: number;
    private assistancePoll?: ReturnType<typeof setInterval>;
    private pendingShipboardOffer?: ConcourseMissionOffer;
    private pendingDestinationOptions?: (resolved: any) => any;
    private isOfferingContract = false;
    private lifecycle = 0;
    private backgroundGeneration = 0;
    // Menu's spriteFromPict may still assign its texture after it is detached.
    private initialBackground?: PIXI.Container;
    private finishShow?: () => void;
    private acceptingContract = false;
    private assistanceDeadline = 0;
    private surrenderPoll?: ReturnType<typeof setInterval>;
    private surrenderDeadline = 0;
    private surrenderTarget?: string;
    private surrenderSequence?: number;
    private static readonly OUTCOME_TIMEOUT_MS = 120_000;

    constructor(gameData: GameData, controlEvents: Observable<ControlEvent>) {
        super(gameData, COMMS_LAYOUT.background, controlEvents);
        this.initialBackground = this.container.children[0];

        this.message = new PIXI.Text({ text: '', style: COMMS_FONT });
        this.message.position.set(
            COMMS_LAYOUT.message.x, COMMS_LAYOUT.message.y);
        this.message.style.wordWrapWidth = COMMS_LAYOUT.message.width;
        this.container.addChild(this.message);

        const [closeSlot, greetSlot, assistSlot] =
            commsButtonSlots([90, 70, 130]);
        const close = new Button(
            gameData, 'Close Channel', closeSlot.width, closeSlot);
        const greetings = new Button(
            gameData, 'Greetings', greetSlot.width, greetSlot);
        const assistance = new Button(
            gameData, 'Request Assistance', assistSlot.width, assistSlot);
        this.buttons = { assistance, greetings, close };
        this.addButtons(this.buttons);

        close.click.subscribe(this.done.bind(this));
        greetings.click.subscribe(this.sayGreetings.bind(this));
        assistance.click.subscribe(this.requestAssistance.bind(this));

        this.controls = new MenuControls(controlEvents, {
            hail: this.done.bind(this),
            depart: this.done.bind(this),
        });
    }

    async setBackgroundPict(pictId: string) {
        const generation = this.backgroundGeneration = (this.backgroundGeneration ?? 0) + 1;
        try {
            const sprite = await this.gameData.spriteFromPictAsync(pictId);
            if (generation !== this.backgroundGeneration) {
                sprite.destroy();
                return;
            }
            sprite.interactive = true;
            sprite.anchor.set(0.5);
            if (this.container.children.length > 0) {
                const previous = this.container.removeChildAt(0);
                if (previous !== this.initialBackground) previous.destroy();
                this.container.addChildAt(sprite, 0);
            } else {
                this.container.addChild(sprite);
            }
        } catch (e) {
            console.warn(`Failed to load comms background ${pictId}`, e);
        }
    }

    setTarget(target: HailTarget | undefined) {
        this.done();
        this.target = target;
        const bg = target?.isEscort
            ? COMMS_ESCORT_BACKGROUND
            : target?.isPlanet
                ? COMMS_PLANET_BACKGROUND
                : COMMS_SHIP_BACKGROUND;
        void this.setBackgroundPict(bg);
    }

    override async show(input: Entity): Promise<Entity> {
        this.done();
        const lifecycle = this.lifecycle;
        void this.setBackgroundPict(this.target?.isEscort ? COMMS_ESCORT_BACKGROUND
            : this.target?.isPlanet ? COMMS_PLANET_BACKGROUND : COMMS_SHIP_BACKGROUND);
        this.setInput(input);
        const result = new Promise<Entity>(resolve => {
            this.finishShow = () => resolve(input);
        });
        void this.prepareShow(input).catch(error => {
            if (this.lifecycle === lifecycle) {
                console.warn('Failed to open comms', error);
                this.done();
            }
        });
        return result;
    }

    private contextKey(input: Entity): string {
        const state = input.components.get(PlayerStateComponent);
        return JSON.stringify([state?.currentSystem, state?.shipId, state?.diedAt,
            input.components.get(TargetComponent)?.target,
            plainSnapshot(input.components.get(PlayerDeathComponent))]);
    }

    private contextGuard() {
        const input = this.input;
        const lifecycle = this.lifecycle;
        const key = this.contextKey(input);
        return () => {
            if (this.lifecycle !== lifecycle) return false;
            if (this.input !== input || this.contextKey(input) !== key) {
                this.done();
                return false;
            }
            return true;
        };
    }

    private async prepareShow(input: Entity) {
        const current = this.contextGuard();
        await this.buildPromise;
        if (!current()) return;
        this.hailedUuid = input.components.get(TargetComponent)?.target;
        this.pendingPrice = 0;
        this.assistanceHelper = undefined;
        this.assistanceSequence = undefined;
        this.buttons.assistance.setText('Request Assistance');
        this.pendingShipboardOffer = undefined;
        this.pendingDestinationOptions = undefined;
        this.isOfferingContract = false;
        try {
            const isHostile = Boolean(this.target?.hostile || this.relation() === 'enemy');
            const { offers, destinationOptions } = await getShipboardMissionOffers(this.gameData, input);
            if (!current()) return;
            if (offers.length > 0 && !isHostile && !this.target?.isPlanet && !this.target?.isEscort) {
                this.pendingShipboardOffer = offers[0];
                this.pendingDestinationOptions = destinationOptions;
            }
        } catch {
            // Fallback
        }
        if (!current()) return;
        await this.loadLines();
        if (!current()) return;
        this.openChannel();
        this.container.visible = true;
        this.controls.bind();
        this.reconcileAssistance();
    }

    private relation(): GovernmentRelation {
        return this.target?.relation ?? 'neutral';
    }

    private record(): number {
        return this.target?.record ?? 0;
    }

    private say(block: CommsBlockName, suffix = '') {
        const index = commsLineIndex(block);
        const line = this.lines?.[index] ?? '';
        this.message.text = `${this.message.text}\n${line}${suffix}`.trim();
    }

    private openChannel() {
        const name = this.target?.name ?? '';
        if (this.target?.isPlanet) {
            this.message.text = `Communications channel open to ${name}.\n\nTraffic Control: "Approach vector clear. Welcome to ${name}, Captain."`;
            this.buttons.greetings.setText('Greetings');
            this.buttons.assistance.setText('Demand Tribute');
            return;
        }
        if (this.target?.isEscort) {
            this.message.text = `Channel open to escort ${name}.\n\nEscort Pilot: "Awaiting orders, Flagship. All fleet systems green."`;
            this.buttons.greetings.setText('Form Up');
            this.buttons.assistance.setText('Attack Target');
            return;
        }
        const isHostile = Boolean(this.target?.hostile || this.relation() === 'enemy');
        if (isHostile) {
            this.message.text = `Channel open to hostile vessel ${name}.\n\nHostile Pilot: "Power down your shields and prepare to be boarded!"`;
            this.buttons.greetings.setText('Demand Yield');
            this.buttons.assistance.setText('Offer Bribe');
            return;
        }

        this.buttons.greetings.setText('Greetings');
        this.buttons.assistance.setText('Request Assistance');
        const prefix = this.channelLines?.[
            commsLineIndex('channelOpen')] ?? '';
        this.message.text = prefix
            ? `${prefix}${name}.`
            : `Channel open to ${name}.`;
        this.say(hailPromptBlock({
            relation: this.relation(),
            hostile: false,
            record: this.record(),
        }));
    }

    private sayGreetings() {
        if (this.target?.isPlanet) {
            this.message.text = `${this.target.name} Traffic Control: "Safe travels, Captain. Transmitting current landing and trade advisories."`;
            return;
        }
        if (this.target?.isEscort) {
            this.orderFormUp();
            return;
        }
        const isHostile = Boolean(this.target?.hostile || this.relation() === 'enemy');
        if (isHostile) {
            this.demandSurrender();
            return;
        }
        if (this.pendingShipboardOffer) {
            const offer = this.pendingShipboardOffer;
            const pay = offer.mission.payVal > 0
                ? `\n\nPayment offered: ${offer.mission.payVal.toLocaleString()} cr.` : '';
            this.message.text = `${this.target?.name ?? 'Vessel'}: "${offer.displayText}"${pay}`;
            this.buttons.assistance.setText('Accept Contract');
            this.buttons.assistance.state = 'normal';
            this.isOfferingContract = true;
            return;
        }

        const rel = this.relation();
        if (this.target?.hostile || rel === 'enemy') {
            this.say('greetingHostile');
        } else if (rel === 'ally' || this.record() > 0) {
            this.say('greetingWarm');
        } else {
            this.say('greetingIndifferent');
        }
    }

    private orderFormUp() {
        const name = this.target?.name ?? 'Escort';
        let shapeName = 'V-formation';
        if (this.input) {
            const currentOrder = this.input.components.get(EscortOrderComponent);
            const sequence = (currentOrder?.sequence ?? 0) + 1;
            const currentShape = currentOrder?.formationShape ?? 'wedge';
            const names: Record<string, string> = {
                wedge: 'V-formation',
                line: 'Line Abreast formation',
                column: 'Column formation',
                diamond: 'Diamond formation',
            };
            shapeName = names[currentShape] ?? 'formation';
            this.input.components.set(EscortOrderComponent, {
                mode: 'formation',
                sequence,
                formationShape: currentShape,
            });
        }
        this.message.text = `${this.message.text}\n\n${name}: "Acknowledged, Flagship. Rejoining ${shapeName} alongside you."`;
    }

    private demandPlanetTribute() {
        const name = this.target?.name ?? 'Stellar';
        const targetId = this.hailedUuid ?? 'planet';
        const state = this.input?.components.get(PlayerStateComponent);
        if (!state) {
            return;
        }
        state.dominatedStellars = state.dominatedStellars ?? [];
        if (state.dominatedStellars.includes(targetId)) {
            this.message.text = `${this.message.text}\n\n${name} Traffic Control: "We are already paying your daily tribute! Please do not bombard our orbital installations."`;
            return;
        }
        state.dominatedStellars.push(targetId);
        const initialTribute = 5_000;
        state.credits += initialTribute;
        this.message.text = `${this.message.text}\n\n${name} Traffic Control: "We cannot withstand your orbital superiority! We submit to your rule. ${initialTribute.toLocaleString()} credits tribute transferred, and daily tribute will follow."`;
    }

    private demandSurrender() {
        if (this.surrenderPoll !== undefined || !this.input || !this.hailedUuid) return;
        const request = this.input.components.get(SurrenderRequestComponent);
        const outcome = this.input.components.get(SurrenderOutcomeComponent);
        // Resume an unacknowledged request, including one sent outside this panel.
        const pending = request && (!outcome || outcome.sequence < request.sequence
            || (outcome.sequence === request.sequence && outcome.target !== request.target));
        this.surrenderTarget = pending ? request.target : this.hailedUuid;
        this.surrenderSequence = pending ? request.sequence
            : Math.max(request?.sequence ?? 0, outcome?.sequence ?? 0) + 1;
        if (!pending) {
            this.input.components.set(SurrenderRequestComponent, {
                target: this.surrenderTarget, sequence: this.surrenderSequence,
            });
        }
        this.message.text = 'Surrender demand awaiting server response.';
        this.surrenderDeadline = Date.now() + Comms.OUTCOME_TIMEOUT_MS;
        const current = this.contextGuard();
        const poll = setInterval(() => {
            if (!current()) {
                clearInterval(poll);
                if (this.surrenderPoll === poll) this.surrenderPoll = undefined;
                return;
            }
            this.updateSurrenderOutcome();
        }, 100);
        this.surrenderPoll = poll;
    }

    private updateSurrenderOutcome() {
        const outcome = this.input?.components.get(SurrenderOutcomeComponent);
        if (outcome && outcome.target === this.surrenderTarget
            && outcome.sequence === this.surrenderSequence) {
            this.message.text = outcome.status === 'paid'
                ? `Surrender confirmed: ${outcome.amount.toLocaleString()} credits transferred.`
                : `Surrender rejected${outcome.reason ? `: ${outcome.reason}` : '.'}`;
        } else if (Date.now() >= this.surrenderDeadline) {
            this.message.text = 'Surrender response timed out; result unknown. No new demand was sent.';
        } else {
            return;
        }
        this.stopSurrenderOutcomePolling();
    }

    private stopSurrenderOutcomePolling() {
        if (this.surrenderPoll !== undefined) clearInterval(this.surrenderPoll);
        this.surrenderPoll = undefined;
    }

    private async acceptContract() {
        if (this.acceptingContract) return;
        const input = this.input;
        const lifecycle = this.lifecycle;
        const offer = this.pendingShipboardOffer;
        const state = structuredClone(plainSnapshot(input?.components.get(PlayerStateComponent)));
        if (!state || !offer) return;
        const baseline = JSON.stringify(state);
        const current = this.contextGuard();
        this.acceptingContract = true;
        try {
            const options = this.pendingDestinationOptions
                ? this.pendingDestinationOptions(offer.resolved)
                : { initialPlanetId: '', resolved: offer.resolved };
            if (!acceptMission(state, offer.mission, options)) {
                this.message.text = 'Contract could not be accepted. Check mission capacity, cargo space and destination.';
                return;
            }
            await startPendingNcbMissions(this.gameData, state, options);
            if (!current()) return;
            const fresh = plainSnapshot(input.components.get(PlayerStateComponent));
            if (JSON.stringify(fresh) !== baseline) {
                this.message.text = 'Pilot state changed while loading the contract. Please try again.';
                return;
            }
            input.components.set(PlayerStateComponent, state);
            this.message.text = 'Contract confirmed!';
            this.buttons.assistance.setText('Request Assistance');
            this.isOfferingContract = false;
            this.pendingShipboardOffer = undefined;
            this.pendingDestinationOptions = undefined;
        } catch (error) {
            if (this.lifecycle === lifecycle) {
                this.message.text = 'Contract could not be loaded. Please try again.';
                console.warn('Comms contract acceptance failed', error);
            }
        } finally {
            if (this.lifecycle === lifecycle) this.acceptingContract = false;
        }
    }

    private requestAssistance() {
        if (this.isOfferingContract && this.pendingShipboardOffer) {
            void this.acceptContract();
            return;
        }

        if (this.target?.isPlanet) {
            this.demandPlanetTribute();
            return;
        }
        if (this.target?.isEscort) {
            this.orderAttackTarget();
            return;
        }
        const isHostile = Boolean(this.target?.hostile || this.relation() === 'enemy');
        if (isHostile) {
            this.offerBribe();
            return;
        }
        if (this.assistancePoll !== undefined) {
            return;
        }
        if (this.reconcileAssistance()) return;
        const state = this.input?.components.get(PlayerStateComponent);
        const shipData = this.input?.components.get(ShipDataComponent);
        const helper = this.hailedUuid;
        if (!state || !helper) {
            return;
        }
        if (this.pendingPrice > 0) {
            this.acceptPrice(this.pendingPrice);
            return;
        }
        const request = this.input.components.get(AssistanceRequestComponent);
        const decision = assistanceDecision({
            relation: this.relation(),
            hostile: this.target?.hostile ?? false,
            record: this.record(),
            fuel: state.fuel ?? 0,
            fuelCapacity: shipData?.fuelCapacity ?? 0,
            disabled: Boolean(
                this.input?.components.get(DisabledComponent)),
            roadsideAssistance: this.target?.roadsideAssistance,
            isEscort: this.target?.isEscort,
            generosity: assistanceGenerosity(this.input.uuid, helper),
        });
        this.say(decision.block, this.priceSuffix(decision.outcome,
            decision.price));
        if (decision.outcome === 'granted') {
            this.submitAssistance('request', helper, request?.sequence ?? 0);
        } else if (decision.outcome === 'wantsPayment') {
            this.pendingPrice = decision.price;
            this.buttons.assistance.setText('Accept Price');
        }
    }

    private priceSuffix(outcome: AssistanceOutcome, price: number): string {
        return outcome === 'wantsPayment' && price > 0
            ? ` (${price} credits)` : '';
    }


    private orderAttackTarget() {
        const name = this.target?.name ?? 'Escort';
        const targetComponent = this.input?.components?.get(TargetComponent);
        if (!targetComponent?.target) {
            this.message.text = `${this.message.text}\n\n${name}: "No target currently locked on flagship sensors."`;
            return;
        }
        if (this.input) {
            const currentOrder = this.input.components.get(EscortOrderComponent);
            const sequence = (currentOrder?.sequence ?? 0) + 1;
            this.input.components.set(EscortOrderComponent, {
                mode: 'attack',
                sequence,
                targetUuid: targetComponent.target,
            });
        }
        this.message.text = `${this.message.text}\n\n${name}: "Target locked! Engaging target with full weapon batteries."`;
    }

    private offerBribe() {
        const state = this.input?.components?.get(PlayerStateComponent);
        const name = this.target?.name ?? 'Vessel';
        const bribe = 2_000;
        if (!state || state.credits < bribe) {
            this.message.text = `${this.message.text}\n\n${name}: "You don't even have 2,000 credits to offer! Die!"`;
            return;
        }
        state.credits -= bribe;
        this.message.text = `${this.message.text}\n\n${name}: "Credits received (2,000 cr). We will hold fire. Get out of our sight!"`;
    }
    private acceptPrice(price: number) {
        const state = this.input?.components.get(PlayerStateComponent);
        if (!state) {
            return;
        }
        if (state.credits < price) {
            this.say('cannotAfford');
            return;
        }
        const helper = this.hailedUuid;
        if (!helper) {
            return;
        }
        const request = this.input.components.get(AssistanceRequestComponent);
        this.pendingPrice = 0;
        this.buttons.assistance.setText('Request Assistance');
        this.submitAssistance('accept', helper, request?.sequence ?? 0);
    }

    private submitAssistance(
        action: 'request' | 'accept',
        helper: string,
        previousSequence: number,
    ) {
        if (!this.input) {
            return;
        }
        if (this.reconcileAssistance()) return;
        const outcome = this.input.components.get(AssistanceOutcomeComponent);
        const request = this.input.components.get(AssistanceRequestComponent);
        const sequence = Math.max(previousSequence, request?.sequence ?? 0,
            outcome?.sequence ?? 0) + 1;
        this.input.components.set(AssistanceRequestComponent, {
            helper,
            sequence,
            action,
        });
        this.assistanceHelper = helper;
        this.assistanceSequence = sequence;
        this.say('onMyWay');
        this.startAssistanceOutcomePolling();
    }

    private reconcileAssistance(): boolean {
        const outcome = this.input?.components.get(AssistanceOutcomeComponent);
        const request = this.input?.components.get(AssistanceRequestComponent);
        // A paid rescue remains authoritative even when a later request was ignored.
        const pending = outcome?.phase === 'approaching' ? outcome
            : request && (!outcome || request.sequence > outcome.sequence
                || (request.sequence === outcome.sequence && request.helper !== outcome.helper))
                ? request : undefined;
        if (!pending) return false;
        this.assistanceHelper = pending.helper;
        this.assistanceSequence = pending.sequence;
        this.pendingPrice = 0;
        this.say('onMyWay');
        this.startAssistanceOutcomePolling();
        return true;
    }

    private startAssistanceOutcomePolling() {
        // Reconciliation may switch the watched rescue, but must not extend the wait.
        if (this.assistancePoll !== undefined) return;
        this.assistanceDeadline = Date.now() + Comms.OUTCOME_TIMEOUT_MS;
        const current = this.contextGuard();
        const poll = setInterval(() => {
            if (!current()) {
                clearInterval(poll);
                if (this.assistancePoll === poll) this.assistancePoll = undefined;
                return;
            }
            this.updateAssistanceOutcome();
        }, 100);
        this.assistancePoll = poll;
    }

    private stopAssistanceOutcomePolling() {
        if (this.assistancePoll !== undefined) {
            clearInterval(this.assistancePoll);
            this.assistancePoll = undefined;
        }
    }

    private updateAssistanceOutcome() {
        const helper = this.assistanceHelper;
        const sequence = this.assistanceSequence;
        const outcome = this.input?.components.get(
            AssistanceOutcomeComponent);
        if (outcome?.phase === 'approaching'
            && (outcome.helper !== helper || outcome.sequence !== sequence)) {
            // The server may retain a paid rescue and ignore the request we sent.
            // Watch that rescue explicitly, never treat its result as ours.
            this.assistanceHelper = outcome.helper;
            this.assistanceSequence = outcome.sequence;
        }
        if (!helper || sequence === undefined || !outcome
            || outcome.helper !== helper || outcome.sequence !== sequence
            || outcome.phase === 'approaching') {
            if (this.assistanceDeadline && Date.now() >= this.assistanceDeadline) {
                this.stopAssistanceOutcomePolling();
                this.message.text = 'Assistance response timed out; rescue status unknown. Reopen or request assistance to check again.';
            }
            return;
        }
        if (outcome.phase === 'completed') {
            this.say('takeItAndGo');
        } else {
            this.say(this.failureBlock(outcome.reason));
            const explanation = outcome.reason === 'helper-disabled'
                ? 'The assisting ship is disabled and cannot complete the rescue.'
                : outcome.reason === 'government-unavailable'
                    ? 'Assistance is unavailable because government information could not be verified.'
                    : '';
            if (explanation) this.message.text += `\n${explanation}`;
            const refunded = outcome.refundedCredits;
            if (refunded !== undefined && Number.isFinite(refunded) && refunded > 0) {
                this.message.text += `\nServer confirmed a refund of ${refunded.toLocaleString()} credits.`;
            }
        }
        this.stopAssistanceOutcomePolling();
    }

    private failureBlock(
        reason: AssistanceFailureReason | undefined,
    ): CommsBlockName {
        switch (reason) {
            case 'cannot-afford':
                return 'cannotAfford';
            case 'hostile':
                return 'inYourDreams';
            case 'not-stranded':
                return 'notInTrouble';
            case 'payment-required':
                return 'helpForPay';
            case 'refused':
                return 'tooBusy';
            case 'helper-disabled':
            case 'government-unavailable':
                return 'cannotHelp';
            default:
                return 'cannotHelp';
        }
    }

    protected override done() {
        this.lifecycle = (this.lifecycle ?? 0) + 1;
        this.backgroundGeneration = (this.backgroundGeneration ?? 0) + 1;
        this.stopAssistanceOutcomePolling();
        this.stopSurrenderOutcomePolling();
        this.acceptingContract = false;
        const finishShow = this.finishShow;
        this.finishShow = undefined;
        this.container.visible = false;
        this.controls.unbind();
        this.pendingShipboardOffer = undefined;
        this.pendingDestinationOptions = undefined;
        this.isOfferingContract = false;
        this.pendingPrice = 0;
        finishShow?.();
    }

    private async loadLines() {
        const lists = this.gameData.data.StringList;
        if (!lists) {
            return;
        }
        this.lines ??= await lists.get(COMMS_STRING_LIST)
            .then(list => list.strings)
            .catch(() => undefined);
        this.channelLines ??= await lists.get(COMMS_CHANNEL_STRING_LIST)
            .then(list => list.strings)
            .catch(() => undefined);
    }
}

export { ASSISTANCE_PRICE, canHailGovernment, getGovernmentCommName };
