import parserUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm?url&no-inline';
import type { Language, Parser, Query } from '@vscode/tree-sitter-wasm';
import * as treeSitterNamespace from '@vscode/tree-sitter-wasm';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { syntaxLanguageForEditorLanguage } from '../../../../platform/syntax/common/syntaxApi.js';
import { bundledTreeSitterGrammars } from './treeSitterGrammars.generated.js';

const runtime = (treeSitterNamespace as unknown as { default?: typeof treeSitterNamespace; }).default ?? treeSitterNamespace;

/** Loads bundled WASM grammars once per window; documents own and release their trees. */
export class TreeSitterWasmLibrary extends Disposable {
	declare readonly _serviceBrand: undefined;
	private initialization: Promise<void> | undefined;
	private readonly languages = new Map<string, Promise<Language | undefined>>();
	private readonly queries = new Map<string, Query>();
	private readonly tags = new Map<string, Query>();
	private readonly folds = new Map<string, Query>();
	private readonly injections = new Map<string, Query>();

	supportsLanguage(languageId: string): boolean {
		return !!definition(languageId)?.url;
	}

	async getParserClass(): Promise<typeof treeSitterNamespace.Parser> {
		this.initialization ??= (async () => {
			// Fetch explicitly: the packaged runtime's file:// XHR fallback is not
			// reliable in Electron. The same asset path also works in the Web host.
			const options = { locateFile: () => parserUrl, wasmBinary: await fetchWasm(parserUrl) };
			await runtime.Parser.init(options);
		})();
		await this.initialization;
		return runtime.Parser;
	}

	getLanguagePromise(languageId: string): Promise<Language | undefined> {
		let language = this.languages.get(languageId);
		if (!language) {
			language = this.loadLanguage(languageId);
			this.languages.set(languageId, language);
			void language.catch(() => this.languages.delete(languageId));
		}
		return language;
	}

	getHighlightingQueries(languageId: string): Query | undefined {
		return this.queries.get(languageId);
	}

	getSymbolQueries(languageId: string): Query | undefined { return this.tags.get(languageId); }
	getFoldingQueries(languageId: string): Query | undefined { return this.folds.get(languageId); }
	getInjectionQueries(languageId: string): Query | undefined { return this.injections.get(languageId); }

	private async loadLanguage(languageId: string): Promise<Language | undefined> {
		const entry = definition(languageId);
		if (!entry?.url) return undefined;
		await this.getParserClass();
		const language = await runtime.Language.load(await fetchWasm(entry.url));
		if (this.isDisposed) return undefined;
		this.queries.set(languageId, new runtime.Query(language, entry.query));
		this.tags.set(languageId, new runtime.Query(language, entry.tags));
		this.folds.set(languageId, new runtime.Query(language, entry.folds));
		if (entry.injections) this.injections.set(languageId, new runtime.Query(language, entry.injections));
		return language;
	}

	override dispose(): void {
		for (const query of this.queries.values()) query.delete();
		for (const query of this.tags.values()) query.delete();
		for (const query of this.folds.values()) query.delete();
		this.folds.clear();
		for (const query of this.injections.values()) query.delete();
		this.injections.clear();
		this.tags.clear();
		this.queries.clear();
		this.languages.clear();
		super.dispose();
	}
}

async function fetchWasm(url: string): Promise<Uint8Array> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Unable to load Tree-sitter WASM (${response.status})`);
	return new Uint8Array(await response.arrayBuffer());
}

function definition(languageId: string) {
	const language = syntaxLanguageForEditorLanguage(languageId);
	return language ? bundledTreeSitterGrammars[language] : undefined;
}
