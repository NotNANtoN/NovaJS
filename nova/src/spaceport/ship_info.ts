import { OutfitData } from 'novadatainterface/OutiftData';
import { Entity } from 'nova_ecs/entity';
import * as PIXI from 'pixi.js';
import { Observable } from 'rxjs';
import { GameData } from '../client/gamedata/GameData';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import { OutfitsStateComponent } from '../nova_plugin/outfit_plugin';
import { PlayerStateComponent } from '../nova_plugin/player_state';
import { ShipDataComponent } from '../nova_plugin/ship_plugin';
import { Button } from './button';
import { Menu } from './menu';
import { MenuControls } from './menu_controls';
import {
    shipInfoCargo,
    shipInfoFacts,
    shipInfoMissions,
    shipInfoOutfits,
} from './ship_info_content';
import { SHIP_INFO_LAYOUT } from './ship_info_layout';

const SHIP_INFO_FONT = {
    heading: {
        fontFamily: 'Geneva', fontSize: 12, fill: 0xffffff, align: 'left',
    } as const,
    body: {
        fontFamily: 'Geneva', fontSize: 10, fill: 0xffffff,
        align: 'left', wordWrap: true, wordWrapWidth: 280,
    } as const,
    summary: {
        fontFamily: 'Geneva', fontSize: 10, fill: 0xffff00, align: 'left',
    } as const,
};

function addPane(
    owner: PIXI.Container,
    region: { x: number; y: number; width: number; height: number },
    style: PIXI.TextStyle | Partial<PIXI.ITextStyle>,
): PIXI.Text {
    const text = new PIXI.Text('', style);
    text.position.set(region.x, region.y);
    if (text.style.wordWrap) {
        text.style.wordWrapWidth = region.width;
    }
    const mask = new PIXI.Graphics();
    mask.beginFill(0xffffff);
    mask.drawRect(region.x, region.y, region.width, region.height);
    mask.endFill();
    text.mask = mask;
    owner.addChild(mask, text);
    return text;
}

/**
 * The retail pilot-status dialog, reached with the "properties" key both in
 * flight and while landed. Ranks and legal record are deliberately absent:
 * neither exists as game state yet, and inventing rows for them would
 * misreport the pilot.
 */
export class ShipInfo extends Menu<Entity> {
    private readonly facts: PIXI.Text;
    private readonly outfits: PIXI.Text;
    private readonly summary: PIXI.Text;
    private readonly missions: PIXI.Text;
    private systemName?: string;

    constructor(
        gameData: GameData,
        controlEvents: Observable<ControlEvent>,
    ) {
        super(gameData, SHIP_INFO_LAYOUT.background, controlEvents);
        this.facts = addPane(
            this.container, SHIP_INFO_LAYOUT.facts, SHIP_INFO_FONT.body);
        this.outfits = addPane(
            this.container, SHIP_INFO_LAYOUT.outfits, SHIP_INFO_FONT.body);
        this.summary = addPane(
            this.container, SHIP_INFO_LAYOUT.summary, SHIP_INFO_FONT.summary);
        this.missions = addPane(
            this.container, SHIP_INFO_LAYOUT.missions, SHIP_INFO_FONT.body);

        const done = new Button(
            gameData, 'Done', 50, SHIP_INFO_LAYOUT.doneButton);
        this.addButtons({ done });
        done.click.subscribe(this.done.bind(this));

        this.controls = new MenuControls(controlEvents, {
            properties: this.done.bind(this),
            depart: this.done.bind(this),
        });
    }

    setSystemName(name: string | undefined) {
        this.systemName = name;
    }

    override async show(input: Entity): Promise<Entity> {
        await this.buildPromise;
        this.setInput(input);
        await this.render();
        return super.show(input);
    }

    private async render() {
        const state = this.input.components.get(PlayerStateComponent);
        const shipData = this.input.components.get(ShipDataComponent);
        const outfits = this.input.components.get(OutfitsStateComponent);
        this.facts.text = shipInfoFacts(
            state, shipData?.name, this.systemName);
        this.outfits.text = shipInfoOutfits(
            outfits, await this.outfitNames(outfits));
        this.summary.text = shipInfoCargo(state);
        this.missions.text = shipInfoMissions(state);
    }

    private async outfitNames(
        outfits: ReadonlyMap<string, unknown> | undefined,
    ): Promise<Map<string, string>> {
        const names = new Map<string, string>();
        if (!outfits) {
            return names;
        }
        await Promise.all([...outfits.keys()].map(async id => {
            try {
                const outfit: OutfitData = await this.gameData.data.Outfit
                    .get(id);
                names.set(id, outfit.name);
            } catch {
                // An outfit from a missing plug-in still deserves a row.
            }
        }));
        return names;
    }
}
