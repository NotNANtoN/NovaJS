/**
 * Nova control bits (NCBs). EV Nova exposes 10,000 boolean "control
 * bits" (b0 - b9999) that mission scripting reads and writes through
 * two little languages, both documented in the EVN Bible ("A quick
 * word about control bits and scripting in EV Nova"):
 *
 * - Test expressions are boolean expressions over the bits (plus a few
 *   special terms) used by availability fields, e.g. `b1 & (b2 | !b3)`.
 * - Set expressions are lists of operations run when something happens
 *   (a mission completes, an outfit is bought, ...), e.g. `b1 !b2 ^b3
 *   G142 R(b4 !b5)`.
 *
 * This module is the pure parser/evaluator for both. It has no ECS
 * dependencies; storage of the bits themselves and the side-effecting
 * operators are supplied by the caller.
 */

export class NCBParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NCBParseError';
    }
}

/** Bits are numbered b0 - b9999. */
export const MAX_CONTROL_BIT = 9999;

function parseBitNumber(digits: string, expression: string): number {
    const bit = parseInt(digits, 10);
    if (bit > MAX_CONTROL_BIT) {
        throw new NCBParseError(
            `Control bit b${bit} out of range (b0 - b${MAX_CONTROL_BIT})` +
            ` in ${JSON.stringify(expression)}`);
    }
    return bit;
}

// --- Test expressions ---

export type NCBTestExpression =
    /** Blank expressions evaluate to true. */
    | { type: 'true' }
    /** Bxxx: the value of control bit xxx. */
    | { type: 'bit', bit: number }
    /** Oxxx: the player owns at least one of outfit ID xxx. */
    | { type: 'outfit', id: number }
    /** Exxx: the player has explored system ID xxx. */
    | { type: 'explored', id: number }
    /** G: the player's gender (1 if male, 0 if female). */
    | { type: 'gender' }
    /** Pxxx: the game is registered ([P]aid for) or in its demo period. */
    | { type: 'registered', days: number }
    | { type: 'not', operand: NCBTestExpression }
    | { type: 'and', operands: NCBTestExpression[] }
    | { type: 'or', operands: NCBTestExpression[] };

/**
 * Everything a test expression can ask about. `getBit` is the only
 * required part; the exotic terms default to sensible values for a
 * game that doesn't model them (no outfits, nothing explored, male,
 * registered).
 */
export interface NCBTestContext {
    /** Bxxx: the value of control bit xxx. */
    getBit(bit: number): boolean;
    /** Oxxx: whether the player owns at least one of outfit ID xxx. */
    hasOutfit?(id: number): boolean;
    /** Exxx: whether the player has explored system ID xxx. */
    hasExplored?(id: number): boolean;
    /** G: the player's gender. True if male. */
    isMale?: boolean;
}

type TestToken =
    | { kind: '(' | ')' | '!' | '&' | '|' }
    | { kind: 'term', term: NCBTestExpression };

function tokenizeTest(expression: string): TestToken[] {
    const tokens: TestToken[] = [];
    // Case doesn't matter, per the Bible.
    const lower = expression.toLowerCase();
    const pattern = /\s+|[()!&|]|([bope])(\d+)|g/gy;
    let index = 0;
    while (index < lower.length) {
        pattern.lastIndex = index;
        const match = pattern.exec(lower);
        if (!match) {
            throw new NCBParseError(
                `Unexpected ${JSON.stringify(expression[index])} at index ` +
                `${index} in test expression ${JSON.stringify(expression)}`);
        }
        index = pattern.lastIndex;
        const [text, letter, digits] = match;
        if (/^\s+$/.test(text)) {
            continue;
        }
        if (letter) {
            const value = parseInt(digits, 10);
            switch (letter) {
                case 'b':
                    tokens.push({
                        kind: 'term',
                        term: { type: 'bit', bit: parseBitNumber(digits, expression) },
                    });
                    break;
                case 'o':
                    tokens.push({ kind: 'term', term: { type: 'outfit', id: value } });
                    break;
                case 'e':
                    tokens.push({ kind: 'term', term: { type: 'explored', id: value } });
                    break;
                case 'p':
                    tokens.push({ kind: 'term', term: { type: 'registered', days: value } });
                    break;
            }
        } else if (text === 'g') {
            tokens.push({ kind: 'term', term: { type: 'gender' } });
        } else {
            tokens.push({ kind: text as '(' | ')' | '!' | '&' | '|' });
        }
    }
    return tokens;
}

