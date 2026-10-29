import { left, right } from 'nova_ecs/either';
import { ArgTypes } from "./arg_types";
import { ArgModifier } from "./arg_modifier";
import { UnknownComponent } from "./component";
import { Optional } from "./optional";
import { Query } from "./query";


export function FirstAvailable<V extends ArgTypes>(values: V[]) {
    const opts = values.map(v => Optional(v));
    const allKnown = opts.every(o => o.modifierComponents !== undefined && o.modifierComponents !== null);
    const modifierComponents = allKnown
        ? opts.reduce((acc, o) => {
            for (const c of o.modifierComponents!) {
                acc.add(c);
            }
            return acc;
        }, new Set<UnknownComponent>())
        : null;
    return new ArgModifier({
        query: new Query(opts),
        modifierComponents,
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
