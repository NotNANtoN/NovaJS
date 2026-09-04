import { Observable } from 'rxjs';
import { MissionData } from 'novadatainterface/MissionData';
import { GameData } from '../client/gamedata/GameData';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import { ClassicDialog, CLASSIC_MAC_FONT, CLASSIC_MAC_TITLE_FONT } from './classic_dialog';
import * as PIXI from 'pixi.js';

// Retail PICT 8505 "Mission BBS / Briefing" (471x320)
const BACKGROUND = 'nova:8505';

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
            background: BACKGROUND,
            title: prompt => prompt.title,
            titlePosition: { x: 0, y: -138 },
            titleStyle: {
                ...CLASSIC_MAC_TITLE_FONT,
                fontSize: 13,
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
                                const maxHeight = 85;
                                const scale = Math.min(
                                    maxWidth / (sprite.width || maxWidth),
                                    maxHeight / (sprite.height || maxHeight),
                                    1,
                                );
                                sprite.scale.set(scale);
                                sprite.position.set(145, -112);
                                container.addChild(sprite);
                            } catch {
                                // Fallback if graphic missing
                            }
                        }

                        const wrapWidth = hasGraphic ? 315 : 430;
                        const viewHeight = 210;
                        const viewX = -215;
                        const viewY = -112;

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

                        // Mask to prevent any spill outside the frame
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
                        container.hitArea = new PIXI.Rectangle(viewX, viewY, 435, viewHeight);
                        container.on('wheel', (event: PIXI.FederatedWheelEvent) => {
                            applyScroll(event.deltaY > 0 ? 25 : -25);
                        });
                    },
                },
                {
                    type: 'text',
                    id: 'statusText',
                    position: { x: -215, y: 122 },
                    width: 255,
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
                    width: 65,
                    position: { x: 50, y: 122 },
                    isCancel: true,
                    action: (_dialog, prompt) => {
                        prompt.accepted = false;
                        return prompt;
                    },
                },
                {
                    id: 'accept',
                    label: 'Accept',
                    width: 65,
                    position: { x: 135, y: 122 },
                    isDefault: true,
                    action: (_dialog, prompt) => {
                        prompt.accepted = true;
                        return prompt;
                    },
                },
            ],
        });
    }
}
