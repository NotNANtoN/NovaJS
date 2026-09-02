import 'jasmine';
import {
    getDefaultGovtData,
} from 'novadatainterface/GovtData';
import {
    getDefaultPlanetData,
} from 'novadatainterface/PlanetData';
import {
    getDefaultSystemData,
} from 'novadatainterface/SystemData';
import {
    navigationHazard,
    formatStarmapPorts,
    starmapPanelData,
    starmapPanelText,
    starmapGoods,
    starmapServices,
} from './starmap_content';

describe('starmap information content', () => {
    const system = {
        ...getDefaultSystemData(),
        id: 'nova:130',
        name: 'Tichel',
        government: 128,
        planets: ['nova:1', 'nova:2', 'nova:3'],
        asteroidDensity: 7,
    };
    const government = {
        ...getDefaultGovtData(),
        id: 'nova:128',
        name: 'Federation',
        crimeTolerance: 20,
        initialRecord: 0,
    };
    const port = {
        ...getDefaultPlanetData(),
        id: 'nova:1',
        name: 'Viking',
        canLand: true,
        flags: 0x1 | 0x2 | 0x4 | 0x8,
        tradeCommodities: [
            {
                commodity: 'Food' as const,
                priceLevel: 'low' as const,
                price: 60,
            },
            {
                commodity: 'Metal' as const,
                priceLevel: 'medium' as const,
                price: 200,
            },
        ],
    };
    const secondPort = {
        ...getDefaultPlanetData(),
        id: 'nova:2',
        name: 'Spacedock II',
        canLand: true,
        flags: 0x1 | 0x40,
        tradeCommodities: [
            {
                commodity: 'Industrial Goods' as const,
                priceLevel: 'medium' as const,
                price: 350,
            },
            {
                commodity: 'Equipment' as const,
                priceLevel: 'high' as const,
                price: 687,
            },
        ],
    };
    const inaccessible = {
        ...getDefaultPlanetData(),
        id: 'nova:3',
        name: 'Unreachable',
        canLand: false,
        flags: 0x1 | 0x2 | 0x4 | 0x8 | 0x40,
        tradeCommodities: [{
            commodity: 'Luxury Goods' as const,
            priceLevel: 'high' as const,
            price: 1125,
        }],
    };

    it('assembles the selected system fields from game data', () => {
        const panel = starmapPanelData({
            system,
            currentSystemId: 'nova:999',
            known: true,
            planets: [port, secondPort, inaccessible],
            government,
            legalRecords: { 'nova:128': -5 },
            gameDate: 0,
        });

        expect(panel.heading).toBe('Selected System');
        expect(panel.systemName).toBe('Tichel');
        expect(panel.government).toBe('Federation');
        expect(panel.legalStatus).toBe('No Convictions');
        expect(panel.ports).toEqual(['Viking', 'Spacedock II']);
        expect(panel.goods).toEqual([
            'Food', 'Industrial Goods', 'Metal', 'Equipment',
        ]);
        expect(panel.services).toEqual([
            'Trading', 'Outfitting', 'Shipyard', 'Bar', 'Recharge',
        ]);
        expect(panel.navigationHazards).toBe('Dense asteroid field');
        expect(panel.date).toBe('18 October 1177 NC');
    });

    it('handles independent governments and systems without hazards', () => {
        const panel = starmapPanelData({
            system: {
                ...system,
                id: 'nova:131',
                government: -1,
                asteroidDensity: 0,
            },
            currentSystemId: 'nova:131',
            known: true,
            planets: [],
        });

        expect(panel.heading).toBe('Current System');
        expect(panel.government).toBe('Independent');
        expect(panel.legalStatus).toBeUndefined();
        expect(panel.navigationHazards).toBeUndefined();
    });

    it('reveals no system information for unknown systems', () => {
        const panel = starmapPanelData({
            system,
            currentSystemId: system.id,
            known: false,
            planets: [port],
            government,
            legalRecords: { 'nova:128': -50 },
        });

        expect(panel.systemName).toBe('');
        expect(panel.government).toBeUndefined();
        expect(panel.legalStatus).toBeUndefined();
        expect(panel.goods).toEqual([]);
        expect(panel.services).toEqual([]);
        expect(panel.ports).toEqual([]);
    });

    it('unions goods and services across landable stellars only', () => {
        expect(starmapGoods([port, secondPort, inaccessible])).toEqual([
            'Food', 'Industrial Goods', 'Metal', 'Equipment',
        ]);
        expect(starmapServices([port, secondPort, inaccessible])).toEqual([
            'Trading', 'Outfitting', 'Shipyard', 'Bar', 'Recharge',
        ]);
    });

    it('maps asteroid density to retail-style hazard wording', () => {
        expect(navigationHazard(0)).toBeUndefined();
        expect(navigationHazard(1)).toBe('Asteroid field');
        expect(navigationHazard(6)).toBe('Asteroid field');
        expect(navigationHazard(7)).toBe('Dense asteroid field');
    });

    it('omits the hazard line when there is no hazard', () => {
        const text = starmapPanelText(starmapPanelData({
            system: { ...system, asteroidDensity: 0 },
            currentSystemId: system.id,
            known: true,
            planets: [],
            government,
            gameDate: 1,
        }));
        expect(text.bottom).toBe('Ports: None');
        expect(text.bottom).not.toContain('Navigation Hazards');
    });

    it('includes active transmissions in the panel body when present', () => {
        const text = starmapPanelText(starmapPanelData({
            system,
            currentSystemId: system.id,
            known: true,
            planets: [port],
            government,
            transmissions: ['[SOS] Captain Jack: MAYDAY', '[PILOT] Commander Sarah: in orbit'],
        }));
        expect(text.body).toContain('Active Transmissions:');
        expect(text.body).toContain('[SOS] Captain Jack: MAYDAY');
        expect(text.body).toContain('[PILOT] Commander Sarah: in orbit');
    });

    it('truncates long port lists between stellar names', () => {
        expect(formatStarmapPorts(
            ['Viking', 'Spacedock II', 'A Very Long Stellar Name'], 22,
        )).toBe('Viking, Spacedock II, …');
    });
});
