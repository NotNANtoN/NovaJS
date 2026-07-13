import * as t from 'io-ts';
import { Component } from 'nova_ecs/component';
import { map } from 'nova_ecs/datatypes/map';

const WeaponState = t.intersection([t.type({
    count: t.number,
    firing: t.boolean,
}), t.partial({
    target: t.string,
    /**
     * The weapon's fire group, copied from its game data when the
     * state is derived. Carried in synced state so weapon selection
     * (secondary cycling, primary fire) never reads `getCached` at
     * input-application time — a cache-warmth-gated read there is
     * per-world state, and provably made an offline replay select a
     * different secondary than the live session.
     */
    fireGroup: t.string,
})]);
export type WeaponState = t.TypeOf<typeof WeaponState>;

export const WeaponsState = map(t.string /* weapon id */, WeaponState);
export type WeaponsState = t.TypeOf<typeof WeaponsState>;
export const WeaponsStateComponent = new Component<WeaponsState>('WeaponsStateComponent');
