import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { bundledLanguages, type BundledLanguage } from 'shiki/langs';
import type { LanguageInput, LanguageRegistration, RegexEngine } from 'shiki/types';
import { WebWorkerServer, type WebWorkerRequestHandler } from '../../../../base/common/worker/webWorker.js';
import { start } from '../../../../editor/editor.worker.start.js';
import { chatHighlightChannel, maximumChatHighlightLength } from './chatHighlightProtocol.js';

const theme = { name: 'ash-token-scopes', type: 'dark' as const, settings: [] };
// Shiki does not ship these file grammars. Keep their basic highlighting available before installation.
const fileGrammars = new Map<string, LanguageRegistration>([
	['bazelrc', {
		name: 'bazelrc', scopeName: 'source.bazelrc', repository: {}, patterns: [
			{ name: 'comment.line.number-sign.bazelrc', match: '#.*$' },
			{ name: 'keyword.control.bazelrc', match: '^\\s*[a-z][\\w-]*(?=:|\\s|$)' },
			{ name: 'entity.name.function.bazelrc', match: '(?<=:)[\\w-]+' },
			{ name: 'variable.other.property.bazelrc', match: '(?<!\\S)--[\\w-]+' },
			{ name: 'string.quoted.double.bazelrc', begin: '"', end: '"', patterns: [{ match: '\\\\.' }] },
			{ name: 'string.quoted.single.bazelrc', begin: "'", end: "'" },
		]
	}],
	['ignore', {
		name: 'ignore', scopeName: 'source.ignore', repository: {}, patterns: [
			{ name: 'comment.line.number-sign.ignore', match: '^#.*$' },
			{
				name: 'string.unquoted.ignore', begin: '^(?=.)', end: '$', patterns: [
					{ name: 'constant.character.escape.ignore', match: '\\\\.' },
					{ name: 'keyword.operator.negation.ignore', match: '^!' },
					{ name: 'keyword.operator.wildcard.ignore', match: '[?*]' },
					{ name: 'punctuation.separator.ignore', match: '[/\\[\\]]' },
				]
			},
		]
	}],
]);

class GrammarHighlighter {
	private highlighter: Promise<HighlighterCore> | undefined;
	private readonly loading = new Map<LanguageInput, Promise<void>>();

	constructor(private readonly createEngine: () => RegexEngine | Promise<RegexEngine>) { }

	async tokenize(load: LanguageInput, language: string, text: string, signal: AbortSignal) {
		const highlighter = await (this.highlighter ??= createHighlighterCore({ themes: [theme], langs: [], engine: this.createEngine() }));
		let grammar = this.loading.get(load);
		if (!grammar) {
			grammar = highlighter.loadLanguage(load);
			this.loading.set(load, grammar);
			void grammar.catch(() => this.loading.delete(load));
		}
		await grammar;
		signal.throwIfAborted();
		return highlighter.codeToTokensBase(text, { lang: language, theme: theme.name, includeExplanation: 'scopeName', tokenizeMaxLineLength: 2048, tokenizeTimeLimit: 50 });
	}
}

class ChatHighlightWorker implements WebWorkerRequestHandler {
	private readonly javascript = new GrammarHighlighter(() => createJavaScriptRegexEngine({ forgiving: true }));
	private readonly oniguruma = new GrammarHighlighter(async () => {
		const [{ createOnigurumaEngine }, { default: wasm }] = await Promise.all([import('shiki/engine/oniguruma'), import('shiki/onig.wasm?url')]);
		return createOnigurumaEngine(fetch(wasm));
	});
	private readonly requiresOniguruma = new Set<LanguageInput>();

	async handleRequest(message: Record<string, unknown>, signal: AbortSignal) {
		const { language, text } = message;
		if (typeof language !== 'string' || typeof text !== 'string' || text.length > maximumChatHighlightLength) throw new TypeError('Invalid chat highlight request');
		const load = Object.hasOwn(bundledLanguages, language) ? bundledLanguages[language as BundledLanguage] : fileGrammars.get(language);
		if (!load) return [];
		let tokens;
		if (!this.requiresOniguruma.has(load)) {
			try {
				tokens = await this.javascript.tokenize(load, language, text, signal);
			} catch {
				signal.throwIfAborted();
				this.requiresOniguruma.add(load);
			}
		}
		tokens ??= await this.oniguruma.tokenize(load, language, text, signal);
		const output: [line: number, start: number, end: number, type: string][] = [];
		for (const [row, line] of tokens.entries()) {
			let column = 1;
			for (const token of line) {
				for (const part of token.explanation ?? []) {
					for (let index = part.scopes.length - 1; index >= 0; index--) {
						const type = tokenType(part.scopes[index]!.scopeName);
						if (type && part.content.length) {
							output.push([row + 1, column, column + part.content.length, type]);
							break;
						}
					}
					column += part.content.length;
				}
				if (!token.explanation?.length) column += token.content.length;
			}
		}
		return output;
	}

	handleNotification(): never { throw new TypeError('Unexpected chat highlight notification'); }
}

function tokenType(scope: string): string | undefined {
	if (scope.startsWith('constant.numeric')) return 'number';
	if (scope.startsWith('keyword.operator')) return 'operator';
	if (/^(?:entity\.name\.function|support\.function)\./u.test(scope)) return 'function';
	if (/^(?:entity\.name\.type|entity\.name\.class|support\.type|support\.class)\./u.test(scope)) return 'type';
	if (/^(?:variable\.other\.property|support\.type\.property-name)\./u.test(scope)) return 'property';
	if (scope.startsWith('entity.other.attribute-name.')) return 'attribute';
	switch (scope.split('.', 1)[0]) {
		case 'storage': return 'keyword';
		case 'comment': return 'comment';
		case 'constant': return 'constant';
		case 'keyword': return 'keyword';
		case 'punctuation': return 'punctuation';
		case 'string': return 'string';
		case 'variable': return 'variable';
	}
	return undefined;
}

start(({ port, resources }) => resources.add(new WebWorkerServer(port, chatHighlightChannel, new ChatHighlightWorker())));
