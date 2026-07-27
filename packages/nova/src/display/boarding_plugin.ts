import { Entity } from 'nova_ecs/entity';
import { Plugin } from 'nova_ecs/plugin';
import { Query } from 'nova_ecs/query';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { EcsEvent } from 'nova_ecs/events';
import { Entities } from 'nova_ecs/arg_types';
import { Optional } from 'nova_ecs/optional';
import * as PIXI from 'pixi.js';
import { Observable } from 'rxjs';
import { DisplayAssetDataInterface } from '../client/gamedata/display_asset_data.js';
import { ControlAction } from '../nova_plugin/controls.js';
import { ControlEvent, ControlsSubject } from '../nova_plugin/controls_plugin.js';
import {
    BoardingComponent, BoardingState,
} from '../nova_plugin/boarding_component.js';
import { CargoComponent } from '../nova_plugin/cargo_plugin.js';
import { FuelComponent } from '../nova_plugin/health_plugin.js';
import { PlayerShipSelector } from '../nova_plugin/player_ship_plugin.js';
import { DisplayAssetDataResource } from '../nova_plugin/game_data_resource.js';
import { formatCredits } from './status_bar_content.js';
import { Button } from '../spaceport/button.js';
import { MenuControls } from '../spaceport/menu_controls.js';
import { ScreenSize } from './screen_size_plugin.js';
import { Stage } from './stage_resource.js';

/**
 * The plunder (PICT 8515) and capture-assignment (PICT 8516) dialogs.
 *
 * These are modal overlays that OPEN AND CLOSE by watching the synced
 * BoardingComponent on the local player's ship (BoardingUiSystem): the
 * simulation is the source of truth for whether a boarding is in
 * progress and what has already been taken, so the display can't own
 * that lifecycle with a promise the way the spaceport does. Every button
 * emits a PlunderActionEvent, which browser.ts forwards to the sim as a
 * control-event input (see the module docs in boarding_component.ts and
 * boarding_plugin.ts) — so the take/capture is replayed identically on
 * every peer, not applied locally.
 *
 * Layout is eyeballed against PICT 8515/8516 (capture_assignment.png);
 * pixel fidelity comes in the dedicated visual pass. Containers and
 * buttons are named for headless driving ('PlunderDialog',
 * 'CaptureAssignment', 'Button:Take Cargo', ...).
 */

/**
 * A plunder-dialog button press, forwarded by browser.ts to the sim as
 * a control-event input on the boarding ship.
 */
export const PlunderActionEvent =
    new EcsEvent<{ action: ControlAction }>('PlunderActionEvent');

const WIDTH = 320;
const HEIGHT = 200;
const ORIGIN_X = -WIDTH / 2;
const ORIGIN_Y = -HEIGHT / 2;
const TITLE_FONT: Partial<PIXI.ITextStyle> = {
    fontFamily: 'Geneva', fontSize: 12, fill: 0xffffff, align: 'left',
};
const BODY_FONT: Partial<PIXI.ITextStyle> = {
    fontFamily: 'Geneva', fontSize: 10, fill: 0xffffff, align: 'left',
    wordWrap: true, wordWrapWidth: WIDTH - 24,
};

/** One selectable action row. */
interface Row {
    action: ControlAction;
    button: Button;
    /** Whether the row is currently actionable (else greyed/skipped). */
    enabled: boolean;
}

class PlunderDialog {
    readonly container = new PIXI.Container();
    private controls: MenuControls;
    private title = new PIXI.Text('', TITLE_FONT);
    private body = new PIXI.Text('', BODY_FONT);
    private rows: Row[] = [];
    private selected = 0;
    private highlight = new PIXI.Graphics();

    constructor(private displayAssets: DisplayAssetDataInterface,
        controlEvents: Observable<ControlEvent>,
        private send: (action: ControlAction) => void) {
        this.container.name = 'PlunderDialog';
        this.container.visible = false;

        const shield = new PIXI.Graphics()
            .beginFill(0x000000, 0.001).drawRect(-4000, -4000, 8000, 8000)
            .endFill();
        shield.interactive = true;
        this.container.addChild(shield);

        // PICT 8515 is the plunder frame in stock Nova.
        const background = this.safeSprite('nova:8515');
        background.anchor.set(0.5);
        background.interactive = true;
        this.container.addChild(background);

        this.title.text = 'Boarding disabled ship';
        this.title.position.set(ORIGIN_X + 12, ORIGIN_Y + 10);
        this.body.position.set(ORIGIN_X + 12, ORIGIN_Y + 30);
        this.container.addChild(this.highlight, this.title, this.body);

        // Action rows: take cargo, credits, fuel, attempt capture, done.
        const specs: [ControlAction, string][] = [
            ['plunderCargo', 'Take Cargo'],
            ['plunderCredits', 'Take Credits'],
            ['plunderFuel', 'Take Fuel'],
            ['plunderCapture', 'Attempt Capture'],
            ['plunderDone', 'Done'],
        ];
        specs.forEach(([action, label], i) => {
            const button = new Button(this.displayAssets, label, 140,
                { x: ORIGIN_X + 90, y: ORIGIN_Y + 84 + i * 22 });
            button.click.subscribe(() => this.activate(action));
            this.container.addChild(button.container);
            this.rows.push({ action, button, enabled: true });
        });

        this.controls = new MenuControls(controlEvents, {
            up: () => this.move(-1),
            down: () => this.move(1),
            accept: () => this.activate(this.rows[this.selected]?.action),
            // 'b' / Escape close the session (same as Done).
            board: () => this.activate('plunderDone'),
            depart: () => this.activate('plunderDone'),
        });
    }

