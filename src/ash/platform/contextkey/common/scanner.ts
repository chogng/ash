import { localize } from '../../../nls.js';

export const enum TokenType {
	LParen,
	RParen,
	Neg,
	Eq,
	NotEq,
	Lt,
	LtEq,
	Gt,
	GtEq,
	RegexOp,
	RegexStr,
	True,
	False,
	In,
	Not,
	And,
	Or,
	Str,
	QuotedStr,
	Error,
	EOF,
}

type TextTokenType = TokenType.Str | TokenType.QuotedStr | TokenType.RegexStr | TokenType.Error;
type EqualityTokenType = TokenType.Eq | TokenType.NotEq;

export type Token =
	| { readonly type: TextTokenType; readonly offset: number; readonly lexeme: string; }
	| { readonly type: EqualityTokenType; readonly offset: number; readonly isTripleEq: boolean; }
	| { readonly type: Exclude<TokenType, TextTokenType | EqualityTokenType>; readonly offset: number; };

export interface LexingError {
	readonly offset: number;
	readonly lexeme: string;
	readonly additionalInfo?: string;
}

const operators = new Map<string, TokenType>([
	['(', TokenType.LParen],
	[')', TokenType.RParen],
	['!', TokenType.Neg],
	['==', TokenType.Eq],
	['===', TokenType.Eq],
	['!=', TokenType.NotEq],
	['!==', TokenType.NotEq],
	['<', TokenType.Lt],
	['<=', TokenType.LtEq],
	['>', TokenType.Gt],
	['>=', TokenType.GtEq],
	['=~', TokenType.RegexOp],
	['&&', TokenType.And],
	['||', TokenType.Or],
]);
const keywords = new Map<string, TokenType>([
	['true', TokenType.True],
	['false', TokenType.False],
	['in', TokenType.In],
	['not', TokenType.Not],
]);

/** Converts when-clause text into tokens without evaluating context values. */
export class Scanner {
	private source = '';
	private diagnostics: LexingError[] = [];

	public get errors(): Readonly<LexingError[]> { return this.diagnostics; }

	public reset(value: string): this {
		this.source = value;
		this.diagnostics = [];
		return this;
	}

	public scan(): Token[] {
		this.diagnostics = [];
		const tokens: Token[] = [];
		const operatorPattern = /!==|===|!=|==|<=|>=|=~|&&|\|\||[()!<>]/uy;
		let offset = 0;
		while (offset < this.source.length) {
			const character = this.source[offset];
			if (/\s/u.test(character)) {
				offset++;
				continue;
			}
			const start = offset;
			operatorPattern.lastIndex = offset;
			const operator = operatorPattern.exec(this.source)?.[0];
			if (operator) {
				const type = operators.get(operator)!;
				tokens.push(type === TokenType.Eq || type === TokenType.NotEq
					? { type, offset, isTripleEq: operator.length === 3 }
					: { type: type as Exclude<TokenType, TextTokenType | EqualityTokenType>, offset });
				offset += operator.length;
				continue;
			}
			if (character === "'" || character === '"') {
				offset++;
				let value = '';
				while (offset < this.source.length && this.source[offset] !== character) {
					// Single-quoted values preserve regex and Windows path backslashes.
					// Double quotes retain Ash's existing escaped-string support.
					if (character === '"' && this.source[offset] === '\\' && offset + 1 < this.source.length) {
						offset++;
						const escaped = this.source[offset++];
						value += ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[escaped] ?? escaped;
					} else {
						value += this.source[offset++];
					}
				}
				if (offset === this.source.length) {
					tokens.push(this.error(start, offset, localize('contextkey.unterminatedString', 'Unterminated string.')));
				} else {
					tokens.push({ type: TokenType.QuotedStr, offset: start + 1, lexeme: value });
					offset++;
				}
				continue;
			}
			if (character === '/') {
				const end = regexEnd(this.source, offset);
				if (end === undefined) {
					offset = this.source.length;
					tokens.push(this.error(start, offset, localize('contextkey.unterminatedRegex', 'Unterminated regular expression.')));
				} else {
					offset = end;
					tokens.push({ type: TokenType.RegexStr, offset: start, lexeme: this.source.slice(start, offset) });
				}
				continue;
			}
			while (offset < this.source.length && isWordCharacter(this.source[offset])) {
				offset++;
			}
			if (offset === start) {
				offset++;
				tokens.push(this.error(start, offset, localize('contextkey.unexpectedToken', 'Unexpected token "{0}".', character)));
				continue;
			}
			const lexeme = this.source.slice(start, offset);
			const keyword = keywords.get(lexeme);
			tokens.push(keyword === undefined ? { type: TokenType.Str, offset: start, lexeme }
				: { type: keyword as TokenType.True | TokenType.False | TokenType.In | TokenType.Not, offset: start });
		}
		tokens.push({ type: TokenType.EOF, offset: this.source.length });
		return tokens;
	}

	public static getLexeme(token: Token): string {
		if ('lexeme' in token) {
			return token.lexeme;
		}
		if (token.type === TokenType.Eq || token.type === TokenType.NotEq) {
			return (token.type === TokenType.Eq ? '==' : '!=') + (token.isTripleEq ? '=' : '');
		}
		for (const [text, type] of [...operators, ...keywords]) {
			if (type === token.type) {
				return text;
			}
		}
		return 'EOF';
	}

	private error(start: number, end: number, additionalInfo: string): Token {
		const lexeme = this.source.slice(start, end);
		this.diagnostics.push({ offset: start, lexeme, additionalInfo });
		return { type: TokenType.Error, offset: start, lexeme };
	}
}

function isWordCharacter(character: string): boolean {
	return /[\p{L}\p{N}_]/u.test(character) || '.-:/\\*?+[]^,#@;"%$<>'.includes(character);
}

function regexEnd(source: string, start: number): number | undefined {
	let inClass = false;
	for (let offset = start + 1; offset < source.length; offset++) {
		const character = source[offset];
		if (character === '\\') {
			offset++;
			continue;
		}
		if (character === '[') {
			inClass = true;
		} else if (character === ']') {
			inClass = false;
		} else if (character === '/' && !inClass) {
			offset++;
			while (offset < source.length && /[a-z]/iu.test(source[offset])) {
				offset++;
			}
			return offset;
		}
	}
	return undefined;
}
