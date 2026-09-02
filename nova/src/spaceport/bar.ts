import { MissionOfferLocation } from 'novadatainterface/MissionData';
import * as PIXI from 'pixi.js';
import { Observable } from 'rxjs';
import { GameData } from '../client/gamedata/GameData';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import {
    BAR_STRING_LISTS,
    BarFlavorKind,
    RetailStringLists,
    barButtonLabel,
    barFlavorText,
} from './bar_content';
import { BAR_LAYOUT, barButtonSlots } from './bar_layout';
import { Button } from './button';
import { MissionBoard } from './mission_bbs';
import { MenuControls } from './menu_controls';

export class Bar extends MissionBoard {
    private readonly hub = new PIXI.Container();
    private readonly inheritedVisibility:
        ReadonlyMap<PIXI.Container, boolean>;
    private readonly content = new PIXI.Text('', {
        fontFamily: 'Geneva',
        fontSize: 10,
        fill: 0xffffff,
        align: 'left',
        wordWrap: true,
        wordWrapWidth: BAR_LAYOUT.text.width,
    });
    private readonly missionControls: MenuControls['controls'];
    private missionsButton!: Button;
    private flavorKind: BarFlavorKind = 'news';
    private flavorIndex = 0;
    private retailStrings: RetailStringLists = {};
    private retailStringsPromise?: Promise<void>;

    constructor(
        gameData: GameData,
        planetId: string,
        controlEvents: Observable<ControlEvent>,
        onInfo?: () => void | Promise<void>,
    ) {
        super(
            gameData,
            planetId,
            controlEvents,
            MissionOfferLocation.Bar,
            '',
            onInfo,
        );

        this.missionControls = { ...this.controls.controls };
        this.inheritedVisibility = new Map(this.container.children.map(child =>
            [child, child.visible] as const));

        const background = gameData.spriteFromPict(BAR_LAYOUT.background);
        background.anchor.set(0.5);
        background.interactive = true;
        this.hub.addChild(background);

        this.content.position.set(BAR_LAYOUT.text.x, BAR_LAYOUT.text.y);
        const mask = new PIXI.Graphics();
        mask.rect(
            BAR_LAYOUT.text.x,
            BAR_LAYOUT.text.y,
            BAR_LAYOUT.text.width,
            BAR_LAYOUT.text.height,
        ).fill(0xffffff);
        this.content.mask = mask;
        this.hub.addChild(mask, this.content);

        const firstRow = barButtonSlots([45, 48, 75]);
        const secondRow = barButtonSlots([65, 35]);
        const gamble = new Button(gameData, 'Gamble', firstRow[0]!.width, {
            x: firstRow[0]!.x,
            y: firstRow[0]!.y,
        });
        const holovid = new Button(gameData, 'Holovid', firstRow[1]!.width, {
            x: firstRow[1]!.x,
            y: firstRow[1]!.y,
        });
        const hire = new Button(gameData, 'Hire Escort', firstRow[2]!.width, {
            x: firstRow[2]!.x,
            y: firstRow[2]!.y,
        });
        // Not the Mission BBS: STR# 150 files that label with the spaceport
        // menu, alongside Trade Center and Outfitter. What the bar offers is
        // the people drinking in it, so it says so, and says nothing when
        // there is nobody to talk to.
        const missions = new Button(
            gameData, 'Ask Around', secondRow[0]!.width, {
                x: secondRow[0]!.x,
                y: secondRow[0]!.y + 28,
            });
        const done = new Button(gameData, 'Done', secondRow[1]!.width, {
            x: secondRow[1]!.x,
            y: secondRow[1]!.y + 28,
        });
        // Retail exposes these actions, but its binary-only odds and escort
        // price/pay formulas are not described by the Bible or data fields.
        gamble.state = 'grey';
        hire.state = 'grey';
        holovid.click.subscribe(() => {
            this.flavorKind = 'holovid';
            this.flavorIndex++;
            this.renderFlavor();
        });
        this.missionsButton = missions;
        missions.click.subscribe(() => this.showMissions());
        done.click.subscribe(this.done.bind(this));
        for (const button of [gamble, holovid, hire, missions, done]) {
            this.hub.addChild(button.container);
        }
        this.container.addChild(this.hub);

        const cycle = (delta: number) => {
            this.flavorIndex += delta;
            this.renderFlavor();
        };
        this.controls.controls = {
            up: () => cycle(-1),
            down: () => cycle(1),
            missions: () => this.showMissions(),
            depart: this.done.bind(this),
        };

        void this.loadRetailStrings().then(() => {
            gamble.setText(barButtonLabel(this.retailStrings, 'gamble')
                ?? 'Gamble');
            holovid.setText(barButtonLabel(this.retailStrings, 'holovid')
                ?? 'Holovid');
            hire.setText(barButtonLabel(this.retailStrings, 'hireEscort')
                ?? 'Hire Escort');
            done.setText(barButtonLabel(this.retailStrings, 'done') ?? 'Done');
            this.renderFlavor();
        });
        // Lay the hub out, but leave the keys alone: this runs when the
        // spaceport is built, and binding here would leave the bar listening
        // for its own keys while the pilot is still on the landing screen.
        this.showHub(false);
    }

    override async show(input: Parameters<MissionBoard['show']>[0]) {
        await this.loadRetailStrings();
        const showing = super.show(input);
        this.showHub();
        return showing;
    }

    private showHub(bind = true) {
        for (const child of this.inheritedVisibility.keys()) {
            child.visible = false;
        }
        this.hub.visible = true;
        this.missionsButton.state = this.offerCount > 0 ? 'normal' : 'grey';
        this.controls.controls = {
            up: () => {
                this.flavorIndex--;
                this.renderFlavor();
            },
            down: () => {
                this.flavorIndex++;
                this.renderFlavor();
            },
            missions: () => this.showMissions(),
            depart: this.done.bind(this),
        };
        if (bind) {
            this.controls.bind();
        }
        this.renderFlavor();
    }

    private showMissions() {
        if (this.offerCount === 0) {
            return;
        }
        this.hub.visible = false;
        for (const [child, visible] of this.inheritedVisibility) {
            child.visible = visible;
        }
        this.controls.controls = this.missionControls;
        this.controls.bind();
    }

    private async loadRetailStrings() {
        if (this.retailStringsPromise) {
            return this.retailStringsPromise;
        }
        this.retailStringsPromise = (async () => {
            const stringLists = this.gameData.data.StringList;
            if (!stringLists) {
                return;
            }
            const load = async (id: number) => {
                try {
                    return (await stringLists.get(`nova:${id}`)).strings;
                } catch {
                    return undefined;
                }
            };
            const [buttons, messages, commercials, news] = await Promise.all([
                load(BAR_STRING_LISTS.buttons),
                load(BAR_STRING_LISTS.messages),
                load(BAR_STRING_LISTS.commercials),
                load(BAR_STRING_LISTS.news),
            ]);
            this.retailStrings = { buttons, messages, commercials, news };
        })();
        return this.retailStringsPromise;
    }

    private renderFlavor() {
        this.content.text = barFlavorText(
            this.retailStrings,
            this.flavorKind,
            this.flavorIndex,
        ) ?? '';
    }
}
