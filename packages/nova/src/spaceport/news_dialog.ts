import { CronData } from 'novadatainterface/cron_data';
import { Entity } from 'nova_ecs/entity';
import * as PIXI from 'pixi.js';
import { firstValueFrom, Observable, Subject } from 'rxjs';
import { DisplayAssetDataInterface } from '../client/gamedata/display_asset_data.js';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { ControlEvent } from '../nova_plugin/controls_plugin.js';
import { CronStatesComponent } from '../nova_plugin/player_state_plugin.js';
import { MenuControls } from './menu_controls.js';
import { MissionUniverse } from './mission_universe.js';

// The 300x230 news dialog PICTs (9000 generic, 9001+ per-govt
// NewsPic): header art on top, text pane at x 5..295, y 132..226.
const TEXT_X = -140;
const TEXT_Y = 22;
const TEXT_WIDTH = 280;

const NEWS_FONT: Partial<PIXI.ITextStyle> = {
    fontFamily: 'Geneva', fontSize: 10, fill: 0xffffff,
    align: 'left', wordWrap: true, wordWrapWidth: TEXT_WIDTH,
};

/** Shown when no crön has news for this stellar (cf. STR# 8101). */
const GENERIC_NEWS = [
    'Local News: A recent spate of thefts around the spaceport '
    + 'have local traders up in arms.',
    'Financial News: Stock prices fall again. Gli-Tech shares have '
    + 'reached a 750 year low of 1823 credits per share.',
    'Top News: Pirate raids on the increase Federation-wide. '
    + 'Information leading to the discovery of their home-base is '
    + 'now worth 1 billion credits.',
];

/**
 * The bar news window, shown when the player enters the bar (as in
 * the original). The background is the stellar's government NewsPic
 * (e.g. the Hyper News Network for the Federation) or the generic
 * independent frame; dismissed with a click or the depart key.
 *
 * Content comes from the crön machinery: crons whose per-player state
 * is currently active contribute their news — GovtNews strings when
 * the stellar's govt matches, otherwise IndNewsStr strings. Local
 * news beats independent news, per the Bible. Simplifications
 * (documented gaps): allied governments do not share local news (only
 * an exact govt match), and the generic no-news flavor is a hardcoded
 * sample of STR# 8101 rather than the parsed resource.
 *
 * Which string of a list shows is plain Math.random: player-local UI,
 * like mission offer rolls — nothing here reaches the simulation.
 */
export class NewsDialog {
    container = new PIXI.Container();
    private controls: MenuControls;
    private closed = new Subject<void>();
    private background?: PIXI.Sprite;
    private text = new PIXI.Text('', NEWS_FONT);

    constructor(private displayAssets: DisplayAssetDataInterface,
        private simulationData: SimulationGameDataInterface,
        controlEvents: Observable<ControlEvent>,
        private universe: MissionUniverse,
        private planetId: string) {
        this.container.name = 'NewsDialog';
        this.container.visible = false;
        this.controls = new MenuControls(controlEvents, {
            depart: () => this.closed.next(),
        });
        this.text.position.set(TEXT_X, TEXT_Y);
    }

    /** Picks the news for the player's active crons at this stellar. */
    private pickNews(entity: Entity, govtId: string | null): string {
        const cronStates = entity.components.get(CronStatesComponent);
        const active: CronData[] = this.universe.crons.filter(
            cron => cronStates?.get(cron.id)?.phase === 'active');

        const local: string[] = [];
        const independent: string[] = [];
        for (const cron of active) {
            const matching = govtId ? cron.govtNews.find(
                news => news.govt === govtId) : undefined;
            if (matching) {
                local.push(pick(matching.strings));
            } else if (cron.indNews.length > 0) {
                independent.push(pick(cron.indNews));
            }
        }
        // Local news takes precedence over independent (Bible p. 21);
        // show a couple of items like the original's news feed.
        const items = (local.length > 0 ? local : independent).slice(0, 3);
        if (items.length === 0) {
            items.push(pick(GENERIC_NEWS));
        }
        return items.join('\n\n');
    }

    /** Shows the dialog and resolves when the player dismisses it. */
    async show(entity: Entity): Promise<void> {
        let govtId: string | null = null;
        let backgroundPict = 'nova:9000';
        try {
            const planet = await this.simulationData.data.Planet
                .get(this.planetId);
            govtId = planet.govt;
            if (govtId) {
                const govt = await this.simulationData.data.Govt.get(govtId);
                if (govt.newsPic) {
                    backgroundPict = govt.newsPic;
                }
            }
        } catch (e) {
            console.warn('News dialog failed to load planet/govt:', e);
        }

        this.background?.destroy();
        this.background = this.displayAssets.spriteFromPict(backgroundPict);
        this.background.anchor.set(0.5);
        this.background.interactive = true;
        this.background.cursor = 'pointer';
        // Any click on the news window dismisses it.
        this.background.on('pointerdown', () => this.closed.next());
        this.container.addChildAt(this.background, 0);
        this.container.addChild(this.text);

        try {
            await this.universe.load();
            this.text.text = this.pickNews(entity, govtId);
        } catch (e) {
            console.warn('News dialog failed to load crons:', e);
            this.text.text = GENERIC_NEWS[0];
        }

        this.container.visible = true;
        this.controls.bind();
        await firstValueFrom(this.closed);
        this.controls.unbind();
        this.container.visible = false;
    }
}

function pick<T>(items: T[]): T {
    return items[Math.floor(Math.random() * items.length)];
}
