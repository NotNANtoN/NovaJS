import {
    ConcourseMissionOffer,
    getShipboardMissionOffers,
} from './mission_bbs';
import {
    acceptMission,
    startPendingNcbMissions,
} from '../nova_plugin/mission_plugin';
import { Entity } from 'nova_ecs/entity';
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
import { DisabledComponent } from '../nova_plugin/death_plugin';
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

    constructor(gameData: GameData, controlEvents: Observable<ControlEvent>) {
        super(gameData, COMMS_LAYOUT.background, controlEvents);

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
        try {
            const sprite = await this.gameData.spriteFromPictAsync(pictId);
            sprite.interactive = true;
            sprite.anchor.set(0.5);
            if (this.container.children.length > 0) {
                this.container.removeChildAt(0);
                this.container.addChildAt(sprite, 0);
            } else {
                this.container.addChild(sprite);
            }
        } catch (e) {
            console.warn(`Failed to load comms background ${pictId}`, e);
        }
    }

    setTarget(target: HailTarget | undefined) {
        this.target = target;
        const bg = target?.isEscort
            ? COMMS_ESCORT_BACKGROUND
            : target?.isPlanet
                ? COMMS_PLANET_BACKGROUND
                : COMMS_SHIP_BACKGROUND;
        void this.setBackgroundPict(bg);
    }

    override async show(input: Entity): Promise<Entity> {
        await this.buildPromise;
        this.stopAssistanceOutcomePolling();
        this.setInput(input);
        this.hailedUuid = input.components.get(TargetComponent)?.target;
        this.pendingPrice = 0;
        this.assistanceHelper = undefined;
        this.assistanceSequence = undefined;
        this.buttons.assistance.setText('Request Assistance');
        this.pendingShipboardOffer = undefined;
        this.isOfferingContract = false;
        try {
            const { offers, destinationOptions } = await getShipboardMissionOffers(this.gameData, input);
            if (offers.length > 0 && !this.target?.hostile && !this.target?.isPlanet && !this.target?.isEscort) {
                this.pendingShipboardOffer = offers[0];
                this.pendingDestinationOptions = destinationOptions;
            }
        } catch {
            // Fallback
        }
        await this.loadLines();
        this.openChannel();
        return super.show(input);
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
            this.buttons.assistance.setText('Information');
            return;
        }
        if (this.target?.isEscort) {
            this.message.text = `Channel open to escort ${name}.\n\nEscort Pilot: "Awaiting orders, Flagship. All fleet systems green."`;
            this.buttons.greetings.setText('Form Up');
            this.buttons.assistance.setText('Attack Target');
            return;
        }
        if (this.target?.hostile) {
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
        if (this.target?.hostile) {
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

    private demandSurrender() {
        const name = this.target?.name ?? 'Vessel';
        this.message.text = `${this.message.text}\n\n${name}: "You think we fear you? We will never surrender! Prepare to burn!"`;
    }

    private requestAssistance() {
        if (this.isOfferingContract && this.pendingShipboardOffer) {
            const state = this.input?.components.get(PlayerStateComponent);
            if (state) {
                const offer = this.pendingShipboardOffer;
                acceptMission(state, offer.mission, {
                    ...this.pendingDestinationOptions!(offer.resolved),
                });
                void startPendingNcbMissions(this.gameData, state, {
                    ...this.pendingDestinationOptions!(offer.resolved),
                });
                this.message.text = `${this.target?.name ?? 'Vessel'}: "Contract confirmed! We appreciate your assistance, Captain."`;
                this.buttons.assistance.setText('Request Assistance');
                this.isOfferingContract = false;
                this.pendingShipboardOffer = undefined;
                return;
            }
        }

        if (this.target?.isEscort) {
            this.orderAttackTarget();
            return;
        }
        if (this.target?.hostile) {
            this.offerBribe();
            return;
        }
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
        const sequence = previousSequence + 1;
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

    private startAssistanceOutcomePolling() {
        this.stopAssistanceOutcomePolling();
        this.assistancePoll = setInterval(
            this.updateAssistanceOutcome.bind(this), 100);
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
        if (!helper || sequence === undefined || !outcome
            || outcome.helper !== helper || outcome.sequence < sequence
            || outcome.phase === 'approaching') {
            return;
        }
        if (outcome.phase === 'completed') {
            this.say('takeItAndGo');
        } else {
            this.say(this.failureBlock(outcome.reason));
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
            default:
                return 'cannotHelp';
        }
    }

    protected override done() {
        this.stopAssistanceOutcomePolling();
        super.done();
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
