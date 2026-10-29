import { isRecord } from '../../../../../base/common/types.js';
import { isUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import type { DesignVariable, DesignVariableType } from './designResources.js';

export type PrototypeValue = string | number | boolean;
type Operator = '+' | '-' | '*' | '/' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or';
export type PrototypeExpression =
	| { readonly kind: 'literal'; readonly value: PrototypeValue; }
	| { readonly kind: 'variable'; readonly id: string; }
	| { readonly kind: 'unary'; readonly operator: '-' | 'not'; readonly operand: PrototypeExpression; }
	| { readonly kind: 'binary'; readonly operator: Operator; readonly left: PrototypeExpression; readonly right: PrototypeExpression; };
const precedence: Record<Operator, number> = { or: 1, and: 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6 };
function invalid(): never { throw new TypeError(localize('sessions.design.prototype.invalidExpression', 'Enter a valid expression with compatible values and operators.')); }

/** Persist identities, not variable names. Neither imported expressions nor typed input execute JavaScript. */
export function readPrototypeExpression(value: unknown): PrototypeExpression {
	let count = 0;
	const visit = (raw: unknown, depth: number): PrototypeExpression => {
		if (!isRecord(raw) || ++count > 256 || depth > 32) { return invalid(); }
		const only = (keys: readonly string[]): boolean => Object.keys(raw).every(key => keys.includes(key));
		if (raw.kind === 'literal' && only(['kind', 'value']) && (typeof raw.value === 'boolean' || typeof raw.value === 'number' && Number.isFinite(raw.value) || typeof raw.value === 'string' && raw.value.length <= 4096)) { return { kind: 'literal', value: raw.value as PrototypeValue }; }
		if (raw.kind === 'variable' && only(['kind', 'id']) && isUuid(raw.id)) { return { kind: 'variable', id: raw.id }; }
		if (raw.kind === 'unary' && only(['kind', 'operator', 'operand']) && (raw.operator === '-' || raw.operator === 'not')) { return { kind: 'unary', operator: raw.operator, operand: visit(raw.operand, depth + 1) }; }
		if (raw.kind === 'binary' && only(['kind', 'operator', 'left', 'right']) && typeof raw.operator === 'string' && Object.hasOwn(precedence, raw.operator)) { return { kind: 'binary', operator: raw.operator as Operator, left: visit(raw.left, depth + 1), right: visit(raw.right, depth + 1) }; }
		return invalid();
	};
	return visit(value, 0);
}

/** Missing library variables are unresolved; known type errors are rejected at the input boundary. */
export function prototypeExpressionType(expression: PrototypeExpression, variables: readonly DesignVariable[]): DesignVariableType | undefined {
	if (expression.kind === 'literal') { return typeof expression.value as 'string' | 'number' | 'boolean'; }
	if (expression.kind === 'variable') { return variables.find(variable => variable.id === expression.id)?.type; }
	if (expression.kind === 'unary') { const type = prototypeExpressionType(expression.operand, variables); const expected = expression.operator === 'not' ? 'boolean' : 'number'; if (type && type !== expected) { invalid(); } return expected; }
	const a = prototypeExpressionType(expression.left, variables), b = prototypeExpressionType(expression.right, variables);
	const requireTypes = (allowed: readonly DesignVariableType[]): void => { if (a && !allowed.includes(a) || b && !allowed.includes(b)) { invalid(); } };
	if (expression.operator === 'and' || expression.operator === 'or') { requireTypes(['boolean']); return 'boolean'; }
	if (expression.operator === '==' || expression.operator === '!=') { if (a && b && a !== b) { invalid(); } return 'boolean'; }
	if (['<', '<=', '>', '>='].includes(expression.operator)) { requireTypes(['number']); return 'boolean'; }
	if (expression.operator === '+') { requireTypes(['number', 'string']); return a === 'string' || b === 'string' ? 'string' : a && b ? 'number' : undefined; }
	requireTypes(['number']); return 'number';
}

/** Undefined propagates rather than coercing missing variables, division by zero, or invalid operands. */
export function evaluatePrototypeExpression(expression: PrototypeExpression, resolve: (id: string) => PrototypeValue | undefined): PrototypeValue | undefined {
	if (expression.kind === 'literal') { return expression.value; }
	if (expression.kind === 'variable') { return resolve(expression.id); }
	if (expression.kind === 'unary') { const value = evaluatePrototypeExpression(expression.operand, resolve); return expression.operator === 'not' ? typeof value === 'boolean' ? !value : undefined : typeof value === 'number' ? -value : undefined; }
	const a = evaluatePrototypeExpression(expression.left, resolve);
	if (a === undefined) { return undefined; }
	if (expression.operator === 'and' && a === false) { return false; }
	if (expression.operator === 'or' && a === true) { return true; }
	const b = evaluatePrototypeExpression(expression.right, resolve);
	if (b === undefined) { return undefined; }
	if (expression.operator === 'and' || expression.operator === 'or') { return typeof a === 'boolean' && typeof b === 'boolean' ? expression.operator === 'and' ? a && b : a || b : undefined; }
	if (expression.operator === '==' || expression.operator === '!=') { return typeof a === typeof b ? expression.operator === '==' ? a === b : a !== b : undefined; }
	if (expression.operator === '+' && (typeof a === 'string' || typeof b === 'string') && typeof a !== 'boolean' && typeof b !== 'boolean') { const value = `${a}${b}`; return value.length <= 4096 ? value : undefined; }
	if (typeof a !== 'number' || typeof b !== 'number') { return undefined; }
	switch (expression.operator) {
		case '<': return a < b;
		case '<=': return a <= b;
		case '>': return a > b;
		case '>=': return a >= b;
		default: { const value = expression.operator === '+' ? a + b : expression.operator === '-' ? a - b : expression.operator === '*' ? a * b : a / b; return Number.isFinite(value) ? value : undefined; }
	}
}

/** Names with spaces or punctuation use backticks; duplicate names require a variable ID token. */
export function formatPrototypeExpression(expression: PrototypeExpression, variables: readonly DesignVariable[]): string {
	if (expression.kind === 'literal') { return JSON.stringify(expression.value); }
	if (expression.kind === 'variable') {
		const variable = variables.find(variable => variable.id === expression.id);
		if (!variable || variables.filter(item => item.name === variable.name).length !== 1) { return `@{${expression.id}}`; }
		return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(variable.name) && !['true', 'false', 'and', 'or', 'not'].includes(variable.name) ? variable.name : '`' + variable.name.replace(/[`\\]/gu, '\\$&') + '`';
	}
	if (expression.kind === 'unary') { return `${expression.operator} (${formatPrototypeExpression(expression.operand, variables)})`; }
	return `(${formatPrototypeExpression(expression.left, variables)} ${expression.operator} ${formatPrototypeExpression(expression.right, variables)})`;
}

export function parsePrototypeExpression(text: string, variables: readonly DesignVariable[]): PrototypeExpression {
	if (!text.trim() || text.length > 8192) { invalid(); }
	const tokens: string[] = [];
	let position = 0;
	const token = /\s*("(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|@\{[\da-f-]+\}|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[\p{L}_][\p{L}\p{N}_]*|==|!=|<=|>=|[()+\-*/<>!])/uy;
	while (position < text.trimEnd().length) { token.lastIndex = position; const match = token.exec(text); if (!match || tokens.length >= 1024) { invalid(); } tokens.push(match![1]); position = token.lastIndex; }
	let index = 0, depth = 0;
	const expression = (minimum: number): PrototypeExpression => {
		if (++depth > 32) { invalid(); }
		const current = tokens[index++];
		let left: PrototypeExpression;
		if (current === '(') { left = expression(0); if (tokens[index++] !== ')') { invalid(); } }
		else if (current === '-' || current === 'not' || current === '!') { left = { kind: 'unary', operator: current === '-' ? '-' : 'not', operand: expression(7) }; }
		else if (current?.startsWith('"')) { try { left = { kind: 'literal', value: JSON.parse(current) as string }; } catch { return invalid(); } }
		else if (current === 'true' || current === 'false') { left = { kind: 'literal', value: current === 'true' }; }
		else if (/^(?:\d|\.)/u.test(current ?? '')) { const value = Number(current); if (!Number.isFinite(value)) { invalid(); } left = { kind: 'literal', value }; }
		else {
			const name = current?.startsWith('`') ? current.slice(1, -1).replace(/\\([`\\])/gu, '$1') : current;
			const matches = current?.startsWith('@{') ? variables.filter(variable => variable.id === current.slice(2, -1)) : variables.filter(variable => variable.name === name);
			if (matches.length !== 1) { return invalid(); }
			left = { kind: 'variable', id: matches[0].id };
		}
		while (Object.hasOwn(precedence, tokens[index] ?? '') && precedence[tokens[index] as Operator] >= minimum) { const operator = tokens[index++] as Operator; left = { kind: 'binary', operator, left, right: expression(precedence[operator] + 1) }; }
		depth--; return left;
	};
	const result = readPrototypeExpression(expression(0));
	if (index !== tokens.length) { invalid(); }
	prototypeExpressionType(result, variables);
	return result;
}
