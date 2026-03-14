import { TypedNamedSymbol } from './typed_named_symbol.js';

export type ResourceData<C> = C extends Resource<infer Data> ? Data : never;
export type UnknownResource = Resource<unknown>;

/**
 * A `Resource` is like a `Component` that can be attached to the `World`. There
 * is at most a single value for each type of Resource in a World, and any query
 * for that resource will return that value. Resources are useful for storing
 * global state that all systems should be able to access regardless of which
 * entity they are currently running on.
 */
const resourceSymbol = Symbol('Resource');

export class Resource<Data> implements TypedNamedSymbol<Data> {
    private readonly resourceSymbol = resourceSymbol;
    constructor(readonly name: string) { }

    toString() {
        return `Resource(${this.name})`;
    }
}
