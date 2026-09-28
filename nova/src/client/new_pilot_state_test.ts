import 'jasmine';
import { createInitialPlayerState, toPersistentPlayerState } from '../nova_plugin/player_state';
import { fetchNewPilotState } from './new_pilot_state';

describe('fetchNewPilotState', () => {
    const respond = (body: unknown, ok = true) =>
        (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

    it('uses the server New Pilot state', async () => {
        const server = {
            ...createInitialPlayerState(),
            currentSystem: 'nova:300',
            credits: 30_000,
        };
        const state = await fetchNewPilotState(
            respond(toPersistentPlayerState(server)));
        expect(state.currentSystem).toBe('nova:300');
        expect(state.credits).toBe(30_000);
    });

    it('falls back to local defaults on failure or an invalid body', async () => {
        const local = createInitialPlayerState();
        for (const fetchImpl of [
            respond({}, false),
            respond({ nonsense: true }),
            (async () => { throw new Error('offline'); }) as unknown as typeof fetch,
            undefined,
        ]) {
            const state = await fetchNewPilotState(fetchImpl ?? (null as never));
            expect(state.currentSystem).toBe(local.currentSystem);
            expect(state.credits).toBe(local.credits);
        }
    });
});
