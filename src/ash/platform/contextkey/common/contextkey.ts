import type { Event } from "../../../base/common/event.js";
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { localize } from '../../../nls.js';
import { isWindows } from '../../../base/common/platform.js';
import { extUriIgnorePathCase } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { Schemas } from '../../../base/common/network.js';
import { Scanner, TokenType, type Token, type LexingError } from './scanner.js';

export const IContextKeyService = createDecorator<IContextKeyService>('contextKeyService');

export type ContextKeyValue = boolean | string | number | null | undefined | readonly unknown[] | Readonly<Record<string, unknown>>;

/** Read-only values used to evaluate action and keybinding conditions. */
export interface Context {
	getValue<T extends ContextKeyValue>(key: string): T | undefined;
}

/** A composable condition evaluated against the current context keys. */
export interface ContextKeyExpression {
	evaluate(context: Context): boolean;
	keys(): ReadonlySet<string>;
}

export interface ContextKeyChangeEvent {
	readonly keys: ReadonlySet<string>;
	affectsSome(keys: ReadonlySet<string>): boolean;
}

/**
 * A typed handle bound to one context key service.
 *
 * Components set values while they own the state and call `reset` when the
 * state returns to its declared default.
 */
export interface IContextKey<T extends ContextKeyValue> {
	set(value: T): void;
	reset(): void;
	get(): T | undefined;
}

/** Evaluates and publishes context values for one context. */
export interface IContextKeyService extends Context {
	readonly onDidChangeContext: Event<ContextKeyChangeEvent>;

	contextMatchesRules(
		expression: ContextKeyExpression | undefined,
	): boolean;
	createKey<T extends ContextKeyValue>(
		key: string,
		defaultValue: T,
	): IContextKey<T>;
	getContext(): Context;
	bufferChangeEvents(callback: () => void): void;
	setContext(key: string, value: ContextKeyValue): void;
	removeContext(key: string): void;
}

/**
 * Declares one context key and its default independently of a concrete scope.
 */
export class RawContextKey<T extends ContextKeyValue> {
	constructor(
		readonly key: string,
		readonly defaultValue: T,
	) {
		if (!key) throw new TypeError("Context key must not be empty");
	}

	bindTo(service: IContextKeyService): IContextKey<T> {
		return service.createKey(this.key, this.defaultValue);
	}

	isEqualTo(value: T): ContextKeyExpression {
		return ContextKeyExpr.equals(this.key, value);
	}
}

class Expression implements ContextKeyExpression {
	constructor(
		readonly evaluate: (context: Context) => boolean,
		readonly keys: () => ReadonlySet<string>,
	) { }
}

/** Factory functions for context expressions used by contributions. */
export const ContextKeyExpr = {
	deserialize(source: string | null | undefined): ContextKeyExpression | undefined {
		return source == null ? undefined : new Parser().parse(source);
	},

	true(): ContextKeyExpression {
		return new Expression(() => true, () => new Set());
	},

	false(): ContextKeyExpression {
		return new Expression(() => false, () => new Set());
	},

	has(key: string): ContextKeyExpression {
		return new Expression(
			(context) => Boolean(context.getValue(key)),
			() => new Set([key]),
		);
	},

	not(key: string): ContextKeyExpression {
		return new Expression(
			(context) => !context.getValue(key),
			() => new Set([key]),
		);
	},

	equals(key: string, value: ContextKeyValue): ContextKeyExpression {
		if (typeof value === 'boolean') {
			return value ? this.has(key) : this.not(key);
		}
		return new Expression(
			// When clauses compare numeric text and numeric context values equivalently.
			(context) => context.getValue(key) == value,
			() => new Set([key]),
		);
	},

	notEquals(key: string, value: ContextKeyValue): ContextKeyExpression {
		const expression = this.equals(key, value);
		return new Expression(
			(context) => !expression.evaluate(context),
			() => new Set([key]),
		);
	},

	regex(key: string, value: RegExp): ContextKeyExpression {
		// Global and sticky flags carry mutable match state across evaluations.
		const regexp = new RegExp(value.source, value.flags.replace(/[gy]/gu, ''));
		return new Expression(context => regexp.test(String(context.getValue(key))), () => new Set([key]));
	},

	in(key: string, valueKey: string): ContextKeyExpression {
		return new Expression(context => {
			const value = context.getValue(key);
			const collection = context.getValue(valueKey);
			if (Array.isArray(collection)) {
				return collection.some(candidate => membershipValueEquals(value, candidate));
			}
			if (collection === null || typeof collection !== 'object' || typeof value !== 'string') {
				return false;
			}
			return Object.keys(collection).some(candidate => membershipValueEquals(value, candidate));
		}, () => new Set([key, valueKey]));
	},

	notIn(key: string, valueKey: string): ContextKeyExpression {
		const expression = this.in(key, valueKey);
		return new Expression(context => !expression.evaluate(context), () => expression.keys());
	},

	greater(key: string, value: number | string): ContextKeyExpression {
		return numericComparison(key, value, (left, right) => left > right);
	},

	greaterEquals(key: string, value: number | string): ContextKeyExpression {
		return numericComparison(key, value, (left, right) => left >= right);
	},

	smaller(key: string, value: number | string): ContextKeyExpression {
		return numericComparison(key, value, (left, right) => left < right);
	},

	smallerEquals(key: string, value: number | string): ContextKeyExpression {
		return numericComparison(key, value, (left, right) => left <= right);
	},

	and(
		...expressions: readonly (ContextKeyExpression | undefined)[]
	): ContextKeyExpression | undefined {
		const defined = expressions.filter(
			(expression): expression is ContextKeyExpression => Boolean(expression),
		);
		if (defined.length === 0) return undefined;
		return combineExpressions(
			defined,
			(context) => defined.every((expression) => expression.evaluate(context)),
		);
	},

	or(
		...expressions: readonly (ContextKeyExpression | undefined)[]
	): ContextKeyExpression | undefined {
		const defined = expressions.filter(
			(expression): expression is ContextKeyExpression => Boolean(expression),
		);
		if (defined.length === 0) return undefined;
		return combineExpressions(
			defined,
			(context) => defined.some((expression) => expression.evaluate(context)),
		);
	},
};

