/**
 * EV Nova control-bit (NCB) expressions.
 *
 * The parser is deliberately independent of the ECS. Test expressions are
 * parsed into a small AST and evaluated against a supplied context. Set
 * expressions are parsed into operations so callers can provide the game
 * specific handlers for non-bit operations.
 */

export type MissionBits = Set<number> | boolean[];

export interface NcbTestContext {
    missionBits: ReadonlySet<number> | readonly boolean[];
    registered?: boolean;
    daysSinceRegistration?: number;
    gender?: 'male' | 'female' | number;
    outfits?: ReadonlySet<number | string>;
    exploredSystems?: ReadonlySet<number | string>;
}

export type NcbTestExpression =
    | { type: 'literal', value: boolean }
    | { type: 'bit', bit: number }
    | { type: 'registered', days: number }
    | { type: 'gender' }
    | { type: 'hasOutfit', id: number }
    | { type: 'exploredSystem', id: number }
    | { type: 'not', expression: NcbTestExpression }
    | { type: 'and', left: NcbTestExpression, right: NcbTestExpression }
    | { type: 'or', left: NcbTestExpression, right: NcbTestExpression };

export class NcbParseError extends Error {
    constructor(message: string, readonly offset?: number) {
        super(offset === undefined ? message : `${message} at ${offset}`);
        this.name = 'NcbParseError';
    }
}

const MAX_BIT = 9999;

function assertBit(bit: number, offset: number) {
    if (!Number.isInteger(bit) || bit < 0 || bit > MAX_BIT) {
        throw new NcbParseError(`Control bit must be between 0 and ${MAX_BIT}`, offset);
    }
}

function readBit(bits: NcbTestContext['missionBits'], bit: number): boolean {
    return bits instanceof Set
        ? bits.has(bit)
        : Boolean((bits as readonly boolean[])[bit]);
}

function readNumber(source: string, start: number): [number | undefined, number] {
    const match = /^\d+/.exec(source.slice(start));
    if (!match) {
        return [undefined, start];
    }
    return [Number(match[0]), start + match[0].length];
}

class TestParser {
    private index = 0;

    constructor(private readonly source: string) { }

    parse(): NcbTestExpression {
        this.skipWhitespace();
        if (this.index === this.source.length) {
            return { type: 'literal', value: true };
        }

        const expression = this.parseOr();
        this.skipWhitespace();
        if (this.index !== this.source.length) {
            throw new NcbParseError(
                `Unexpected '${this.source[this.index]}'`, this.index);
        }
        return expression;
    }

    private parseOr(): NcbTestExpression {
        let expression = this.parseAnd();
        while (true) {
            this.skipWhitespace();
            if (this.source[this.index] !== '|') {
                return expression;
            }
            this.index++;
            expression = {
                type: 'or',
                left: expression,
                right: this.parseAnd(),
            };
        }
    }

    private parseAnd(): NcbTestExpression {
        let expression = this.parseUnary();
        while (true) {
            this.skipWhitespace();
            if (this.source[this.index] !== '&') {
                return expression;
            }
            this.index++;
            expression = {
                type: 'and',
                left: expression,
                right: this.parseUnary(),
            };
        }
    }

    private parseUnary(): NcbTestExpression {
        this.skipWhitespace();
        if (this.source[this.index] === '!') {
            this.index++;
            return { type: 'not', expression: this.parseUnary() };
        }

        if (this.source[this.index] === '(') {
            this.index++;
            const expression = this.parseOr();
            this.skipWhitespace();
            if (this.source[this.index] !== ')') {
                throw new NcbParseError('Expected closing parenthesis', this.index);
            }
            this.index++;
            return expression;
        }

        return this.parseOperand();
    }

    private parseOperand(): NcbTestExpression {
        const offset = this.index;
        const operator = this.source[this.index]?.toUpperCase();
        if (!operator) {
            throw new NcbParseError('Expected an operand', this.index);
        }
        this.index++;

        const [number, end] = readNumber(this.source, this.index);
        this.index = end;

        switch (operator) {
            case 'B':
                if (number === undefined) {
                    throw new NcbParseError('Bit operand needs a number', offset);
                }
                assertBit(number, offset);
                return { type: 'bit', bit: number };
            case 'P':
                if (number === undefined) {
                    throw new NcbParseError('Registration operand needs a number', offset);
                }
                return { type: 'registered', days: number };
            case 'G':
                if (number !== undefined) {
                    throw new NcbParseError('Gender operand does not take a number', offset);
                }
                return { type: 'gender' };
            case 'O':
                if (number === undefined) {
                    throw new NcbParseError('Outfit operand needs a number', offset);
                }
                return { type: 'hasOutfit', id: number };
            case 'E':
                if (number === undefined) {
                    throw new NcbParseError('Explored-system operand needs a number', offset);
                }
                return { type: 'exploredSystem', id: number };
            default:
                throw new NcbParseError(`Unknown test operand '${operator}'`, offset);
        }
    }

