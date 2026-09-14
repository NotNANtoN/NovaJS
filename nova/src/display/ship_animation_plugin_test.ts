import 'jasmine';
import { ShipAnimationSystem } from './ship_animation_plugin';

describe('ShipAnimationSystem', () => {
    function makeMockSprite() {
        return {
            pixiSprite: {
                visible: false,
                alpha: 1,
                blendMode: 'normal',
                tint: 0xffffff,
            },
        };
    }

    function makeMockAnimation() {
        const sprites = new Map<string, any>([
            ['baseImage', makeMockSprite()],
            ['glowImage', makeMockSprite()],
            ['shieldImage', makeMockSprite()],
            ['lightImage', makeMockSprite()],
            ['weapImage', makeMockSprite()],
        ]);
        return { sprites } as any;
    }

    const ship = { id: 'test_ship' } as any;
    const weaponsState = new Map<string, any>();
    const gameData = {
        data: {
            Weapon: {
                getCached: () => undefined,
            },
        },
    } as any;
    const time = { time: 1000, delta_ms: 16, delta_s: 0.016, frame: 60 };
    const ionized = false;
    const ionizationColor = { color: 0x888888 } as any;

    it('illuminates glowImage with additive blend when accelerating', () => {
        const animation = makeMockAnimation();
        const glowSprite = animation.sprites.get('glowImage')!.pixiSprite;

        // Not accelerating -> hidden
        ShipAnimationSystem.step(
            ship, weaponsState, gameData, animation, time, ionized, ionizationColor,
            { accelerating: 0 } as any, undefined,
        );
        expect(glowSprite.visible).toBe(false);

        // Accelerating -> visible, blendMode 'add', alpha > 0
        ShipAnimationSystem.step(
            ship, weaponsState, gameData, animation, time, ionized, ionizationColor,
            { accelerating: 1 } as any, undefined,
        );
        expect(glowSprite.visible).toBe(true);
        expect(glowSprite.blendMode).toBe('add');
        expect(glowSprite.alpha).toBeGreaterThan(0.5);
    });

    it('flashes shieldImage with additive blend when taking shield damage and fades over time', () => {
        const animation = makeMockAnimation();
        const shieldSprite = animation.sprites.get('shieldImage')!.pixiSprite;
        const shieldStat = { current: 100, max: 100 };

        // Initial state at full shields -> hidden
        ShipAnimationSystem.step(
            ship, weaponsState, gameData, animation, { ...time, time: 1000 }, ionized, ionizationColor,
            undefined, shieldStat as any,
        );
        expect(shieldSprite.visible).toBe(false);

        // Takes damage (100 -> 80) -> shield flash triggers
        shieldStat.current = 80;
        ShipAnimationSystem.step(
            ship, weaponsState, gameData, animation, { ...time, time: 1050 }, ionized, ionizationColor,
            undefined, shieldStat as any,
        );
        expect(shieldSprite.visible).toBe(true);
        expect(shieldSprite.blendMode).toBe('add');
        expect(shieldSprite.alpha).toBeGreaterThan(0);

        // After flash duration (160ms after 1050ms = 1210ms) -> hidden again
        ShipAnimationSystem.step(
            ship, weaponsState, gameData, animation, { ...time, time: 1250 }, ionized, ionizationColor,
            undefined, shieldStat as any,
        );
        expect(shieldSprite.visible).toBe(false);
    });

    it('blinks running lights periodically', () => {
        const animation = makeMockAnimation();
        const lightSprite = animation.sprites.get('lightImage')!.pixiSprite;

        // At time = 500 (500 % 2000 < 1000) -> on
        ShipAnimationSystem.step(
            ship, weaponsState, gameData, animation, { ...time, time: 500 }, ionized, ionizationColor,
            undefined, undefined,
        );
        expect(lightSprite.visible).toBe(true);

        // At time = 1500 (1500 % 2000 >= 1000) -> off
        ShipAnimationSystem.step(
            ship, weaponsState, gameData, animation, { ...time, time: 1500 }, ionized, ionizationColor,
            undefined, undefined,
        );
        expect(lightSprite.visible).toBe(false);
    });
});
