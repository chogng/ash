import { Disposable } from '../../../../base/common/lifecycle.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { MetadataConsts } from '../../../common/encodedTokenAttributes.js';
import { TokenizationRegistry, type EncodedTokenizationResult, type IState, type ITokenizationSupport, type Token, type TokenizationResult } from '../../../common/languages.js';
import { ILanguageService } from '../../../common/languages/language.js';
import { IStandaloneThemeService } from '../standaloneTheme.js';
import { createError, findRules, substituteMatches, type ILexer, type IRule } from './monarchCommon.js';
import type { IExpandedMonarchLanguageAction, IMonarchLanguageAction } from './monarchTypes.js';

interface EmbeddedState {
	readonly languageId: string;
	readonly state: IState | null;
}

class LineState implements IState {
	constructor(public readonly stack: readonly string[], public readonly embedded: EmbeddedState | null) {}

	public clone(): IState {
		return new LineState(this.stack.slice(), this.embedded && { ...this.embedded, state: this.embedded.state?.clone() ?? null });
	}

	public equals(other: IState): boolean {
		if (!(other instanceof LineState) || this.stack.length !== other.stack.length || this.stack.some((state, index) => state !== other.stack[index])) {
			return false;
		}
		if (!this.embedded || !other.embedded) {
			return this.embedded === other.embedded;
		}
		return this.embedded.languageId === other.embedded.languageId && (
			this.embedded.state === other.embedded.state || !!this.embedded.state?.equals(other.embedded.state!)
		);
	}
}

export type ILoadStatus = { loaded: true } | { loaded: false; promise: Promise<void> };

export class MonarchTokenizer extends Disposable implements ITokenizationSupport {
	private readonly embeddedLanguages = new Set<string>();
	private readonly loading = new Map<string, Promise<void>>();
	private notifying = false;

