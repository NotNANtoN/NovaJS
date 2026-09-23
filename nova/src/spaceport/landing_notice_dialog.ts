import * as PIXI from 'pixi.js';
import { Observable } from 'rxjs';
import { GameData } from '../client/gamedata/GameData';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import { MissionNotice } from '../nova_plugin/mission_plugin';
import { ClassicDialog, CLASSIC_MAC_FONT, CLASSIC_MAC_TITLE_FONT } from './classic_dialog';

// Retail PICT 8524 (upper, 441x9), 8525 (middle, 441x365), 8526 (lower, 441x40)
// "Generic text/briefing" 3-piece modal dialog frame (total 441x414)
export const LANDING_NOTICE_FRAME = {
    width: 441,
    height: 414,
    topHeight: 9,
    middleHeight: 365,
    bottomHeight: 40,
} as const;

export class LandingNoticeDialog extends ClassicDialog<MissionNotice> {
    constructor(
        gameData: GameData,
        controlEvents: Observable<ControlEvent>,
    ) {
        super(gameData, controlEvents, {
            background: 'nova:8525',
            title: notice => notice.kind === 'success'
                ? 'Mission Complete'
                : (notice.kind === 'failure' ? 'Mission Failed' : 'Mission Notice'),
            titlePosition: { x: 0, y: -188 },
            titleStyle: (notice: MissionNotice) => ({
                ...CLASSIC_MAC_TITLE_FONT,
                fontSize: 13,
                fontWeight: 'bold',
                fill: notice.kind === 'failure' ? 0xff5555 : 0xffd588,
                align: 'center',
            }),
            sections: [
                {
                    type: 'custom',
                    id: 'noticeContent',
                    render: async (container, notice, gData) => {
                        container.removeChildren();

                        const hasGraphic = Boolean(notice.graphic && notice.graphic > 0);
                        if (hasGraphic) {
                            try {
                                const texture = await gData.textureFromPictAsync(`nova:${notice.graphic}`);
                                if (texture && texture !== PIXI.Texture.EMPTY) {
                                    const sprite = new PIXI.Sprite(texture);
                                    sprite.anchor.set(0.5, 0);
                                    const maxWidth = 115;
                                    const maxHeight = 90;
                                    const scale = Math.min(
                                        maxWidth / (texture.width || maxWidth),
                                        maxHeight / (texture.height || maxHeight),
                                        1,
                                    );
                                    sprite.scale.set(scale);
                                    sprite.position.set(135, -155);
                                    container.addChild(sprite);
                                }
                            } catch {
                                // Fallback if graphic missing
                            }
                        }

                        const wrapWidth = hasGraphic ? 275 : 400;
                        const viewHeight = 318;
                        const viewX = -200;
                        const viewY = -160;

                        // Scrollable text container
                        const scrollContainer = new PIXI.Container();
                        scrollContainer.position.set(viewX, viewY);

                        const textSprite = new PIXI.Text({
                            text: notice.text,
                            style: {
                                ...CLASSIC_MAC_FONT,
                                fontSize: 11,
                                wordWrap: true,
                                wordWrapWidth: wrapWidth,
                                fill: 0xffffff,
                                lineHeight: 16,
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

                        // Mouse wheel scroll handling
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
            ],
            buttons: [
                {
                    id: 'ok',
                    label: 'OK',
                    width: 70,
                    position: { x: 130, y: 174 },
                    isDefault: true,
                    isCancel: true,
                },
            ],
        });

        // Assemble the authentic retail 3-part generic text/briefing frame:
        // 8524 (upper, 441x9) + 8525 (middle, 441x365) + 8526 (lower, 441x40)
        const bgContainer = new PIXI.Container();
        const topCap = gameData.spriteFromPict('nova:8524');
        topCap.anchor.set(0.5, 0);
        topCap.position.set(0, -207);

        const middle = gameData.spriteFromPict('nova:8525');
        middle.anchor.set(0.5, 0);
        middle.position.set(0, -198);

        const bottomCap = gameData.spriteFromPict('nova:8526');
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
