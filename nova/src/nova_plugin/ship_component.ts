import * as t from 'io-ts';
import { Component } from 'nova_ecs/component';

export const ShipType = t.type({
    id: t.string, // Not a UUID. A nova id.
});
export type ShipType = t.TypeOf<typeof ShipType>;

export const ShipComponent = new Component<ShipType>('Ship');
