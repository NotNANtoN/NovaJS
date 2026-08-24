import { MissionOfferLocation } from 'novadatainterface/MissionData';
import { Observable } from 'rxjs';
import { GameData } from '../client/gamedata/GameData';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import { MissionBoard } from './mission_bbs';

export class Bar extends MissionBoard {
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
            'A handful of travelers and locals trade rumors over the station noise.',
            onInfo,
        );
    }
}
