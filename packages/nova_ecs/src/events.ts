import { Entity } from './entity.js';
import { TypedNamedSymbol } from './typed_named_symbol.js';


const eventSymbol = Symbol('Event');
export class EcsEvent<Data> implements TypedNamedSymbol<Data> {
    // Necessary so Query does not extend EcsEvent, which ruins the arg
    // type system.
    private readonly eventSymbol = eventSymbol;
    readonly name: string;

    constructor(name = '') {
        this.name = name;
    }
}

export const StepEvent = new EcsEvent<true>('step');
export const DeleteEvent = new EcsEvent<Set<[string /* uuid */, Entity]>>('delete');
export const AddEvent = new EcsEvent<[string /* uuid */, Entity]>('add');

export interface EcsEventWithEntities<Data> {
    event: EcsEvent<Data>;
    data: Data;
    entities?: Array<string | Entity>;
}

export type EventData<E> = E extends EcsEvent<infer Data> ? Data : never;
export type UnknownEvent = EcsEvent<unknown>;
export type UnknownEventWithEntities = EcsEventWithEntities<unknown>;
