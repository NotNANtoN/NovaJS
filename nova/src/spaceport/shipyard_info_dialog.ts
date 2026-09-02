import { ShipData } from 'novadatainterface/ShipData';
import * as PIXI from 'pixi.js';
import { Observable } from 'rxjs';
import { GameData } from '../client/gamedata/GameData';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import { Button } from './button';
import { Menu } from './menu';
import { FONT } from './outfitter';
import {
    pictDisplayScale,
    shipyardInfoLeftColumn,
    shipyardInfoMiddleColumn,
    shipyardInfoPictId,
    shipyardInfoTitle,
    shipyardInfoWeaponsColumn,
} from './shipyard_info_content';

const BACKGROUND = 'nova:8507';
const DONE_BUTTON = { x: 120, y: 218 };

export class ShipyardInfoDialog extends Menu<ShipData> {
    private readonly title = new PIXI.Text('', {
        fontFamily: 'Geneva', fontSize: 12, fill: 0xffffff, align: 'center',
    });
    private readonly pictContainer = new PIXI.Container();
    private readonly leftSpecs = new PIXI.Text('', FONT.normal);
    private readonly middleSpecs = new PIXI.Text('', FONT.normal);
    private readonly weaponsSpecs = new PIXI.Text('', FONT.normal);

    constructor(
        gameData: GameData,
        controlEvents: Observable<ControlEvent>,
    ) {
        super(gameData, BACKGROUND, controlEvents);
        this.title.anchor.set(0.5, 0);
        this.title.position.set(0, -248);

        this.pictContainer.position.set(0, -75);

        this.leftSpecs.position.set(-280, 95);
        this.middleSpecs.position.set(-90, 95);
        this.weaponsSpecs.position.set(100, 95);

        this.container.addChild(
            this.title,
            this.pictContainer,
            this.leftSpecs,
            this.middleSpecs,
            this.weaponsSpecs,
        );

        const done = new Button(gameData, 'Done', 50, DONE_BUTTON);
        this.addButtons({ done });
        done.click.subscribe(this.done.bind(this));

        this.controls.controls = {
            depart: this.done.bind(this),
            buy: this.done.bind(this),
            properties: this.done.bind(this),
        };
    }

    override async show(ship: ShipData): Promise<ShipData> {
        await this.buildPromise;
        await this.renderShip(ship);
        return super.show(ship);
    }

    private async renderShip(ship: ShipData) {
        this.title.text = shipyardInfoTitle(ship);
        this.leftSpecs.text = shipyardInfoLeftColumn(ship);
        this.middleSpecs.text = shipyardInfoMiddleColumn(ship);
        try {
            this.weaponsSpecs.text = await shipyardInfoWeaponsColumn(
                ship,
                this.gameData.data.Outfit!,
                this.gameData.data.Weapon!,
            );
        } catch (error) {
            console.warn('Failed to load shipyard weapons info', error);
            this.weaponsSpecs.text = 'Standard Weapons\n\nNone';
        }

        this.pictContainer.removeChildren();
        const pictId = shipyardInfoPictId(ship);
        try {
            const sprite = await this.gameData.spriteFromPictAsync(pictId);
            sprite.anchor.set(0.5);
            const scale = pictDisplayScale(sprite.width, sprite.height);
            sprite.scale.set(scale);
            this.pictContainer.addChild(sprite);
        } catch (error) {
            console.warn(`Failed to load shipyard info pict ${pictId}`, error);
            if (ship.pict && ship.pict !== pictId) {
                try {
                    const fallback = await this.gameData.spriteFromPictAsync(ship.pict);
                    fallback.anchor.set(0.5);
                    fallback.scale.set(pictDisplayScale(fallback.width, fallback.height));
                    this.pictContainer.addChild(fallback);
                } catch {
                    // Ignore missing fallback
                }
            }
        }
    }
}
