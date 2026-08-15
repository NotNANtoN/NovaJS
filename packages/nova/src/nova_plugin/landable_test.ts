import 'jasmine';
import { getDefaultPlanetData, PlanetData } from 'novadatainterface/planet_data';
import { getIntegrationGameData } from '../communication/simulation_test_fixture.js';
import { landable } from './landable.js';

function planet(flags: Partial<PlanetData['flags']>): PlanetData {
    const base = getDefaultPlanetData();
    return { ...base, flags: { ...base.flags, ...flags } };
}

describe('landable', () => {
    it('is true for an ordinary port (spöb Flags 0x0001 set)', () => {
        expect(landable(planet({ canLand: true }))).toBeTrue();
    });

    it('is false without the can-land bit', () => {
        expect(landable(planet({ canLand: false }))).toBeFalse();
    });

    it('is false for a land-only-if-destroyed stellar, which nothing can '
        + 'destroy yet', () => {
            expect(landable(planet({
                canLand: true, landOnlyIfDestroyed: true,
            }))).toBeFalse();
        });
});

describe('landable against real Nova data', () => {
    let planets: PlanetData[];
    beforeAll(async () => {
        const gameData = await getIntegrationGameData();
        const ids = await gameData.ids;
        planets = await Promise.all(
            ids.Planet.map(id => gameData.data.Planet.get(id)));
    }, 60_000);

    it('refuses Jupiter, which the original never lets you land on', () => {
        const jupiter = planets.find(p => p.id === 'nova:159')!;
        expect(jupiter.name).toBe('Jupiter');
        expect(landable(jupiter)).toBeFalse();
    });

    it('refuses every destroyed hypergate and admits every working one',
        () => {
            const gates = planets.filter(p => p.gate?.kind === 'hypergate');
            // The stock network: 16 destroyed gates (no HyperLinks at all)
            // and the working ones, which all have destinations.
            const dead = gates.filter(g => !landable(g));
            const alive = gates.filter(g => landable(g));
            expect(dead.length).toBe(16);
            expect(alive.length).toBeGreaterThan(0);
            for (const gate of dead) {
                expect(gate.gate!.destinations.length)
                    .withContext(`${gate.id} ${gate.name}`).toBe(0);
            }
            for (const gate of alive) {
                expect(gate.gate!.destinations.length)
                    .withContext(`${gate.id} ${gate.name}`)
                    .toBeGreaterThan(0);
            }
            // The named ones from the collapsed network.
            expect(dead.map(g => g.id)).toContain('nova:130'); // HG-Aldebaran
            expect(dead.map(g => g.id)).toContain('nova:131'); // HG-Vega
            expect(alive.map(g => g.id)).toContain('nova:1400'); // HG-V01
        });

    it('admits an ordinary port', () => {
        const earth = planets.find(p => p.id === 'nova:128')!;
        expect(earth.name).toBe('Earth');
        expect(landable(earth)).toBeTrue();
    });
});
