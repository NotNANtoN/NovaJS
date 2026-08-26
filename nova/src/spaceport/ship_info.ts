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
    shipInfoStanding,
    StatusLadders,
} from './ship_info_content';
import { GovtData } from 'novadatainterface/GovtData';
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
 * flight and while landed. Ranks are still absent because the ränk resources
 * are not parsed, so there is no way to name one.
 */
export class ShipInfo extends Menu<Entity> {
    private readonly facts: PIXI.Text;
    private readonly outfits: PIXI.Text;
    private readonly summary: PIXI.Text;
    private readonly missions: PIXI.Text;
    private readonly standing: PIXI.Text;
    private systemName?: string;
    private governments = new Map<string, GovtData>();
    private ladders: StatusLadders = {};
    /** STR# 4000 'All Cargo', which names each mission CargoType. */
    private cargoNames: readonly string[] = [];
    private referenceData?: Promise<void>;

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
        this.standing = addPane(
            this.container, SHIP_INFO_LAYOUT.standing, SHIP_INFO_FONT.body);

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
        await this.loadReferenceData(state?.legalRecords);
        this.facts.text = shipInfoFacts(
            state, shipData?.name, this.systemName, this.ladders);
        this.outfits.text = shipInfoOutfits(
            outfits, await this.outfitNames(outfits));
        this.summary.text = shipInfoCargo(state, this.cargoNames);
        this.missions.text = shipInfoMissions(state);
        this.standing.text = shipInfoStanding(
            state, this.governments, this.ladders);
    }

    /**
     * Pull the retail word ladders once, then the governments the pilot has a
     * record with. Missing resources leave the compiled-in ladders in place.
     */
    private async loadReferenceData(
        records: Record<string, number> | undefined,
    ): Promise<void> {
        this.referenceData ??= this.loadLadders();
        await this.referenceData;
        await Promise.all(Object.keys(records ?? {})
            .filter(id => !this.governments.has(id))
            .map(async id => {
                try {
                    const govt = await this.gameData.data.Govt?.get(id);
                    if (govt) {
                        this.governments.set(id, govt);
                    }
                } catch {
                    // Fall back to showing the raw government id.
                }
            }));
    }

    private async loadLadders(): Promise<void> {
        const lists = this.gameData.data.StringList;
        if (!lists) {
            return;
        }
        const read = async (id: string) => {
            try {
                const list = await lists.get(id);
                return list.strings.length > 0 ? list.strings : undefined;
            } catch {
                return undefined;
            }
        };
        // STR# 134 is the legal-record ladder and 138 the combat ratings.
        this.ladders = {
            legal: await read('nova:134'),
            combat: await read('nova:138'),
        };
        this.cargoNames = await read('nova:4000') ?? [];
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
