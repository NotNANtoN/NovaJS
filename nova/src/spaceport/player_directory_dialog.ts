import * as PIXI from 'pixi.js';
import { Observable } from 'rxjs';
import { GameData } from '../client/gamedata/GameData';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import { PilotDirectoryEntry } from '../nova_plugin/player_state';
import { Button } from './button';
import { Menu } from './menu';
import { MenuControls } from './menu_controls';

const DIRECTORY_TITLE_FONT = {
    fontFamily: 'Geneva, Arial, sans-serif',
    fontSize: 14,
    fontWeight: 'bold',
    fill: 0xffd588,
    align: 'center',
} as const;

const SECTION_HEADER_FONT = {
    fontFamily: 'Geneva, Arial, sans-serif',
    fontSize: 11,
    fontWeight: 'bold',
    fill: 0x44ddff,
    align: 'left',
} as const;

const ENTRY_FONT = {
    fontFamily: 'Geneva, Arial, sans-serif',
    fontSize: 10,
    fill: 0xe0e0e0,
    align: 'left',
} as const;

export class PlayerDirectoryDialog extends Menu<string | undefined> {
    private readonly titleText: PIXI.Text;
    private readonly onlineHeader: PIXI.Text;
    private readonly onlineEntries: PIXI.Text;
    private readonly offlineHeader: PIXI.Text;
    private readonly offlineEntries: PIXI.Text;
    private readonly plotCourseButton: Button;
    private pilots: PilotDirectoryEntry[] = [];
    private selectedSystem?: string;

    constructor(
        gameData: GameData,
        controlEvents: Observable<ControlEvent>,
    ) {
        // Use standard large modal background
        super(gameData, 'nova:8509', controlEvents);
        this.container.name = 'PlayerDirectoryDialog';

        this.titleText = new PIXI.Text('GALAXY PILOT DIRECTORY & TRANSPONDERS', DIRECTORY_TITLE_FONT);
        this.titleText.anchor.set(0.5, 0);
        this.titleText.position.set(0, -180);
        this.container.addChild(this.titleText);

        this.onlineHeader = new PIXI.Text('● ACTIVE PILOTS ONLINE', SECTION_HEADER_FONT);
        this.onlineHeader.position.set(-200, -145);
        this.container.addChild(this.onlineHeader);

        this.onlineEntries = new PIXI.Text('Fetching active transponders...', ENTRY_FONT);
        this.onlineEntries.position.set(-190, -125);
        this.container.addChild(this.onlineEntries);

        this.offlineHeader = new PIXI.Text('○ GALAXY REGISTER (LAST KNOWN STATUS)', {
            ...SECTION_HEADER_FONT,
            fill: 0xaaaaaa,
        });
        this.offlineHeader.position.set(-200, -20);
        this.container.addChild(this.offlineHeader);

        this.offlineEntries = new PIXI.Text('Loading pilot registry...', ENTRY_FONT);
        this.offlineEntries.position.set(-190, 0);
        this.container.addChild(this.offlineEntries);

        this.plotCourseButton = new Button(gameData, 'Plot Course', 90, { x: 40, y: 155 });
        const doneButton = new Button(gameData, 'Done', 70, { x: 145, y: 155 });
        this.addButtons({ plot: this.plotCourseButton, done: doneButton });

        this.plotCourseButton.click.subscribe(() => {
            this.done(this.selectedSystem);
        });
        doneButton.click.subscribe(() => {
            this.done(undefined);
        });

        this.controls = new MenuControls(controlEvents, {
            depart: () => this.done(undefined),
            properties: () => this.done(undefined),
        });
    }

    async refresh() {
        try {
            const response = await fetch('/api/galaxy/pilots');
            if (response.ok) {
                this.pilots = await response.json() as PilotDirectoryEntry[];
                this.renderEntries();
            }
        } catch {
            this.onlineEntries.text = 'Unable to reach galaxy transponder relay.';
            this.offlineEntries.text = 'Offline.';
        }
    }

    private renderEntries() {
        const online = this.pilots.filter(p => p.isOnline);
        const offline = this.pilots.filter(p => !p.isOnline);

        if (online.length === 0) {
            this.onlineEntries.text = 'No other pilots detected in this sector.';
        } else {
            this.onlineEntries.text = online.map((p, idx) => {
                const sys = p.currentSystem.replace(/^.*:/, '');
                return `${idx + 1}. ${p.pilotName} [${p.shipName}] - In flight in System ${sys} (${p.kills} kills)`;
            }).slice(0, 5).join('\n');
            this.selectedSystem = online[0]?.currentSystem;
        }

        if (offline.length === 0) {
            this.offlineEntries.text = 'No registered records found in local database.';
        } else {
            this.offlineEntries.text = offline.map(p => {
                const planet = p.lastLandedPlanet ? p.lastLandedPlanet.replace(/^.*:/, '') : 'Deep Space';
                const sys = p.lastLandedSystem ? p.lastLandedSystem.replace(/^.*:/, '') : p.currentSystem.replace(/^.*:/, '');
                return `• ${p.pilotName} [${p.shipName}] - Last docked at ${planet} (${sys})`;
            }).slice(0, 6).join('\n');
            if (!this.selectedSystem && offline[0]?.currentSystem) {
                this.selectedSystem = offline[0].currentSystem;
            }
        }
    }

    override async show(): Promise<string | undefined> {
        void this.refresh();
        return super.show();
    }
}
