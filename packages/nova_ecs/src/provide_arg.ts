import { right } from "fp-ts/lib/Either.js";
import { ArgModifier } from "./arg_modifier.js";
import { ArgData, ArgsToData, ArgTypes, GetEntity } from "./arg_types.js";
import { Component, ComponentData } from "./component.js";
import { Optional } from "./optional.js";
import { Query } from "./query.js";

export function ProvideArg<Provided extends Component<any>, Args extends readonly ArgTypes[]>({ provided, factory, args }: {
    provided: Provided,
    factory: (...args: ArgsToData<Args>) => ComponentData<Provided>,
    args: Args
}) {
    return new ArgModifier({
        query: new Query([Optional(provided), GetEntity, ...args] as const,
            `Provide ${provided.name}`),
        transform: (providedVal, entity, ...factoryArgs) => {
            if (providedVal) {
                return right(providedVal as ArgData<Provided>);
            }
            const newVal = factory(...factoryArgs);
            entity.components.set(provided, newVal);
            return right(newVal);
        }
    });
}
