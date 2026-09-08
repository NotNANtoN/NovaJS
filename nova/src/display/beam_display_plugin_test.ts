import 'jasmine';
import * as PIXI from 'pixi.js';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { MovementState } from 'nova_ecs/plugins/movement_plugin';
import { BeamDisplaySystem } from './beam_display_plugin';
import { BeamWeaponData, getDefaultBeamWeaponData } from 'novadatainterface/WeaponData';

function movementAt(x = 0, y = 0): MovementState {
    return {
        position: new Position(x, y),
        velocity: new Vector(0, 0),
        rotation: new Angle(0),
        turning: 0,
        turnBack: false,
        accelerating: 0,
    };
}

describe('beam display color conversion', () => {
    it('does not throw when beamColor or coronaColor is a 32-bit ARGB integer (> 0xFFFFFF)', () => {
        const graphics = new PIXI.Graphics();
        const beamHandle = {
            root: graphics,
            dispose: () => {},
        };

        // 4278249826 is 0xFF00E962 (alpha 0xFF with RGB 0x00E962), which throws
        // in unmasked PixiJS v8 Color conversion.
        const beamData: BeamWeaponData = {
            ...getDefaultBeamWeaponData(),
            beamAnimation: {
                width: 4,
                beamColor: 4278249826,
                coronaColor: 4278249826,
                coronaFalloff: 4,
                length: 200,
                lightningAmplitude: 0,
                lightningDensity: 0,
            },
        };

        expect(() => {
            BeamDisplaySystem.step(
                beamData,
                undefined,
                movementAt(100, 100),
                beamHandle as never,
            );
        }).not.toThrow();

        // Also test with lightning beam mode
        const lightningBeam: BeamWeaponData = {
            ...getDefaultBeamWeaponData(),
            beamAnimation: {
                width: 4,
                beamColor: 4278249826,
                coronaColor: 4278249826,
                coronaFalloff: 0,
                length: 200,
                lightningAmplitude: 10,
                lightningDensity: 5,
            },
        };

        expect(() => {
            BeamDisplaySystem.step(
                lightningBeam,
                undefined,
                movementAt(50, 50),
                beamHandle as never,
            );
        }).not.toThrow();
    });
});