function combineExpressions(
	expressions: readonly ContextKeyExpression[],
	evaluate: (context: Context) => boolean,
): ContextKeyExpression {
	const keys = new Set<string>();
	for (const expression of expressions) {
		for (const key of expression.keys()) keys.add(key);
	}
	return new Expression(evaluate, () => keys);
}

function membershipValueEquals(value: ContextKeyValue, candidate: unknown): boolean {
	if (value === candidate) {
		return true;
	}
	if (!isWindows || typeof value !== 'string' || typeof candidate !== 'string'
		|| !value.startsWith(`${Schemas.file}:`) || !candidate.startsWith(`${Schemas.file}:`)) {
		return false;
	}
	return extUriIgnorePathCase.isEqual(URI.parse(value), URI.parse(candidate));
}

function numericComparison(key: string, value: number | string, compare: (left: number, right: number) => boolean): ContextKeyExpression {
	const right = parseFloat(String(value));
	return new Expression(context => {
		const left = context.getValue(key);
		return (typeof left === 'number' || typeof left === 'string') && compare(parseFloat(String(left)), right);
	}, () => new Set([key]));
}

export interface ParsingError {
	readonly message: string;
	readonly offset: number;
	readonly lexeme: string;
	readonly additionalInfo?: string;
}

const parseFailure = Symbol('contextKeyParseFailure');

/** Parses when clauses and retains diagnostics for configuration boundaries. */
export class Parser {
	private readonly scanner = new Scanner();
	private tokens: readonly Token[] = [];
	private position = 0;
	private diagnostics: ParsingError[] = [];

	public get lexingErrors(): Readonly<LexingError[]> { return this.scanner.errors; }
	public get parsingErrors(): Readonly<ParsingError[]> { return this.diagnostics; }

	public parse(source: string): ContextKeyExpression | undefined {
		this.position = 0;
		this.diagnostics = [];
		this.tokens = this.scanner.reset(source).scan();
		if (this.lexingErrors.length > 0) {
			this.tokens = [];
			return undefined;
		}
		try {
			if (!source.trim()) {
				this.fail(this.current(), localize('contextkey.emptyExpression', 'Context key expression must not be empty.'));
			}
			const expression = this.parseOr();
			this.expect(TokenType.EOF);
			return expression;
		} catch (error) {
			if (error !== parseFailure) {
				throw error;
			}
			return undefined;
		} finally {
			// Reusable parsers retain diagnostics, never the previous resource's tokens.
			this.tokens = [];
		}
	}

	private parseOr(): ContextKeyExpression {
		const expressions = [this.parseAnd()];
		while (this.match(TokenType.Or)) {
			expressions.push(this.parseAnd());
		}
		return ContextKeyExpr.or(...expressions)!;
	}

	private parseAnd(): ContextKeyExpression {
		const expressions = [this.parseUnary()];
		while (this.match(TokenType.And)) {
			expressions.push(this.parseUnary());
		}
		return ContextKeyExpr.and(...expressions)!;
	}

