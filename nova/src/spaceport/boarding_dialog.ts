import { Observable } from 'rxjs';
import { GameData } from '../client/gamedata/GameData';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import { ClassicDialog, CLASSIC_MAC_FONT } from './classic_dialog';

// Retail PICT 8515 "Plunder"
export const PLUNDER_BACKGROUND = 'nova:8515';

export interface BoardingTargetInfo {
    uuid: string;
    shipName: string;
    shipType: string;
    credits: number;
    cargoTons: number;
    crew: number;
    isDerelict?: boolean;
}

export type BoardingAction = 'plunder' | 'capture' | 'leave';

export interface BoardingDialogResult {
    action: BoardingAction;
    targetUuid: string;
}

export class BoardingDialog extends ClassicDialog<BoardingTargetInfo> {
    private selectedAction: BoardingAction = 'leave';

    constructor(
        gameData: GameData,
        controlEvents: Observable<ControlEvent>,
        onAction?: (result: BoardingDialogResult) => void,
    ) {
        super(gameData, controlEvents, {
            background: PLUNDER_BACKGROUND,
            title: info => `Boarding: ${info.shipName || info.shipType}`,
            titlePosition: { x: 0, y: -72 },
            subtitle: info => info.isDerelict ? 'Abandoned Derelict - No Life Signs' : 'Vessel Disabled - Airlock Sealed',
            subtitlePosition: { x: 0, y: -52 },
            sections: [
                {
                    type: 'columns',
                    id: 'specs',
                    position: { x: -140, y: -25 },
                    colWidth: 140,
                    items: [
                        {
                            label: 'Class:',
                            value: info => info.shipType,
                        },
                        {
                            label: 'Hold Cargo:',
                            value: info => `${info.cargoTons} tons`,
                        },
                        {
                            label: 'Credits:',
                            value: info => `${info.credits} cr`,
                        },
                        {
                            label: 'Crew:',
                            value: info => info.isDerelict ? '0 (Uncrewed)' : `${info.crew} defenders`,
                        },
                    ],
                },
            ],
            buttons: [
                {
                    id: 'plunder',
                    label: 'Plunder',
                    width: 70,
                    position: { x: -100, y: 55 },
                    action: async (_dialog, info) => {
                        this.selectedAction = 'plunder';
                        onAction?.({ action: 'plunder', targetUuid: info.uuid });
                    },
                },
                {
                    id: 'capture',
                    label: 'Capture',
                    width: 70,
                    position: { x: 0, y: 55 },
                    action: async (_dialog, info) => {
                        this.selectedAction = 'capture';
                        onAction?.({ action: 'capture', targetUuid: info.uuid });
                    },
                },
                {
                    id: 'leave',
                    label: 'Leave',
                    width: 60,
                    position: { x: 100, y: 55 },
                    isDefault: true,
                    isCancel: true,
                    action: async (_dialog, info) => {
                        this.selectedAction = 'leave';
                        onAction?.({ action: 'leave', targetUuid: info.uuid });
                    },
                },
            ],
        });
    }

    getSelectedAction(): BoardingAction {
        return this.selectedAction;
    }
}
