import { dailyPay, escortTerms, hirePrice, MAXIMUM_ESCORTS } from './escort_terms';
import { hireEscort } from './escort_plugin';

describe('escort terms', () => {
    it('prices hiring at the tenth of hull cost retail uses for escorts', () => {
        expect(hirePrice({ cost: 150_000 })).toEqual(15_000);
        expect(dailyPay({ cost: 150_000 })).toEqual(1_500);
    });

    it('never quotes a free escort, however cheap the hull', () => {
        expect(hirePrice({ cost: 0 })).toEqual(1);
        expect(dailyPay({ cost: 1 })).toEqual(1);
    });

    it('quotes terms a hire can be paid from', () => {
        const terms = escortTerms('nova:133', { cost: 500_000 });
        const result = hireEscort(
            60_000, { contracts: [] }, terms, MAXIMUM_ESCORTS);
        expect(result.hired).toBeTrue();
        expect(result.credits).toEqual(10_000);
        expect(result.roster.contracts[0].dailyPay).toEqual(5_000);
    });

    it('refuses a hire the pilot cannot afford', () => {
        const terms = escortTerms('nova:133', { cost: 500_000 });
        const result = hireEscort(
            1_000, { contracts: [] }, terms, MAXIMUM_ESCORTS);
        expect(result.hired).toBeFalse();
        expect(result.credits).toEqual(1_000);
    });
});