/**
 * Parses a control bit test expression, e.g. `b13 & (b15 | !b72)`.
 * A blank expression parses to `{type: 'true'}`.
 *
 * Nova's own evaluator is "fairly primitive" and unpredictable about
 * mixed `&`/`|` without parentheses; this one gives `!` the highest
 * precedence, then `&`, then `|`, which agrees with Nova on all
 * properly-parenthesized expressions.
 */
export function parseNCBTest(expression: string): NCBTestExpression {
    const tokens = tokenizeTest(expression);
    if (tokens.length === 0) {
        return { type: 'true' };
    }
    let position = 0;

    function fail(message: string): never {
        throw new NCBParseError(
            `${message} in test expression ${JSON.stringify(expression)}`);
    }

    function parseOr(): NCBTestExpression {
        const operands = [parseAnd()];
        while (tokens[position]?.kind === '|') {
            position++;
            operands.push(parseAnd());
        }
        return operands.length === 1 ? operands[0] : { type: 'or', operands };
    }

    function parseAnd(): NCBTestExpression {
        const operands = [parseUnary()];
        while (tokens[position]?.kind === '&') {
            position++;
            operands.push(parseUnary());
        }
        return operands.length === 1 ? operands[0] : { type: 'and', operands };
    }

    function parseUnary(): NCBTestExpression {
        const token = tokens[position];
        if (!token) {
            fail('Unexpected end');
        }
        switch (token.kind) {
            case '!':
                position++;
                return { type: 'not', operand: parseUnary() };
            case '(': {
                position++;
                const inner = parseOr();
                if (tokens[position]?.kind !== ')') {
                    fail('Expected ")"');
                }
                position++;
                return inner;
            }
            case 'term':
                position++;
                return token.term;
            default:
                fail(`Unexpected "${token.kind}"`);
        }
    }

    const parsed = parseOr();
    if (position !== tokens.length) {
        fail('Trailing tokens');
    }
    return parsed;
}

export function evaluateParsedNCBTest(expression: NCBTestExpression,
    context: NCBTestContext): boolean {
    switch (expression.type) {
        case 'true':
            return true;
        case 'bit':
            return context.getBit(expression.bit);
        case 'outfit':
            return context.hasOutfit?.(expression.id) ?? false;
        case 'explored':
            return context.hasExplored?.(expression.id) ?? false;
        case 'gender':
            return context.isMale ?? true;
        case 'registered':
            // NovaJS is always "registered".
            return true;
        case 'not':
            return !evaluateParsedNCBTest(expression.operand, context);
        case 'and':
            return expression.operands.every(
                operand => evaluateParsedNCBTest(operand, context));
        case 'or':
            return expression.operands.some(
                operand => evaluateParsedNCBTest(operand, context));
    }
}

/**
 * Evaluates a control bit test expression. A blank expression is true.
 * Throws `NCBParseError` on malformed expressions.
 */
export function evaluateNCBTest(expression: string,
    context: NCBTestContext): boolean {
    return evaluateParsedNCBTest(parseNCBTest(expression), context);
}

// --- Set expressions ---

