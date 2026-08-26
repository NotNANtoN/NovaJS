import { missionShipAppearsInSystem } from './mission_ship_plugin';

describe('mission ship system matching', () => {
    it('lets ShipSyst -6 fleets follow the player between systems', () => {
        expect(missionShipAppearsInSystem('*', 'nova:130')).toBe(true);
        expect(missionShipAppearsInSystem('*', 'nova:333')).toBe(true);
    });

    it('keeps fixed mission fleets in their selected system', () => {
        expect(missionShipAppearsInSystem('nova:333', 'nova:333')).toBe(true);
        expect(missionShipAppearsInSystem('nova:333', 'nova:334')).toBe(false);
    });
});
