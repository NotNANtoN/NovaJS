import 'jasmine';
import * as PIXI from 'pixi.js';
import { Subject } from 'rxjs';
import { MockGameData } from 'novadatainterface/MockGameData';
import { getDefaultOutfitData, OutfitData } from 'novadatainterface/OutfitData';
import { getDefaultPlanetData } from 'novadatainterface/PlanetData';
import { getDefaultShipData, ShipData } from 'novadatainterface/ShipData';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import { createInitialPlayerState, PlayerState } from '../nova_plugin/player_state';
import { OutfitsState } from '../nova_plugin/outfit_plugin';
import { Outfitter } from './outfitter';

describe('Outfitter Conquest buy/sell workflow', () => {
    let gameData: MockGameData;
    let controlEvents: Subject<ControlEvent>;
    let lightning: ShipData;
    let lightCannon: OutfitData;
    let irLauncher: OutfitData;
    let irMissile: OutfitData;
    let mediumBlaster: OutfitData;

    beforeEach(() => {
        gameData = new MockGameData();
        controlEvents = new Subject<ControlEvent>();

        (gameData as any).spriteFromPict = () => new PIXI.Sprite(PIXI.Texture.EMPTY);
        (gameData as any).spriteFromPictAsync = async () => new PIXI.Sprite(PIXI.Texture.EMPTY);
        (gameData as any).textureFromPict = () => PIXI.Texture.EMPTY;
        (gameData as any).textureFromPictAsync = async () => PIXI.Texture.EMPTY;

        spyOn(PIXI.CanvasTextMetrics, 'measureText').and.returnValue({
            width: 50,
            height: 12,
            lines: ['test'],
            lineHeight: 12,
            maxLineWidth: 50,
            fontProperties: { ascent: 10, descent: 2, fontSize: 12 },
        } as any);

        lightning = {
            ...getDefaultShipData(),
            id: 'nova:135',
            name: 'Lightning',
            freeSpace: 20,
            maxGuns: 6,
            maxTurrets: 0,
            physics: { ...getDefaultShipData().physics, freeMass: 31 },
            outfits: { 'nova:438': 3, 'nova:134': 1, 'nova:135': 5 },
        };
        lightCannon = {
            ...getDefaultOutfitData(),
            id: 'nova:438',
            name: 'Light Cannon',
            price: 10000,
            max: 6,
            flags: 1,
            displayWeight: 10,
            physics: { freeMass: 2 },
        };
        irLauncher = {
            ...getDefaultOutfitData(),
            id: 'nova:134',
            name: 'IR Missile Launcher',
            price: 20000,
            max: 4,
            flags: 0,
            displayWeight: 20,
            physics: { freeMass: 5 },
        };
        irMissile = {
            ...getDefaultOutfitData(),
            id: 'nova:135',
            name: 'IR Missile',
            price: 750,
            max: 200,
            flags: 0,
            displayWeight: 19,
            physics: { freeMass: 0 },
        };
        mediumBlaster = {
            ...getDefaultOutfitData(),
            id: 'nova:129',
            name: 'Medium Blaster',
            price: 20000,
            max: 6,
            flags: 1,
            displayWeight: 30,
            physics: { freeMass: 8 },
        };

        gameData.data.Ship.map.set(lightning.id, lightning);
        // Deliberately keep nova:438 out of ids.Outfit or only installed on the ship
        // to verify installed stock outfits are still loaded and sellable.
        gameData.data.Outfit.map.set(lightCannon.id, lightCannon);
        gameData.data.Outfit.map.set(irLauncher.id, irLauncher);
        gameData.data.Outfit.map.set(irMissile.id, irMissile);
        gameData.data.Outfit.map.set(mediumBlaster.id, mediumBlaster);
        const baseIds = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(gameData), 'ids')!.get!;
        Object.defineProperty(gameData, 'ids', {
            get: async () => ({
                ...await baseIds.call(gameData),
                Ship: [lightning.id],
                Outfit: [mediumBlaster.id, irLauncher.id, irMissile.id],
            }),
        });
    });

    it('sells stock outfits, updates credits/space, buys Medium Blaster, and returns clean OutfitsState without zero entries', async () => {
        const planet = {
            ...getDefaultPlanetData(),
            id: 'nova:128',
            name: 'Earth',
            hasOutfitter: true,
        };
        const playerState: PlayerState = {
            ...createInitialPlayerState(),
            gameMode: 'conquest',
            shipId: lightning.id,
            credits: 15000,
        };

        const outfitter = new Outfitter(gameData as any, controlEvents);
        outfitter.setPlanetData(planet);
        outfitter.setPlayerState(playerState);
        outfitter.setShipData(lightning);

        const initialOutfits: OutfitsState = new Map([
            ['nova:438', { count: 3 }],
            ['nova:134', { count: 1 }],
            ['nova:135', { count: 5 }],
        ]);
        const resultPromise = outfitter.show(initialOutfits);
        // Wait for show() -> refreshGrid() to settle
        await new Promise(resolve => setTimeout(resolve, 20));

        const grid = (outfitter as any).itemGrid;
        expect(grid).toBeDefined();

        // Trying to buy Medium Blaster with 15,000 cr should fail with feedback
        expect(grid.selectId('nova:129')).toBe(true);
        await (outfitter as any).buyOutfit(1);
        expect((outfitter as any).text.feedback.text).toContain('Not enough credits');

        // Sell IR Missile Launcher (+5,000 cr -> 20,000 cr, +5t -> 25t free)
        expect(grid.selectId('nova:134')).toBe(true);
        await (outfitter as any).sellOutfit(1);
        expect(playerState.credits).toBe(20000);
        expect((outfitter as any).getAvailableMass()).toBe(25);

        // Sell all 3 Light Cannons (+7,500 cr -> 27,500 cr, +6t -> 31t free)
        expect(grid.selectId('nova:438')).toBe(true);
        await (outfitter as any).sellOutfit(3);
        expect(playerState.credits).toBe(27500);
        expect((outfitter as any).getAvailableMass()).toBe(31);

        // Buy Medium Blaster (-20,000 cr -> 7,500 cr, -8t -> 23t free)
        expect(grid.selectId('nova:129')).toBe(true);
        await (outfitter as any).buyOutfit(1);
        expect(playerState.credits).toBe(7500);
        expect((outfitter as any).getAvailableMass()).toBe(23);
        expect((outfitter as any).text.feedback.text).toBe('');

        // Close outfitter and inspect returned OutfitsState
        (outfitter as any).done();
        const finalOutfits = await resultPromise;
        expect(finalOutfits.get('nova:129')).toEqual({ count: 1 });
        expect(finalOutfits.get('nova:135')).toEqual({ count: 5 });
        expect(finalOutfits.has('nova:134')).toBe(false);
        expect(finalOutfits.has('nova:438')).toBe(false);
        // Ensure no zero-count pollution
        for (const [, val] of finalOutfits) {
            expect(val.count).toBeGreaterThan(0);
        }
    });

    it('reports space and gun-mount limits in feedback when blocked', async () => {
        const planet = {
            ...getDefaultPlanetData(),
            id: 'nova:128',
            name: 'Earth',
            hasOutfitter: true,
        };
        const tightShip: ShipData = {
            ...lightning,
            maxGuns: 1,
            physics: { ...lightning.physics, freeMass: 10 },
        };
        const playerState: PlayerState = {
            ...createInitialPlayerState(),
            gameMode: 'conquest',
            shipId: tightShip.id,
            credits: 100000,
        };

        const outfitter = new Outfitter(gameData as any, controlEvents);
        outfitter.setPlanetData(planet);
        outfitter.setPlayerState(playerState);
        outfitter.setShipData(tightShip);

        const resultPromise = outfitter.show(new Map([['nova:438', { count: 1 }]]));
        await new Promise(resolve => setTimeout(resolve, 20));

        const grid = (outfitter as any).itemGrid;
        expect(grid.selectId('nova:129')).toBe(true);
        await (outfitter as any).buyOutfit(1);
        expect((outfitter as any).text.feedback.text).toContain('No fixed gun mounts available');

        // Raise maxGuns to 6, keep tight mass (10 - 2 = 8, buy 1 -> 0 left, 2nd should fail on space)
        tightShip.maxGuns = 6;
        await (outfitter as any).buyOutfit(1);
        expect((outfitter as any).getAvailableMass()).toBe(0);
        await (outfitter as any).buyOutfit(1);
        expect((outfitter as any).text.feedback.text).toContain('Not enough space');

        (outfitter as any).done();
        await resultPromise;
    });
});
