import { Either } from 'nova_ecs/either';
import { ArgData, ArgsToData, ArgTypes } from "./arg_types";
import { UnknownComponent } from "./component";
import { Query } from "./query";


type Transform<Args extends readonly any[], Result> =
    (...args: ArgsToData<Args>) => Either<undefined, ArgData<Result>>;

export type UnknownArgModifier = ArgModifier<readonly ArgTypes[], unknown>;
export type AnyArgModifier = ArgModifier<any, any>;

export class ArgModifier<Args extends readonly ArgTypes[], Result> {
    query: Query<Args>;
    transform: Transform<Args, Result>;
    readonly optionalValue?: ArgTypes;
    readonly modifierComponents?: ReadonlySet<UnknownComponent> | null;
    constructor({ query, transform, optionalValue, modifierComponents }: {
        query: Query<Args>,
        transform: Transform<Args, Result>,
        optionalValue?: ArgTypes,
        modifierComponents?: ReadonlySet<UnknownComponent> | null,
    }) {
        this.query = query;
        this.transform = transform;
        this.optionalValue = optionalValue;
        this.modifierComponents = modifierComponents;
    }
}

export type ArgModifierResult<M> = M extends ArgModifier<any, infer Result> ? ArgData<Result> : never;