export type NCBSetOperation =
    /** bxxx: set control bit xxx. */
    | { type: 'set', bit: number }
    /** !bxxx: clear control bit xxx. */
    | { type: 'clear', bit: number }
    /** ^bxxx: toggle control bit xxx. */
    | { type: 'toggle', bit: number }
    /** R(<op1> <op2>): run one of the two operations at random. */
    | { type: 'random', choices: [NCBSetOperation, NCBSetOperation] }
    /** Axxx: if mission ID xxx is currently active, abort it. */
    | { type: 'abortMission', id: number }
    /** Fxxx: if mission ID xxx is currently active, cause it to fail. */
    | { type: 'failMission', id: number }
    /** Sxxx: start mission ID xxx automatically. */
    | { type: 'startMission', id: number }
    /** Gxxx: grant one of outfit ID xxx to the player. */
    | { type: 'grantOutfit', id: number }
    /** Dxxx: remove (delete) one of outfit ID xxx from the player. */
    | { type: 'removeOutfit', id: number }
    /**
     * Mxxx / Nxxx: move the player to system xxx. M puts the player on
     * top of the system's first stellar (or its centre); N keeps the
     * player's x/y coordinates relative to the system centre.
     */
    | { type: 'moveToSystem', id: number, keepCoordinates: boolean }
    /**
     * Cxxx / Exxx / Hxxx: change the player's ship to ship type xxx.
     * C keeps the player's outfits and grants none of the new ship's
     * defaults; E keeps the player's outfits and also grants the
     * defaults; H drops nonpersistent outfits and grants the defaults.
     */
    | {
        type: 'changeShip', id: number,
        outfits: 'keep' | 'keepAndGrantDefaults' | 'dropAndGrantDefaults',
    }
    /** Kxxx: activate rank ID xxx. */
    | { type: 'activateRank', id: number }
    /** Lxxx: deactivate rank ID xxx. */
    | { type: 'deactivateRank', id: number }
    /** Pxxx: play sound ID xxx. */
    | { type: 'playSound', id: number }
    /** Yxxx: destroy stellar ID xxx. */
    | { type: 'destroyStellar', id: number }
    /** Uxxx: regenerate (un-destroy) stellar ID xxx. */
    | { type: 'regenerateStellar', id: number }
    /**
     * Qxxx: make the player immediately leave (absquatulate) whatever
     * stellar he's landed on, showing a message from STR# ID xxx.
     */
    | { type: 'leaveStellar', stringId: number }
    /**
     * Txxx: change the name (title) of the player's ship to a string
     * randomly selected from STR# resource ID xxx.
     */
    | { type: 'renameShip', stringId: number }
    /** Xxxx: make system ID xxx be explored. */
    | { type: 'exploreSystem', id: number };

/**
 * The side effects a set expression can request. Bit mutation is
 * required; every other operator is optional and ignored (with a
 * console warning) when its hook is absent, so callers only implement
 * what their part of the game supports.
 *
 * Note that `grantOutfit` (Gxxx) bypasses all purchase requirements:
 * free mass, hardpoints, the outfit's Max count, availability, and
 * Require bits.
 */
export interface NCBSetHooks {
    setBit(bit: number): void;
    clearBit(bit: number): void;
    toggleBit(bit: number): void;
    /** Gxxx. Must ignore purchase limits. */
    grantOutfit?(id: number): void;
    /** Dxxx */
    removeOutfit?(id: number): void;
    /** Axxx */
    abortMission?(id: number): void;
    /** Fxxx */
    failMission?(id: number): void;
    /** Sxxx */
    startMission?(id: number): void;
    /** Mxxx / Nxxx */
    moveToSystem?(id: number, keepCoordinates: boolean): void;
    /** Cxxx / Exxx / Hxxx */
    changeShip?(id: number,
        outfits: 'keep' | 'keepAndGrantDefaults' | 'dropAndGrantDefaults'): void;
    /** Kxxx */
    activateRank?(id: number): void;
    /** Lxxx */
    deactivateRank?(id: number): void;
    /** Pxxx */
    playSound?(id: number): void;
    /** Yxxx */
    destroyStellar?(id: number): void;
    /** Uxxx */
    regenerateStellar?(id: number): void;
    /** Qxxx */
    leaveStellar?(stringId: number): void;
    /** Txxx */
    renameShip?(stringId: number): void;
    /** Xxxx */
    exploreSystem?(id: number): void;
}

/**
 * Parses a control bit set expression, e.g. `b1 !b2 ^b3 G142 R(b4 !b5)`.
 * A blank expression parses to no operations.
 */
