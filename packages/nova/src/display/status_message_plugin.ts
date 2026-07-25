import { Plugin } from "nova_ecs/plugin";
import { Resource } from "nova_ecs/resource";
import { System } from "nova_ecs/system";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import * as PIXI from "pixi.js";
import { SimulationGameDataResource } from "../nova_plugin/game_data_resource.js";
import { GameDateComponent } from "../nova_plugin/player_state_plugin.js";
import { PlayerShipSelector } from "../nova_plugin/player_ship_plugin.js";
import { SystemIdResource } from "../nova_plugin/system_id_resource.js";
import { jumpArrivalMessage } from "./status_bar_content.js";
import { ResizeEvent, ScreenSize } from "./screen_size_plugin.js";
import { Stage } from "./stage_resource.js";

/**
 * The bottom-left on-screen status line the original game uses for the date on
 * system entry and transient gameplay messages (e.g. "Jumping into the Sanddown
 * system on November 21st, 1177 NC."). Display-only: it reads simulation state
 * (never writes it) and fades a message out after a few seconds.
 */
class StatusLine {
    readonly container = new PIXI.Container();
    private readonly text: PIXI.Text;
    /** Wall-clock time (TimeResource) the current message was set. */
    private shownAt = -Infinity;
    /** How long the message stays fully opaque, then how long it fades. */
    private static readonly HOLD_MS = 8000;
    private static readonly FADE_MS = 4000;
    /** Left/bottom inset from the screen edge, matching the original. */
    private static readonly INSET = 8;

    constructor() {
        this.text = new PIXI.Text("", new PIXI.TextStyle({
            fontFamily: 'Geneva',
            fontSize: 12,
            fill: 0xffffff,
        }));
        this.text.anchor.set(0, 1);
        this.container.addChild(this.text);
        this.container.name = 'StatusLine';
    }

    /** The message currently displayed (empty when none). */
    get message(): string {
        return this.text.text;
    }

    setMessage(message: string, time: number) {
        this.text.text = message;
        this.shownAt = time;
    }

    /** Fades the message: fully shown for HOLD_MS, then linearly over FADE_MS. */
    update(time: number) {
        const age = time - this.shownAt;
        if (age <= StatusLine.HOLD_MS) {
            this.container.alpha = 1;
        } else {
            this.container.alpha = Math.max(0,
                1 - (age - StatusLine.HOLD_MS) / StatusLine.FADE_MS);
        }
    }

    reposition(screenHeight: number) {
        this.container.position.set(StatusLine.INSET,
            screenHeight - StatusLine.INSET);
    }
}

export const StatusLineResource = new Resource<StatusLine>('StatusLine');
/** The scenario's date suffix (e.g. " NC"), fetched once at build. */
const DateSuffixResource = new Resource<{ suffix: string }>('StatusLineDateSuffix');
/** Marks that the arrival message has been shown for this system's world. */
const ArrivalShownResource = new Resource<{ shown: boolean }>('StatusLineArrivalShown');

const StatusLineResize = new System({
    name: 'StatusLineResize',
    events: [ResizeEvent],
    args: [StatusLineResource, ResizeEvent] as const,
    step(statusLine, { y }) {
        statusLine.reposition(y);
    },
});

// Composes the "Jumping into ..." arrival line once per system (the display
// world is rebuilt on each jump), then fades it out. Reads the player's synced
// game date; never mutates the simulation.
const DrawStatusMessage = new System({
    name: 'DrawStatusMessage',
    args: [StatusLineResource, ArrivalShownResource, DateSuffixResource,
        GameDateComponent, TimeResource, SimulationGameDataResource,
        SystemIdResource, PlayerShipSelector] as const,
    step(statusLine, arrivalShown, dateSuffix, date, { time }, gameData,
        systemId) {
        if (!arrivalShown.shown) {
            const systemName = gameData.data.System.getCached(systemId)?.name;
            if (systemName) {
                statusLine.setMessage(
                    jumpArrivalMessage(systemName, date, dateSuffix.suffix),
                    time);
                arrivalShown.shown = true;
            }
        }
        statusLine.update(time);
    },
});

export const StatusMessagePlugin: Plugin = {
    name: 'StatusMessage',
    async build(world) {
        const simulationData = world.resources.get(SimulationGameDataResource);
        if (!simulationData) {
            throw new Error('Expected simulation game data resource to exist');
        }
        const stage = world.resources.get(Stage);
        if (!stage) {
            throw new Error('Expected Stage resource to exist');
        }

        // The scenario's date suffix (" NC" in stock Nova), read once.
        let suffix = '';
        try {
            const ids = await simulationData.ids;
            if (ids.PlayerStart.length > 0) {
                const starts = await Promise.all(ids.PlayerStart.map(
                    id => simulationData.data.PlayerStart.get(id)));
                const start = starts.find(s => s.isDefault) ?? starts[0];
                suffix = start?.dateSuffix ?? '';
            }
        } catch (e) {
            console.warn('Failed to load player start for date suffix:', e);
        }
        world.resources.set(DateSuffixResource, { suffix });
        world.resources.set(ArrivalShownResource, { shown: false });

        const statusLine = new StatusLine();
        const screen = world.resources.get(ScreenSize);
        statusLine.reposition(screen?.y ?? window.innerHeight);
        stage.addChild(statusLine.container);
        world.resources.set(StatusLineResource, statusLine);

        world.addSystem(StatusLineResize);
        world.addSystem(DrawStatusMessage);
    },
    remove(world) {
        world.removeSystem(StatusLineResize);
        world.removeSystem(DrawStatusMessage);
        const stage = world.resources.get(Stage);
        const statusLine = world.resources.get(StatusLineResource);
        if (stage && statusLine) {
            stage.removeChild(statusLine.container);
        }
        world.resources.delete(StatusLineResource);
        world.resources.delete(DateSuffixResource);
        world.resources.delete(ArrivalShownResource);
    },
};