    private skipWhitespace() {
        while (this.index < this.source.length
            && /\s/.test(this.source[this.index])) {
            this.index++;
        }
    }
}

export function parseTestExpression(expression: string): NcbTestExpression {
    return new TestParser(expression).parse();
}

function hasId(ids: ReadonlySet<number | string> | undefined, id: number) {
    return ids?.has(id) || ids?.has(String(id)) || false;
}

export function evaluateTestAst(
    expression: NcbTestExpression, context: NcbTestContext,
): boolean {
    switch (expression.type) {
        case 'literal':
            return expression.value;
        case 'bit':
            return readBit(context.missionBits, expression.bit);
        case 'registered':
            return context.registered === true
                || (context.daysSinceRegistration !== undefined
                    && context.daysSinceRegistration < expression.days);
        case 'gender':
            return context.gender === 'male' || context.gender === 1;
        case 'hasOutfit':
            return hasId(context.outfits, expression.id);
        case 'exploredSystem':
            return hasId(context.exploredSystems, expression.id);
        case 'not':
            return !evaluateTestAst(expression.expression, context);
        case 'and':
            return evaluateTestAst(expression.left, context)
                && evaluateTestAst(expression.right, context);
        case 'or':
            return evaluateTestAst(expression.left, context)
                || evaluateTestAst(expression.right, context);
    }
}

export function evaluateTestExpression(
    expression: string | NcbTestExpression,
    context: NcbTestContext = { missionBits: new Set() },
): boolean {
    return evaluateTestAst(
        typeof expression === 'string' ? parseTestExpression(expression) : expression,
        context);
}

/** Short alias for callers evaluating AvailBits-style fields. */
export const evaluateTest = evaluateTestExpression;

export type NcbOperation =
    | { type: 'setBit', bit: number }
    | { type: 'clearBit', bit: number }
    | { type: 'toggleBit', bit: number }
    | { type: 'randomChance', percent: number }
    | { type: 'randomChoice', choices: NcbOperation[][] }
    | { type: 'abortMission', id: number }
    | { type: 'failMission', id: number }
    | { type: 'startMission', id: number }
    | { type: 'grantOutfit', id: number }
    | { type: 'removeOutfit', id: number }
    | { type: 'moveToSystem', id: number }
    | { type: 'moveToSystemRelative', id: number }
    | { type: 'changeShip', id: number, includeDefaults: boolean }
    | { type: 'activateRank', id: number }
    | { type: 'deactivateRank', id: number }
    | { type: 'playSound', id: number }
    | { type: 'destroyStellar', id: number }
    | { type: 'regenerateStellar', id: number }
    | { type: 'leaveStellar', id: number }
    | { type: 'renameShip', id: number }
    | { type: 'exploreSystem', id: number }
    | { type: 'unknown', raw: string, operator?: string, id?: number };

export interface NcbSetParseOptions {
    logger?: (message: string) => void;
}

export interface NcbSetExecutionOptions extends NcbSetParseOptions {
    random?: () => number;
    handlers?: Partial<{
        [K in NcbOperation['type']]: (operation: NcbOperation) => void
    }>;
}

function unknownOperation(
    raw: string, options: NcbSetParseOptions, offset: number,
): NcbOperation {
    options.logger?.(`Unrecognized NCB set operation '${raw}' at ${offset}`);
    return { type: 'unknown', raw };
}

function parseSetToken(
    token: string, options: NcbSetParseOptions, offset: number,
): NcbOperation {
    const randomMatch = /^R(\d+)$/i.exec(token);
    if (randomMatch) {
        return {
            type: 'randomChance',
            percent: Math.max(0, Math.min(100, Number(randomMatch[1]))),
        };
    }

    const bitMatch = /^([!^]?)B(\d+)$/i.exec(token);
    if (bitMatch) {
        const bit = Number(bitMatch[2]);
        assertBit(bit, offset);
        switch (bitMatch[1]) {
            case '!':
                return { type: 'clearBit', bit };
            case '^':
                return { type: 'toggleBit', bit };
            default:
                return { type: 'setBit', bit };
        }
    }

    const operatorMatch = /^([A-Z])(\d+)$/i.exec(token);
    if (!operatorMatch) {
        return unknownOperation(token, options, offset);
    }

    const operator = operatorMatch[1].toUpperCase();
    const id = Number(operatorMatch[2]);
    switch (operator) {
        case 'A':
            return { type: 'abortMission', id };
        case 'F':
            return { type: 'failMission', id };
        case 'S':
            return { type: 'startMission', id };
        case 'G':
            return { type: 'grantOutfit', id };
        case 'D':
            return { type: 'removeOutfit', id };
        case 'M':
            return { type: 'moveToSystem', id };
        case 'N':
            return { type: 'moveToSystemRelative', id };
        case 'C':
            return { type: 'changeShip', id, includeDefaults: false };
        case 'E':
            return { type: 'changeShip', id, includeDefaults: true };
        case 'H':
            return { type: 'changeShip', id, includeDefaults: true };
        case 'K':
            return { type: 'activateRank', id };
        case 'L':
            return { type: 'deactivateRank', id };
        case 'P':
            return { type: 'playSound', id };
        case 'Y':
            return { type: 'destroyStellar', id };
        case 'U':
            return { type: 'regenerateStellar', id };
        case 'Q':
            return { type: 'leaveStellar', id };
        case 'T':
            return { type: 'renameShip', id };
        case 'X':
            return { type: 'exploreSystem', id };
        default:
            return unknownOperation(token, options, offset);
    }
}

