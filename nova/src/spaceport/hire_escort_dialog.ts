import { Observable } from 'rxjs';
import * as PIXI from 'pixi.js';
import { GameData } from '../client/gamedata/GameData';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import { ClassicDialog, CLASSIC_MAC_FONT } from './classic_dialog';
import { EscortHireTerms } from '../nova_plugin/escort_plugin';
import { MAXIMUM_ESCORTS } from '../nova_plugin/escort_terms';
import { EscortContract } from '../nova_plugin/player_state';

export interface EscortCandidate {
    id: string;
    shipType: string;
    terms: EscortHireTerms;
    shields: number;
    armor: number;
    speed: number;
    pictId?: string;
}

export interface HireEscortState {
    credits: number;
    roster: readonly EscortContract[];
    candidates: readonly EscortCandidate[];
    selectedCandidateIndex: number;
    statusMessage?: string;
    onHire?: (candidate: EscortCandidate) => boolean;
}

export const HIRE_BACKGROUND = 'nova:8507';

/**
 * Authentic Classic Mac OS Spaceport Bar Escort Hiring Dialog.
 */
export class HireEscortDialog extends ClassicDialog<HireEscortState> {
    private stateData!: HireEscortState;
    private statusTextNode?: PIXI.Text;

    constructor(
        gameData: GameData,
        controlEvents: Observable<ControlEvent>,
    ) {
        super(gameData, controlEvents, {
            background: HIRE_BACKGROUND,
            title: data => {
                const candidate = data.candidates[data.selectedCandidateIndex];
                return candidate ? `Mercenary Pilot: ${candidate.shipType}` : 'No Escorts Available';
            },
            titlePosition: { x: 0, y: -248 },
            titleStyle: {
                fontFamily: 'Geneva, Chicago, Arial, sans-serif',
                fontSize: 12,
                fontWeight: 'bold',
                fill: 0xffffff,
                align: 'center',
            },
            sections: [
                {
                    type: 'columns',
                    id: 'specs',
                    position: { x: -280, y: 95 },
                    colWidth: 120,
                    items: [
                        {
                            label: 'Ship Class:',
                            value: data => data.candidates[data.selectedCandidateIndex]?.shipType ?? 'None',
                        },
                        {
                            label: 'Shields:',
                            value: data => `${data.candidates[data.selectedCandidateIndex]?.shields ?? 0}`,
                        },
                        {
                            label: 'Armor:',
                            value: data => `${data.candidates[data.selectedCandidateIndex]?.armor ?? 0}`,
                        },
                        {
                            label: 'Max Velocity:',
                            value: data => `${data.candidates[data.selectedCandidateIndex]?.speed ?? 0}`,
                        },
                    ],
                },
                {
                    type: 'columns',
                    id: 'terms',
                    position: { x: -90, y: 95 },
                    colWidth: 110,
                    items: [
                        {
                            label: 'Signing Fee:',
                            value: data => `${(data.candidates[data.selectedCandidateIndex]?.terms.hirePrice ?? 0).toLocaleString()} cr`,
                            color: 0xffd588,
                        },
                        {
                            label: 'Daily Pay:',
                            value: data => `${(data.candidates[data.selectedCandidateIndex]?.terms.dailyPay ?? 0).toLocaleString()} cr/day`,
                        },
                        {
                            label: 'Active Fleet:',
                            value: data => `${data.roster.length} / ${MAXIMUM_ESCORTS} escorts`,
                        },
                        {
                            label: 'Your Credits:',
                            value: data => `${data.credits.toLocaleString()} cr`,
                            color: 0x44ff88,
                        },
                    ],
                },
                {
                    type: 'custom',
                    id: 'statusPane',
                    render: (container, data) => {
                        this.statusTextNode = new PIXI.Text({
                            text: data.statusMessage ?? 'Mercenary pilot awaiting combat contract.',
                            style: {
                                ...CLASSIC_MAC_FONT,
                                fontSize: 10,
                                fill: 0xffe0a0,
                                wordWrap: true,
                                wordWrapWidth: 200,
                            },
                        });
                        this.statusTextNode.position.set(100, 95);
                        container.addChild(this.statusTextNode);
                    },
                },
            ],
            buttons: [
                {
                    id: 'next',
                    label: 'Next Wingman',
                    width: 80,
                    position: { x: -110, y: 218 },
                    action: async () => {
                        if (this.stateData.candidates.length > 1) {
                            this.stateData.selectedCandidateIndex =
                                (this.stateData.selectedCandidateIndex + 1) % this.stateData.candidates.length;
                            this.stateData.statusMessage = 'Viewing next mercenary candidate.';
                            void this.show(this.stateData);
                        }
                        return this.stateData;
                    },
                },
                {
                    id: 'hire',
                    label: 'Sign Contract',
                    width: 80,
                    position: { x: 5, y: 218 },
                    action: async () => {
                        this.executeHire();
                        return this.stateData;
                    },
                },
                {
                    id: 'done',
                    label: 'Done',
                    width: 50,
                    position: { x: 120, y: 218 },
                    isDefault: true,
                    isCancel: true,
                    action: async () => {
                        return this.stateData;
                    },
                },
            ],
        });
    }

    private executeHire() {
        const candidate = this.stateData.candidates[this.stateData.selectedCandidateIndex];
        if (!candidate) {
            this.stateData.statusMessage = 'No mercenary candidates available for hire.';
            return;
        }

        if (this.stateData.roster.length >= MAXIMUM_ESCORTS) {
            this.stateData.statusMessage = `Fleet roster full! Maximum of ${MAXIMUM_ESCORTS} escorts allowed.`;
            void this.show(this.stateData);
            return;
        }

        if (this.stateData.credits < candidate.terms.hirePrice) {
            this.stateData.statusMessage = `Insufficient credits! You need ${candidate.terms.hirePrice.toLocaleString()} cr.`;
            void this.show(this.stateData);
            return;
        }

        const success = this.stateData.onHire?.(candidate);
        if (success !== false) {
            this.stateData.credits -= candidate.terms.hirePrice;
            this.stateData.statusMessage = `Contract signed! ${candidate.shipType} added to your escort formation.`;
            void this.show(this.stateData);
        }
    }

    override async show(input: HireEscortState): Promise<HireEscortState> {
        this.stateData = input;
        return super.show(input);
    }
}
