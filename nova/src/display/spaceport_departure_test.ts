import 'jasmine';
import { Entity } from 'nova_ecs/entity';
import { EncodedEntity } from 'nova_ecs/plugins/serializer_plugin';
import {
    createInitialPlayerState,
    PersistentPlayerState,
    PlayerStateComponent,
    PlayerStorePort,
    toPersistentPlayerState,
} from '../nova_plugin/player_state';
import { persistDeparture } from './spaceport_departure';

interface RecordedSave {
    token: string;
    state: PersistentPlayerState;
    ship?: EncodedEntity;
}

function storeSpy(saves: RecordedSave[], fail = false): PlayerStorePort {
    return {
        ready: Promise.resolve(),
        async get() {
            return undefined;
        },
        async getOrCreate() {
            return toPersistentPlayerState(createInitialPlayerState());
        },
        async save(token, state, ship) {
            if (fail) {
                throw new Error('disk is full');
            }
            saves.push({ token, state, ship });
            return saves.length;
        },
        async snapshot() {
            throw new Error('not used');
        },
        async getSnapshots() {
            return [];
        },
        async restoreSnapshot() {
            return undefined;
        },
        bindPeer() { },
        getTokenForPeer() {
            return undefined;
        },
        async flush() { },
    };
}

function encodedShip(id: string): EncodedEntity {
    return { components: [['Ship', { id }]] };
}

describe('spaceport departure', () => {
    it('stores the ship the pilot leaves with, not the one they arrived in',
        async () => {
            const saves: RecordedSave[] = [];
            const ship = new Entity('bought');
            const landingState =
                toPersistentPlayerState(createInitialPlayerState());

            await persistDeparture(
                storeSpy(saves), 'token', ship, landingState,
                () => encodedShip('nova:200'));

            expect(saves.length).toBe(1);
            expect(saves[0].token).toBe('token');
            expect(saves[0].ship).toEqual(encodedShip('nova:200'));
        });

    it('prefers the state carried by a replacement ship', async () => {
        const saves: RecordedSave[] = [];
        const landingState =
            toPersistentPlayerState(createInitialPlayerState());
        const purchased = {
            ...toPersistentPlayerState(createInitialPlayerState()),
            credits: 17,
        };
        const ship = new Entity('bought');
        ship.components.set(PlayerStateComponent, purchased as never);

        await persistDeparture(
            storeSpy(saves), 'token', ship, landingState,
            () => encodedShip('nova:200'));

        expect(saves[0].state.credits).toBe(17);
    });

    it('does nothing without a token', async () => {
        const saves: RecordedSave[] = [];
        await persistDeparture(
            storeSpy(saves), undefined, new Entity('ship'),
            toPersistentPlayerState(createInitialPlayerState()),
            () => encodedShip('nova:128'));
        expect(saves.length).toBe(0);
    });

    it('reports a failed save instead of breaking the departure', async () => {
        const errors = spyOn(console, 'error');
        await expectAsync(persistDeparture(
            storeSpy([], true), 'token', new Entity('ship'),
            toPersistentPlayerState(createInitialPlayerState()),
            () => encodedShip('nova:128'))).toBeResolved();
        expect(errors).toHaveBeenCalled();
    });
});
