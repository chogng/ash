import { escapeRegExpCharacters } from '../../../../base/common/strings.js';
import type { IMonarchLanguageAction, IMonarchLanguageBracket } from './monarchTypes.js';

export interface ILexerMin {
	languageId: string;
	includeLF: boolean;
	ignoreCase: boolean;
	unicode: boolean;
	defaultToken: string;
	[attribute: string]: any;
}

export interface ILexer extends ILexerMin {
	start: string;
	maxStack: number;
	tokenPostfix: string;
	tokenizer: { [name: string]: IRule[] };
	brackets: IMonarchLanguageBracket[];
}

export interface IRule {
	action: IMonarchLanguageAction;
	name: string;
	resolveRegex(state: string): RegExp;
}

export function createError(lexer: ILexerMin, message: string): Error {
	return new Error(`${lexer.languageId}: ${message}`);
}

export function findRules(lexer: ILexer, state: string): IRule[] | null {
	let name = state;
	for (;;) {
		if (Object.hasOwn(lexer.tokenizer, name)) {
			return lexer.tokenizer[name]!;
		}
		const separator = name.lastIndexOf('.');
		if (separator < 0) {
			return null;
		}
		name = name.slice(0, separator);
	}
}

export function substituteMatches(lexer: ILexerMin, value: string, id: string, matches: string[], state: string): string {
	const parts = state.split('.');
	return value.replace(/\$(\$|#|[sS]\d+|\d+|@[\w]+)/g, (_, reference: string) => {
		if (reference === '$') {
			return '$';
		}
		if (reference === '#') {
			return id;
		}
		if (/^[sS]/.test(reference)) {
			const index = Number(reference.slice(1));
			return index === 0 ? state : parts[index - 1] ?? '';
		}
		if (reference.startsWith('@')) {
			return String(lexer[reference.slice(1)] ?? '');
		}
		return matches[Number(reference)] ?? '';
	});
}

export function substituteMatchesRe(_lexer: ILexerMin, value: string, state: string): string {
	const parts = state.split('.');
	return value.replace(/\$[sS](\d+)/g, (_, rawIndex: string) => {
		const index = Number(rawIndex);
		return escapeRegExpCharacters(index === 0 ? state : parts[index - 1] ?? '');
	});
}
