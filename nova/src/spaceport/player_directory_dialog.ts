import * as PIXI from 'pixi.js';
import { Observable } from 'rxjs';
import { GameData } from '../client/gamedata/GameData';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import { PilotDirectoryEntry } from '../nova_plugin/player_state';
import { ClassicDialog } from './classic_dialog';

const DIRECTORY_TITLE_FONT = {
    fontFamily: 'Geneva, Chicago, Arial, sans-serif',
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
    fontFamily: 'Geneva, Monaco, Arial, sans-serif',
    fontSize: 10,
    fill: 0xe0e0e0,
    align: 'left',
} as const;

export class PlayerDirectoryDialog extends ClassicDialog<string | undefined> {
    private onlineEntriesText = new PIXI.Text({ text: 'Fetching active transponders...', style: ENTRY_FONT });
    private offlineEntriesText = new PIXI.Text({ text: 'Loading pilot registry...', style: ENTRY_FONT });
    private pilots: PilotDirectoryEntry[] = [];
    private selectedSystem?: string;

    constructor(
        gameData: GameData,
        controlEvents: Observable<ControlEvent>,
    ) {
        super(gameData, controlEvents, {
            background: 'nova:8509',
            title: 'GALAXY PILOT DIRECTORY & TRANSPONDERS',
            titlePosition: { x: 0, y: -180 },
            titleStyle: DIRECTORY_TITLE_FONT,
            sections: [
                {
                    type: 'custom',
                    id: 'directoryContent',
                    render: (container) => {
                        const onlineHeader = new PIXI.Text({ text: '● ACTIVE PILOTS ONLINE', style: SECTION_HEADER_FONT });
                        onlineHeader.position.set(-200, -145);
                        this.onlineEntriesText.position.set(-190, -125);

                        const offlineHeader = new PIXI.Text({
                            text: '○ GALAXY REGISTER (LAST KNOWN STATUS)',
                            style: {
                                ...SECTION_HEADER_FONT,
                                fill: 0xaaaaaa,
                            },
                        });
                        offlineHeader.position.set(-200, -20);
                        this.offlineEntriesText.position.set(-190, 0);

                        container.addChild(onlineHeader, this.onlineEntriesText, offlineHeader, this.offlineEntriesText);
                    },
                },
            ],
            buttons: [
                {
                    id: 'plot',
                    label: 'Plot Course',
                    width: 90,
                    position: { x: 40, y: 155 },
                    action: async () => {
                        return this.selectedSystem;
                    },
                },
                {
                    id: 'done',
                    label: 'Done',
                    width: 70,
                    position: { x: 145, y: 155 },
                    isDefault: true,
                    isCancel: true,
                    action: async () => {
                        return undefined;
                    },
                },
            ],
        });
        this.container.name = 'PlayerDirectoryDialog';
    }

    async refresh() {
        try {
            const response = await fetch('/api/galaxy/pilots');
            if (response.ok) {
                this.pilots = await response.json() as PilotDirectoryEntry[];
                this.renderEntries();
            }
        } catch {
            this.onlineEntriesText.text = 'Unable to reach galaxy transponder relay.';
            this.offlineEntriesText.text = 'Offline.';
        }
    }

    private renderEntries() {
        const online = this.pilots.filter(p => p.isOnline);
        const offline = this.pilots.filter(p => !p.isOnline);

        if (online.length === 0) {
            this.onlineEntriesText.text = 'No other pilots detected in this sector.';
        } else {
            this.onlineEntriesText.text = online.map((p, idx) => {
                const sys = p.currentSystem.replace(/^.*:/, '');
                return `${idx + 1}. ${p.pilotName} [${p.shipName}] - In flight in System ${sys} (${p.kills} kills)`;
            }).slice(0, 5).join('\n');
            this.selectedSystem = online[0]?.currentSystem;
        }

        if (offline.length === 0) {
            this.offlineEntriesText.text = 'No registered records found in local database.';
        } else {
            this.offlineEntriesText.text = offline.map(p => {
                const planet = p.lastLandedPlanet ? p.lastLandedPlanet.replace(/^.*:/, '') : 'Deep Space';
                const sys = p.lastLandedSystem ? p.lastLandedSystem.replace(/^.*:/, '') : p.currentSystem.replace(/^.*:/, '');
                return `• ${p.pilotName} [${p.shipName}] - Last docked at ${planet} (${sys})`;
            }).slice(0, 6).join('\n');
            if (!this.selectedSystem && offline[0]?.currentSystem) {
                this.selectedSystem = offline[0].currentSystem;
            }
        }
    }

    override async show(input?: string | undefined): Promise<string | undefined> {
        void this.refresh();
        return super.show(input);
    }
}
