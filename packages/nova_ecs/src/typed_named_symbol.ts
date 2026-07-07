export const typedNamedSymbol = Symbol('TypedNamedSymbol');

export interface TypedNamedSymbol<Data> {
    readonly name: string;
    readonly [typedNamedSymbol]?: Data;
}
