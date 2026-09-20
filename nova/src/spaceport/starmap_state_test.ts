import 'jasmine';
import {
    consumeInitialCenter,
    systemMarkerStyle,
} from './starmap_state';
import {
    getMissionDestinationMarkers,
    getSystemMissionDetails,
    resolveMissionTargetSystem,
    SystemGraph,
} from './starmap';

describe('starmap world presentation state', () => {
    it('centers only the first open in each constructed system world', () => {
        const firstWorld = { centeredOnce: false };
        expect(consumeInitialCenter(firstWorld)).toBeTrue();
        expect(consumeInitialCenter(firstWorld)).toBeFalse();

        const destinationWorld = { centeredOnce: false };
        expect(consumeInitialCenter(destinationWorld)).toBeTrue();
    });

    it('marks the current system independently of the plotted route', () => {
        expect(systemMarkerStyle('nova:130', 'nova:130')).toEqual({
            current: true,
            ringColor: 0xffffff,
            ringWidth: 2,
        });
        expect(systemMarkerStyle('nova:162', 'nova:130'))
            .toEqual({ current: false });
    });

    it('identifies destination systems and mission types for map markers', () => {
        const systems = [
            { id: 'nova:128', name: 'Sol', planets: ['nova:128', 'nova:129'] },
            { id: 'nova:130', name: 'Alpha Centauri', planets: ['nova:130'] },
            { id: 'nova:135', name: 'Barnard', planets: ['nova:135'] },
        ] as never;

        const missions = [
            {
                missionId: 'm1',
                state: 'active' as const,
                travelDestination: 'nova:130',
                cargo: { type: 1001, quantity: 10 },
            },
            {
                missionId: 'm2',
                state: 'active' as const,
                destination: 'nova:135',
                cargo: { type: 1, quantity: 5 },
            },
            {
                missionId: 'm3',
                state: 'active' as const,
                destination: 'nova:128',
            },
        ];

        const markers = getMissionDestinationMarkers(missions as never, systems);
        expect(markers.get('nova:130')).toBe('passenger');
        expect(markers.get('nova:135')).toBe('cargo');
        expect(markers.get('nova:128')).toBe('storyline');
    });

    it('resolves planet destinations correctly even when planet ID matches another system ID', () => {
        // Retail EV Nova scenario:
        // Planet Earth is nova:128 in System Sol (nova:130).
        // Planet Altia is nova:163 in System Altair (nova:135).
        // System Gefjon is nova:163! (collides with Planet Altia ID)
        // System Kania is nova:128! (collides with Planet Earth ID)
        const systems = [
            { id: 'nova:128', name: 'Kania', planets: ['nova:999'] },
            { id: 'nova:130', name: 'Sol', planets: ['nova:128'] },
            { id: 'nova:135', name: 'Altair', planets: ['nova:163'] },
            { id: 'nova:163', name: 'Gefjon', planets: ['nova:888'] },
        ] as never;

        const missions = [
            // "Ferry Passengers to Altia": targets planet nova:163 (Altia) -> must resolve to Altair (nova:135), NOT Gefjon (nova:163)
            {
                missionId: 'm_altia',
                state: 'active' as const,
                travelDestination: 'nova:163',
                destination: 'nova:163',
                cargo: { type: 1001, quantity: 5 },
            },
            // "Head to Sol": Travel anywhere (*), return to Earth (nova:128 in Sol nova:130)
            {
                missionId: 'm_sol',
                state: 'active' as const,
                travelDestination: '*',
                returnDestination: 'nova:128',
                destination: 'nova:128',
                missionData: { title: 'Head to Sol' },
            },
        ];

        const markers = getMissionDestinationMarkers(missions as never, systems);
        expect(markers.get('nova:135')).toBe('passenger'); // Altair
        expect(markers.get('nova:163')).toBeUndefined();   // Gefjon must NOT have a marker
        expect(markers.get('nova:130')).toBe('storyline');   // Sol
        expect(markers.get('nova:128')).toBeUndefined();   // Kania must NOT have a marker

        // Verify system mission details also resolve correctly:
        const solDetails = getSystemMissionDetails('nova:130', missions as never, systems);
        expect(solDetails.length).toBe(1);
        expect(solDetails[0]).toContain('Head to Sol');

        const altairDetails = getSystemMissionDetails('nova:135', missions as never, systems);
        expect(altairDetails.length).toBe(1);
        expect(altairDetails[0]).toContain('Passenger');

        const gefjonDetails = getSystemMissionDetails('nova:163', missions as never, systems);
        expect(gefjonDetails.length).toBe(0);
    });

    it('plots a hyperjump route when clicking on charted systems outside explored history', () => {
        const systems = [
            { id: 'sol', name: 'Sol', links: ['centauri'], planets: [], position: [0, 0] },
            { id: 'centauri', name: 'Alpha Centauri', links: ['sol', 'barnard'], planets: [], position: [10, 10] },
            { id: 'barnard', name: 'Barnard', links: ['centauri'], planets: [], position: [20, 20] },
        ] as never;

        // Player starts in Sol, with only Sol in explored systems
        let selectedSystem: string | undefined;
        const graph = new SystemGraph(
            systems,
            'sol',
            ['sol'],
            id => { selectedSystem = id; },
        );

        // Clicking on Barnard (unvisited) must plot the route and select the system!
        (graph as any).onClickSystem('barnard');
        expect(selectedSystem).toBe('barnard');
        expect(graph.route).toEqual(['centauri', 'barnard']);
        expect(graph.isKnown('barnard')).toBeTrue();

        // When the player jumps to Centauri:
        graph.setCurrentSystem('centauri');
        (graph as any).onClickSystem('barnard');
        expect(graph.route).toEqual(['barnard']);
    });

    it('resolves duplicate storyline system variants so missions and clicks target the active instance', () => {
        // Retail EV Nova scenario:
        // Sirius (nova:148) links to Glimmer base (nova:193).
        // Glimmer has base instance (nova:193) and storyline instance (nova:759).
        // Mission targets Brass (planet nova:503), which is listed in nova:759.
        const systems = [
            {
                id: 'nova:148',
                name: 'Sirius',
                links: ['nova:193'],
                planets: ['nova:145'],
                position: [-80, -70],
            },
            {
                id: 'nova:193',
                name: 'Glimmer',
                links: ['nova:148'],
                planets: ['nova:214'],
                position: [-60, -80],
                visibility: '!(b6300 | b6302)',
            },
            {
                id: 'nova:759',
                name: 'Glimmer',
                links: ['nova:148'],
                planets: ['nova:503'],
                position: [-60, -80],
                visibility: '(b6300 & !b130) & !b6301',
            },
        ] as never;

        const missions = [
            {
                missionId: 'm_glimmer',
                state: 'active' as const,
                destination: 'nova:503',
                travelDestination: 'nova:503',
                returnDestination: '*',
                cargo: { type: 1001, quantity: 1 },
                missionData: { title: 'Somta Group to Brass' },
            },
        ];

        // 1. Mission destination markers should place the marker on active Glimmer (nova:193), NOT inactive nova:759
        const activeMarkers = getMissionDestinationMarkers(missions as never, systems, new Set());
        expect(activeMarkers.get('nova:193')).toBe('passenger');
        expect(activeMarkers.get('nova:759')).toBeUndefined();

        const missionDetails = getSystemMissionDetails('nova:193', missions as never, systems, new Set());
        expect(missionDetails.length).toBe(1);
        expect(missionDetails[0]).toContain('Somta Group to Brass');

        // 2. SystemGraph clicking on inactive nova:759 resolves to active nova:193 and plots the route
        let selected: string | undefined;
        const graph = new SystemGraph(
            systems,
            'nova:148',
            ['nova:148'],
            id => { selected = id; },
            () => true,
            { x: 800, y: 600 } as never,
            new Set(),
        );

        // Clicking either nova:193 or stacked clone nova:759 must both resolve to active nova:193
        (graph as any).onClickSystem('nova:759');
        expect(selected).toBe('nova:193');
        expect(graph.route).toEqual(['nova:193']);

        (graph as any).onClickSystem('nova:193');
        expect(selected).toBe('nova:193');
        expect(graph.route).toEqual(['nova:193']);
    });
});