export function parseNCBSet(expression: string): NCBSetOperation[] {
    // Case doesn't matter, per the Bible.
    const lower = expression.toLowerCase();
    const pattern = /\s+|([!^]?)b(\d+)|([afsgdmncehklpyuqtx])(\d+)|r\(|\)/gy;
    let index = 0;

    function fail(message: string): never {
        throw new NCBParseError(
            `${message} in set expression ${JSON.stringify(expression)}`);
    }

    // Stack of R( groups under construction; the bottom entry collects
    // the top-level operations.
    const stack: NCBSetOperation[][] = [[]];
    while (index < lower.length) {
        pattern.lastIndex = index;
        const match = pattern.exec(lower);
        if (!match) {
            fail(`Unexpected ${JSON.stringify(expression[index])} at ` +
                `index ${index}`);
        }
        index = pattern.lastIndex;
        const [text, bitPrefix, bitDigits, opLetter, opDigits] = match;
        if (/^\s+$/.test(text)) {
            continue;
        }
        const operations = stack[stack.length - 1];
        if (bitDigits !== undefined) {
            const bit = parseBitNumber(bitDigits, expression);
            operations.push(
                bitPrefix === '!' ? { type: 'clear', bit } :
                    bitPrefix === '^' ? { type: 'toggle', bit } :
                        { type: 'set', bit });
        } else if (opLetter !== undefined) {
            const id = parseInt(opDigits, 10);
            switch (opLetter) {
                case 'a': operations.push({ type: 'abortMission', id }); break;
                case 'f': operations.push({ type: 'failMission', id }); break;
                case 's': operations.push({ type: 'startMission', id }); break;
                case 'g': operations.push({ type: 'grantOutfit', id }); break;
                case 'd': operations.push({ type: 'removeOutfit', id }); break;
                case 'm': operations.push(
                    { type: 'moveToSystem', id, keepCoordinates: false });
                    break;
                case 'n': operations.push(
                    { type: 'moveToSystem', id, keepCoordinates: true });
                    break;
                case 'c': operations.push(
                    { type: 'changeShip', id, outfits: 'keep' });
                    break;
                case 'e': operations.push({
                    type: 'changeShip', id,
                    outfits: 'keepAndGrantDefaults',
                });
                    break;
                case 'h': operations.push({
                    type: 'changeShip', id,
                    outfits: 'dropAndGrantDefaults',
                });
                    break;
                case 'k': operations.push({ type: 'activateRank', id }); break;
                case 'l': operations.push({ type: 'deactivateRank', id }); break;
                case 'p': operations.push({ type: 'playSound', id }); break;
                case 'y': operations.push({ type: 'destroyStellar', id }); break;
                case 'u': operations.push({ type: 'regenerateStellar', id }); break;
                case 'q': operations.push({ type: 'leaveStellar', stringId: id }); break;
                case 't': operations.push({ type: 'renameShip', stringId: id }); break;
                case 'x': operations.push({ type: 'exploreSystem', id }); break;
            }
        } else if (text === 'r(') {
            stack.push([]);
        } else if (text === ')') {
            if (stack.length < 2) {
                fail(`Unmatched ")" at index ${index - 1}`);
            }
            const choices = stack.pop()!;
            if (choices.length !== 2) {
                fail(`R(...) takes exactly two operations, got ${choices.length}`);
            }
            stack[stack.length - 1].push({
                type: 'random',
                choices: [choices[0], choices[1]],
            });
        }
    }
    if (stack.length !== 1) {
        fail('Unclosed "R("');
    }
    return stack[0];
}

const warnedMissingHooks = new Set<string>();
function missingHook(name: string) {
    // TODO: Implement the remaining hooks (missions, ranks, stellar
    // destruction, ...) as their game features land.
    if (!warnedMissingHooks.has(name)) {
        warnedMissingHooks.add(name);
        console.warn(`NCB set operation ${name} is not implemented here; ignoring.`);
    }
}

