export interface Left<E> {
    readonly _tag: 'Left';
    readonly left: E;
}

export interface Right<A> {
    readonly _tag: 'Right';
    readonly right: A;
}

export type Either<E, A> = Left<E> | Right<A>;

export function left<E = never, A = never>(e: E): Either<E, A> {
    return { _tag: 'Left', left: e };
}

export function right<E = never, A = never>(a: A): Either<E, A> {
    return { _tag: 'Right', right: a };
}

export function isLeft<E, A>(ma: Either<E, A>): ma is Left<E> {
    return ma._tag === 'Left';
}

export function isRight<E, A>(ma: Either<E, A>): ma is Right<A> {
    return ma._tag === 'Right';
}

export function map<A, B>(f: (a: A) => B): <E>(fa: Either<E, A>) => Either<E, B> {
    return fa => (isRight(fa) ? right(f(fa.right)) : fa);
}

export function getOrElse<E, A>(onLeft: (e: E) => A): (ma: Either<E, A>) => A {
    return ma => (isRight(ma) ? ma.right : onLeft(ma.left));
}
