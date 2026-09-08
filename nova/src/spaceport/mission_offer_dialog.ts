import { Observable } from 'rxjs';
import { MissionData } from 'novadatainterface/MissionData';
import { GameData } from '../client/gamedata/GameData';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import { ClassicDialog, CLASSIC_MAC_FONT, CLASSIC_MAC_TITLE_FONT } from './classic_dialog';
import * as PIXI from 'pixi.js';

// Retail PICT 8521 (upper, 441x9), 8522 (middle, 441x365), 8523 (lower, 441x40)
// "Mission offer" 3-piece dialog frame (total 441x414)
export const MISSION_OFFER_FRAME = {
    width: 441,
    height: 414,
    topHeight: 9,
    middleHeight: 365,
    bottomHeight: 40,
} as const;

export interface MissionOfferPrompt {
    mission: MissionData;
    title: string;
    text: string;
    payText?: string;
    cargoText?: string;
    acceptLabel?: string;
    refuseLabel?: string;
    accepted?: boolean;
}

export class MissionOfferDialog extends ClassicDialog<MissionOfferPrompt> {
    constructor(
        gameData: GameData,
        controlEvents: Observable<ControlEvent>,
    ) {
        super(gameData, controlEvents, {
            background: 'nova:8522',
            title: prompt => prompt.title,
            titlePosition: { x: 0, y: -188 },
            titleStyle: {
                ...CLASSIC_MAC_TITLE_FONT,
                fontSize: 13,
                fill: 0xffd588,
            },
            sections: [
                {
                    type: 'custom',
                    id: 'briefContent',
                    render: (container, prompt, gData) => {
                        container.removeChildren();

                        const hasGraphic = Boolean(prompt.mission.briefGraphic && prompt.mission.briefGraphic > 0);
                        if (hasGraphic) {
                            try {
                                const sprite = gData.spriteFromPict(`nova:${prompt.mission.briefGraphic}`);
                                sprite.anchor.set(0.5, 0);
                                const maxWidth = 115;
                                const maxHeight = 90;
                                const scale = Math.min(
                                    maxWidth / (sprite.width || maxWidth),
                                    maxHeight / (sprite.height || maxHeight),
                                    1,
                                );
                                sprite.scale.set(scale);
                                sprite.position.set(135, -155);
                                container.addChild(sprite);
                            } catch {
                                // Fallback if graphic missing
                            }
                        }

                        const wrapWidth = hasGraphic ? 275 : 400;
                        const viewHeight = 318;
                        const viewX = -200;
                        const viewY = -162;

                        // Scrollable text container
                        const scrollContainer = new PIXI.Container();
                        scrollContainer.position.set(viewX, viewY);

                        const textSprite = new PIXI.Text({
                            text: prompt.text,
                            style: {
                                ...CLASSIC_MAC_FONT,
                                fontSize: 11,
                                wordWrap: true,
                                wordWrapWidth: wrapWidth,
                                fill: 0xffffff,
                            },
                        });
                        scrollContainer.addChild(textSprite);

                        // Mask to keep text cleanly framed inside the inner area
                        const mask = new PIXI.Graphics()
                            .rect(viewX, viewY, wrapWidth + 10, viewHeight)
                            .fill(0xffffff);
                        container.addChild(mask);
                        scrollContainer.mask = mask;
                        container.addChild(scrollContainer);

                        // Mouse wheel & keyboard scroll handling
                        const maxScroll = Math.max(0, textSprite.height - viewHeight + 10);
                        let scrollOffset = 0;
                        const applyScroll = (delta: number) => {
                            if (maxScroll <= 0) return;
                            scrollOffset = Math.max(0, Math.min(maxScroll, scrollOffset + delta));
                            scrollContainer.position.y = viewY - scrollOffset;
                        };

                        container.eventMode = 'static';
                        container.hitArea = new PIXI.Rectangle(viewX, viewY, 410, viewHeight);
                        container.on('wheel', (event: PIXI.FederatedWheelEvent) => {
                            applyScroll(event.deltaY > 0 ? 25 : -25);
                        });
                    },
                },
                {
                    type: 'text',
                    id: 'statusText',
                    position: { x: -200, y: 178 },
                    width: 235,
                    content: prompt => {
                        const parts: string[] = [];
                        if (prompt.payText) parts.push(`Payment: ${prompt.payText}`);
                        if (prompt.cargoText) parts.push(`Cargo: ${prompt.cargoText}`);
                        return parts.join('   ');
                    },
                    style: {
                        ...CLASSIC_MAC_FONT,
                        fontSize: 11,
                        fill: 0xffd588,
                    },
                },
            ],
            buttons: [
                {
                    id: 'refuse',
                    label: 'Refuse',
                    width: 70,
                    position: { x: 45, y: 174 },
                    isCancel: true,
                    action: (_dialog, prompt) => {
                        prompt.accepted = false;
                        return prompt;
                    },
                },
                {
                    id: 'accept',
                    label: 'Accept',
                    width: 70,
                    position: { x: 130, y: 174 },
                    isDefault: true,
                    action: (_dialog, prompt) => {
                        prompt.accepted = true;
                        return prompt;
                    },
                },
            ],
            onShow: (dialog, prompt) => {
                dialog.getButton('accept')?.setText(prompt.acceptLabel || 'Accept');
                dialog.getButton('refuse')?.setText(prompt.refuseLabel || 'Refuse');
            },
        });

        // Assemble the authentic retail 3-part mission offer frame:
        // 8521 (upper, 441x9) + 8522 (middle, 441x365) + 8523 (lower, 441x40)
        const bgContainer = new PIXI.Container();
        const topCap = gameData.spriteFromPict('nova:8521');
        topCap.anchor.set(0.5, 0);
        topCap.position.set(0, -207);

        const middle = gameData.spriteFromPict('nova:8522');
        middle.anchor.set(0.5, 0);
        middle.position.set(0, -198);

        const bottomCap = gameData.spriteFromPict('nova:8523');
        bottomCap.anchor.set(0.5, 0);
        bottomCap.position.set(0, 167);

        bgContainer.addChild(topCap, middle, bottomCap);
        bgContainer.eventMode = 'static';

        if (this.container.children.length > 0) {
            this.container.removeChildAt(0);
        }
        this.container.addChildAt(bgContainer, 0);
    }
}