    private safeSprite(id: string): PIXI.Sprite {
        try {
            return this.displayAssets.spriteFromPict(id);
        } catch {
            // Missing PICT: a plain dark panel keeps the flow driveable.
            const g = new PIXI.Graphics().beginFill(0x101820, 0.95)
                .lineStyle(1, 0x88aacc)
                .drawRect(ORIGIN_X, ORIGIN_Y, WIDTH, HEIGHT).endFill();
            const tex = new PIXI.Sprite();
            tex.addChild(g);
            return tex as unknown as PIXI.Sprite;
        }
    }

    private activate(action: ControlAction | undefined) {
        if (!action) {
            return;
        }
        const row = this.rows.find(r => r.action === action);
        if (row && !row.enabled) {
            return;
        }
        this.send(action);
    }

    private move(delta: number) {
        const enabledIndices = this.rows
            .map((r, i) => (r.enabled ? i : -1)).filter(i => i >= 0);
        if (enabledIndices.length === 0) {
            return;
        }
        const pos = enabledIndices.indexOf(this.selected);
        const next = pos < 0
            ? enabledIndices[0]
            : enabledIndices[(pos + delta + enabledIndices.length)
                % enabledIndices.length];
        this.selected = next;
        this.refreshHighlight();
    }

    open() {
        if (this.container.visible) {
            return;
        }
        this.container.visible = true;
        this.controls.bind();
    }

    close() {
        if (!this.container.visible) {
            return;
        }
        this.container.visible = false;
        this.controls.unbind();
    }

    /** Refreshes button enable/label state and the booty summary from
     * the synced boarding + victim state. */
    refresh(boarding: BoardingState, target: Entity | undefined) {
        const cargo = target?.components.get(CargoComponent);
        const cargoTons = cargo
            ? [...cargo.values()].reduce((a, b) => a + b, 0) : 0;
        const fuel = target?.components.get(FuelComponent);

        const lines: string[] = [];
        if (cargoTons > 0 && cargo) {
            lines.push('Cargo aboard:');
            for (const key of [...cargo.keys()].sort()) {
                lines.push(`  ${key}: ${cargo.get(key)} tons`);
            }
        } else {
            lines.push('No cargo aboard.');
        }
        lines.push(`Money: ${formatCredits(boarding.creditsAvailable)}`);
        if (fuel) {
            lines.push(`Fuel aboard: ${Math.floor(fuel.current)}`);
        }
        if (boarding.capture === 'failed') {
            lines.push('You were repelled while attempting to capture!');
        }
        this.body.text = lines.join('\n');

        const enabledByAction: Record<string, boolean> = {
            plunderCargo: !boarding.cargoTaken && cargoTons > 0,
            plunderCredits: !boarding.creditsTaken
                && boarding.creditsAvailable > 0,
            plunderFuel: !boarding.fuelTaken && !!fuel && fuel.current > 0,
            plunderCapture: boarding.capture !== 'succeeded',
            plunderDone: true,
        };
        for (const row of this.rows) {
            row.enabled = enabledByAction[row.action] ?? true;
            if (row.button.state !== 'clicked') {
                row.button.state = row.enabled ? 'normal' : 'grey';
            }
        }
        if (!this.rows[this.selected]?.enabled) {
            this.move(1);
        }
        this.refreshHighlight();
    }

    private refreshHighlight() {
        this.highlight.clear();
        const row = this.rows[this.selected];
        if (!row || !row.enabled) {
            return;
        }
        this.highlight.beginFill(0x8b0000, 0.4)
            .drawRect(ORIGIN_X + 88, row.button.container.position.y - 1,
                144, 22).endFill();
    }
}

/** The capture-assignment dialog (PICT 8516): keep the captured ship as
 * an escort, or release it (Done). Bible alternatives (swap to it, sell
 * it) are seams that need the ship-swap / dock-sell paths. */
class CaptureAssignmentDialog {
    readonly container = new PIXI.Container();
    private controls: MenuControls;