function findClosingParenthesis(source: string, opening: number) {
    let depth = 0;
    for (let index = opening; index < source.length; index++) {
        if (source[index] === '(') {
            depth++;
        } else if (source[index] === ')') {
            depth--;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
}

function splitTopLevelWhitespace(source: string): string[] {
    const result: string[] = [];
    let start = 0;
    let depth = 0;
    for (let index = 0; index <= source.length; index++) {
        const character = source[index];
        if (character === '(') {
            depth++;
        } else if (character === ')') {
            depth--;
        }
        if (index === source.length
            || (/\s/.test(character) && depth === 0)) {
            if (source.slice(start, index).trim()) {
                result.push(source.slice(start, index).trim());
            }
            start = index + 1;
        }
    }
    return result;
}

export function parseSetExpression(
    expression: string, options: NcbSetParseOptions = {},
): NcbOperation[] {
    const operations: NcbOperation[] = [];
    let index = 0;
    while (index < expression.length) {
        while (index < expression.length && /\s/.test(expression[index])) {
            index++;
        }
        if (index >= expression.length) {
            break;
        }

        const start = index;
        const operator = expression[index].toUpperCase();
        if (operator === 'R' && expression[index + 1] === '(') {
            const closing = findClosingParenthesis(expression, index + 1);
            if (closing < 0) {
                operations.push(unknownOperation(
                    expression.slice(start), options, start));
                break;
            }
            const inner = expression.slice(index + 2, closing);
            const choices = splitTopLevelWhitespace(inner);
            if (choices.length === 2) {
                operations.push({
                    type: 'randomChoice',
                    choices: choices.map(choice =>
                        parseSetExpression(choice, options)),
                });
            } else {
                operations.push(unknownOperation(
                    expression.slice(start, closing + 1), options, start));
            }
            index = closing + 1;
            continue;
        }

        while (index < expression.length
            && !/\s/.test(expression[index])
            && expression[index] !== '('
            && expression[index] !== ')') {
            index++;
        }
        if (index === start) {
            operations.push(unknownOperation(expression[index], options, index));
            index++;
            continue;
        }
        operations.push(parseSetToken(
            expression.slice(start, index), options, start));
    }
    return operations;
}

function writeBit(bits: MissionBits, bit: number, value: boolean) {
    if (bits instanceof Set) {
        if (value) {
            bits.add(bit);
        } else {
            bits.delete(bit);
        }
    } else {
        bits[bit] = value;
    }
}

function randomValue(random: () => number) {
    return Math.min(0.9999999999999999, Math.max(0, random()));
}

export function executeSetOperations(
    operations: readonly NcbOperation[],
    missionBits: MissionBits,
    options: NcbSetExecutionOptions = {},
): void {
    const random = options.random ?? Math.random;
    const logger = options.logger ?? console.warn;

    for (const operation of operations) {
        switch (operation.type) {
            case 'setBit':
                writeBit(missionBits, operation.bit, true);
                break;
            case 'clearBit':
                writeBit(missionBits, operation.bit, false);
                break;
            case 'toggleBit':
                writeBit(missionBits, operation.bit, !readBit(missionBits, operation.bit));
                break;
            case 'randomChance':
                // RNNN is treated as a gate for the remaining operations.
                if (randomValue(random) >= operation.percent / 100) {
                    return;
                }
                break;
            case 'randomChoice': {
                const choice = operation.choices[
                    Math.floor(randomValue(random) * operation.choices.length)];
                if (choice) {
                    executeSetOperations(choice, missionBits, options);
                }
                break;
            }
            case 'unknown':
                logger(`Cannot execute unknown NCB operation '${operation.raw}'`);
                break;
            default: {
                const handler = options.handlers?.[operation.type];
                if (handler) {
                    handler(operation);
                } else {
                    logger(`No handler registered for NCB operation '${operation.type}'`);
                }
                break;
            }
        }
    }
}

export function applySetExpression(
    expression: string,
    missionBits: MissionBits,
    options: NcbSetExecutionOptions = {},
): NcbOperation[] {
    const operations = parseSetExpression(expression, options);
    executeSetOperations(operations, missionBits, options);
    return operations;
}

