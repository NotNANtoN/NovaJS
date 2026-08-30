import {
    calculateJumpDistances,
    generateProceduralMissions,
    jumpDistanceBFS,
} from './procedural_missions';

const systems = [
    { id: 'nova:1', links: ['nova:2'] },
    { id: 'nova:2', links: ['nova:1', 'nova:3'] },
    { id: 'nova:3', links: ['nova:2', 'nova:4'] },
    { id: 'nova:4', links: ['nova:3'] },
];

const planets = [
    { id: 'nova:10', name: 'Origin', inhabited: true, systemId: 'nova:1' },
    { id: 'nova:20', name: 'Second', inhabited: true, systemId: 'nova:2' },
    { id: 'nova:30', name: 'Third', inhabited: true, systemId: 'nova:3' },
    { id: 'nova:40', name: 'Fourth', inhabited: true, systemId: 'nova:4' },
];

describe('procedural mission generation', () => {
    it('computes shortest linked-system distances with BFS', () => {
        expect([...calculateJumpDistances('nova:1', systems)])
            .toEqual([
                ['nova:1', 0],
                ['nova:2', 1],
                ['nova:3', 2],
                ['nova:4', 3],
            ]);
        expect(jumpDistanceBFS('nova:1', 'nova:4', systems)).toBe(3);
        expect(jumpDistanceBFS('nova:1', 'nova:99', systems)).toBeUndefined();
    });

    it('is stable for a stellar/date and changes with the game date', () => {
        const input = {
            currentSystemId: 'nova:1',
            currentPlanetId: 'nova:10',
            gameDate: 0,
            systems,
            planets,
            freeSpace: 5,
        };
        const first = generateProceduralMissions(input);
        const second = generateProceduralMissions(input);
        expect(first).toEqual(second);
        expect(first.length).toBeGreaterThanOrEqual(6);
        expect(first.length).toBeLessThanOrEqual(12);
        expect(first.every(offer => offer.jumpDistance >= 1
            && offer.jumpDistance <= 4)).toBe(true);
        expect(first.some(offer => !offer.available)).toBe(true);

        const nextDate = generateProceduralMissions({
            ...input,
            gameDate: 1,
        });
        expect(nextDate.map(offer => offer.mission.id))
            .not.toEqual(first.map(offer => offer.mission.id));
    });

    it('generates bounty missions with target ship goals and high payouts', () => {
        let foundBounty = false;
        for (let day = 0; day < 20; day++) {
            const offers = generateProceduralMissions({
                currentSystemId: 'nova:1',
                currentPlanetId: 'nova:10',
                gameDate: day,
                systems,
                planets,
                freeSpace: 10,
            });
            const bounty = offers.find(o => o.type === 'bounty');
            if (bounty) {
                foundBounty = true;
                expect(bounty.available).toBe(true);
                expect(bounty.mission.shipGoal).toBe(1);
                expect(bounty.mission.shipCount).toBe(1);
                expect(bounty.mission.name).toContain('BOUNTY:');
                expect(bounty.mission.payVal).toBeGreaterThanOrEqual(15_000);
                break;
            }
        }
        expect(foundBounty).toBe(true);
    });
});

