import { Observable } from 'rxjs';
import { GameData } from '../client/gamedata/GameData';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import { MissionNotice } from '../nova_plugin/mission_plugin';
import { ClassicDialog } from './classic_dialog';

// Retail PICT 8517 "Mission Info"
const BACKGROUND = 'nova:8517';
const OK_BUTTON = { x: 130, y: 38 };

export class LandingNoticeDialog extends ClassicDialog<MissionNotice> {
    constructor(
        gameData: GameData,
        controlEvents: Observable<ControlEvent>,
    ) {
        super(gameData, controlEvents, {
            background: BACKGROUND,
            title: notice => notice.kind === 'success' ? 'Mission Complete' : 'Mission Notice',
            titlePosition: { x: 0, y: -68 },
            titleStyle: (notice: MissionNotice) => ({
                fontFamily: 'Geneva, Chicago, Arial, sans-serif',
                fontSize: 13,
                fontWeight: 'bold',
                fill: notice.kind === 'success' ? 0xffffff : 0xff5555,
                align: 'center',
            }),
            sections: [
                {
                    type: 'text',
                    id: 'bodyText',
                    position: { x: -210, y: -42 },
                    width: 420,
                    content: notice => notice.text,
                    style: {
                        fontFamily: 'Geneva, Monaco, Arial, sans-serif',
                        fontSize: 10,
                        fill: 0xffffff,
                        align: 'left',
                        wordWrap: true,
                        wordWrapWidth: 420,
                    },
                },
            ],
            buttons: [
                {
                    id: 'ok',
                    label: 'OK',
                    width: 50,
                    position: OK_BUTTON,
                    isDefault: true,
                    isCancel: true,
                },
            ],
        });
    }
}