    constructor(displayAssets: DisplayAssetDataInterface,
        controlEvents: Observable<ControlEvent>,
        send: (action: ControlAction) => void) {
        this.container.name = 'CaptureAssignment';
        this.container.visible = false;

        const shield = new PIXI.Graphics()
            .beginFill(0x000000, 0.001).drawRect(-4000, -4000, 8000, 8000)
            .endFill();
        shield.interactive = true;
        this.container.addChild(shield);

        let background: PIXI.Sprite;
        try {
            background = displayAssets.spriteFromPict('nova:8516');
        } catch {
            const g = new PIXI.Graphics().beginFill(0x101820, 0.95)
                .lineStyle(1, 0x88aacc)
                .drawRect(ORIGIN_X, ORIGIN_Y, WIDTH, HEIGHT).endFill();
            background = new PIXI.Sprite();
            background.addChild(g);
        }
        background.anchor?.set(0.5);
        background.interactive = true;
        this.container.addChild(background);

        const title = new PIXI.Text('You have captured the ship!', TITLE_FONT);
        title.position.set(ORIGIN_X + 12, ORIGIN_Y + 12);
        this.container.addChild(title);

        const escort = new Button(displayAssets, 'Keep as Escort', 160,
            { x: ORIGIN_X + 80, y: ORIGIN_Y + 90 });
        escort.click.subscribe(() => send('plunderCaptureEscort'));
        const release = new Button(displayAssets, 'Release', 160,
            { x: ORIGIN_X + 80, y: ORIGIN_Y + 120 });
        release.click.subscribe(() => send('plunderDone'));
        this.container.addChild(escort.container, release.container);

        this.controls = new MenuControls(controlEvents, {
            accept: () => send('plunderCaptureEscort'),
            depart: () => send('plunderDone'),
        });
    }

    open() {
        if (this.container.visible) {
            return;
        }
        this.container.visible = true;
        this.controls.bind();
    }

    close() {
        if (!this.container.visible) {
            return;
        }
        this.container.visible = false;
        this.controls.unbind();
    }
}

/** Owns both dialogs and switches between them from the synced state. */
class BoardingUi {
    readonly plunder: PlunderDialog;
    readonly assignment: CaptureAssignmentDialog;

    constructor(displayAssets: DisplayAssetDataInterface,
        controlEvents: Observable<ControlEvent>,
        send: (action: ControlAction) => void,
        private screen: { x: number, y: number }) {
        this.plunder = new PlunderDialog(displayAssets, controlEvents, send);
        this.assignment =
            new CaptureAssignmentDialog(displayAssets, controlEvents, send);
    }

    reposition() {
        const x = this.screen.x / 2;
        const y = this.screen.y / 2;
        this.plunder.container.position.set(x, y);
        this.assignment.container.position.set(x, y);
    }

    update(boarding: BoardingState | undefined, target: Entity | undefined) {
        this.reposition();
        if (!boarding) {
            this.plunder.close();
            this.assignment.close();
            return;
        }
        if (boarding.capture === 'succeeded') {
            this.plunder.close();
            this.assignment.open();
        } else {
            this.assignment.close();
            this.plunder.open();
            this.plunder.refresh(boarding, target);
        }
    }
}

const BoardingUiResource = new Resource<BoardingUi>('BoardingUi');

// Runs each frame for the local player's ship (PlayerShipSelector),
// opening/closing/refreshing the dialogs from its synced
// BoardingComponent. Optional so it still runs (to close the dialogs)
// when no boarding is in progress.
const PlayerBoardingQuery = new Query(
    [PlayerShipSelector, Optional(BoardingComponent)] as const);
const BoardingUiSystem = new System({
    name: 'BoardingUiSystem',
    args: [BoardingUiResource, PlayerBoardingQuery, Entities] as const,
    step(ui, players, entities) {
        const boarding = players[0]?.[1] ?? undefined;
        const target = boarding
            ? entities.get(boarding.target) : undefined;
        ui.update(boarding ?? undefined, target);
    },
});

export const BoardingDisplayPlugin: Plugin = {
    name: 'BoardingDisplayPlugin',
    build(world) {
        const displayAssets = world.resources.get(DisplayAssetDataResource);
        const controls = world.resources.get(ControlsSubject);
        const stage = world.resources.get(Stage);
        const screen = world.resources.get(ScreenSize);
        if (!displayAssets || !controls || !stage || !screen) {
            throw new Error('BoardingDisplayPlugin missing display resources');
        }
        const send = (action: ControlAction) =>
            world.emit(PlunderActionEvent, { action });
        const ui = new BoardingUi(displayAssets, controls, send, screen);
        stage.addChild(ui.plunder.container);
        stage.addChild(ui.assignment.container);
        world.resources.set(BoardingUiResource, ui);
        world.addSystem(BoardingUiSystem);
    },
    remove(world) {
        world.removeSystem(BoardingUiSystem);
        const stage = world.resources.get(Stage);
        const ui = world.resources.get(BoardingUiResource);
        if (stage && ui) {
            stage.removeChild(ui.plunder.container);
            stage.removeChild(ui.assignment.container);
        }
        world.resources.delete(BoardingUiResource);
    },
};
