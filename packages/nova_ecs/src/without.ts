import { left, right } from "fp-ts/lib/Either.js";
import { ArgTypes } from "./arg_types.js";
import { ArgModifier } from "./arg_modifier.js";
import { Optional } from "./optional.js";
import { Query } from "./query.js";


export function Without<V extends ArgTypes>(value: V) {
    return new ArgModifier({
        query: new Query([Optional(value)]),
        transform: (val) => {
            if (val !== undefined) {
                // Fail since the value was found
                return left(undefined);
            }
            // Succeed since the value was unavailable
            return right(undefined);
        }
    });
}