	constructor(
		private readonly languageId: string,
		private readonly lexer: ILexer,
		@ILanguageService private readonly languageService: ILanguageService,
		@IStandaloneThemeService private readonly themes: IStandaloneThemeService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		this._register(TokenizationRegistry.onDidChange(event => {
			if (this.notifying || event.changedLanguages.includes(languageId) || !event.changedLanguages.some(language => this.embeddedLanguages.has(language))) {
				return;
			}
			this.notifying = true;
			try {
				TokenizationRegistry.handleChange([languageId]);
			} finally {
				this.notifying = false;
			}
		}));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('editor.maxTokenizationLineLength', { overrideIdentifier: languageId })) {
				TokenizationRegistry.handleChange([languageId]);
			}
		}));
	}

	public get embeddedLoaded(): Promise<void> {
		return Promise.all(this.loading.values()).then(() => undefined);
	}

	public getLoadStatus(): ILoadStatus {
		return this.loading.size === 0 ? { loaded: true } : { loaded: false, promise: this.embeddedLoaded };
	}

	public getInitialState(): IState {
		return new LineState([this.lexer.start], null);
	}

	public tokenize(line: string, hasEOL: boolean, state: IState): TokenizationResult {
		const result = this.scan(line, hasEOL, state, false);
		return { tokens: result.tokens, endState: result.endState };
	}

	public tokenizeEncoded(line: string, hasEOL: boolean, state: IState): EncodedTokenizationResult {
		const result = this.scan(line, hasEOL, state, true);
		return { tokens: new Uint32Array(result.encoded), rawTokens: result.tokens, endState: result.endState };
	}

	private scan(line: string, hasEOL: boolean, initial: IState, encoded: boolean): { tokens: Token[]; encoded: number[]; endState: LineState } {
		this.assertNotDisposed();
		if (!(initial instanceof LineState)) {
			throw createError(this.lexer, 'Tokenization state belongs to another tokenizer');
		}
		const tokens: Token[] = [];
		const metadata: number[] = [];
		const theme = this.themes.getColorTheme().tokenTheme;
		const emitMetadata = (offset: number, value: number): void => {
			if (offset >= line.length || metadata[metadata.length - 1] === value) {
				return;
			}
			metadata.push(offset, value);
		};
		const emitRaw = (offset: number, type: string, language: string): void => {
			if (offset >= line.length) {
				return;
			}
			const previous = tokens[tokens.length - 1];
			if (!previous || previous.type !== type || previous.language !== language) {
				tokens.push({ offset, type, language });
			}
		};
		const emit = (offset: number, type: string, language = this.languageId): void => {
			emitRaw(offset, type, language);
			if (encoded) {
				emitMetadata(offset, theme.match(this.languageService.languageIdCodec.encodeLanguageId(language), type) | MetadataConsts.BALANCED_BRACKETS_MASK);
			}
		};
		const limit = this.configuration.getValue<number>('editor.maxTokenizationLineLength', { overrideIdentifier: this.languageId });
		if (line.length >= limit) {
			emit(0, '');
			return { tokens, encoded: metadata, endState: initial };
		}
		const stack = initial.stack.slice();
		let embedded = initial.embedded && { ...initial.embedded, state: initial.embedded.state?.clone() ?? null };
		const text = this.lexer.includeLF && hasEOL ? `${line}\n` : line;
		const visited = new Set<string>();
		let offset = 0;
		while (offset <= text.length) {
			const state = stack[stack.length - 1]!;
			const rules = findRules(this.lexer, state);
			if (!rules) {
				throw createError(this.lexer, `Unknown state: ${state}`);
			}
			const key = JSON.stringify([offset, stack, embedded?.languageId]);
			if (visited.has(key)) {
				throw createError(this.lexer, `Rules do not advance at ${offset} in ${state}`);
			}
			visited.add(key);
			if (embedded) {
				const exit = this.findEmbeddedExit(rules, state, text, offset);
				const end = Math.min(exit ?? text.length, line.length);
				if (end > offset || (line.length === 0 && exit === undefined)) {
					const support = this.embeddedSupport(embedded.languageId);
					if (support && support !== this) {
						const childState = embedded.state ?? support.getInitialState();
						const content = line.slice(offset, end);
						const childHasEOL = exit === undefined && hasEOL;
						if (encoded && support.tokenizeEncoded) {
							const result = support.tokenizeEncoded(content, childHasEOL, childState);
							for (const token of result.rawTokens ?? []) {
								emitRaw(offset + token.offset, token.type, token.language);
							}
							for (let index = 0; index < result.tokens.length; index += 2) {
								emitMetadata(offset + result.tokens[index]!, result.tokens[index + 1]!);
							}
							embedded.state = result.endState;
						} else {
							const result = support.tokenize(content, childHasEOL, childState);
							for (const token of result.tokens) {
								emit(offset + token.offset, token.type, token.language);
							}
							embedded.state = result.endState;
						}
					} else {
						emit(offset, '', embedded.languageId);
					}
				}
				if (exit === undefined) {
					break;
				}
				offset = exit;
			}
			let match: RegExpExecArray | null = null;
			let rule: IRule | undefined;
			for (const candidate of rules) {
				const regex = candidate.resolveRegex(state);
				regex.lastIndex = offset;
				match = regex.exec(text);
				if (match) {
					rule = candidate;
					break;
				}
			}
			if (!rule || !match) {
				if (offset === text.length) {
					break;
				}
				emit(offset, this.tokenType(this.lexer.defaultToken, text[offset]!));
				offset += this.lexer.unicode && text.codePointAt(offset)! > 0xffff ? 2 : 1;
				continue;
			}
			const matched = match;
			const apply = (input: IMonarchLanguageAction, start: number, end: number): number => {
				const id = text.slice(start, end);
				const action = this.action(input, id, matched, state, end === text.length);
				let nextOffset = end;
				if (action.group) {
					if (action.group.length !== matched.length - 1) {
						throw createError(this.lexer, `Capture count does not match actions in ${rule!.name}`);
					}
					let groupOffset = start;
					for (let index = 0; index < action.group.length; index++) {
						const bounds = matched.indices![index + 1];
						if (!bounds) {
							continue;
						}
						if (bounds[0] !== groupOffset || bounds[1] > end) {
							throw createError(this.lexer, `Capture groups must partition the match in ${rule!.name}`);
						}
						nextOffset = apply(action.group[index]!, bounds[0], bounds[1]);
						groupOffset = bounds[1];
					}
					if (groupOffset !== end) {
						throw createError(this.lexer, `Capture groups must cover the match in ${rule!.name}`);
					}
				} else if (action.token === '@rematch') {
					nextOffset = start;
				} else if (end > start) {
					const token = substituteMatches(this.lexer, action.token ?? '', id, matched, state);
					emit(start, this.tokenType(token, id));
				}
				if (action.log !== undefined) {
					console.log(`${this.languageId}: ${substituteMatches(this.lexer, action.log, id, matched, state)}`);
				}
				if (action.switchTo !== undefined) {
					stack[stack.length - 1] = substituteMatches(this.lexer, action.switchTo, id, matched, state).replace(/^@/, '');
				} else if (action.next !== undefined) {
					const next = substituteMatches(this.lexer, action.next, id, matched, state);
					switch (next) {
						case '@pop':
							if (stack.length === 1) {
								throw createError(this.lexer, 'Cannot pop the initial state');
							}
							stack.pop();
							break;
						case '@popall': stack.splice(1); break;
						case '@push': stack.push(stack[stack.length - 1]!); break;
						default: stack.push(next.replace(/^@/, '')); break;
					}
				}
				if (stack.length > this.lexer.maxStack || !findRules(this.lexer, stack[stack.length - 1]!)) {
					throw createError(this.lexer, `Invalid state transition from ${state}`);
				}
				if (action.nextEmbedded !== undefined) {
					const next = substituteMatches(this.lexer, action.nextEmbedded, id, matched, state);
					if (next === '@pop') {
						embedded = null;
					} else {
						const languageId = this.languageService.getLanguageIdByMimeType(next) ?? next;
						this.embeddedSupport(languageId);
						embedded = { languageId, state: null };
					}
				}
				if (action.goBack !== undefined) {
					nextOffset -= action.goBack;
					if (nextOffset < 0) {
						throw createError(this.lexer, 'goBack moved before the start of the line');
					}
				}
				return nextOffset;
			};
			const nextOffset = apply(rule.action, offset, offset + match[0].length);
			if (nextOffset === text.length && match[0].length === 0 && JSON.stringify([nextOffset, stack, embedded?.languageId]) === key) {
				break;
			}
			offset = nextOffset;
		}
		return { tokens, encoded: metadata, endState: new LineState(stack, embedded) };
	}

	private tokenType(token: string, text: string): string {
		if (token.startsWith('@brackets')) {
			const value = this.lexer.ignoreCase ? text.toLowerCase() : text;
			const bracket = this.lexer.brackets.find(item => [item.open, item.close].some(side => (this.lexer.ignoreCase ? side.toLowerCase() : side) === value));
			if (!bracket) {
				throw createError(this.lexer, `No bracket definition for ${text}`);
			}
			token = `${bracket.token}${token.slice('@brackets'.length)}`;
		}
		return token ? `${token}${this.lexer.tokenPostfix}` : '';
	}

	private action(input: IMonarchLanguageAction, id: string, matches: string[], state: string, eos: boolean): IExpandedMonarchLanguageAction {
		if (typeof input === 'string') {
			return { token: input };
		}
		if (Array.isArray(input)) {
			return { group: input };
		}
		if (input.cases) {
			for (const [guard, value] of Object.entries(input.cases)) {
				if (this.matchesCase(guard, id, matches, state, eos)) {
					return { ...input, cases: undefined, ...this.action(value, id, matches, state, eos) };
				}
			}
			return { token: this.lexer.defaultToken };
		}
		return input;
	}

	private matchesCase(guard: string, id: string, matches: string[], state: string, eos: boolean): boolean {
		if (guard === '@default' || guard === '@' || guard === '') {
			return true;
		}
		if (guard === '@eos') {
			return eos;
		}
		let candidate = id;
		let pattern = guard;
		let operator = '~';
		const comparison = /^(\$(?:[sS]\d+|\d+|#))?(==|!=|!~|~)?(.*)$/.exec(guard)!;
		if (comparison[1]) {
			candidate = substituteMatches(this.lexer, comparison[1], id, matches, state);
		}
		operator = comparison[2] ?? operator;
		pattern = comparison[3]!;
		let result: boolean;
		if (pattern.startsWith('@')) {
			const values: unknown = this.lexer[pattern.slice(1)];
			if (!Array.isArray(values)) {
				throw createError(this.lexer, `Case ${pattern} requires an array`);
			}
			result = values.some(value => this.lexer.ignoreCase ? String(value).toLowerCase() === candidate.toLowerCase() : value === candidate);
		} else if (operator === '==' || operator === '!=') {
			const expected = substituteMatches(this.lexer, pattern, id, matches, state);
			result = this.lexer.ignoreCase ? expected.toLowerCase() === candidate.toLowerCase() : expected === candidate;
		} else {
			result = new RegExp(`^(?:${pattern})$`, this.lexer.ignoreCase ? 'i' : '').test(candidate);
		}
		return operator === '!=' || operator === '!~' ? !result : result;
	}

	private embeddedSupport(languageId: string): ITokenizationSupport | null {
		this.embeddedLanguages.add(languageId);
		this.languageService.requestBasicLanguageFeatures(languageId);
		const support = TokenizationRegistry.get(languageId);
		if (!support && !TokenizationRegistry.isResolved(languageId) && !this.loading.has(languageId)) {
			const pending = TokenizationRegistry.getOrCreate(languageId).then(() => {
				this.loading.delete(languageId);
			});
			this.loading.set(languageId, pending);
			void pending.catch(onUnexpectedError);
		}
		return support;
	}

	private findEmbeddedExit(rules: IRule[], state: string, text: string, offset: number): number | undefined {
		let first: number | undefined;
		for (const rule of rules) {
			const expression = rule.resolveRegex(state);
			const search = new RegExp(expression.source, expression.flags.replace('y', 'g'));
			search.lastIndex = offset;
			for (let match = search.exec(text); match; match = search.exec(text)) {
				if (first !== undefined && match.index >= first) {
					break;
				}
				const action = this.action(rule.action, match[0], match, state, match.index + match[0].length === text.length);
				if (action.nextEmbedded === '@pop' || action.group?.some(item => this.action(item, match![0], match!, state, false).nextEmbedded === '@pop')) {
					first = match.index;
					break;
				}
				if (match[0].length === 0) {
					search.lastIndex++;
				}
			}
		}
		return first;
	}
}
