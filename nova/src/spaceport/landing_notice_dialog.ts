import * as PIXI from 'pixi.js';
import { Observable } from 'rxjs';
import { GameData } from '../client/gamedata/GameData';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import { MissionNotice } from '../nova_plugin/mission_plugin';
import { Button } from './button';
import { Menu } from './menu';

const BACKGROUND = 'nova:8517';
const OK_BUTTON = { x: 130, y: 38 };

export class LandingNoticeDialog extends Menu<MissionNotice> {
    private readonly titleText = new PIXI.Text('', {
        fontFamily: 'Geneva', fontSize: 13, fill: 0xffffff, align: 'center',
    });
    private readonly bodyText = new PIXI.Text('', {
        fontFamily: 'Geneva', fontSize: 10, fill: 0xffffff,
        align: 'left', wordWrap: true, wordWrapWidth: 420,
    });

    constructor(
        gameData: GameData,
        controlEvents: Observable<ControlEvent>,
    ) {
        super(gameData, BACKGROUND, controlEvents);
        this.titleText.anchor.set(0.5, 0);
        this.titleText.position.set(0, -68);

        this.bodyText.position.set(-210, -42);

        const ok = new Button(gameData, 'OK', 50, OK_BUTTON);
        this.addButtons({ ok });
        ok.click.subscribe(this.done.bind(this));

        this.container.addChild(this.titleText, this.bodyText);

        this.controls.controls = {
            depart: this.done.bind(this),
            buy: this.done.bind(this),
            properties: this.done.bind(this),
        };
    }

    override async show(notice: MissionNotice): Promise<MissionNotice> {
        await this.buildPromise;
        this.titleText.text = notice.kind === 'success' ? 'Mission Complete' : 'Mission Notice';
        this.titleText.style.fill = notice.kind === 'success' ? 0xffffff : 0xff5555;
        this.bodyText.text = notice.text;
        return super.show(notice);
    }
}
