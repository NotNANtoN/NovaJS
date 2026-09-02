import { ShipData } from 'novadatainterface/ShipData';
import * as PIXI from 'pixi.js';
import { Observable } from 'rxjs';
import { GameData } from '../client/gamedata/GameData';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import { ClassicDialog } from './classic_dialog';
import { FONT } from './outfitter';
import {
    pictDisplayScale,
    shipyardInfoLeftColumn,
    shipyardInfoMiddleColumn,
    shipyardInfoPictId,
    shipyardInfoTitle,
    shipyardInfoWeaponsColumn,
} from './shipyard_info_content';

// Retail PICT 8507 "Ship description + pict"
const BACKGROUND = 'nova:8507';
const DONE_BUTTON = { x: 120, y: 218 };

export class ShipyardInfoDialog extends ClassicDialog<ShipData> {
    constructor(
        gameData: GameData,
        controlEvents: Observable<ControlEvent>,
    ) {
        super(gameData, controlEvents, {
            background: BACKGROUND,
            title: ship => shipyardInfoTitle(ship),
            titlePosition: { x: 0, y: -248 },
            titleStyle: {
                fontFamily: 'Geneva, Chicago, Arial, sans-serif',
                fontSize: 12,
                fontWeight: 'bold',
                fill: 0xffffff,
                align: 'center',
            },
            sections: [
                {
                    type: 'text',
                    id: 'leftSpecs',
                    position: { x: -280, y: 95 },
                    content: ship => shipyardInfoLeftColumn(ship),
                    style: FONT.normal,
                },
                {
                    type: 'text',
                    id: 'middleSpecs',
                    position: { x: -90, y: 95 },
                    content: ship => shipyardInfoMiddleColumn(ship),
                    style: FONT.normal,
                },
                {
                    type: 'custom',
                    id: 'weaponsSpecs',
                    render: async (container, ship, gData) => {
                        let text = 'Standard Weapons\n\nNone';
                        try {
                            text = await shipyardInfoWeaponsColumn(
                                ship,
                                gData.data.Outfit!,
                                gData.data.Weapon!,
                            );
                        } catch (error) {
                            console.warn('Failed to load shipyard weapons info', error);
                        }
                        const label = new PIXI.Text(text, FONT.normal);
                        label.position.set(100, 95);
                        container.addChild(label);
                    },
                },
                {
                    type: 'custom',
                    id: 'shipPict',
                    render: async (container, ship, gData) => {
                        const pictContainer = new PIXI.Container();
                        pictContainer.position.set(0, -75);
                        const pictId = shipyardInfoPictId(ship);
                        try {
                            const sprite = await gData.spriteFromPictAsync(pictId);
                            sprite.anchor.set(0.5);
                            sprite.scale.set(pictDisplayScale(sprite.width, sprite.height));
                            pictContainer.addChild(sprite);
                        } catch (error) {
                            console.warn(`Failed to load shipyard info pict ${pictId}`, error);
                            if (ship.pict && ship.pict !== pictId) {
                                try {
                                    const fallback = await gData.spriteFromPictAsync(ship.pict);
                                    fallback.anchor.set(0.5);
                                    fallback.scale.set(pictDisplayScale(fallback.width, fallback.height));
                                    pictContainer.addChild(fallback);
                                } catch {
                                    // Ignore missing fallback
                                }
                            }
                        }
                        container.addChild(pictContainer);
                    },
                },
            ],
            buttons: [
                {
                    id: 'done',
                    label: 'Done',
                    width: 50,
                    position: DONE_BUTTON,
                    isDefault: true,
                    isCancel: true,
                },
            ],
        });
    }
}
