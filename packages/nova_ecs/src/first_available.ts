import { left, right } from "fp-ts/lib/Either.js";
import { ArgTypes } from "./arg_types.js";
import { ArgModifier } from "./arg_modifier.js";
import { Optional } from "./optional.js";
import { Query } from "./query.js";


export function FirstAvailable<V extends ArgTypes>(values: V[]) {
    return new ArgModifier({
        query: new Query(values.map(v => Optional(v))),
        transform: (...vals) => {
            for (const val of vals) {
                if (val !== undefined) {
                    // Succeed with the first value found.
                    return right(val);
                }
            }
            // Fail since no value was available.
            return left(undefined);
        }
    });
}
