import { isDraft, Patch } from 'immer';
import * as t from 'io-ts';
import 'jasmine';
import { GetEntity } from '../arg_types';
import { Component } from '../component';
import { set } from '../datatypes/set';
import { Entity } from '../entity';
import { System } from '../system';
import { World } from '../world';
import { DeltaMaker, DeltaPlugin, DeltaResource, OptionalComponentDelta } from './delta_plugin';

const FooComponent = new Component<{ x: number }>('Foo');
const FooType = t.type({ x: t.number });
const BarComponent = new Component<{ y: string }>('Bar');
const BarType = t.type({ y: t.string });

const SetComponent = new Component<{ s: Set<string> }>('Set');
const SetType = t.type({ s: set(t.string) });
const BooleanComponent = new Component<boolean>('Boolean');
const NumberComponent = new Component<number>('Number');
const StringComponent = new Component<string>('String');
const NullComponent = new Component<null>('Null');
const UndefinedMarkerComponent =
    new Component<undefined>('UndefinedMarker');

const FooDelta: OptionalComponentDelta<{ x: number }, number> = {
    componentType: FooType,
    deltaType: t.number,
    getDelta(a, b) {
        if (a.x !== b.x) {
            return b.x;
        }
        return;
    },
    applyDelta(foo, delta) {
        foo.x = delta
    },
}

const BarDelta: OptionalComponentDelta<{ y: string }, Patch[]> = { componentType: BarType };
const SetDelta: OptionalComponentDelta<{ s: Set<string> }, Patch[]> = { componentType: SetType };


