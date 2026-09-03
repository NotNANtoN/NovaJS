import { Observable } from 'rxjs';
import { MissionData } from 'novadatainterface/MissionData';
import { GameData } from '../client/gamedata/GameData';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import { ClassicDialog, CLASSIC_MAC_FONT, CLASSIC_MAC_TITLE_FONT } from './classic_dialog';

const BACKGROUND = 'nova:8517'; // Retail PICT 8517 "Mission Info"

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
            titlePosition: { x: 0, y: -68 },
            titleStyle: {
                ...CLASSIC_MAC_TITLE_FONT,
                fontSize: 12,
            },
            sections: [
                {
                    type: 'custom',
                    id: 'briefGraphic',
                    render: (container, prompt, gData) => {
                        container.removeChildren();
                        if (prompt.mission.briefGraphic && prompt.mission.briefGraphic > 0) {
                            try {
                                const sprite = gData.spriteFromPict(`nova:${prompt.mission.briefGraphic}`);
                                sprite.anchor.set(0.5, 0);
                                const maxWidth = 120;
                                const maxHeight = 80;
                                const scale = Math.min(
                                    maxWidth / (sprite.width || maxWidth),
                                    maxHeight / (sprite.height || maxHeight),
                                    1,
                                );
                                sprite.scale.set(scale);
                                sprite.position.set(140, -45);
                                container.addChild(sprite);
                            } catch {
                                // Fallback
                            }
                        }
                    },
                },
                {
                    type: 'text',
                    id: 'bodyText',
                    position: { x: -210, y: -42 },
                    width: 420,
                    content: prompt => prompt.text,
                    style: {
                        ...CLASSIC_MAC_FONT,
                        fontSize: 10,
                        wordWrap: true,
                        wordWrapWidth: 420,
                    },
                },
                {
                    type: 'text',
                    id: 'statusText',
                    position: { x: -210, y: 38 },
                    width: 250,
                    content: prompt => {
                        const parts: string[] = [];
                        if (prompt.payText) parts.push(`Payment: ${prompt.payText}`);
                        if (prompt.cargoText) parts.push(`Cargo: ${prompt.cargoText}`);
                        return parts.join('   ');
                    },
                    style: {
                        ...CLASSIC_MAC_FONT,
                        fontSize: 10,
                        fill: 0xffd588,
                    },
                },
            ],
            buttons: [
                {
                    id: 'refuse',
                    label: 'Refuse',
                    width: 60,
                    position: { x: 50, y: 38 },
                    isCancel: true,
                    action: (_dialog, prompt) => {
                        prompt.accepted = false;
                        return prompt;
                    },
                },
                {
                    id: 'accept',
                    label: 'Accept',
                    width: 60,
                    position: { x: 130, y: 38 },
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
