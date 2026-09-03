import { Observable } from 'rxjs';
import * as PIXI from 'pixi.js';
import { GameData } from '../client/gamedata/GameData';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import { ClassicDialog, CLASSIC_MAC_FONT } from './classic_dialog';

export interface GambleState {
    credits: number;
    lastWager: number;
    lastResult: string;
    totalWon: number;
    onCreditsChange?: (credits: number) => void;
}

export const GAMBLE_BACKGROUND = 'nova:8515';

/**
 * Authentic Classic Mac OS Spaceport Cantina Dice Gambling Dialog.
 */
export class GambleDialog extends ClassicDialog<GambleState> {
    private stateData: GambleState = {
        credits: 10_000,
        lastWager: 0,
        lastResult: 'Place your wager against the house.',
        totalWon: 0,
    };

    private resultTextNode?: PIXI.Text;

    constructor(
        gameData: GameData,
        controlEvents: Observable<ControlEvent>,
    ) {
        super(gameData, controlEvents, {
            background: GAMBLE_BACKGROUND,
            title: () => 'Cantina High-Stakes Gambling',
            titlePosition: { x: 0, y: -72 },
            subtitle: () => 'Roll 2d6 against the house dealer. Highest roll wins!',
            subtitlePosition: { x: 0, y: -52 },
            sections: [
                {
                    type: 'columns',
                    id: 'stats',
                    position: { x: -140, y: -25 },
                    colWidth: 140,
                    items: [
                        {
                            label: 'Credits:',
                            value: data => `${data.credits.toLocaleString()} cr`,
                            color: 0xffd588,
                        },
                        {
                            label: 'Last Wager:',
                            value: data => data.lastWager > 0 ? `${data.lastWager.toLocaleString()} cr` : 'None',
                        },
                        {
                            label: 'Session Net:',
                            value: data => `${data.totalWon >= 0 ? '+' : ''}${data.totalWon.toLocaleString()} cr`,
                            color: 0x44ff88,
                        },
                    ],
                },
                {
                    type: 'custom',
                    id: 'resultPane',
                    render: (container, data) => {
                        this.resultTextNode = new PIXI.Text({
                            text: data.lastResult,
                            style: {
                                ...CLASSIC_MAC_FONT,
                                fontSize: 11,
                                fill: 0xffffff,
                                align: 'center',
                                wordWrap: true,
                                wordWrapWidth: 260,
                            },
                        });
                        this.resultTextNode.anchor.set(0.5, 0);
                        this.resultTextNode.position.set(0, 20);
                        container.addChild(this.resultTextNode);
                    },
                },
            ],
            buttons: [
                {
                    id: 'bet1000',
                    label: 'Bet 1,000',
                    width: 75,
                    position: { x: -95, y: 55 },
                    action: async () => {
                        this.playRound(1_000);
                        return this.stateData;
                    },
                },
                {
                    id: 'bet5000',
                    label: 'Bet 5,000',
                    width: 75,
                    position: { x: 0, y: 55 },
                    action: async () => {
                        this.playRound(5_000);
                        return this.stateData;
                    },
                },
                {
                    id: 'leave',
                    label: 'Leave',
                    width: 60,
                    position: { x: 95, y: 55 },
                    isDefault: true,
                    isCancel: true,
                    action: async () => {
                        return this.stateData;
                    },
                },
            ],
        });
    }

    private playRound(wager: number) {
        if (this.stateData.credits < wager) {
            this.stateData.lastResult = `You need at least ${wager.toLocaleString()} credits to place this wager!`;
            if (this.resultTextNode) {
                this.resultTextNode.text = this.stateData.lastResult;
            }
            return;
        }

        const playerRoll = (Math.floor(Math.random() * 6) + 1) + (Math.floor(Math.random() * 6) + 1);
        const houseRoll = (Math.floor(Math.random() * 6) + 1) + (Math.floor(Math.random() * 6) + 1);

        this.stateData.lastWager = wager;

        if (playerRoll > houseRoll) {
            this.stateData.credits += wager;
            this.stateData.totalWon += wager;
            this.stateData.lastResult = `Victory! You rolled a ${playerRoll} against the house's ${houseRoll}. Won ${wager.toLocaleString()} credits!`;
        } else if (playerRoll < houseRoll) {
            this.stateData.credits -= wager;
            this.stateData.totalWon -= wager;
            this.stateData.lastResult = `House wins. The dealer rolled a ${houseRoll} against your ${playerRoll}. Lost ${wager.toLocaleString()} credits.`;
        } else {
            this.stateData.lastResult = `Standoff! Both rolled a ${playerRoll}. Bets returned.`;
        }

        if (this.resultTextNode) {
            this.resultTextNode.text = this.stateData.lastResult;
        }
        this.stateData.onCreditsChange?.(this.stateData.credits);
        // Refresh display
        void this.show(this.stateData);
    }

    override async show(input: GambleState): Promise<GambleState> {
        this.stateData = input;
        return super.show(input);
    }
}