describe('Delta Plugin', () => {
    let world1: World;
    let world2: World;
    let deltaMaker1: DeltaMaker;
    let deltaMaker2: DeltaMaker;

    beforeEach(() => {
        world1 = new World();
        world1.addPlugin(DeltaPlugin);
        world2 = new World();
        world2.addPlugin(DeltaPlugin);

        const maybeDelta1 = world1.resources.get(DeltaResource);
        if (!maybeDelta1) {
            throw new Error('Expected world 1 to have delta resource');
        }
        deltaMaker1 = maybeDelta1;

        const maybeDelta2 = world2.resources.get(DeltaResource);
        if (!maybeDelta2) {
            throw new Error('Expected world 2 to have delta resource');
        }
        deltaMaker2 = maybeDelta2;

        deltaMaker1.addComponent(FooComponent, FooDelta);
        deltaMaker1.addComponent(BarComponent, BarDelta);
        deltaMaker1.addComponent(SetComponent, SetDelta);
        deltaMaker1.addComponent(BooleanComponent, {
            componentType: t.boolean,
        });
        deltaMaker1.addComponent(NumberComponent, {
            componentType: t.number,
            deltaType: t.number,
            applyDelta: (_value, delta) => delta,
        });
        deltaMaker1.addComponent(StringComponent, {
            componentType: t.string,
            deltaType: t.string,
            applyDelta: (_value, delta) => delta,
        });
        deltaMaker1.addComponent(NullComponent, {
            componentType: t.null,
        });
        deltaMaker1.addComponent(UndefinedMarkerComponent, {
            componentType: t.undefined,
        });

        deltaMaker2.addComponent(FooComponent, FooDelta);
        deltaMaker2.addComponent(BarComponent, BarDelta);
        deltaMaker2.addComponent(SetComponent, SetDelta);
        deltaMaker2.addComponent(BooleanComponent, {
            componentType: t.boolean,
        });
        deltaMaker2.addComponent(NumberComponent, {
            componentType: t.number,
            deltaType: t.number,
            applyDelta: (_value, delta) => delta,
        });
        deltaMaker2.addComponent(StringComponent, {
            componentType: t.string,
            deltaType: t.string,
            applyDelta: (_value, delta) => delta,
        });
        deltaMaker2.addComponent(NullComponent, {
            componentType: t.null,
        });
        deltaMaker2.addComponent(UndefinedMarkerComponent, {
            componentType: t.undefined,
        });
    });

    it('sends the state of new components', () => {
        const entity = new Entity()
            .setName('Test Entity')
            .addComponent(FooComponent, { x: 123 })
            .addComponent(BarComponent, { y: 'Hello' });

        const firstDelta = deltaMaker1.getDelta(entity);
        if (!firstDelta?.componentStates) {
            fail('Expected firstDelta to have component states');
            return;
        }

        expect([...firstDelta.componentStates?.keys()])
            .toEqual(['Foo', 'Bar']);

        expect(firstDelta.componentDeltas).toBeUndefined();
        expect(firstDelta.removeComponents).toBeUndefined();

        const secondDelta = deltaMaker1.getDelta(entity);
        expect(secondDelta).toBeUndefined();
    });

    it('sends the state of replaced components', () => {
        const entity = new Entity()
            .setName('Test Entity')
            .addComponent(FooComponent, { x: 123 })
            .addComponent(BarComponent, { y: 'Hello' });

        const firstDelta = deltaMaker1.getDelta(entity);
        if (!firstDelta?.componentStates) {
            fail('Expected firstDelta to have component states');
            return;
        }

        expect([...firstDelta.componentStates?.keys()])
            .toEqual(['Foo', 'Bar']);

        expect(firstDelta.componentDeltas).toBeUndefined();
        expect(firstDelta.removeComponents).toBeUndefined();

        entity.components.set(FooComponent, { x: 456 });

        const secondDelta = deltaMaker1.getDelta(entity);
        if (!secondDelta?.componentStates) {
            fail('Expected secondDelta to have component states');
            return;
        }
        expect([...secondDelta.componentStates.keys()])
            .toEqual(['Foo']);

        expect(secondDelta.componentDeltas).toBeUndefined();
        expect(secondDelta.removeComponents).toBeUndefined();
    });

    it('creates new components that were sent', () => {
        const entity = new Entity()
            .setName('Test Entity')
            .addComponent(FooComponent, { x: 123 })
            .addComponent(BarComponent, { y: 'Hello' });

        const delta = deltaMaker1.getDelta(entity);
        if (!delta) {
            fail('Expected delta to be defined');
            return;
        }

        const entity2 = new Entity();
        deltaMaker2.applyDelta(entity2, delta);

        expect(entity2.components.get(FooComponent))
            .toEqual(entity.components.get(FooComponent));

        expect(entity2.components.get(BarComponent))
            .toEqual(entity.components.get(BarComponent));
    });

    it('updates components with deltas', () => {
        const entity = new Entity()
            .setName('Test Entity')
            .addComponent(FooComponent, { x: 123 })
            .addComponent(BarComponent, { y: 'Hello' })
            .addComponent(SetComponent, { s: new Set(['asdf']) });

        const entity2 = new Entity(entity.name, entity.components);

        const fooBarSystem = new System({
            name: 'FooBarSystem',
            args: [FooComponent, BarComponent] as const,
            step: (foo, bar) => {
                foo.x += 1;
                bar.y = String(foo.x);
            }
        });

        world1.addSystem(fooBarSystem);
        world1.entities.set('test entity uuid', entity);

        // Skip the first delta since it will send the state
        // of each new component.
        deltaMaker1.getDelta(entity);
        world1.step();
        const delta2 = deltaMaker1.getDelta(entity);
        if (!delta2) {
            fail('Expected delta2 to be defined');
            return;
        }

        deltaMaker2.applyDelta(entity2, delta2);

        expect(delta2.componentDeltas).toBeDefined();
        expect(delta2.componentStates).toBeUndefined();
        expect(delta2.removeComponents).toBeUndefined();
        expect([...delta2.componentDeltas!.keys()]).toEqual(['Foo', 'Bar']);

        expect(entity.components.get(FooComponent)).toEqual({ x: 124 });
        expect(entity2.components.get(FooComponent)).toEqual({ x: 124 });

        expect(entity.components.get(BarComponent)).toEqual({ y: '124' });
        expect(entity2.components.get(BarComponent)).toEqual({ y: '124' });
    });

    it('removes deleted components', () => {
        const entity = new Entity()
            .setName('Test Entity')
            .addComponent(FooComponent, { x: 123 })
            .addComponent(BarComponent, { y: 'Hello' });

        const entity2 = new Entity(entity.name, entity.components);

        const removeFooSystem = new System({
            name: 'FooBarSystem',
            args: [GetEntity, FooComponent] as const,
            step: (entity) => {
                entity.components.delete(FooComponent);
            }
        });

        world1.addSystem(removeFooSystem);
        world1.entities.set('test entity uuid', entity);

        // Skip the first delta since it will send the state
        // of each new component.
        deltaMaker1.getDelta(entity);
        world1.step();
        const delta2 = deltaMaker1.getDelta(entity);
        if (!delta2) {
            fail('Expected delta2 to be defined');
            return;
        }

        expect(entity2.components.get(FooComponent)).toEqual({ x: 123 });
        deltaMaker2.applyDelta(entity2, delta2);
        expect(entity2.components.get(FooComponent)).toBeUndefined();

        expect(delta2.componentDeltas).toBeUndefined();
        expect(delta2.componentStates).toBeUndefined();
        expect(delta2.removeComponents).toEqual(new Set(['Foo']));
    });

    it('does not report a component as changed when untracking', () => {
        // Untracking finishes Immer drafts. That is a representation change,
        // not a value change: reporting it re-runs every Provide watching one
        // of the entity's components, which rebuilds derived gameplay state
        // (weapon counts, reload accumulators, physics) and discards live
        // local input. Regression test for firing intent lost every step.
        const entity = new Entity()
            .setName('Test Entity')
            .addComponent(FooComponent, { x: 1 })
            .addComponent(BarComponent, { y: 'Hello' });
        world1.entities.set('test entity uuid', entity);

        // Draft the components so untrack has drafts to finish.
        deltaMaker1.getDelta(entity);
        world1.step();

        const changed: string[] = [];
        world1.entities.events.changeComponent.subscribe(
            ([, , component]) => changed.push(component.name));

        deltaMaker1.untrack(entity);

        expect(changed).toEqual([]);
        expect(entity.components.get(FooComponent)).toEqual({ x: 1 });
        expect(entity.components.get(BarComponent)).toEqual({ y: 'Hello' });
    });

    it('keeps a local edit outbound across a remote update', () => {
        const entity = new Entity()
            .setName('Test Entity')
            .addComponent(FooComponent, { x: 1 })
            .addComponent(BarComponent, { y: 'local' });
        world1.entities.set('test entity uuid', entity);
        deltaMaker1.getDelta(entity);
        deltaMaker1.clearDirty(entity);

        entity.components.set(BarComponent, { y: 'local edit' });
        deltaMaker1.applyRemoteUpdate(entity, () => {
            entity.components.set(FooComponent, { x: 42 });
        });

        expect(entity.components.get(FooComponent)).toEqual({ x: 42 });
        expect(entity.components.get(BarComponent)).toEqual({ y: 'local edit' });
        const delta = deltaMaker1.getDelta(entity);
        expect(delta?.componentStates?.has('Bar')
            || delta?.componentDeltas?.has('Bar')).toBeTrue();
    });

    it('tracks an initial boolean without drafting it', () => {
        const entity = new Entity()
            .addComponent(BooleanComponent, true);

        let delta: ReturnType<DeltaMaker['getDelta']> = undefined;
        expect(() => {
            delta = deltaMaker1.getDelta(entity);
        }).not.toThrow();

        expect(delta!.componentStates?.get(BooleanComponent.name)).toBeTrue();
        expect(entity.components.get(BooleanComponent)).toBeTrue();
        expect(isDraft(entity.components.get(BooleanComponent))).toBeFalse();
        expect(deltaMaker1.getDelta(entity)).toBeUndefined();
    });

    it('sends primitive replacements as full states', () => {
        const entity = new Entity()
            .addComponent(BooleanComponent, true)
            .addComponent(NumberComponent, 0)
            .addComponent(StringComponent, '')
            .addComponent(NullComponent, null);

        const initial = deltaMaker1.getDelta(entity);
        expect(initial?.componentStates).toEqual(new Map<string, unknown>([
            [BooleanComponent.name, true],
            [NumberComponent.name, 0],
            [StringComponent.name, ''],
            [NullComponent.name, null],
        ]));

        entity.components.set(BooleanComponent, true);
        entity.components.set(NumberComponent, 0);
        entity.components.set(StringComponent, '');
        entity.components.set(NullComponent, null);
        expect(deltaMaker1.getDelta(entity)).toBeUndefined();

        entity.components.set(BooleanComponent, false);
        entity.components.set(NumberComponent, 1);
        entity.components.set(StringComponent, 'changed');
        const replacement = deltaMaker1.getDelta(entity);

        expect(replacement?.componentStates)
            .toEqual(new Map<string, unknown>([
                [BooleanComponent.name, false],
                [NumberComponent.name, 1],
                [StringComponent.name, 'changed'],
            ]));
        expect(replacement?.componentDeltas).toBeUndefined();
        expect(deltaMaker1.getDelta(entity)).toBeUndefined();
    });

    it('distinguishes an absent component from a present undefined marker', () => {
        const entity = new Entity().addComponent(FooComponent, { x: 1 });
        deltaMaker1.getDelta(entity);

        entity.components.set(UndefinedMarkerComponent, undefined);
        const added = deltaMaker1.getDelta(entity);
        expect(added?.componentStates?.has(UndefinedMarkerComponent.name))
            .toBeTrue();
        expect(added?.componentStates?.get(UndefinedMarkerComponent.name))
            .toBeUndefined();
    });

    it('tracks primitive removal and re-addition', () => {
        const entity = new Entity()
            .addComponent(BooleanComponent, false);
        deltaMaker1.getDelta(entity);

        entity.components.delete(BooleanComponent);
        const removed = deltaMaker1.getDelta(entity);
        expect(removed?.removeComponents)
            .toEqual(new Set([BooleanComponent.name]));

        entity.components.set(BooleanComponent, false);
        const readded = deltaMaker1.getDelta(entity);
        expect(readded?.componentStates?.has(BooleanComponent.name)).toBeTrue();
        expect(readded?.componentStates?.get(BooleanComponent.name)).toBeFalse();
    });

    it('applies states and deltas over falsy primitive values', () => {
        const entity = new Entity()
            .addComponent(BooleanComponent, false)
            .addComponent(NumberComponent, 0)
            .addComponent(StringComponent, '');

        const stateMissing = deltaMaker2.applyDelta(entity, {
            componentStates: new Map<string, unknown>([
                [BooleanComponent.name, true],
                [NumberComponent.name, 2],
                [StringComponent.name, 'state'],
            ]),
        });
        expect(stateMissing.size).toBe(0);
        expect(entity.components.get(BooleanComponent)).toBeTrue();
        expect(entity.components.get(NumberComponent)).toBe(2);
        expect(entity.components.get(StringComponent)).toBe('state');

        entity.components.set(NumberComponent, 0);
        entity.components.set(StringComponent, '');
        const deltaMissing = deltaMaker2.applyDelta(entity, {
            componentDeltas: new Map<string, unknown>([
                [NumberComponent.name, 3],
                [StringComponent.name, 'delta'],
            ]),
        });
        expect(deltaMissing.size).toBe(0);
        expect(entity.components.get(NumberComponent)).toBe(3);
        expect(entity.components.get(StringComponent)).toBe('delta');
    });

    it('retries after a component codec throws without consuming state', () => {
        const ThrowingComponent =
            new Component<{ value: number }>('ThrowingCodec');
        const ValueType = t.type({ value: t.number });
        let shouldThrow = true;
        const ThrowingType = new t.Type<
            { value: number },
            unknown,
            unknown
        >(
            'ThrowingType',
            ValueType.is,
            ValueType.validate,
            value => {
                if (shouldThrow) {
                    shouldThrow = false;
                    throw new Error('codec failed');
                }
                return ValueType.encode(value);
            },
        );
        deltaMaker1.addComponent(ThrowingComponent, {
            componentType: ThrowingType,
        });
        const entity = new Entity()
            .addComponent(ThrowingComponent, { value: 1 });

        expect(() => deltaMaker1.getDelta(entity))
            .toThrowError('codec failed');
        expect(entity.components.get(ThrowingComponent)).toEqual({ value: 1 });

        const retry = deltaMaker1.getDelta(entity);
        expect(retry?.componentStates?.get(ThrowingComponent.name))
            .toEqual({ value: 1 });
        expect(isDraft(entity.components.get(ThrowingComponent))).toBeTrue();
    });

    it('retries after a custom delta throws without leaving a revoked draft', () => {
        const ThrowingComponent =
            new Component<{ value: number }>('ThrowingDelta');
        const ValueType = t.type({ value: t.number });
        let shouldThrow = true;
        deltaMaker1.addComponent(ThrowingComponent, {
            componentType: ValueType,
            getDelta: (_a, _b, patches) => {
                if (shouldThrow) {
                    shouldThrow = false;
                    throw new Error('delta failed');
                }
                return patches.length > 0 ? patches : undefined;
            },
        });
        const entity = new Entity()
            .addComponent(ThrowingComponent, { value: 1 });
        deltaMaker1.getDelta(entity);

        entity.components.get(ThrowingComponent)!.value = 2;
        expect(() => deltaMaker1.getDelta(entity))
            .toThrowError('delta failed');
        expect(entity.components.get(ThrowingComponent)!.value).toBe(2);
        expect(isDraft(entity.components.get(ThrowingComponent))).toBeTrue();

        const retry = deltaMaker1.getDelta(entity);
        expect(retry?.componentStates?.get(ThrowingComponent.name))
            .toEqual({ value: 2 });

        entity.components.get(ThrowingComponent)!.value = 3;
        const subsequent = deltaMaker1.getDelta(entity);
        expect(subsequent?.componentDeltas?.has(ThrowingComponent.name))
            .toBeTrue();
    });
});