	private parseUnary(): ContextKeyExpression {
		if (this.match(TokenType.Neg)) {
			const token = this.current();
			if (token.type === TokenType.Str) {
				this.position++;
				return ContextKeyExpr.not(token.lexeme);
			}
			if (token.type !== TokenType.LParen && token.type !== TokenType.True && token.type !== TokenType.False) {
				return this.fail(token, localize('contextkey.expectedKey', 'Expected a context key, received "{0}".', Scanner.getLexeme(token)));
			}
			const operand = this.parseUnary();
			return new Expression(context => !operand.evaluate(context), () => operand.keys());
		}
		if (this.match(TokenType.LParen)) {
			const expression = this.parseOr();
			this.expect(TokenType.RParen);
			return expression;
		}
		if (this.match(TokenType.True)) {
			return ContextKeyExpr.true();
		}
		if (this.match(TokenType.False)) {
			return ContextKeyExpr.false();
		}
		const key = this.expect(TokenType.Str).lexeme;
		const operator = this.current().type;
		if (![TokenType.Eq, TokenType.NotEq, TokenType.RegexOp, TokenType.In, TokenType.Not, TokenType.Gt, TokenType.GtEq, TokenType.Lt, TokenType.LtEq].includes(operator)) {
			return ContextKeyExpr.has(key);
		}
		this.position++;
		if (operator === TokenType.RegexOp) {
			return this.parseRegex(key);
		}
		if (operator === TokenType.Not) {
			this.expect(TokenType.In);
		}
		const value = this.comparisonValue();
		switch (operator) {
			case TokenType.Eq: return ContextKeyExpr.equals(key, value);
			case TokenType.NotEq: return ContextKeyExpr.notEquals(key, value);
			case TokenType.In: return ContextKeyExpr.in(key, String(value));
			case TokenType.Not: return ContextKeyExpr.notIn(key, String(value));
			case TokenType.Gt: return ContextKeyExpr.greater(key, String(value));
			case TokenType.GtEq: return ContextKeyExpr.greaterEquals(key, String(value));
			case TokenType.Lt: return ContextKeyExpr.smaller(key, String(value));
			case TokenType.LtEq: return ContextKeyExpr.smallerEquals(key, String(value));
			default: return this.fail(this.current(), localize('contextkey.unexpectedToken', 'Unexpected token "{0}".', Scanner.getLexeme(this.current())));
		}
	}

	private parseRegex(key: string): ContextKeyExpression {
		const token = this.current();
		if (token.type !== TokenType.RegexStr && token.type !== TokenType.QuotedStr) {
			return this.fail(token, localize('contextkey.invalidRegex', 'Invalid regular expression.'));
		}
		this.position++;
		const closingSlash = token.lexeme.lastIndexOf('/');
		if (!token.lexeme.startsWith('/') || closingSlash === 0) {
			return this.fail(token, localize('contextkey.invalidRegex', 'Invalid regular expression.'));
		}
		try {
			return ContextKeyExpr.regex(key, new RegExp(token.lexeme.slice(1, closingSlash), token.lexeme.slice(closingSlash + 1)));
		} catch (error) {
			if (!(error instanceof SyntaxError)) {
				throw error;
			}
			return this.fail(token, localize('contextkey.invalidRegex', 'Invalid regular expression.'));
		}
	}

	private comparisonValue(): string | boolean {
		const token = this.current();
		switch (token.type) {
			case TokenType.EOF: return '';
			case TokenType.True: this.position++; return true;
			case TokenType.False: this.position++; return false;
			case TokenType.Str:
			case TokenType.QuotedStr: this.position++; return token.lexeme;
			case TokenType.In: this.position++; return 'in';
			default: return this.fail(token, localize('contextkey.expectedValue', 'Expected a comparison value, received "{0}".', Scanner.getLexeme(token)));
		}
	}

	private current(): Token { return this.tokens[this.position]; }

	private match(type: TokenType): boolean {
		if (this.current().type !== type) {
			return false;
		}
		this.position++;
		return true;
	}

	private expect<T extends TokenType>(type: T): Token & { type: T; } {
		const token = this.current();
		if (!this.match(type)) {
			const lexeme = Scanner.getLexeme(token);
			const message = type === TokenType.Str
				? localize('contextkey.expectedKey', 'Expected a context key, received "{0}".', lexeme)
				: localize('contextkey.expectedToken', 'Expected "{0}", received "{1}".', Scanner.getLexeme({ type } as Token), lexeme);
			this.fail(token, message);
		}
		return token as Token & { type: T; };
	}

	private fail(token: Token, message: string): never {
		this.diagnostics.push({ message, offset: token.offset, lexeme: Scanner.getLexeme(token) });
		throw parseFailure;
	}
}
