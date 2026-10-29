import { createError, findRules, substituteMatchesRe, type ILexer, type IRule } from './monarchCommon.js';
import type { IExpandedMonarchLanguageAction, IMonarchLanguage, IMonarchLanguageAction } from './monarchTypes.js';

export function compile(languageId: string, definition: IMonarchLanguage): ILexer {
	if (!definition || typeof definition.tokenizer !== 'object' || definition.tokenizer === null) {
		throw new TypeError(`${languageId}: tokenizer states are required`);
	}
	const states = Object.keys(definition.tokenizer);
	if (states.length === 0) {
		throw new TypeError(`${languageId}: at least one tokenizer state is required`);
	}
	const lexer: ILexer = {
		...definition,
		languageId,
		includeLF: definition.includeLF ?? false,
		ignoreCase: definition.ignoreCase ?? false,
		unicode: definition.unicode ?? false,
		defaultToken: definition.defaultToken ?? 'source',
		start: definition.start ?? states[0]!,
		maxStack: 100,
		tokenPostfix: definition.tokenPostfix ?? `.${languageId}`,
		tokenizer: Object.create(null) as Record<string, IRule[]>,
		brackets: (definition.brackets ?? [
			{ open: '{', close: '}', token: 'delimiter.curly' },
			{ open: '[', close: ']', token: 'delimiter.square' },
			{ open: '(', close: ')', token: 'delimiter.parenthesis' },
			{ open: '<', close: '>', token: 'delimiter.angle' },
		]).map(bracket => ({ ...bracket })),
	};
	for (const [key, value] of Object.entries(definition)) {
		if (Array.isArray(value) && key !== 'brackets') {
			lexer[key] = value.slice();
		}
	}
	const compiling = new Set<string>();
	const compileState = (name: string): IRule[] => {
		if (Object.hasOwn(lexer.tokenizer, name)) {
			return lexer.tokenizer[name]!;
		}
		if (compiling.has(name)) {
			throw createError(lexer, `Cyclic tokenizer include: ${name}`);
		}
		if (!Object.hasOwn(definition.tokenizer, name) || !Array.isArray(definition.tokenizer[name])) {
			throw createError(lexer, `Unknown tokenizer state: ${name}`);
		}
		compiling.add(name);
		const rules: IRule[] = [];
		for (const input of definition.tokenizer[name]!) {
			if (!Array.isArray(input) && input.include !== undefined) {
				rules.push(...compileState(input.include.replace(/^@/, '')));
				continue;
			}
			const expression = Array.isArray(input) ? input[0] : input.regex;
			const inputAction = Array.isArray(input) ? input[1] : input.action;
			if (!(expression instanceof RegExp) && typeof expression !== 'string') {
				throw createError(lexer, `A regex is required in state ${name}`);
			}
			if (inputAction === undefined) {
				throw createError(lexer, `An action is required in state ${name}`);
			}
			let action = copyAction(lexer, inputAction);
			if (Array.isArray(input) && input.length === 3) {
				if (Array.isArray(action)) {
					action = { group: action, next: input[2] };
				} else {
					action = { ...(typeof action === 'string' ? { token: action } : action), next: input[2] };
				}
			}
			const source = expandMacros(lexer, expression instanceof RegExp ? expression.source : expression, []);
			const flags = `dy${lexer.ignoreCase ? 'i' : ''}${lexer.unicode ? 'u' : ''}`;
			let pattern: string | undefined;
			let regex: RegExp;
			const resolveRegex = (state: string): RegExp => {
				const resolved = substituteMatchesRe(lexer, source, state);
				if (pattern !== resolved) {
					regex = new RegExp(resolved, flags);
					pattern = resolved;
				}
				return regex;
			};
			resolveRegex(name);
			rules.push({ name: `${name}:${rules.length}`, action, resolveRegex });
		}
		compiling.delete(name);
		lexer.tokenizer[name] = rules;
		return rules;
	};
	for (const state of states) {
		compileState(state);
	}
	if (!findRules(lexer, lexer.start)) {
		throw createError(lexer, `Unknown initial state: ${lexer.start}`);
	}
	return lexer;
}

function expandMacros(lexer: ILexer, expression: string, visited: string[]): string {
	return expression.replace(/@@|@([\w]+)/g, (match, name: string | undefined) => {
		if (name === undefined) {
			return '@';
		}
		if (!Object.hasOwn(lexer, name)) {
			return match;
		}
		if (visited.includes(name)) {
			throw createError(lexer, `Cyclic regex attribute: ${[...visited, name].join(' → ')}`);
		}
		const value: unknown = lexer[name];
		if (typeof value !== 'string' && !(value instanceof RegExp)) {
			throw createError(lexer, `Regex attribute ${name} must be a string or RegExp`);
		}
		return `(?:${expandMacros(lexer, typeof value === 'string' ? value : value.source, [...visited, name])})`;
	});
}

function copyAction(lexer: ILexer, action: IMonarchLanguageAction): IMonarchLanguageAction {
	if (typeof action === 'string') {
		return action;
	}
	if (Array.isArray(action)) {
		return action.map(item => copyAction(lexer, item)) as (string | IExpandedMonarchLanguageAction)[];
	}
	if (!action || typeof action !== 'object') {
		throw createError(lexer, 'Token actions must be strings, objects or capture groups');
	}
	if (action.goBack !== undefined && (!Number.isSafeInteger(action.goBack) || action.goBack < 0)) {
		throw createError(lexer, 'goBack must be a non-negative integer');
	}
	return {
		...action,
		group: action.group?.map(item => copyAction(lexer, item)),
		cases: action.cases && Object.fromEntries(Object.entries(action.cases).map(([guard, value]) => [guard, copyAction(lexer, value)])),
	};
}
