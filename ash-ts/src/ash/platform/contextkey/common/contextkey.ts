import type { Event } from "../../../base/common/event.js";

export type ContextKeyValue = boolean | string | number | null | undefined;

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
	) {}
}

/** Factory functions for context expressions used by contributions. */
export const ContextKeyExpr = {
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
		return new Expression(
			(context) => Object.is(context.getValue(key), value),
			() => new Set([key]),
		);
	},

	notEquals(key: string, value: ContextKeyValue): ContextKeyExpression {
		return new Expression(
			(context) => !Object.is(context.getValue(key), value),
			() => new Set([key]),
		);
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
