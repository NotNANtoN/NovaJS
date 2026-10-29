import { isRight, Right, right } from 'nova_ecs/either';
import { ArgModifier } from "./arg_modifier";
import { ArgData, ArgTypes, GetArg, GetEntity, UUID } from "./arg_types";
import { Component, UnknownComponent } from "./component";
import { EcsEvent } from "./events";
import { Query } from "./query";
import { Resource } from "./resource";

let sharedGetArgQuery: Query<readonly [typeof GetArg]> | undefined;
function getSharedGetArgQuery(): Query<readonly [typeof GetArg]> {
    return sharedGetArgQuery ??= new Query([GetArg] as const);
}

export function Optional<V extends ArgTypes>(value: V):
    ArgModifier<readonly [typeof GetArg], V | undefined> {
    const modifierComponents = value instanceof Component && !(value instanceof Resource)
        ? new Set<UnknownComponent>([value])
        : (value instanceof Resource || value instanceof EcsEvent || value === UUID || value === GetEntity)
            ? new Set<UnknownComponent>()
            : value instanceof ArgModifier
                ? value.modifierComponents ?? null
                : null;
    return new ArgModifier({
        query: getSharedGetArgQuery(),
        optionalValue: value,
        modifierComponents,
        transform: (getArg) => {
            try {
                const result = getArg(value);
                if (isRight(result)) {
                    return result as Right<ArgData<V>>;
                }
            } catch {
                return right(undefined);
            }
            return right(undefined);
        }
    });
}
