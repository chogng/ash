import parserUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm?url&no-inline';
import type { Language, Parser, Query } from '@vscode/tree-sitter-wasm';
import * as treeSitterNamespace from '@vscode/tree-sitter-wasm';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { syntaxLanguageForEditorLanguage } from '../../../../platform/syntax/common/syntaxApi.js';
import { bundledTreeSitterGrammars } from './treeSitterGrammars.generated.js';
import type { ExtensionTreeSitterWorkerHost } from '../common/extensionTreeSitterGrammar.js';

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

	constructor(private readonly extensionGrammars?: ExtensionTreeSitterWorkerHost) { super(); }

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
		const extension = await this.extensionGrammars?.getGrammar(languageId);
		const entry = extension ? undefined : definition(languageId);
		if (!entry && !extension) return undefined;
		await this.getParserClass();
		const bytes = entry ? await fetchWasm(entry.url, 'gzip') : await decompressExtensionGrammar(extension!.wasm);
		const language = await runtime.Language.load(bytes);
		if (this.isDisposed) return undefined;
		const queries: Query[] = [];
		try {
			queries.push(new runtime.Query(language, entry?.query ?? extension!.highlights));
			queries.push(new runtime.Query(language, entry?.tags ?? extension!.tags));
			queries.push(new runtime.Query(language, entry?.folds ?? extension!.folds));
			const injections = entry?.injections ?? extension?.injections;
			if (injections) queries.push(new runtime.Query(language, injections));
		} catch (error) {
			for (const query of queries) query.delete();
			throw error;
		}
		this.queries.set(languageId, queries[0]!);
		this.tags.set(languageId, queries[1]!);
		this.folds.set(languageId, queries[2]!);
		if (queries[3]) this.injections.set(languageId, queries[3]);
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

async function fetchWasm(url: string, encoding?: 'gzip'): Promise<Uint8Array> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Unable to load Tree-sitter WASM (${response.status})`);
	if (encoding === 'gzip') {
		if (!response.body) throw new Error('Empty Tree-sitter grammar response');
		// The stored asset is a gzip file, so any Web host can serve it as-is.
		const decoded = response.body.pipeThrough(new DecompressionStream('gzip'));
		return new Uint8Array(await new Response(decoded).arrayBuffer());
	}
	return new Uint8Array(await response.arrayBuffer());
}

async function decompressExtensionGrammar(bytes: Uint8Array): Promise<Uint8Array> {
	if (!(bytes instanceof Uint8Array) || !bytes.length) throw new TypeError('Invalid Tree-sitter grammar bytes');
	let length = 0;
	const decoded = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('gzip'))
		.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				length += chunk.byteLength;
				if (length > 16 * 1024 * 1024) throw new RangeError('Installed grammar exceeds the maximum Wasm size');
				controller.enqueue(chunk);
			},
		}));
	return new Uint8Array(await new Response(decoded).arrayBuffer());
}

function definition(languageId: string) {
	const language = syntaxLanguageForEditorLanguage(languageId);
	return language ? bundledTreeSitterGrammars[language] : undefined;
}