function runParsedNCBSetOperation(operation: NCBSetOperation,
    hooks: NCBSetHooks, random: () => number): void {
    switch (operation.type) {
        case 'set':
            hooks.setBit(operation.bit);
            break;
        case 'clear':
            hooks.clearBit(operation.bit);
            break;
        case 'toggle':
            hooks.toggleBit(operation.bit);
            break;
        case 'random':
            runParsedNCBSetOperation(
                operation.choices[random() < 0.5 ? 0 : 1], hooks, random);
            break;
        case 'grantOutfit':
            hooks.grantOutfit
                ? hooks.grantOutfit(operation.id)
                : missingHook('Gxxx (grant outfit)');
            break;
        case 'removeOutfit':
            hooks.removeOutfit
                ? hooks.removeOutfit(operation.id)
                : missingHook('Dxxx (remove outfit)');
            break;
        case 'abortMission':
            hooks.abortMission
                ? hooks.abortMission(operation.id)
                : missingHook('Axxx (abort mission)');
            break;
        case 'failMission':
            hooks.failMission
                ? hooks.failMission(operation.id)
                : missingHook('Fxxx (fail mission)');
            break;
        case 'startMission':
            hooks.startMission
                ? hooks.startMission(operation.id)
                : missingHook('Sxxx (start mission)');
            break;
        case 'moveToSystem':
            hooks.moveToSystem
                ? hooks.moveToSystem(operation.id, operation.keepCoordinates)
                : missingHook('Mxxx/Nxxx (move to system)');
            break;
        case 'changeShip':
            hooks.changeShip
                ? hooks.changeShip(operation.id, operation.outfits)
                : missingHook('Cxxx/Exxx/Hxxx (change ship)');
            break;
        case 'activateRank':
            hooks.activateRank
                ? hooks.activateRank(operation.id)
                : missingHook('Kxxx (activate rank)');
            break;
        case 'deactivateRank':
            hooks.deactivateRank
                ? hooks.deactivateRank(operation.id)
                : missingHook('Lxxx (deactivate rank)');
            break;
        case 'playSound':
            hooks.playSound
                ? hooks.playSound(operation.id)
                : missingHook('Pxxx (play sound)');
            break;
        case 'destroyStellar':
            hooks.destroyStellar
                ? hooks.destroyStellar(operation.id)
                : missingHook('Yxxx (destroy stellar)');
            break;
        case 'regenerateStellar':
            hooks.regenerateStellar
                ? hooks.regenerateStellar(operation.id)
                : missingHook('Uxxx (regenerate stellar)');
            break;
        case 'leaveStellar':
            hooks.leaveStellar
                ? hooks.leaveStellar(operation.stringId)
                : missingHook('Qxxx (leave stellar)');
            break;
        case 'renameShip':
            hooks.renameShip
                ? hooks.renameShip(operation.stringId)
                : missingHook('Txxx (rename ship)');
            break;
        case 'exploreSystem':
            hooks.exploreSystem
                ? hooks.exploreSystem(operation.id)
                : missingHook('Xxxx (explore system)');
            break;
    }
}

export function runParsedNCBSet(operations: NCBSetOperation[],
    hooks: NCBSetHooks, random: () => number): void {
    for (const operation of operations) {
        runParsedNCBSetOperation(operation, hooks, random);
    }
}

/**
 * Runs a control bit set expression against the given hooks. `random`
 * decides R(a b) choices; pass a deterministic source (e.g. the ECS
 * Random resource's `next`) when running inside the simulation.
 */
export function runNCBSet(expression: string, hooks: NCBSetHooks,
    random: () => number): void {
    runParsedNCBSet(parseNCBSet(expression), hooks, random);
}

/**
 * Hooks that mutate a `Set<number>` of control bits and optionally
 * grant/remove outfits in an `id -> count` map. This is what outfit
 * OnPurchase/OnSell strings use; the outfit-count map is keyed by
 * global outfit ids, so numeric resource ids pass through `resolveId`.
 */
export function makeControlBitHooks(bits: Set<number>, outfitCounts?: {
    outfits: Map<string, number>,
    /** Maps a resource id like 142 to a global id like "nova:142". */
    resolveId(id: number): string,
}): NCBSetHooks {
    const hooks: NCBSetHooks = {
        setBit: bit => bits.add(bit),
        clearBit: bit => bits.delete(bit),
        toggleBit: bit => bits.has(bit) ? bits.delete(bit) : bits.add(bit),
    };
    if (outfitCounts) {
        const { outfits, resolveId } = outfitCounts;
        // Grants bypass all purchase limits by design.
        hooks.grantOutfit = id => {
            const globalId = resolveId(id);
            outfits.set(globalId, (outfits.get(globalId) ?? 0) + 1);
        };
        hooks.removeOutfit = id => {
            const globalId = resolveId(id);
            const count = outfits.get(globalId) ?? 0;
            if (count > 1) {
                outfits.set(globalId, count - 1);
            } else {
                outfits.delete(globalId);
            }
        };
    }
    return hooks;
}
